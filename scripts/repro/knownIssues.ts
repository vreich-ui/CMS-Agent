// Minimal, offline reproductions for the cheaply reproducible entries in docs/KNOWN_ISSUES.md.
// Documentation tooling only: nothing here fixes anything, and every check prints REPRODUCED when
// the defect is still present on the current tree and NOT REPRODUCED once it has been fixed (at
// which point the matching KNOWN_ISSUES entry should be closed). Runs against the in-memory store
// and the real MCP endpoint core — no network, no secrets, no side effects outside this process.
//
//   WORKSPACE_STORE=memory npx tsx scripts/repro/knownIssues.ts
//
// Exit code is 0 whenever the script itself ran; the per-finding verdicts are the output.
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.WORKSPACE_STORE = "memory";
process.env.MCP_STATE_STORE = "memory";
process.env.MCP_API_TOKEN = "repro-static-bearer";
const SCOPED = "repro-scoped-platform";
process.env.MCP_SCOPED_TOKENS_JSON = JSON.stringify({ [SCOPED]: { projects: ["platform"], toolAllowlist: ["workflow_get_run", "workflow_set_operator_publish_decision"] } });

const { BlobLearningRepository } = await import("../../src/agent/repository/blobs/BlobLearningRepository.js");
const { handleMcpHttp } = await import("../../src/agent/mcp/http/mcpEndpoint.js");
const { repositoryManager } = await import("../../src/agent/runtime/repositories.js");

type Verdict = { id: string; title: string; reproduced: boolean; detail: string };
const verdicts: Verdict[] = [];
const record = (id: string, title: string, reproduced: boolean, detail: string) => verdicts.push({ id, title, reproduced, detail });

// A lightweight blob-store double with the same surface the blob repositories feature-detect.
const memoryBlobStore = () => {
  const blobs = new Map<string, unknown>();
  return {
    blobs,
    async get(key: string, options?: { type?: string }) {
      const value = blobs.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? structuredClone(value) : JSON.stringify(value);
    },
    async setJSON(key: string, value: unknown) { blobs.set(key, structuredClone(value)); },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: "x" })), directories: [] };
    },
    async delete(key: string) { blobs.delete(key); }
  } as any;
};

// ---------------------------------------------------------------------------------------------
// C-1 — learning.list_observations reads `learning/` as if every blob were an observation, so the
// conversation-turn ledgers written under learning/conversation-turn-gc/ shadow the real observations.
{
  const store = memoryBlobStore();
  const workspaceObservations = [{ id: "obs_real", observation: "a real observation", status: "active", createdAt: "2026-09-01T00:00:00.000Z" }];
  const workspaceRepository = { listObservations: async () => workspaceObservations } as any;
  const repo = new BlobLearningRepository(workspaceRepository, store);
  const ledger = { supersessions: [], references: [] };
  const before = await repo.listObservations();
  await store.setJSON("learning/conversation-turn-gc/platform/chat_1.json", ledger);
  let oneLedger: unknown;
  try { oneLedger = await repo.listObservations(); } catch (error) { oneLedger = error; }
  await store.setJSON("learning/conversation-turn-gc/platform/chat_2.json", ledger);
  let twoLedgers: unknown;
  try { twoLedgers = await repo.listObservations(); } catch (error) { twoLedgers = error; }
  const hidden = Array.isArray(oneLedger) && !oneLedger.some((entry: any) => entry.id === "obs_real");
  const threw = twoLedgers instanceof Error;
  record("C-1", "learning.list_observations breaks once a conversation-turn ledger exists", before.length === 1 && (hidden || threw),
    `no ledger → ${before.length} observation(s); one ledger → ${Array.isArray(oneLedger) ? `${oneLedger.length} record(s), real observation ${hidden ? "HIDDEN" : "visible"}` : String(oneLedger)}; two ledgers → ${threw ? `throws ${(twoLedgers as Error).message}` : "no throw"}`);
}

// ---------------------------------------------------------------------------------------------
// Shared MCP helpers (wire names, static bearer unless told otherwise).
let rpcId = 0;
const rpc = async (name: string, args: Record<string, unknown>, options: { token?: string; headers?: Record<string, string> } = {}) => {
  const response = await handleMcpHttp({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${options.token ?? process.env.MCP_API_TOKEN}`, host: "repro.local", ...(options.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
  });
  const parsed = response.body ? JSON.parse(response.body) : undefined;
  const text = parsed?.result?.content?.[0]?.text;
  return { status: response.statusCode, payload: text ? JSON.parse(text) : parsed };
};

// ---------------------------------------------------------------------------------------------
// K-M4 — actor identity is whatever the caller asserts: the x-workspace-actor header is honoured for
// any bearer, so a static-token caller can sign change history as a named human.
{
  const asserted = { kind: "human", id: "usr_not_really_here", label: "Asserted Human" };
  const update = await rpc("workspace_update_node_metadata", { id: "input_triage", patch: { metadata: { reproMarker: Date.now() } } }, { headers: { "x-workspace-actor": JSON.stringify(asserted) } });
  const changes = await rpc("changes_list", { detail: "summary", nodeId: "input_triage", limit: 5 });
  const entries: any[] = changes.payload?.data?.events ?? changes.payload?.events ?? [];
  const signed = entries.find((entry) => entry?.actor?.id === asserted.id);
  record("K-M4", "Self-asserted actor attribution via x-workspace-actor", update.status === 200 && !!signed,
    signed ? `change ${signed.id ?? "?"} recorded actor ${JSON.stringify(signed.actor)} from a static bearer` : `update status ${update.status}; no change signed by the asserted actor (${entries.length} change(s) listed)`);
}

// ---------------------------------------------------------------------------------------------
// K-M5 — tool-grant widening needs nothing but a full bearer: allowedTools on the publish executor
// can be rewritten with no approval flag, no operator actor, no second factor.
{
  const before = await rpc("workspace_get_node", { id: "publish_executor" });
  const current: string[] = before.payload?.data?.node?.allowedTools ?? before.payload?.node?.allowedTools ?? [];
  const widened = [...new Set([...current, "workflow.run_all"])];
  const result = await rpc("workspace_update_node_tools", { id: "publish_executor", patch: { allowedTools: widened } });
  const after = await rpc("workspace_get_node", { id: "publish_executor" });
  const now: string[] = after.payload?.data?.node?.allowedTools ?? after.payload?.node?.allowedTools ?? [];
  record("K-M5", "Tool grants on a publish node change on a bare full-bearer call", result.status === 200 && now.includes("workflow.run_all"),
    `status ${result.status}; publish_executor.allowedTools ${current.length} → ${now.length} entries (${now.includes("workflow.run_all") ? "grant applied" : "grant refused"})`);
}

// ---------------------------------------------------------------------------------------------
// K-M9 — the scoped-bearer project pin only sees calls that carry projectId/project_id. Run-addressed
// tools carry a runId only, so a tenant's chat credential can approve or read ANOTHER tenant's run.
{
  const started = await rpc("workflow_start_dry_run", { projectId: "dr-lurie", input: { topic: "repro" }, executionMode: "mock" });
  const runId: string | undefined = started.payload?.data?.run?.runId ?? started.payload?.run?.runId ?? started.payload?.data?.runId;
  if (!runId) {
    record("K-M9", "Scoped bearer acts on a foreign tenant's run by runId", false, `could not create a dr-lurie run: status ${started.status} ${JSON.stringify(started.payload).slice(0, 200)}`);
  } else {
    const foreignRead = await rpc("workflow_get_run", { runId }, { token: SCOPED });
    const foreignDecision = await rpc("workflow_set_operator_publish_decision", { runId, decision: "approved" }, { token: SCOPED });
    const check = await rpc("workflow_get_run", { runId });
    const decision = check.payload?.data?.run?.operatorPublishDecision ?? check.payload?.run?.operatorPublishDecision;
    const pinnedCall = await rpc("workflow_get_run", { runId, projectId: "dr-lurie" }, { token: SCOPED });
    record("K-M9", "Scoped bearer acts on a foreign tenant's run by runId", foreignRead.status === 200 && foreignDecision.status === 200 && decision === "approved",
      `platform-scoped bearer: workflow_get_run → ${foreignRead.status}, workflow_set_operator_publish_decision → ${foreignDecision.status}; dr-lurie run now operatorPublishDecision=${JSON.stringify(decision)}; the same call WITH projectId:"dr-lurie" → ${pinnedCall.status} (the pin works only when the argument is present)`);
  }
}

// ---------------------------------------------------------------------------------------------
// C-12 — the two deploy artifacts for cms-agent-mcp name different environment variable sets.
{
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const yaml = readFileSync(path.join(root, "cloudbuild.deploy.yaml"), "utf8");
  const script = readFileSync(path.join(root, "scripts/deploy-mcp.sh"), "utf8");
  const names = (text: string, flag: string): Set<string> => {
    const out = new Set<string>();
    const re = new RegExp(`${flag}[= ]+("?)(\\^\\|\\^)?([^\\n]+?)\\1(?:\\s*\\\\?\\s*$)`, "gm");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const body = match[3];
      for (const pair of body.split(match[2] ? "|" : ",")) {
        const key = pair.trim().split("=")[0].trim();
        if (/^[A-Z][A-Z0-9_]+$/.test(key)) out.add(key);
      }
    }
    return out;
  };
  const trigger = new Set([...names(yaml, "--update-env-vars"), ...names(yaml, "--update-secrets")]);
  const shell = new Set([...names(script, "--update-env-vars"), ...names(script, "--update-secrets")]);
  const onlyTrigger = [...trigger].filter((key) => !shell.has(key)).sort();
  const onlyShell = [...shell].filter((key) => !trigger.has(key)).sort();
  record("C-12", "cloudbuild.deploy.yaml and scripts/deploy-mcp.sh set different variable sets", onlyTrigger.length + onlyShell.length > 0,
    `trigger only: [${onlyTrigger.join(", ")}]; script only: [${onlyShell.join(", ")}]`);
}

// ---------------------------------------------------------------------------------------------
// C-3 — runContinuationTickJob accepts a signal it never forwards; an already-aborted signal still
// runs a full tick.
{
  const { runContinuationTickJob } = await import("../../src/agent/entrypoints/runContinuationTickJob.js");
  const controller = new AbortController();
  controller.abort();
  const lines: string[] = [];
  const { result } = await runContinuationTickJob({ signal: controller.signal, log: (line) => lines.push(line), timeBudgetMs: 1_000, maxRuns: 1 });
  const ranAnyway = typeof result === "object" && result !== null && !("aborted" in result);
  record("C-3", "Continuation tick ignores an aborted signal", ranAnyway, `tick completed with ${JSON.stringify(result).slice(0, 160)}… despite signal.aborted === true`);
}

// ---------------------------------------------------------------------------------------------
for (const verdict of verdicts) {
  console.log(`${verdict.reproduced ? "REPRODUCED    " : "NOT REPRODUCED"} ${verdict.id.padEnd(5)} ${verdict.title}\n               ${verdict.detail}`);
}
repositoryManager.getUsageRepository?.().clear?.();
