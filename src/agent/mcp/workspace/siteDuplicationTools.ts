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
// (deny-all default refuses; nothing a caller passes can widen a bound). trigger_netlify_build and
// deploy stay unreachable from every path, always. publish/release are reachable, since T15.7 (#187),
// through the shared publishing tail this tool's run composes — governed by the project's own
// publishingPolicy.autonomyMode (ADR-2026-08-25-publish-autonomy), never by this tool: it never
// passes `approved` to any advance, and carries no publish/release logic of its own. Genesis actions
// are audited on the ledger persisted with the run.
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
import { DEFAULT_EXECUTION_MODE, assessRunStall, getRun, runModeSummary, startDryRun } from "../../workspace/executor.js";
import { summarizeRunCost } from "../../workspace/conductor.js";
import { summarizeModelUsage } from "../../observability/modelUsage.js";
import { CAPTURE_CONDUCTOR_WORKFLOW_ID } from "../../workspace/captureConductorWorkflow.js";
import { getWorkflowDefinition } from "../../workspace/workflowRegistry.js";
import { CAPTURE_ARTIFACTS, assertSourceWithinPolicy, resolveCaptureAuthority } from "../../capture/captureEngine.js";
import { resolvePublishAuthority } from "../../workspace/publishDecision.js";
import { ProjectMcpAdapter, toConnectionState } from "../../projects/projectMcpAdapter.js";
import { registryEndpointSchema } from "../../projects/projectAdmin.js";
import { runSiteGenesis, type GenesisHumanChecklistItem, type SiteGenesisResult } from "../../capture/siteGenesis.js";
import { kickRun, resolveKickTimeBudgetMs, KICK_MAX_STEPS } from "../../workspace/runKick.js";
import {
  maybeChainCloneAfterCapture,
  SITE_DUPLICATION_REQUEST_STAGE_KEY,
  type DuplicationChainState
} from "../../workspace/siteDuplicationChain.js";
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
// T15.9 (#188): the constant itself now lives in workspace/siteDuplicationChain.ts, which needs it
// too (to find this record from the workspace layer, without the workspace layer importing this MCP
// tool module). Re-exported here so every existing importer of this path keeps resolving it.
export { SITE_DUPLICATION_REQUEST_STAGE_KEY };

// In-call kick budget: a safety ceiling on the advance burst, well under every platform request
// ceiling. The burst normally ends much earlier — at the first no-progress advance.
const KICK_TIME_BUDGET_MS = resolveKickTimeBudgetMs("SITE_DUPLICATE_KICK_BUDGET_MS");

// T15.17 — default budget for site.duplicate. Capture runs ≈$0.125, clone attempts ≈$0.14–$0.18
// per run (T15.9 #188 chains both under one budgetUsd). $5.00 default gives ~17× headroom.
// A fully autonomous duplication should never run uncapped.
const DEFAULT_SITE_DUPLICATE_BUDGET_USD = 5.0;

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
  budgetUsd: { type: "number", minimum: 0, description: `Optional per-run cost ceiling in USD (workflow.start_dry_run semantics); defaults to $${DEFAULT_SITE_DUPLICATE_BUDGET_USD} to ensure every autonomous duplication runs under an explicit ceiling. Refused as budget_exceeded when below the workflow's entry-node reservation — such a run could never dispatch its first node.` },
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
  // T15.9 (#188): the ORIGINAL call's budgetUsd, carried so the chained clone's own ceiling can be
  // derived as "what's left of THIS", not a fresh allowance — see siteDuplicationChain.ts. Absent
  // when the caller never set a ceiling; neither half of the chain gets one invented for it then.
  budgetUsd?: number;
  // T15.9 (#188): written by maybeChainCloneAfterCapture once the capture run reaches a terminal
  // status — "started" (with the clone's own runId) or "refused" (named, never silent). Absent
  // until the capture run halts; site.duplicate_status reports it as `chain`.
  chain?: DuplicationChainState;
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

  // T15.9 (#188): the in-call kick itself now lives in workspace/runKick.ts, shared with the clone
  // half of the chain (siteDuplicationChain.ts) so both kicks obey the identical contract. Bound
  // here to this tool's own configured budget/step cap.
  const kickThisRun = (runId: string) => kickRun(runId, { executionRepository, workspaceRepository }, { timeBudgetMs: KICK_TIME_BUDGET_MS, maxSteps: KICK_MAX_STEPS });

  return [
    tool({
      name: "site.duplicate",
      description: "ONE CALL: duplicate a source site into a landing tenant with the capture_conductor workflow (crawl → map → theme → emit never-released drafts → score → report). With targetProjectId: verifies the existing project is reachable and capture-authorized (registry capturePolicy — the deny-all default refuses). With newSite: runs genesis first: create-site scaffold via the platform seam; Netlify site, build hook and deterministic env under NETLIFY_API_TOKEN; project.create with the tenant MCP endpoint derived from the site; and the Platform-site → Client Manager credential minted internally, persisted only as a digest/policy, installed as secret/function-only Netlify env, verified, and discarded without a human ever handling its value. Remaining account-authority steps are surfaced in the human checklist, never silently skipped. Starts the run AND kicks the long-run plane in the same call. Returns {runId, statusTool, humanChecklist}. Publish/release stay unreachable from every capture node; no secret VALUE ever transits this tool.",
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
        // T15.17: default to $5.00 so every autonomous duplication runs under an explicit ceiling.
        const budgetUsd = data.budgetUsd ?? DEFAULT_SITE_DUPLICATE_BUDGET_USD;
        const entry = entryNodeReservationUsd();
        if (budgetUsd < entry.reservationUsd) {
          throw new SiteDuplicationRefusal("budget_exceeded", `budgetUsd $${budgetUsd} is below the workflow's entry-node reservation ($${entry.reservationUsd} for ${entry.nodeId}): the run would pause for budget before dispatching any node and could never make progress. Supply at least $${entry.reservationUsd}.`);
        }

        // 4. Start — the same startDryRun workflow.start_dry_run drives, with the capture input shape.
        const started = await startDryRun(
          { projectId: targetProjectId, workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID, executionMode: data.executionMode, input: { sourceUrl: data.sourceUrl, targetProjectId }, budgetUsd },
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
          ...(data.budgetUsd !== undefined ? { budgetUsd: data.budgetUsd } : {}),
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
        const kick = await kickThisRun(started.runId);

        // 7. T15.9 (#188) — chain: if the kick alone drove capture all the way to a terminal state
        // (a mock run with nothing to park on), the clone half starts in THIS call too, with no
        // second human-issued workflow.start_dry_run. The normal case — capture parks on the
        // pdf-tool plane — chains later, off the run-continuation tick (runContinuation.ts); see
        // siteDuplicationChain.ts for why both call sites exist and neither races the other.
        const chainOutcome = await maybeChainCloneAfterCapture(kick.run, { executionRepository, workspaceRepository, usageRepository });
        const chainedRun = chainOutcome.action === "chained" || chainOutcome.action === "refused" ? chainOutcome.captureRun : kick.run;

        return ok({
          runId: started.runId,
          statusTool: "site.duplicate_status",
          humanChecklist,
          run: {
            runId: chainedRun.runId,
            projectId: chainedRun.projectId,
            workflowId: chainedRun.workflowId,
            status: chainedRun.status,
            currentNodeId: chainedRun.currentNodeId ?? null,
            mode: runModeSummary(chainedRun)
          },
          kick: {
            steps: kick.steps,
            stoppedBecause: kick.stoppedBecause,
            note: kick.stoppedBecause === "handed_to_long_run_plane"
              ? "The crawl job is created on the pdf-tool plane and the run is parked pending its completion; the long-run planes (Cloud Run conductor job / run-continuation tick) re-drive it to the terminal report — and, on success, chain clone_conductor — with no further MCP call. Observe via site.duplicate_status."
              : "Observe progress and outstanding human items via site.duplicate_status."
          },
          ...(chainOutcome.action === "chained" ? { chain: { status: "started" as const, cloneRunId: chainOutcome.cloneRunId } } : {}),
          ...(chainOutcome.action === "refused" ? { chain: { status: "refused" as const, code: chainOutcome.code, reason: chainOutcome.reason } } : {}),
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

        // T15.9 (#188): report BOTH runs as one duplication. `request.chain` is written once by
        // maybeChainCloneAfterCapture the moment this capture run halts (siteDuplicationChain.ts):
        // absent while capture is still in progress, "started" with the clone's own runId, or
        // "refused" (named, per the chain's failure semantics — a blocked/failed capture never
        // chains). When started, the clone run's own state/spend/publish-authority is read live, the
        // same way this tool already reads capture's.
        const chainState = request?.chain;
        let cloneSummary: Record<string, unknown> | null = null;
        if (chainState?.status === "started") {
          const cloneRun = await getRun(chainState.cloneRunId, executionRepository);
          if (cloneRun) {
            const cloneUsage = await summarizeModelUsage({ runId: cloneRun.runId }, usageRepository);
            const cloneLedger = summarizeRunCost(cloneRun, cloneUsage);
            const cloneAuthority = resolvePublishAuthority(cloneRun);
            cloneSummary = {
              runId: cloneRun.runId,
              workflowId: cloneRun.workflowId,
              status: cloneRun.status,
              currentNodeId: cloneRun.currentNodeId ?? null,
              startedAt: cloneRun.startedAt,
              updatedAt: cloneRun.updatedAt,
              ...(cloneRun.completedAt ? { completedAt: cloneRun.completedAt } : {}),
              mode: runModeSummary(cloneRun),
              stall: assessRunStall(cloneRun) ?? null,
              nodes: cloneRun.nodes.map((node) => ({ nodeId: node.nodeId, status: node.status, ...(node.skip ? { skip: { reason: node.skip.reason } } : {}) })),
              spend: { ledger: cloneLedger },
              publishAuthority: cloneAuthority.authorized
                ? { authorized: true, source: cloneAuthority.source }
                : { authorized: false, code: cloneAuthority.code, reason: cloneAuthority.reason }
            };
          }
        }
        const chain = !chainState
          ? null
          : chainState.status === "started"
            ? { status: "started" as const, cloneRunId: chainState.cloneRunId, startedAt: chainState.startedAt, ...(chainState.budgetUsd !== undefined ? { budgetUsd: chainState.budgetUsd } : {}), clone: cloneSummary }
            : { status: "refused" as const, code: chainState.code, reason: chainState.reason, refusedAt: chainState.refusedAt };

        // Outstanding human items: everything on the checklist stays listed until a human confirms —
        // except the items this system can OBSERVE (the deploy-side env NAMES), which resolve live.
        const config = await projectRepository.get(run.projectId);
        const connection = config ? toConnectionState(config) : undefined;
        const publishAuthority = resolvePublishAuthority(run);
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

        // T15.17 — surface budget ceiling and ledger on the spend block. ledger.budget contains
        // budgetUsd, spentUsdEstimate, and remainingUsdEstimate from the budget evaluation.
        const budgetCeiling = run.budgetUsd ?? DEFAULT_SITE_DUPLICATE_BUDGET_USD;

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
          spend: { ledger, budgetUsd: budgetCeiling },
          reports: reportRefs,
          request: request
            ? { sourceUrl: request.sourceUrl, targetProjectId: request.targetProjectId, requestedAt: request.requestedAt, ...(request.genesis ? { genesis: request.genesis } : {}) }
            : null,
          outstandingHumanItems: humanItems,
          // T15.9 (#188) — the chained clone_conductor run, if any: null until capture halts, then
          // "started" (with the clone run's own live state) or "refused" (named).
          chain,
          // T15.10 (#189) — was `{ publishReachable: false, note: "...a separate, explicitly
          // human-gated act..." }`, unconditionally. False since T15.7 (#187): capture_conductor
          // composes the shared publishing tail, so this run DOES have a live path. What decides
          // whether IT is reachable right now is policy, not a human — the same resolvePublishAuthority
          // read the tail's own gate uses (publishDecision.ts, ADR-2026-08-25-publish-autonomy §2.4),
          // evaluated against this run's own operator record and policy snapshot.
          humanGate: {
            publishReachable: publishAuthority.authorized,
            note: `Publication is governed by this project's publishingPolicy.autonomyMode ("${run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated"}") and the run's own operator record — not a fixed human gate. ${publishAuthority.authorized ? `Currently authorized (source: ${publishAuthority.source}).` : `Currently blocked (${publishAuthority.code}): ${publishAuthority.reason}`} The shared tail's publish_executor/release_executor nodes decide the rest, per-object, once the run reaches them.`
          }
        });
      }
    })
  ];
}
