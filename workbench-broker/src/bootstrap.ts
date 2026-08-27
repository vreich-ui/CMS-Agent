/**
 * GET /api/bootstrap composition (Track A, A2).
 *
 * One round trip for the shell to paint: workflows, each conductor's graph,
 * a lightweight node summary list, recent runs, and the attention feed —
 * built server-side from a SINGLE batched JSON-RPC array request to the
 * upstream MCP workspace (see mcp.ts's `callToolsBatch`), not five
 * sequential round trips.
 *
 * Degrades gracefully: any one component verb failing sets that response
 * key to `null` and records why in `errors`, but never fails the whole
 * response — see `constellation_get_attention`, which is confirmed broken
 * upstream today (workbench/contracts/README.md Finding #4, an Anthropic
 * proxy `-32600 Invalid content from server` error on every call in this
 * workspace) and MUST come back as `attention: null` plus
 * `errors.attention`, not as a failed bootstrap.
 *
 * The three workflow ids are the three conductors this workspace has today
 * (workbench/contracts/README.md's node table: `publishing_conductor`,
 * `capture_conductor`, `clone_conductor`). There is no verb that enumerates
 * workflows on its own — `workspace_get_graph({})`'s own
 * `registeredWorkflowIds` field is preferred when present (so a fourth
 * conductor added later is picked up with no code change here), and this
 * list is only the fallback for when that field is absent or empty.
 */

import type { McpClient } from "./mcp.js";
import { READ_TIMEOUT_MS } from "./mcp.js";

export const KNOWN_WORKFLOW_IDS = ["publishing_conductor", "capture_conductor", "clone_conductor"] as const;
const RECENT_RUNS_LIMIT = 10;

export interface BootstrapWorkflow {
  id: string;
  nodeCount: number | null;
  edgeCount: number | null;
}

export interface BootstrapGraph {
  nodes: unknown[];
  edges: unknown[];
}

export interface BootstrapNodeSummary {
  id: string;
  name: string;
  kind: string;
  description: string;
}

export interface BootstrapResponse {
  workflows: BootstrapWorkflow[] | null;
  graphs: Record<string, BootstrapGraph | null>;
  nodeSummaries: BootstrapNodeSummary[] | null;
  recentRuns: unknown[] | null;
  attention: unknown[] | null;
  workspaceVersion: string;
  capturedAt: string;
  errors?: Record<string, string>;
}

function summarizeNode(raw: unknown): BootstrapNodeSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== "string") return null;
  return {
    id: n.id,
    name: typeof n.name === "string" ? n.name : n.id,
    kind: typeof n.kind === "string" ? n.kind : "",
    description: typeof n.description === "string" ? n.description : "",
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Normalizes whatever shape `constellation_get_attention` eventually settles on (a bare array,
 *  or `{items:[...]}` per its sibling list verbs) into a plain array. Currently moot in practice —
 *  the verb fails outright upstream — but keeps this composer correct once B4 fixes it. */
function normalizeAttention(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: unknown[] }).items;
  }
  return [];
}

export interface ComposeBootstrapOptions {
  timeoutMs?: number;
  /** Opaque generation stamp to echo back as `workspaceVersion` — owned by the caller's cache
   *  (see cache.ts), not this module; this composer has no notion of workspace freshness itself. */
  workspaceVersion: string;
}

export async function composeBootstrap(
  mcpClient: Pick<McpClient, "callToolsBatch">,
  opts: ComposeBootstrapOptions
): Promise<BootstrapResponse> {
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;

  const calls = [
    { verb: "workspace_get_graph", args: {} },
    ...KNOWN_WORKFLOW_IDS.map((id) => ({ verb: "workspace_get_graph", args: { workflowId: id } as Record<string, unknown> })),
    { verb: "workflow_list_runs", args: {} },
    { verb: "constellation_get_attention", args: {} },
  ];

  const results = await mcpClient.callToolsBatch(calls, timeoutMs);
  const errors: Record<string, string> = {};

  const errorOf = (r: (typeof results)[number] | undefined, fallback: string): string =>
    r && !r.ok ? r.error : fallback;

  // --- flat graph -> workflows + nodeSummaries --------------------------------
  const flat = results[0];
  let workflows: BootstrapWorkflow[] | null = null;
  let nodeSummaries: BootstrapNodeSummary[] | null = null;
  if (flat?.ok) {
    const data = flat.data as { nodes?: unknown; registeredWorkflowIds?: unknown } | undefined;
    const nodes = asArray(data?.nodes);
    nodeSummaries = nodes.map(summarizeNode).filter((n): n is BootstrapNodeSummary => n !== null);
    const registered = Array.isArray(data?.registeredWorkflowIds) ? (data!.registeredWorkflowIds as unknown[]) : [];
    const ids = registered.length > 0 ? registered.filter((id): id is string => typeof id === "string") : [...KNOWN_WORKFLOW_IDS];
    workflows = ids.map((id) => ({ id, nodeCount: null, edgeCount: null }));
  } else {
    const message = errorOf(flat, "workspace_get_graph did not return a result.");
    errors.workflows = message;
    errors.nodeSummaries = message;
  }

  // --- per-workflow graphs -----------------------------------------------------
  const graphs: Record<string, BootstrapGraph | null> = {};
  KNOWN_WORKFLOW_IDS.forEach((id, idx) => {
    const r = results[1 + idx];
    if (r?.ok) {
      const data = r.data as { nodes?: unknown; edges?: unknown } | undefined;
      const nodesArr = asArray(data?.nodes);
      const edgesArr = asArray(data?.edges);
      graphs[id] = { nodes: nodesArr, edges: edgesArr };
      const wf = workflows?.find((w) => w.id === id);
      if (wf) {
        wf.nodeCount = nodesArr.length;
        wf.edgeCount = edgesArr.length;
      }
    } else {
      graphs[id] = null;
      errors[`graphs.${id}`] = errorOf(r, `workspace_get_graph({workflowId:"${id}"}) did not return a result.`);
    }
  });

  // --- recent runs --------------------------------------------------------------
  const runsResult = results[1 + KNOWN_WORKFLOW_IDS.length];
  let recentRuns: unknown[] | null = null;
  if (runsResult?.ok) {
    const data = runsResult.data as { runs?: unknown } | undefined;
    recentRuns = asArray(data?.runs).slice(0, RECENT_RUNS_LIMIT);
  } else {
    errors.recentRuns = errorOf(runsResult, "workflow_list_runs did not return a result.");
  }

  // --- attention (expected-flaky upstream verb — see header comment) -----------
  const attentionResult = results[2 + KNOWN_WORKFLOW_IDS.length];
  let attention: unknown[] | null = null;
  if (attentionResult?.ok) {
    attention = normalizeAttention(attentionResult.data);
  } else {
    errors.attention = errorOf(attentionResult, "constellation_get_attention did not return a result.");
  }

  const response: BootstrapResponse = {
    workflows,
    graphs,
    nodeSummaries,
    recentRuns,
    attention,
    workspaceVersion: opts.workspaceVersion,
    capturedAt: new Date().toISOString(),
  };
  if (Object.keys(errors).length > 0) response.errors = errors;
  return response;
}
