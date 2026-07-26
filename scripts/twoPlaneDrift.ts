// Two-plane drift detector (CHANGE-PLAN R-0).
//
// The Netlify Functions plane and the Cloud Run MCP Service plane are supposed to serve the SAME
// control plane: netlify/functions/mcp.mts and src/agent/mcp/http/controlPlaneRouter.ts are both
// thin adapters over src/agent/mcp/http/mcpEndpoint.ts -> workspace/server.ts. Nothing enforced
// that. An adapter that grows its own tool list, an alias that stops resolving on one plane, or a
// silently added/removed/renamed tool is invisible until a client hits it in production.
//
// This detector drives BOTH adapters in-process (no network, no secrets, memory repositories) and
// asserts three things:
//
//   1. Plane parity  — both planes advertise a byte-identical tools/list surface.
//   2. Manifest lock — that surface matches the checked-in docs/mcp-tool-manifest.json, so any
//                      change to the wire contract has to be an explicit, reviewable commit.
//   3. Alias parity  — every DEPRECATED_TOOL_ALIASES entry resolves on both planes (aliases are
//                      deliberately unlisted, so parity check #1 cannot see them).
//
// Usage:
//   npm run test:drift        check (exit 1 on drift)     <- CI
//   npm run drift:update      regenerate the manifest     <- intentional surface change
//
// Scope note: this compares the two planes' CODE. Divergence in DEPLOYED state (one plane running
// an older commit, or MCP_EXPOSED_TOOL_PREFIXES scoping the catalog differently per deployment) is
// a deployment-level concern the detector deliberately neutralizes by clearing that variable — see
// reportEnvScoping() below, which surfaces it as a warning rather than silently comparing apples
// to oranges.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { handler as netlifyMcpHandler } from "../netlify/functions/mcp.mjs";
import { routeControlPlaneRequest } from "../src/agent/mcp/http/controlPlaneRouter.js";
import { DEPRECATED_TOOL_ALIASES } from "../src/agent/mcp/workspace/server.js";

const DRIFT_TOKEN = "two-plane-drift-detector-token";
const MANIFEST_PATH = path.resolve(fileURLToPath(new URL("../docs/mcp-tool-manifest.json", import.meta.url)));

export type ListedTool = { name: string; description?: string; inputSchema?: unknown };
export type ToolFingerprint = { name: string; description: string; inputSchemaHash: string };
export type PlaneSurface = { plane: string; tools: ToolFingerprint[] };

export type SurfaceDiff = {
  onlyInFirst: string[];
  onlyInSecond: string[];
  changed: { name: string; field: "description" | "inputSchema"; first: string; second: string }[];
};

export type Manifest = {
  version: "mcp_tool_manifest.v1";
  note: string;
  toolCount: number;
  surfaceHash: string;
  aliases: Record<string, string>;
  tools: ToolFingerprint[];
};

// ---------------------------------------------------------------------------- fingerprinting

// Stable stringify: JSON.stringify's key order follows insertion order, so two structurally
// identical schemas built by different code paths could hash differently. Sorting keys makes the
// hash depend on the schema's meaning, not on how it was assembled.
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
};

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

export const fingerprintTools = (tools: ListedTool[]): ToolFingerprint[] =>
  tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchemaHash: sha256(stableStringify(tool.inputSchema ?? null)).slice(0, 16)
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const surfaceHash = (tools: ToolFingerprint[]): string => sha256(stableStringify(tools));

// ---------------------------------------------------------------------------- plane drivers

const listToolsRequest = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const callToolRequest = (name: string) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } });

// Netlify Functions plane: the Lambda-shaped adapter, exactly as netlify/functions/mcp.mts exports it.
const netlifyPlane = async (message: unknown): Promise<any> => {
  const response = await netlifyMcpHandler({
    httpMethod: "POST",
    body: JSON.stringify(message),
    headers: { authorization: `Bearer ${DRIFT_TOKEN}` }
  });
  if (response.statusCode !== 200) throw new Error(`netlify plane returned ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body);
};

// Cloud Run plane: the control-plane router the long-lived Node process mounts at /mcp.
const cloudRunPlane = async (message: unknown): Promise<any> => {
  const response = await routeControlPlaneRequest({
    method: "POST",
    path: "/mcp",
    query: {},
    headers: { authorization: `Bearer ${DRIFT_TOKEN}`, host: "drift.local" },
    body: JSON.stringify(message)
  });
  if (response.statusCode !== 200) throw new Error(`cloud-run plane returned ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body);
};

const planes: { plane: string; send: (message: unknown) => Promise<any> }[] = [
  { plane: "netlify", send: netlifyPlane },
  { plane: "cloud-run", send: cloudRunPlane }
];

export async function readPlaneSurfaces(): Promise<PlaneSurface[]> {
  const surfaces: PlaneSurface[] = [];
  for (const { plane, send } of planes) {
    const response = await send(listToolsRequest);
    const tools = response?.result?.tools as ListedTool[] | undefined;
    if (!Array.isArray(tools)) throw new Error(`${plane} plane returned no tools array from tools/list`);
    surfaces.push({ plane, tools: fingerprintTools(tools) });
  }
  return surfaces;
}

// ---------------------------------------------------------------------------- diffing

export function diffSurfaces(first: ToolFingerprint[], second: ToolFingerprint[]): SurfaceDiff {
  const firstByName = new Map(first.map((tool) => [tool.name, tool]));
  const secondByName = new Map(second.map((tool) => [tool.name, tool]));
  const changed: SurfaceDiff["changed"] = [];

  for (const [name, tool] of firstByName) {
    const other = secondByName.get(name);
    if (!other) continue;
    if (tool.description !== other.description) {
      changed.push({ name, field: "description", first: tool.description, second: other.description });
    }
    if (tool.inputSchemaHash !== other.inputSchemaHash) {
      changed.push({ name, field: "inputSchema", first: tool.inputSchemaHash, second: other.inputSchemaHash });
    }
  }

  return {
    onlyInFirst: [...firstByName.keys()].filter((name) => !secondByName.has(name)).sort(),
    onlyInSecond: [...secondByName.keys()].filter((name) => !firstByName.has(name)).sort(),
    changed
  };
}

export const isClean = (diff: SurfaceDiff): boolean =>
  diff.onlyInFirst.length === 0 && diff.onlyInSecond.length === 0 && diff.changed.length === 0;

// Aliases are resolvable but deliberately absent from tools/list, so surface parity cannot see
// them. A tools/call for an alias must not come back "Unknown tool" on either plane. Any other
// error (a validation failure from calling with empty arguments) means the alias DID resolve,
// which is all this check cares about.
export async function checkAliasParity(): Promise<string[]> {
  const failures: string[] = [];
  for (const alias of Object.keys(DEPRECATED_TOOL_ALIASES)) {
    for (const { plane, send } of planes) {
      const response = await send(callToolRequest(alias));
      const message = String(response?.error?.message ?? "");
      if (message.startsWith("Unknown tool")) failures.push(`${plane}: alias "${alias}" does not resolve (${message})`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------- manifest

export const buildManifest = (tools: ToolFingerprint[]): Manifest => ({
  version: "mcp_tool_manifest.v1",
  note: "Generated by scripts/twoPlaneDrift.ts. The wire-facing MCP tool surface shared by the Netlify and Cloud Run planes. Regenerate deliberately with `npm run drift:update` when a tool is intentionally added, removed, or reshaped.",
  toolCount: tools.length,
  surfaceHash: surfaceHash(tools),
  aliases: { ...DEPRECATED_TOOL_ALIASES },
  tools
});

const readManifest = async (): Promise<Manifest | null> => {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

// ---------------------------------------------------------------------------- reporting

const reportEnvScoping = (): string[] => {
  const raw = (process.env.MCP_EXPOSED_TOOL_PREFIXES ?? "").trim();
  if (!raw) return [];
  delete process.env.MCP_EXPOSED_TOOL_PREFIXES;
  return [`MCP_EXPOSED_TOOL_PREFIXES was set ("${raw}") and has been cleared for this run — the detector compares the FULL catalog. Per-plane scoping is a deployment concern, not a code difference.`];
};

const printDiff = (label: string, diff: SurfaceDiff): void => {
  console.error(`\n  ${label}`);
  for (const name of diff.onlyInFirst) console.error(`    - only in first:  ${name}`);
  for (const name of diff.onlyInSecond) console.error(`    + only in second: ${name}`);
  for (const change of diff.changed) {
    console.error(`    ~ ${change.name} (${change.field}):`);
    console.error(`        first:  ${change.first}`);
    console.error(`        second: ${change.second}`);
  }
};

export async function main(argv: string[]): Promise<number> {
  const write = argv.includes("--write");
  process.env.MCP_API_TOKEN = DRIFT_TOKEN;
  const warnings = reportEnvScoping();
  for (const warning of warnings) console.warn(`warning: ${warning}`);

  const [netlify, cloudRun] = await readPlaneSurfaces();
  let failed = false;

  // 1. Plane parity.
  const planeDiff = diffSurfaces(netlify.tools, cloudRun.tools);
  if (isClean(planeDiff)) {
    console.log(`plane parity      ok   ${netlify.tools.length} tools identical on netlify and cloud-run`);
  } else {
    failed = true;
    console.error("plane parity      DRIFT  netlify (first) vs cloud-run (second)");
    printDiff("the two planes no longer serve the same tool surface:", planeDiff);
  }

  // 2. Manifest lock.
  const manifest = await readManifest();
  if (write) {
    const next = buildManifest(netlify.tools);
    await writeFile(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`manifest          written  ${next.toolCount} tools, surfaceHash ${next.surfaceHash.slice(0, 12)}…`);
    return failed ? 1 : 0;
  }
  if (!manifest) {
    failed = true;
    console.error("manifest lock     MISSING  docs/mcp-tool-manifest.json does not exist — run `npm run drift:update`");
  } else {
    const manifestDiff = diffSurfaces(manifest.tools, netlify.tools);
    const aliasDrift = stableStringify(manifest.aliases ?? {}) !== stableStringify(DEPRECATED_TOOL_ALIASES);
    if (isClean(manifestDiff) && !aliasDrift) {
      console.log(`manifest lock     ok   surfaceHash ${manifest.surfaceHash.slice(0, 12)}…`);
    } else {
      failed = true;
      console.error("manifest lock     DRIFT  manifest (first) vs live surface (second)");
      if (!isClean(manifestDiff)) printDiff("the served tool surface no longer matches the checked-in manifest:", manifestDiff);
      if (aliasDrift) {
        console.error("\n    ~ deprecated tool aliases changed:");
        console.error(`        manifest: ${stableStringify(manifest.aliases ?? {})}`);
        console.error(`        live:     ${stableStringify(DEPRECATED_TOOL_ALIASES)}`);
      }
      console.error("\n  If this change is intentional, run `npm run drift:update` and commit the manifest.");
    }
  }

  // 3. Alias parity.
  const aliasFailures = await checkAliasParity();
  if (aliasFailures.length === 0) {
    console.log(`alias parity      ok   ${Object.keys(DEPRECATED_TOOL_ALIASES).length} deprecated aliases resolve on both planes`);
  } else {
    failed = true;
    console.error("alias parity      DRIFT");
    for (const failure of aliasFailures) console.error(`    - ${failure}`);
  }

  return failed ? 1 : 0;
}

// Only self-execute when run directly (`tsx scripts/twoPlaneDrift.ts`), so the pure helpers above
// stay importable from tests without triggering a process exit.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error("two-plane drift detector failed to run:");
      console.error(error);
      process.exitCode = 1;
    });
}
