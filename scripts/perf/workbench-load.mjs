#!/usr/bin/env node
// W0 — the Workbench first-paint load harness.
//
// Fires the exact first-paint verb set (workbench/contracts/first-paint.json) at a live MCP
// control plane, SERIAL then CONCURRENT, three rounds each, and reports p50/p95 per verb and per
// mode. The point is not the absolute numbers — it is the ratio between the two modes:
//
//   Decision rule (H1, server contention): if concurrent p95 >= 3x serial p95 for the
//   SMALL-payload verbs (the ones whose bytes cannot explain their latency), the cost is
//   contention on the shared workspace document load, not transfer.
//
// Also runs the H2 probe: `workflow_list_runs {limit:50}` twice in a row. The first call heals
// every index row it finds below RUN_INDEX_VERSION; if the second call is not dramatically
// cheaper, the heal is not persisting (BlobExecutionRepository swallows its write failure with
// `.catch(() => undefined)`), and every listing pays up to `limit` blob reads forever.
//
// Credentials come from the environment ONLY, never from an argument or a file:
//   CMS_AGENT_MCP_URL    e.g. https://<service>.run.app/mcp
//   CMS_AGENT_MCP_TOKEN  a full bearer
//
//   node scripts/perf/workbench-load.mjs [--rounds 3] [--workflow publishing_conductor]
//        [--json docs/perf/raw/workbench-load.json] [--skip-h2]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const URL_ = process.env.CMS_AGENT_MCP_URL?.trim();
const TOKEN = process.env.CMS_AGENT_MCP_TOKEN?.trim();
const ROUNDS = Number(flag('rounds', '3'));
const WORKFLOW = flag('workflow', 'publishing_conductor');
const JSON_OUT = flag('json', '');

if (!URL_ || !TOKEN) {
  console.error('CMS_AGENT_MCP_URL and CMS_AGENT_MCP_TOKEN must both be set in the environment.');
  console.error('Never pass a token on the command line — it lands in shell history and process listings.');
  process.exit(2);
}

// ----------------------------------------------------------------- MCP transport

let sessionId;
let rpcId = 0;

/** One Streamable-HTTP JSON-RPC call. Returns { ms, bytes, ok, body }. `bytes` is the raw
 *  response length on the wire, which is the figure the load budget is written against. */
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) });
  const started = performance.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body,
  });
  const text = await res.text();
  const ms = performance.now() - started;
  const header = res.headers.get('mcp-session-id');
  if (header && !sessionId) sessionId = header;
  return { ms, bytes: Buffer.byteLength(text), ok: res.ok, status: res.status, body: parseRpc(text) };
}

/** The endpoint may answer as plain JSON or as a one-event SSE stream; accept both. */
function parseRpc(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed); } catch { return null; } }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch { /* keep scanning */ }
  }
  return null;
}

async function initialize() {
  const res = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'workbench-load-harness', version: '1' },
  });
  if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status}`);
  await rpc('notifications/initialized');
  return res;
}

async function endSession() {
  if (!sessionId) return;
  try {
    await fetch(URL_, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sessionId } });
  } catch { /* the session expires on its own; never fail a measurement on teardown */ }
}

const callVerb = (name, callArgs) => rpc('tools/call', { name, arguments: callArgs ?? {} });

/** Tool results arrive as MCP content parts; dig the JSON payload back out. */
function payloadOf(res) {
  const content = res.body?.result?.content;
  const text = Array.isArray(content) ? content.find((part) => part?.type === 'text')?.text : undefined;
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

// ----------------------------------------------------------------- statistics

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i]);
};
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), min: pct(sorted, 0), max: pct(sorted, 100) };
};

// ----------------------------------------------------------------- the burst

/** Resolve the contract's `<first node>` placeholder against the live graph, so the harness
 *  measures the same node the rail would actually have opened. */
async function resolveNodeId() {
  const res = await callVerb('workspace_get_graph', { workflowId: WORKFLOW });
  const nodes = payloadOf(res)?.data?.nodes ?? payloadOf(res)?.nodes ?? [];
  return nodes[0]?.id ?? 'draft_writer';
}

function materialise(calls, nodeId) {
  return calls
    .filter((call) => !call.conditional)
    .map((call) => ({
      verb: call.verb,
      args: JSON.parse(JSON.stringify(call.args).replaceAll('<first node>', nodeId)),
      declaredBytes: call.bytes ?? null,
    }));
}

async function runSerial(burst) {
  const out = [];
  for (const call of burst) {
    const res = await callVerb(call.verb, call.args);
    out.push({ ...call, ms: res.ms, bytes: res.bytes, ok: res.ok });
  }
  return out;
}

async function runConcurrent(burst) {
  const settled = await Promise.all(burst.map(async (call) => {
    const res = await callVerb(call.verb, call.args);
    return { ...call, ms: res.ms, bytes: res.bytes, ok: res.ok };
  }));
  return settled;
}

// ----------------------------------------------------------------- H2 probe

async function probeRunIndexHeal() {
  const first = await callVerb('workflow_list_runs', { limit: 50 });
  const second = await callVerb('workflow_list_runs', { limit: 50 });
  const rows = payloadOf(second)?.data?.runs ?? payloadOf(second)?.runs ?? [];
  return {
    firstMs: Math.round(first.ms),
    secondMs: Math.round(second.ms),
    firstBytes: first.bytes,
    secondBytes: second.bytes,
    rows: rows.length,
    // The stale-row heal is per page and idempotent: if it persists, the second call is cheap.
    // A second call within ~20% of the first means the repair is not landing.
    healPersisted: second.ms < first.ms * 0.8,
  };
}

// ----------------------------------------------------------------- main

async function main() {
  const contract = JSON.parse(await readFile(resolve(repoRoot, 'workbench/contracts/first-paint.json'), 'utf8'));
  await initialize();
  const nodeId = await resolveNodeId();
  const burst = materialise(contract.before.calls, nodeId);

  const modes = { serial: [], concurrent: [] };
  for (let round = 0; round < ROUNDS; round++) {
    modes.serial.push(await runSerial(burst));
    modes.concurrent.push(await runConcurrent(burst));
  }

  const perVerb = new Map();
  for (const [mode, rounds] of Object.entries(modes)) {
    for (const round of rounds) {
      for (const call of round) {
        const entry = perVerb.get(call.verb) ?? { verb: call.verb, bytes: call.bytes, serial: [], concurrent: [] };
        entry[mode].push(call.ms);
        entry.bytes = call.bytes;
        perVerb.set(call.verb, entry);
      }
    }
  }

  // "Small payload" = under 20 KB on the wire. For those, bytes cannot explain latency, so the
  // serial/concurrent gap is contention and nothing else.
  const SMALL_BYTES = 20 * 1024;
  const rows = [...perVerb.values()].map((entry) => ({
    verb: entry.verb,
    bytes: entry.bytes,
    small: entry.bytes < SMALL_BYTES,
    serial: stats(entry.serial),
    concurrent: stats(entry.concurrent),
  }));
  const smallRows = rows.filter((row) => row.small && row.serial.p95 > 0);
  const ratios = smallRows.map((row) => row.concurrent.p95 / Math.max(1, row.serial.p95));
  const medianRatio = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] ?? 0;

  const wallSerial = stats(modes.serial.map((round) => round.reduce((sum, call) => sum + call.ms, 0)));
  const wallConcurrent = stats(modes.concurrent.map((round) => Math.max(...round.map((call) => call.ms))));

  const h2 = has('skip-h2') ? null : await probeRunIndexHeal();

  const report = {
    at: new Date().toISOString(),
    url: URL_.replace(/\/\/[^@]*@/, '//'),
    rounds: ROUNDS,
    workflow: WORKFLOW,
    nodeId,
    burstSize: burst.length,
    totalBytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
    wall: { serial: wallSerial, concurrent: wallConcurrent },
    verbs: rows.sort((a, b) => b.concurrent.p95 - a.concurrent.p95),
    h1: {
      rule: 'concurrent p95 >= 3x serial p95 across small-payload verbs',
      smallPayloadVerbs: smallRows.length,
      medianRatio: Number(medianRatio.toFixed(2)),
      confirmed: medianRatio >= 3,
    },
    h2,
  };

  console.log(render(report));
  if (JSON_OUT) {
    const target = resolve(repoRoot, JSON_OUT);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nraw: ${JSON_OUT}`);
  }
  await endSession();
}

function render(report) {
  const lines = [];
  lines.push(`first-paint burst — ${report.burstSize} verbs, ${report.rounds} rounds, ${(report.totalBytes / 1024).toFixed(0)} KB`);
  lines.push('');
  lines.push('| verb | KB | serial p50 | serial p95 | concurrent p50 | concurrent p95 | ratio |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const row of report.verbs) {
    const ratio = row.serial.p95 ? (row.concurrent.p95 / row.serial.p95).toFixed(1) : '—';
    lines.push(`| ${row.verb}${row.small ? '' : ' *'} | ${((row.bytes ?? 0) / 1024).toFixed(0)} | ${row.serial.p50} | ${row.serial.p95} | ${row.concurrent.p50} | ${row.concurrent.p95} | ${ratio}x |`);
  }
  lines.push('');
  lines.push(`* = payload over 20 KB, excluded from the H1 ratio (transfer could explain its latency).`);
  lines.push('');
  lines.push(`wall clock: serial ${report.wall.serial.p50} ms p50 / ${report.wall.serial.p95} ms p95 · concurrent ${report.wall.concurrent.p50} ms p50 / ${report.wall.concurrent.p95} ms p95`);
  lines.push(`H1 (server contention on the shared workspace load): median small-payload ratio ${report.h1.medianRatio}x across ${report.h1.smallPayloadVerbs} verbs — ${report.h1.confirmed ? 'CONFIRMED' : 'not confirmed'}`);
  if (report.h2) {
    lines.push(`H2 (run-index heal not persisting): workflow_list_runs{limit:50} ${report.h2.firstMs} ms then ${report.h2.secondMs} ms — ${report.h2.healPersisted ? 'heal persisted' : 'HEAL IS NOT PERSISTING'}`);
  }
  return lines.join('\n');
}

main().catch(async (error) => {
  await endSession();
  console.error(error?.message ?? error);
  process.exit(1);
});
