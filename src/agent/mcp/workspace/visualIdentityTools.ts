import { z } from "zod";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import { executeNode } from "../../workspace/nodeRuntime.js";
import { resolveNodeForExecution } from "../../workspace/nodeResolution.js";
import { declaresSitePrefetch, declaresVoicePrefetch } from "../../workspace/nodeGatingSeed.js";
import { getSitePrefetch } from "../../workspace/sitePrefetch.js";
import { getEditorialVoice } from "../../workspace/voicePrefetch.js";
import { objectSchema, ok, tool, WorkspaceToolError, type WorkspaceTool } from "./toolKit.js";

// A1 (D1) — `visual_identity.propose`: the ONE narrow, site-scoped door to the brand-imagery writer.
//
// WHY THIS TOOL EXISTS AT ALL. Platform's `brand_imagery_propose` used to reach this workspace
// through `node_execute('brand_imagery_writer')`. It could never work in production and never did:
// a site-scoped bearer's `toolAllowlist` (siteGenesis.ts's SITE_CLIENT_MANAGER_TOOLS) is the set of
// tools a TENANT's chat may call, and `node_execute` is workspace-PROGRAMMING scope — it takes a
// caller-supplied nodeId and will run any node in the store, for any project, with caller-supplied
// modelConfig. Granting it to a site token to unblock one writer would hand every tenant the whole
// workspace. So the credential refused the call, correctly, and the writer path sat dead in prod for
// a day behind an opaque "CMS-Agent rejected the credential".
//
// RULING R1 (2026-09-04): never widen `node_execute` to site tokens. Add one narrow site-scoped tool
// family instead. This is that family's first member, and the shape every later member must copy:
//
//   * The NODE IS NOT CALLER-SUPPLIED. There is no `nodeId` field on this tool. `kind` selects from a
//     fixed, in-source map, so the set of nodes a site bearer can reach is a compile-time constant
//     that a reviewer can read in one line — not a string that arrives over the wire.
//   * The PROJECT IS NAMED IN THE ARGUMENTS, deliberately. mcpEndpoint.ts's `isScopedMessageAllowed`
//     reads `projectId`/`project_id` off `params.arguments` and refuses any scoped call naming a
//     project outside the bearer's own `projects`. Requiring `project_id` here is what makes that
//     existing check bind: a tenant's bearer cannot propose for another tenant's site. The check
//     below (unknown_project / project_disabled) is the second half, for non-scoped callers.
//   * NO EXECUTION-MODE LEVER. `executionMode` is not on the wire. A caller who could ask for "mock"
//     would get a schema-shaped placeholder proposal back through a path whose entire purpose is to
//     put a real proposal on an approval card.
//   * NO WRITES TO THE CLIENT. The writer node has `allowedTools: []` and writes nothing of its own
//     (visualIdentityNodes.ts): no object is created, patched, applied or published, and materializing
//     and applying a standard stay where they were — a `visual_identity` RUN and the owner-gated apply
//     verb, neither of which this tool can reach.
//     Be exact about what a call DOES persist, because "zero writes" read literally is wrong:
//     nodeRuntime.ts's `executeNode` records an execution run (projectId "workspace", not the tenant's),
//     a node timing, model usage, and — on success — the WORKSPACE-GLOBAL stage output for
//     `brand_imagery_writer` (`workspaceRepository.saveStageOutput`), which every call overwrites with
//     the calling tenant's proposal. Nothing a site bearer holds can read that back
//     (`stage_get_output` / `node_*` are operator-only, and the run id is not returned), so it is
//     bookkeeping noise and an operator-visible last-writer-wins slot, not a tenant-reachable channel —
//     but it is a write, and a reader of this header should not have to discover that in nodeRuntime.ts.
//
// SHIP PATH: this file + adding the wire name to SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts) +
// `npm run scope:update` + a reconciler run with `--apply` to re-mint existing tenants. The middle
// step is not optional and the last one is the one that is always forgotten: widening the constant
// only changes what NEW sites are minted with; every already-registered tenant keeps its old scope
// until the reconciler re-mints it. See docs/mcp-scoped-bearer-auth.md.
//
// If this deployment sets MCP_EXPOSED_TOOL_PREFIXES, it must include `visual_identity` — the
// exposure filter keys on the namespace before the first dot (server.ts), so an unlisted namespace
// is neither advertised nor callable and reads to the caller as an unknown tool.

/** Wire (underscore) name, so callers and the genesis allowlist share one spelling. */
export const VISUAL_IDENTITY_PROPOSE_TOOL = "visual_identity_propose";

export const BRAND_IMAGERY_WRITER_NODE_ID = "brand_imagery_writer";

const VISUAL_IDENTITY_KINDS = ["brand_imagery", "pdf_template"] as const;
export type VisualIdentityProposeKind = (typeof VISUAL_IDENTITY_KINDS)[number];

/**
 * The complete set of nodes this tool can reach, keyed by the `kind` a caller may name. A kind is
 * listed here only when its node is live; `pdf_template` (E2) is declared on the wire contract below
 * but deliberately absent from this map, so naming it is a clean, named refusal rather than a
 * surprise once E2 lands halfway.
 */
export const VISUAL_IDENTITY_PROPOSE_NODES: Readonly<Partial<Record<VisualIdentityProposeKind, string>>> = {
  brand_imagery: BRAND_IMAGERY_WRITER_NODE_ID
};

const regionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1)
}).strict();

// The moodboard reference, in the shape the writer node's own inputSchema declares
// (visualIdentityNodes.ts). Kept verbatim so a later materializer stores the board as given.
const referenceSchema = z.object({
  blobKey: z.string().min(1).max(500).optional(),
  url: z.string().min(1).optional(),
  region: regionSchema.optional(),
  note: z.string().max(200).optional(),
  weight: z.number().min(0).max(1).optional()
}).strict();

// BRIEF §3.9's runner channel. Platform resolves blobKeys/regions into these before the call — this
// workspace has no reach into platform's blob store — so they arrive already model-visible.
const imageRefSchema = z.object({
  url: z.string().min(1).optional(),
  base64: z.string().min(1).optional(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  label: z.string().max(200).optional()
}).strict();

export const visualIdentityProposeInput = z.object({
  project_id: z.string().min(1).max(63),
  kind: z.enum(VISUAL_IDENTITY_KINDS).default("brand_imagery"),
  mode: z.enum(["house", "template"]),
  visualStandardId: z.string().min(1).optional(),
  references: z.array(referenceSchema).max(24).optional(),
  brief: z.string().min(1).max(8_000).optional(),
  existingBrandImagery: z.record(z.string(), z.unknown()).optional(),
  templateSlug: z.string().min(1).max(63).optional(),
  imageRefs: z.array(imageRefSchema).max(8).optional()
}).strict();

const visualIdentityProposeJsonSchema = objectSchema({
  project_id: { type: "string", minLength: 1, maxLength: 63, description: "The caller's own project. A scoped bearer may only name a project in its own policy." },
  kind: { type: "string", enum: [...VISUAL_IDENTITY_KINDS], default: "brand_imagery", description: "Which proposal to write. Only 'brand_imagery' is live; 'pdf_template' is reserved and refused." },
  mode: { type: "string", enum: ["house", "template"], description: "'house' — the site's one declared look. 'template' — a named alternative an override can point at." },
  visualStandardId: { type: "string", minLength: 1, description: "An existing standard being revised, when this is a revision." },
  references: { type: "array", maxItems: 24, items: { type: "object" }, description: "The mood board, in its declared shape (blobKey|url, region?, note?, weight?)." },
  brief: { type: "string", minLength: 1, maxLength: 8000, description: "What the operator asked for, in words. Sufficient on its own when there is no board." },
  existingBrandImagery: { type: "object", description: "The contract in force today, when revising rather than starting." },
  templateSlug: { type: "string", minLength: 1, maxLength: 63, description: "Required for mode 'template': the <slug> in vis_<site>_<slug>." },
  imageRefs: { type: "array", maxItems: 8, items: { type: "object" }, description: "BRIEF §3.9's model-visible view of the board, resolved by the caller." }
}, ["project_id", "mode"]);

export type VisualIdentityToolDeps = {
  workspaceRepository: WorkspaceRepository;
  executionRepository: ExecutionRepository;
  projectRepository: ProjectRepository;
  /**
   * Injection seam for tests only, the same shape agentTools.ts uses for its ConversationalRunner.
   * Production always gets nodeRuntime.ts's real `executeNode`; this exists because the default
   * execution mode is LIVE ("openai") and there is deliberately no wire lever to make it anything
   * else, so a test that wants to exercise this tool's refusals cannot ask for a mock turn.
   */
  executeNodeImpl?: typeof executeNode;
};

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The node's own output off an `executeNode` result. nodeRuntime.ts writes a completed node's output
 * to three equivalent places on the record (`nodes[].output`, `stageOutputs[nodeId]`,
 * `artifacts[].value`); reading all three keeps this working if one of them is ever restructured,
 * and reading NONE of them is what a failed run looks like — which is reported with the run's own
 * recorded errors rather than as an empty success.
 */
export const extractNodeProposal = (
  executed: unknown,
  nodeId: string
): { ok: true; proposal: unknown } | { ok: false; reason: string } => {
  if (!isBag(executed)) return { ok: false, reason: "node execution returned no object." };
  const execution = isBag(executed.execution) ? executed.execution : undefined;
  if (!execution) return { ok: false, reason: "node execution returned no execution record." };

  const nodes = Array.isArray(execution.nodes) ? execution.nodes.filter(isBag) : [];
  const state = nodes.find((node) => node.nodeId === nodeId) ?? nodes[0];
  if (state?.output !== undefined) return { ok: true, proposal: state.output };

  const stageOutputs = isBag(execution.stageOutputs) ? execution.stageOutputs : undefined;
  if (stageOutputs?.[nodeId] !== undefined) return { ok: true, proposal: stageOutputs[nodeId] };

  const artifacts = Array.isArray(execution.artifacts) ? execution.artifacts.filter(isBag) : [];
  const artifact = artifacts.find((entry) => entry.nodeId === nodeId);
  if (artifact?.value !== undefined) return { ok: true, proposal: artifact.value };

  const errors = [
    ...(Array.isArray(execution.errors) ? execution.errors : []),
    ...(Array.isArray(state?.errors) ? (state!.errors as unknown[]) : [])
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 5);
  const status = typeof execution.status === "string" ? execution.status : "unknown";
  return { ok: false, reason: errors.length ? `node run ${status}: ${errors.join("; ")}` : `node run ${status} produced no output.` };
};

export function createVisualIdentityTools({ workspaceRepository, executionRepository, projectRepository, executeNodeImpl }: VisualIdentityToolDeps): WorkspaceTool[] {
  const runNode = executeNodeImpl ?? executeNode;
  return [
    tool({
      name: "visual_identity.propose",
      description:
        "Propose a visual-identity artifact for ONE registered project — today, a brand_imagery_proposal.v1 from the brand_imagery_writer node. One vision model turn, zero tools, and no write to your site: the proposal comes back for an approval card and no object is created, patched, applied or published. The node is chosen by `kind` from a fixed server-side map and is never caller-supplied; `project_id` must be the caller's own project. Applying an approved proposal is a separate, owner-gated step (a visual_identity run, then site_apply_brand_imagery) that this tool cannot reach.",
      zodSchema: visualIdentityProposeInput,
      inputSchema: visualIdentityProposeJsonSchema,
      execute: async (input) => {
        const data = visualIdentityProposeInput.parse(input);

        // Own-property lookup, not a bare index: the zod enum above is what stops `kind` from ever
        // being "constructor"/"toString"/"__proto__" today, but a plain object literal answers all
        // three from Object.prototype (`…["constructor"]` is a FUNCTION, which is truthy), so a bare
        // index would turn any future widening of that enum — or a refactor to z.string() — straight
        // into a nodeId nobody put in this map. The refusal below must be the only other outcome.
        const nodeId = Object.prototype.hasOwnProperty.call(VISUAL_IDENTITY_PROPOSE_NODES, data.kind)
          ? VISUAL_IDENTITY_PROPOSE_NODES[data.kind]
          : undefined;
        if (!nodeId) {
          throw new WorkspaceToolError(
            "visual_identity_kind_not_available",
            `visual_identity.propose has no live writer for kind "${data.kind}". Available: ${Object.keys(VISUAL_IDENTITY_PROPOSE_NODES).join(", ")}.`,
            { kind: data.kind, available: Object.keys(VISUAL_IDENTITY_PROPOSE_NODES) }
          );
        }

        // Second half of the project gate. mcpEndpoint.ts already refuses a SCOPED bearer that names
        // a project outside its policy; this refuses an unknown or disabled project for every
        // caller, and gives the same named codes agent.resolve uses so platform can tell them apart.
        const project = await projectRepository.get(data.project_id);
        if (!project) throw new WorkspaceToolError("unknown_project", `No registered project matches "${data.project_id}".`, { projectId: data.project_id });
        if (project.status !== "active") throw new WorkspaceToolError("project_disabled", `Project "${data.project_id}" is disabled.`, { projectId: data.project_id });

        // The writer's own schema states it as an anyOf; refusing here names WHICH precondition
        // failed instead of surfacing a schema-shaped validation blob for an empty brief.
        const hasBoard = (data.references?.length ?? 0) > 0 || (data.imageRefs?.length ?? 0) > 0;
        if (!hasBoard && !data.brief) {
          throw new WorkspaceToolError(
            "visual_identity_missing_input",
            "visual_identity.propose requires at least one of references or brief — a board with neither is not a brief, it is a blank page.",
            { kind: data.kind }
          );
        }
        if (data.mode === "template" && !data.templateSlug) {
          throw new WorkspaceToolError(
            "visual_identity_missing_template_slug",
            "mode 'template' requires templateSlug — it is the <slug> in vis_<site>_<slug>.",
            { mode: data.mode }
          );
        }

        // `projectId` is what the writer node's own inputSchema names; `project_id` is the wire
        // spelling the scoped-bearer check reads. They are the same value, deliberately.
        const nodeInput: Record<string, unknown> = {
          projectId: data.project_id,
          mode: data.mode,
          ...(data.visualStandardId ? { visualStandardId: data.visualStandardId } : {}),
          ...(data.references?.length ? { references: data.references } : {}),
          ...(data.brief ? { brief: data.brief } : {}),
          ...(data.existingBrandImagery !== undefined ? { existingBrandImagery: data.existingBrandImagery } : {}),
          ...(data.templateSlug ? { templateSlug: data.templateSlug } : {}),
          ...(data.imageRefs?.length ? { imageRefs: data.imageRefs } : {})
        };

        // THE PREFETCH, and why it is repeated here rather than assumed.
        //
        // The writer's prompt promises the model that "the conductor also delivers, deterministically
        // and before your turn: prefetchedContract (… brandPalette, imagePolicyContexts,
        // visualStandard …) and editorialVoice", and the node's metadata declares sitePrefetch and
        // voicePrefetch to ask for exactly that. But those gates live in executor.ts and only fire on
        // a conductor dispatch — `executeNode` runs none of them. The old `node_execute` path had the
        // same hole and it never ran in production, so shipping this door without the prefetch would
        // make its FIRST real use the one that produces a degraded proposal: no site palette (the
        // prompt then instructs the model to state, falsely, that the site declared none), aspect
        // ratios falling back to a guessed pair, and `visualStandard.houseStatus` missing entirely.
        //
        // Both helpers degrade rather than fail — every read resolves to a named warning — so this
        // cannot turn a working proposal into an error. Warnings are returned to the caller so a
        // thin proposal is visibly thin instead of quietly wrong.
        const prefetchWarnings: string[] = [];
        const node = await resolveNodeForExecution(nodeId, workspaceRepository);
        if (node && declaresSitePrefetch(node)) {
          try {
            const site = await getSitePrefetch({ runId: `propose_${data.project_id}`, projectId: data.project_id }, { projectRepository });
            const siteFields = {
              ...(site.visualStandard !== undefined ? { visualStandard: site.visualStandard } : {}),
              ...(site.pdfTemplates !== undefined ? { pdfTemplates: site.pdfTemplates } : {}),
              ...(site.imagePolicyContexts !== undefined ? { imagePolicyContexts: site.imagePolicyContexts } : {}),
              // `brandPalette`, not `brandTokens`: the runners' credential redactor eats any key
              // matching /token/i, so the literal name would deliver "[REDACTED]" (executor.ts, FIX-D).
              ...(site.brandPalette !== undefined ? { brandPalette: site.brandPalette } : {}),
              ...(site.logo !== undefined ? { logo: site.logo } : {})
            };
            if (Object.keys(siteFields).length) nodeInput.prefetchedContract = siteFields;
            for (const warning of site.warnings) prefetchWarnings.push(`site_prefetch_degraded:${warning.code}`);
          } catch (error) {
            prefetchWarnings.push("site_prefetch_degraded:threw");
          }
        }
        if (node && declaresVoicePrefetch(node)) {
          try {
            const voice = await getEditorialVoice({ runId: `propose_${data.project_id}`, projectId: data.project_id }, { projectRepository });
            if (voice.voice) {
              nodeInput.editorialVoice = voice.voice;
              nodeInput.editorialVoiceSource = voice.source;
            }
            if (voice.source !== "live" && voice.warningCode) prefetchWarnings.push(`voice_prefetch_fallback:${voice.warningCode}`);
          } catch {
            prefetchWarnings.push("voice_prefetch_fallback:threw");
          }
        }

        // No executionMode on the wire: this path always runs the real node (nodeRuntime.ts's
        // DEFAULT_EXECUTION_MODE), so a proposal on an approval card is never a mock placeholder.
        const executed = await runNode({ nodeId, input: nodeInput }, { workspaceRepository, executionRepository });

        const extracted = extractNodeProposal(executed, nodeId);
        if (!extracted.ok) {
          throw new WorkspaceToolError(
            "visual_identity_no_proposal",
            `${nodeId} returned no proposal: ${extracted.reason}`,
            { nodeId, kind: data.kind, reason: extracted.reason }
          );
        }

        return ok({
          proposal: extracted.proposal,
          executionId: (executed as { executionId?: string }).executionId,
          nodeId,
          kind: data.kind,
          // Loud degradation, the same convention the conductor uses: "the site facts were not there"
          // is a reportable fact, not something inferable by diffing the proposal's rationale.
          ...(prefetchWarnings.length ? { warnings: prefetchWarnings } : {})
        });
      }
    })
  ];
}
