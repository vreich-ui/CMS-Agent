// T12.11 — `site.duplicate` / `site.duplicate_status`: the ONE-CALL composite entry point R-C5
// rules the product to be. One MCP call takes a source URL (+ an existing target project, or a
// newSite genesis request), provisions-or-targets the landing site, starts the capture_conductor
// workflow, and KICKS the long-run plane — no second MCP round-trip between "start" and "run"
// (the exact two-call gap workflow.start_dry_run + workflow.run_all left open).
//
// WHAT "KICK" MEANS, precisely: after start_dry_run this tool advances the run in-call while nodes
// are COMPLETING, and stops the moment an advance makes no forward progress — which on a capture
// run is the crawl node parking as a pending pdf-tool job. From that moment the work is owned by
// the long-run planes (the Cloud Run conductor job / the run-continuation tick, which re-enters
// every queued/running run each minute with no operator action): polling a 15-minute crawl job
// inside this tool's own request window is exactly what R-C3's 30s-cap constraint forbids, so the
// tool never spins on a poll — the same law capture_crawl's own one-create-or-poll contract keeps.
//
// AUTHORIZATION, unchanged from T12.9: the target's registry ProjectCapturePolicy is THE authority
// (deny-all default refuses; nothing a caller passes can widen a bound), the emission transport's
// forbidden-verb set keeps publish/release/build/deploy unreachable, and this tool never passes
// `approved` to any advance. Genesis actions are audited on the ledger persisted with the run.
//
// CATALOGUED REFUSALS (each test-pinned):
//   duplicate_target_unreachable — unknown/disabled target, endpoint env unconfigured, or the
//                                  target's MCP initialize failing (the adapter's sanitized error
//                                  says which).
//   capture_policy_denies        — the registry policy does not authorize capture (deny-all
//                                  default included); from resolveCaptureAuthority, passed through.
//   capture_source_out_of_policy / capture_source_invalid — sourceUrl outside the target's bounds.
//   netlify_token_missing        — newSite genesis without the standing NETLIFY_API_TOKEN
//                                  prerequisite configured (by NAME) in this deployment.
//   budget_exceeded              — budgetUsd below the workflow's entry-node reservation: the run
//                                  would pause for budget before dispatching ANY node.
//   unknown_run                  — site.duplicate_status for a run that does not exist.

import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import { DEFAULT_EXECUTION_MODE, assessRunStall, getRun, runModeSummary, runNextNode, startDryRun } from "../../workspace/executor.js";
import { HALTED_EXECUTION_STATUSES, type WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { summarizeRunCost } from "../../workspace/conductor.js";
import { summarizeModelUsage } from "../../observability/modelUsage.js";
import { CAPTURE_CONDUCTOR_WORKFLOW_ID } from "../../workspace/captureConductorWorkflow.js";
import { getWorkflowDefinition } from "../../workspace/workflowRegistry.js";
import { CAPTURE_ARTIFACTS, assertSourceWithinPolicy, resolveCaptureAuthority } from "../../capture/captureEngine.js";
import { ProjectMcpAdapter, toConnectionState } from "../../projects/projectMcpAdapter.js";
import { registryEndpointSchema } from "../../projects/projectAdmin.js";
import { runSiteGenesis, type GenesisHumanChecklistItem, type SiteGenesisResult } from "../../capture/siteGenesis.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import type { UsageRepository } from "../../repository/interfaces/UsageRepository.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";

export class SiteDuplicationRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SiteDuplicationRefusal";
  }
}

// The duplication request record persisted on the run (":"-suffixed so it can never collide with a
// node id in stageOutputs — the CAPTURE_CRAWL_JOB_STAGE_KEY precedent). site.duplicate_status reads
// it back for the outstanding human items and the genesis audit ledger.
export const SITE_DUPLICATION_REQUEST_STAGE_KEY = "site_duplicate:request";

// In-call kick budget: a safety ceiling on the advance burst, well under every platform request
// ceiling. The burst normally ends much earlier — at the first no-progress advance.
const KICK_TIME_BUDGET_MS = (() => {
  const configured = Number(process.env.SITE_DUPLICATE_KICK_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60_000;
})();
const KICK_MAX_STEPS = 60;

const newSiteSchema = z.object({
  name: z.string().min(2).max(63),
  netlifySiteName: z.string().min(2).max(63).optional(),
  // Optional endpoint override. Omit it on the normal path: genesis DERIVES the tenant's endpoint
  // from the Netlify site it just created and stores it on the registry record, so a minted tenant
  // needs no <SLUG>_MCP_ENDPOINT anywhere. Validated credential-free (https, no user:password@, no
  // query, no fragment) by the same schema project.create uses — the registry can still never hold
  // a credential, and the TOKEN is untouched: env var NAME only, as always.
  mcpEndpoint: registryEndpointSchema.optional()
}).strict();

const duplicateInput = z.object({
  sourceUrl: z.string().url(),
  targetProjectId: z.string().min(1).optional(),
  newSite: newSiteSchema.optional(),
  budgetUsd: z.number().nonnegative().optional(),
  executionMode: z.enum(["mock", "openai"]).default(DEFAULT_EXECUTION_MODE)
}).strict().refine((value) => (value.targetProjectId === undefined) !== (value.newSite === undefined), {
  message: "supply exactly one of `targetProjectId` (duplicate into an existing registered project) or `newSite` (genesis: provision a new landing tenant first)"
});

const duplicateStatusInput = z.object({ runId: z.string().min(1) }).strict();

const duplicateJsonSchema = objectSchema({
  sourceUrl: { type: "string", format: "uri", description: "HTTPS source to duplicate. Must fall inside the target project's capturePolicy (allowed origins/path prefixes); an out-of-policy source is refused before any run is created." },
  targetProjectId: { type: "string", minLength: 1, description: "Existing registered project to land the duplication in. Verified reachable (MCP initialize) and capture-authorized (registry capturePolicy; the deny-all default refuses). Mutually exclusive with newSite." },
  newSite: objectSchema({
    name: { type: "string", minLength: 2, description: "Lowercase kebab-case slug for the new tenant (repo tree sites/<name>/, registry projectId, <NAME>_MCP_* env var names)." },
    netlifySiteName: { type: "string", minLength: 2, description: "Optional Netlify site name (the <name> in <name>.netlify.app) when it must differ from the slug." },
    mcpEndpoint: { type: "string", format: "uri", maxLength: 512, description: "Optional override for the new tenant's MCP endpoint, stored on its registry record (https, no credentials/query/fragment — an endpoint is not a secret, the token still is). OMIT IT normally: genesis derives the endpoint from the Netlify site it just creates, so no endpoint has to be set by hand anywhere. Use it only when the tenant serves /mcp from a custom domain from day one." }
  }, ["name"]),
  budgetUsd: { type: "number", minimum: 0, description: "Optional per-run cost ceiling in USD (workflow.start_dry_run semantics). Refused as budget_exceeded when below the workflow's entry-node reservation — such a run could never dispatch its first node." },
  executionMode: { type: "string", enum: ["mock", "openai"], default: DEFAULT_EXECUTION_MODE, description: "Passed through to the run. \"mock\" is the cheap CI/test mode; deterministic capture stages run real engine code either way." }
}, ["sourceUrl"]);

const duplicateStatusJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 } }, ["runId"]);

// The reservation the executor's budget gate will demand before dispatching the workflow's first
// node. A budgetUsd below it can never run anything — refuse at the door instead of minting a run
// that is born blocked.
const entryNodeReservationUsd = (): { nodeId: string; reservationUsd: number } => {
  const definition = getWorkflowDefinition(CAPTURE_CONDUCTOR_WORKFLOW_ID);
  const nodes = definition?.canonicalNodes() ?? [];
  const entry = nodes.find((node) => node.dependsOn.length === 0);
  const declared = entry?.modelConfig && typeof (entry.modelConfig as Record<string, unknown>).budgetUsd === "number"
    ? ((entry.modelConfig as Record<string, unknown>).budgetUsd as number)
    : 0;
  return { nodeId: entry?.id ?? "unknown", reservationUsd: declared };
};

type DuplicationRequestRecord = {
  artifact: "site_duplication.v1";
  requestedAt: string;
  sourceUrl: string;
  targetProjectId: string;
  statusTool: "site.duplicate_status";
  humanChecklist: GenesisHumanChecklistItem[];
  genesis?: {
    netlifyMode: SiteGenesisResult["netlifyMode"];
    netlifySiteName: string;
    netlifySiteId?: string;
    envVarNames: SiteGenesisResult["envVarNames"];
    // The endpoint genesis registered on the record (derived, or caller-supplied). Not a secret.
    mcpEndpoint: string;
    ledger: SiteGenesisResult["ledger"];
  };
};

const settledCount = (run: WorkflowExecutionRecord): number =>
  run.nodes.filter((node) => node.status === "completed" || node.status === "skipped" || node.status === "failed").length;

export type SiteDuplicationToolDeps = {
  executionRepository: ExecutionRepository;
  workspaceRepository: WorkspaceRepository;
  projectRepository: ProjectRepository;
  usageRepository: UsageRepository;
};

export function createSiteDuplicationTools(deps: SiteDuplicationToolDeps): WorkspaceTool[] {
  const { executionRepository, workspaceRepository, projectRepository, usageRepository } = deps;

  // Existing-target reachability: registered + active + endpoint env configured + a real MCP
  // initialize answering. Every failure mode names itself inside ONE catalogued code.
  const verifyTargetReachable = async (projectId: string): Promise<void> => {
    const config = await projectRepository.get(projectId);
    if (!config) {
      throw new SiteDuplicationRefusal("duplicate_target_unreachable", `Unknown targetProjectId "${projectId}" — no such project is registered. Register it via project.create (with a capturePolicy) or use newSite for genesis.`);
    }
    if (config.status === "disabled") {
      throw new SiteDuplicationRefusal("duplicate_target_unreachable", `Target project "${projectId}" is disabled; re-enable it (project.update status:"active") before duplicating into it.`);
    }
    const connection = await new ProjectMcpAdapter(config).testConnection();
    if (!connection.ok) {
      throw new SiteDuplicationRefusal("duplicate_target_unreachable", `Target project "${projectId}" is not reachable: ${connection.error ?? "MCP initialize failed"}. (Endpoint/token are read from ${config.mcpEndpointEnvVar}${config.tokenEnvVar ? ` / ${config.tokenEnvVar}` : ""} — values never transit MCP.)`);
    }
  };

  // The in-call kick: advance while nodes settle; stop at the first no-progress advance (the crawl
  // job parking on the pdf-tool plane), a halted status, the step cap, or the time budget. Never
  // passes `approved`.
  const kickRun = async (runId: string): Promise<{ steps: number; stoppedBecause: string; run: WorkflowExecutionRecord }> => {
    const deadline = Date.now() + KICK_TIME_BUDGET_MS;
    let run = (await getRun(runId, executionRepository))!;
    let steps = 0;
    let stoppedBecause = "run_halted";
    while (!HALTED_EXECUTION_STATUSES.has(run.status)) {
      if (steps >= KICK_MAX_STEPS) { stoppedBecause = "kick_step_cap"; break; }
      if (Date.now() > deadline) { stoppedBecause = "kick_time_budget"; break; }
      const before = settledCount(run);
      run = await runNextNode(runId, { executionRepository, workspaceRepository });
      steps += 1;
      if (!HALTED_EXECUTION_STATUSES.has(run.status) && settledCount(run) <= before) {
        // No node settled on this advance: the run is parked on external work (a pending pdf-tool
        // capture job). The long-run planes own it from here — the run-continuation tick re-enters
        // every queued/running run each minute; polling here would spin inside one request window.
        stoppedBecause = "handed_to_long_run_plane";
        break;
      }
    }
    return { steps, stoppedBecause, run };
  };

  return [
    tool({
      name: "site.duplicate",
      description: "ONE CALL: duplicate a source site into a landing tenant with the capture_conductor workflow (crawl → map → theme → emit never-released drafts → score → report). With targetProjectId: verifies the existing project is reachable and capture-authorized (registry capturePolicy — the deny-all default refuses). With newSite: runs genesis first, automated to the limit of account authority (create-site scaffold via the platform seam, Netlify site + build hook + deterministic env defaults under NETLIFY_API_TOKEN — dry-run mode records instead of calling; project.create registration with the tenant's MCP endpoint DERIVED from the site just created and stored on its record — so no <SLUG>_MCP_ENDPOINT is ever set by hand — and the bearer token by env var NAME only), and returns the human checklist for everything past that limit — surfaced verbatim from the provisioning runbook, never silently skipped. Starts the run AND kicks the long-run plane in the same call (no second MCP round-trip); a pending crawl is then re-driven by the conductor job / run-continuation tick. Returns {runId, statusTool, humanChecklist}. Publish/release stay unreachable from every capture node; no secret VALUE ever transits this tool.",
      zodSchema: duplicateInput,
      inputSchema: duplicateJsonSchema,
      execute: async (input) => {
        const data = duplicateInput.parse(input);
        const requestedAt = new Date().toISOString();

        // 1. Target resolution.
        let genesis: SiteGenesisResult | undefined;
        let targetProjectId: string;
        let humanChecklist: GenesisHumanChecklistItem[] = [];
        if (data.newSite) {
          genesis = await runSiteGenesis({ name: data.newSite.name, netlifySiteName: data.newSite.netlifySiteName, mcpEndpoint: data.newSite.mcpEndpoint, sourceUrl: data.sourceUrl }, { projectRepository });
          targetProjectId = genesis.projectId;
          humanChecklist = genesis.humanChecklist;
        } else {
          targetProjectId = data.targetProjectId!;
          await verifyTargetReachable(targetProjectId);
        }

        // 2. Capture authority + source bounds — refused BEFORE any run exists. resolveCaptureAuthority
        // re-reads the registry policy server-side (deny-all default refuses; a caller cannot widen a
        // bound), exactly as every capture stage will again at execution time.
        const { policy } = await resolveCaptureAuthority(targetProjectId, { projectRepository });
        assertSourceWithinPolicy(data.sourceUrl, policy);

        // 3. Budget floor: a ceiling below the entry node's reservation blocks before ANY dispatch.
        if (data.budgetUsd !== undefined) {
          const entry = entryNodeReservationUsd();
          if (data.budgetUsd < entry.reservationUsd) {
            throw new SiteDuplicationRefusal("budget_exceeded", `budgetUsd $${data.budgetUsd} is below the workflow's entry-node reservation ($${entry.reservationUsd} for ${entry.nodeId}): the run would pause for budget before dispatching any node and could never make progress. Supply at least $${entry.reservationUsd}, or omit budgetUsd for no ceiling.`);
          }
        }

        // 4. Start — the same startDryRun workflow.start_dry_run drives, with the capture input shape.
        const started = await startDryRun(
          { projectId: targetProjectId, workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID, executionMode: data.executionMode, input: { sourceUrl: data.sourceUrl, targetProjectId }, budgetUsd: data.budgetUsd },
          executionRepository
        );

        // 5. Persist the duplication request (checklist + genesis audit ledger) ON the run, before any
        // advance, so site.duplicate_status can answer from the record alone.
        const record: DuplicationRequestRecord = {
          artifact: "site_duplication.v1",
          requestedAt,
          sourceUrl: data.sourceUrl,
          targetProjectId,
          statusTool: "site.duplicate_status",
          humanChecklist,
          ...(genesis ? {
            genesis: {
              netlifyMode: genesis.netlifyMode,
              netlifySiteName: genesis.netlifySiteName,
              ...(genesis.netlifySiteId ? { netlifySiteId: genesis.netlifySiteId } : {}),
              envVarNames: genesis.envVarNames,
              mcpEndpoint: genesis.mcpEndpoint,
              ledger: genesis.ledger
            }
          } : {})
        };
        const fresh = (await getRun(started.runId, executionRepository))!;
        await executionRepository.saveRun({ ...fresh, stageOutputs: { ...fresh.stageOutputs, [SITE_DUPLICATION_REQUEST_STAGE_KEY]: record }, updatedAt: new Date().toISOString() });

        // 6. Kick the long-run plane — same call, no second MCP round-trip.
        const kick = await kickRun(started.runId);

        return ok({
          runId: started.runId,
          statusTool: "site.duplicate_status",
          humanChecklist,
          run: {
            runId: kick.run.runId,
            projectId: kick.run.projectId,
            workflowId: kick.run.workflowId,
            status: kick.run.status,
            currentNodeId: kick.run.currentNodeId ?? null,
            mode: runModeSummary(kick.run)
          },
          kick: {
            steps: kick.steps,
            stoppedBecause: kick.stoppedBecause,
            note: kick.stoppedBecause === "handed_to_long_run_plane"
              ? "The crawl job is created on the pdf-tool plane and the run is parked pending its completion; the long-run planes (Cloud Run conductor job / run-continuation tick) re-drive it to the terminal report with no further MCP call. Observe via site.duplicate_status."
              : "Observe progress and outstanding human items via site.duplicate_status."
          },
          ...(genesis ? {
            genesis: {
              projectId: genesis.projectId,
              netlifyMode: genesis.netlifyMode,
              netlifySiteName: genesis.netlifySiteName,
              ...(genesis.netlifySiteId ? { netlifySiteId: genesis.netlifySiteId } : {}),
              envVarNames: genesis.envVarNames,
              ledger: genesis.ledger
            }
          } : {})
        });
      }
    }),

    tool({
      name: "site.duplicate_status",
      description: "Observe a site.duplicate run: run state (+ stall assessment), per-node progress, spend (cost ledger + budget), the capture report references (emission plan, drafts, fidelity, gaps, terminal run report), and the outstanding human checklist items — with the deploy-side item resolved live against the project's resolved connection (env var name + which source answers the endpoint; never a value). Read-only.",
      zodSchema: duplicateStatusInput,
      inputSchema: duplicateStatusJsonSchema,
      execute: async (input) => {
        const { runId } = duplicateStatusInput.parse(input);
        const run = await getRun(runId, executionRepository);
        if (!run) throw new SiteDuplicationRefusal("unknown_run", `No run "${runId}" exists.`);
        const request = run.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY] as DuplicationRequestRecord | undefined;

        const usage = await summarizeModelUsage({ runId }, usageRepository);
        const ledger = summarizeRunCost(run, usage);

        const stageRef = (nodeId: string, artifact: string) => {
          const value = run.stageOutputs[nodeId] as Record<string, unknown> | undefined;
          const present = !!value && value.artifact === artifact;
          return { stage: nodeId, artifact, present, ...(present && typeof value!.summary === "string" ? { summary: value!.summary as string } : {}) };
        };
        const reportRefs = {
          emissionPlan: stageRef("capture_emit_dry", CAPTURE_ARTIFACTS.emissionPlan),
          drafts: stageRef("capture_emit_live", CAPTURE_ARTIFACTS.emissionRun),
          fidelity: stageRef("capture_score", CAPTURE_ARTIFACTS.fidelity),
          gapAdjudication: stageRef("gap_adjudicator", CAPTURE_ARTIFACTS.adjudication),
          runReport: stageRef("capture_report", CAPTURE_ARTIFACTS.report)
        };

        // Outstanding human items: everything on the checklist stays listed until a human confirms —
        // except the items this system can OBSERVE (the deploy-side env NAMES), which resolve live.
        const config = await projectRepository.get(run.projectId);
        const connection = config ? toConnectionState(config) : undefined;
        const humanItems = (request?.humanChecklist ?? []).map((item) => {
          if (item.id === "deploy_side_mcp_env" && connection) {
            // endpointConfigured is true when EITHER source resolves — the env var or the endpoint
            // genesis stored on the record — so for a freshly minted tenant this item reduces to
            // "is the token in place yet?". endpointSource says which answered.
            const satisfied = connection.endpointConfigured && connection.tokenConfigured;
            return { ...item, status: satisfied ? "satisfied" : "outstanding", observed: { endpointConfigured: connection.endpointConfigured, endpointSource: connection.endpointSource, tokenConfigured: connection.tokenConfigured } };
          }
          return { ...item, status: "outstanding" as const };
        });

        return ok({
          runId,
          statusTool: "site.duplicate_status",
          state: {
            status: run.status,
            currentNodeId: run.currentNodeId ?? null,
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
            ...(run.completedAt ? { completedAt: run.completedAt } : {}),
            mode: runModeSummary(run),
            stall: assessRunStall(run) ?? null,
            approvalsRequired: run.approvalsRequired,
            ...(run.budgetBlock ? { budgetBlock: run.budgetBlock } : {}),
            errors: run.errors
          },
          nodes: run.nodes.map((node) => ({
            nodeId: node.nodeId,
            status: node.status,
            ...(typeof node.durationMs === "number" ? { durationMs: node.durationMs } : {}),
            ...(node.warnings?.length ? { warnings: node.warnings } : {}),
            ...(node.skip ? { skip: { reason: node.skip.reason } } : {})
          })),
          spend: { ledger },
          reports: reportRefs,
          request: request
            ? { sourceUrl: request.sourceUrl, targetProjectId: request.targetProjectId, requestedAt: request.requestedAt, ...(request.genesis ? { genesis: request.genesis } : {}) }
            : null,
          outstandingHumanItems: humanItems,
          humanGate: { publishReachable: false, note: "Everything this run writes is a never-released draft; the workflow ends at the report. Publication is a separate, explicitly human-gated act (T12.6-class acceptance is Wolf's disposition)." }
        });
      }
    })
  ];
}
