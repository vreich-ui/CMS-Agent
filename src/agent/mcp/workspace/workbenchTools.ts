import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import { listRunSummariesPage, resolveConductorNodes, runModeSummary } from "../../workspace/executor.js";
import { listRegisteredWorkflowIds, lookupWorkflow } from "../../workspace/workflowRegistry.js";
import { summarizeWorkspaceNodes } from "../../workspace/nodeProjection.js";

// W3 — one verb for the Workbench's first paint.
//
// A cold paint fired FIFTEEN verbs (workbench/contracts/first-paint.json): four whole graphs, three
// of them only so the workflow menu could print `.nodes.length`; a 310 KB flat node list and a
// 20-row run page fired by a command palette that was not open; the whole skill catalogue for a row
// of chips; and five per-node reads for a tab nobody had chosen yet. Five of the fifteen took
// 12-24 s each. Nothing about that is a client bug in isolation — each query is individually
// reasonable — but together they are a page that cannot paint.
//
// The budget this verb exists to hit: <= 2 verb calls and <= 40 KB before the rail is interactive.
// Everything here is read through W1's cached reads and W2's projections, so the whole answer is
// one workspace-document refresh plus one run-index read.
//
// What is deliberately NOT here:
//   * prompts, schemas, tools, skills — the inspector fetches the ONE node a user opened.
//   * `constellation.get_attention` itself. That verb opens run records to cite evidence; the badge
//     only needs counts, and counts come off the index for free. The full list is fetched when the
//     operator expands the strip, which is the moment they have asked for it.
//   * phases. There is no server-side phase — see nodeProjection.ts.

const ATTENTION_STATUSES = ["running", "paused", "blocked", "failed"] as const;

const bootstrapInput = z.object({
  workflowId: z.string().min(1).optional(),
  /** Rows for the rail's recent-runs strip. The rail draws five. */
  recentRunLimit: z.number().int().min(0).max(20).optional()
}).strict();

const bootstrapJsonSchema = objectSchema({
  workflowId: { type: "string", minLength: 1, description: "The workflow whose graph and recent runs to include. Omit to get the registry and the attention counts without a graph — the shape a client uses when it has not chosen a workflow yet." },
  recentRunLimit: { type: "integer", minimum: 0, maximum: 20, description: "Recent run rows to include for that workflow; default 5, 0 to omit them." }
});

export function createWorkbenchTools(deps: { workspaceRepository: WorkspaceRepository; executionRepository: ExecutionRepository }): WorkspaceTool[] {
  const { workspaceRepository, executionRepository } = deps;

  /**
   * Counts off the run index, with no run record opened. `matchedCount` is the honest total for
   * the filter — not the size of a window — which is exactly what a badge needs and what counting
   * rows in a page has repeatedly got wrong on this surface.
   */
  const attentionCounts = async (workflowId?: string): Promise<Record<string, number>> => {
    const entries = await Promise.all(ATTENTION_STATUSES.map(async (status) => {
      const page = await listRunSummariesPage({ status, limit: 1, ...(workflowId ? { workflowId } : {}) }, executionRepository);
      return [status, page.page.matchedCount] as const;
    }));
    return Object.fromEntries(entries);
  };

  return [
    tool({
      name: "workbench.bootstrap",
      description: "Everything the Conductor Workbench needs to paint, in one call: `registeredWorkflowIds` (every workflow this build actually registers — the client's own catalog is presentation config and may not know all of them), `graph` (the requested workflow's nodes in the `detail: \"summary\"` projection plus its edges — see workspace.get_graph), `recentRuns` (the newest summary rows for that workflow, carrying nodeStatuses, with the `modes` map they reference), `attentionCounts` (how many runs are running/paused/blocked/failed, counted off the run index with no run record opened) and `workspaceVersion` (the client's cache-invalidation key — an unchanged version means a persisted client cache is still current). Read-only. Every part is a projection of a verb that still exists on its own; this is one round trip instead of a dozen, not a new source of truth.",
      zodSchema: bootstrapInput,
      inputSchema: bootstrapJsonSchema,
      execute: async (input) => {
        const data = bootstrapInput.parse(input);
        const registeredWorkflowIds = listRegisteredWorkflowIds();
        const recentRunLimit = data.recentRunLimit ?? 5;

        // An unregistered workflowId is REPORTED, never substituted — the same rule
        // resolveConductorNodes enforces (workflowRegistry.ts's R1b note). A client whose catalog
        // is out of date gets the registry back and can recover; it does not get a different
        // workflow's graph under the name it asked for.
        const known = data.workflowId ? lookupWorkflow(data.workflowId).found : false;
        const nodes = data.workflowId && known ? await resolveConductorNodes(workspaceRepository, data.workflowId) : [];
        const graph = data.workflowId && known
          ? {
              workflowId: data.workflowId,
              nodes: summarizeWorkspaceNodes(nodes),
              edges: nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id }))),
              detail: "summary" as const
            }
          : null;

        const modes: Record<string, ReturnType<typeof runModeSummary>> = {};
        const modeKeys = new Map<string, string>();
        const internMode = (mode: ReturnType<typeof runModeSummary>): string => {
          const fingerprint = JSON.stringify(mode);
          const existing = modeKeys.get(fingerprint);
          if (existing) return existing;
          const ref = `m${modeKeys.size}`;
          modeKeys.set(fingerprint, ref);
          modes[ref] = mode;
          return ref;
        };

        const recent = recentRunLimit > 0 && data.workflowId && known
          ? await listRunSummariesPage({ workflowId: data.workflowId, limit: recentRunLimit }, executionRepository)
          : { rows: [], page: { limit: recentRunLimit, matchedCount: 0, hasMore: false } };

        // Node counts for EVERY registered workflow. The Workbench's workflow menu and its deck
        // both print "N nodes", and before this each of them fetched a whole graph per workflow to
        // read `.nodes.length` — three graph downloads on the first paint of a screen that shows
        // one. Every resolution here reads the SAME cached workspace document (W1), so the cost is
        // the canonical overlay merge, not I/O, and the answer is eight integers.
        const nodeCounts = Object.fromEntries(await Promise.all(registeredWorkflowIds.map(async (id) => {
          try { return [id, (await resolveConductorNodes(workspaceRepository, id)).length] as const; }
          catch { return [id, 0] as const; }
        })));

        return ok({
          registeredWorkflowIds,
          nodeCounts,
          ...(data.workflowId && !known ? { unknownWorkflowId: data.workflowId } : {}),
          graph,
          recentRuns: recent.rows.map(({ stallFacts: _stallFacts, ...row }) => ({ ...row, modeRef: internMode(runModeSummary(row)) })),
          modes,
          recentRunsMatchedCount: recent.page.matchedCount,
          attentionCounts: await attentionCounts(),
          workspaceVersion: await workspaceRepository.getWorkspaceVersion()
        });
      }
    })
  ];
}
