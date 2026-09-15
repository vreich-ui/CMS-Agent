// In-memory mutable layer over the raw-fixture set (workbench-verb-fixes).
// Loaded once per page load; mutating verbs (in fixture mode, see client.ts)
// act on this copy so later work packages have something honest to
// optimistically update against.
//
// Everything here holds and returns RAW live-shaped data (the same shapes
// api/adapters.ts's `to<Entity>()` functions accept) — never UI-shape
// ../types.ts objects. client.ts's MOCK_HANDLERS wrap these straight into
// the same one-level-deep envelope a live call would (`{ nodes: [...] }`,
// `{ runs: [...], page: {...} }`, …), and verbs.ts runs that through the
// exact adapter the Cloud Run transport uses. That symmetry — raw fixture in,
// same adapter, same UI shape out — is what makes the fixture-mode
// Playwright suite a real regression net for the live mapping, not a check
// against a parallel fiction. See fixtures/README.md.
//
// Everything here is synchronous — client.ts adds the artificial network
// delay, this module just owns the data.

import changesJson from './fixtures/changes.json';
import nodesJson from './fixtures/nodes.json';
import projectsJson from './fixtures/projects.json';
import runsJson from './fixtures/runs.json';
import runCostsJson from './fixtures/runCosts.json';
import toolsJson from './fixtures/tools.json';
import skillsJson from './fixtures/skills.json';
import observationsJson from './fixtures/observations.json';
import rubricsJson from './fixtures/rubrics.json';
import regressionReportsJson from './fixtures/regressionReports.json';
import datasetsJson from './fixtures/datasets.json';
import comparePairsJson from './fixtures/comparePairs.json';
import usageJson from './fixtures/usage.json';
import readinessJson from './fixtures/readiness.json';
import agentsJson from './fixtures/agents.json';
import { WORKFLOW_CATALOG } from './workflowCatalog';
import type {
  RawAgent,
  RawDataset,
  RawFinetuneReadiness,
  RawObservation,
  RawProject,
  RawRegressionReport,
  RawRubric,
  RawRun,
  RawRunCostLedger,
  RawRunNode,
  RawSkill,
  RawToolDef,
  RawUsageSummary,
  RawWorkflowNode,
} from './adapters';
import type { ComparePair, NodeDefaultOutput, Run, Workflow } from '../types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ============================================================================
// Fixture correction (workbench-node-output-and-run-freshness) — Defect A.
//
// This used to be the other way around: `stage_list_outputs` synthesized a
// legacy-shaped record for EVERY "done" node in every run, and
// `listNodeOutputs` (node_list_outputs) never carried an ordinary artifact
// at all (no fixture row ever set `nodes[].output`). That's backwards from
// production, where every executor completion path pushes exactly one
// canonical run artifact per node and a legacy stage-store record is the
// exception, not the rule (live evidence: run_1789034392364_o7bhnj /
// capture_map — a canonical artifact existed, no stage record did).
//
// Rather than synthesize a canonical artifact for every completed/failed
// node in all 55 fixture runs (a blast radius touching every other spec
// that reads node_list_outputs — DriveCenter's "prior variant" picker,
// Rail's override chip, the override modal's seed buttons), this scopes the
// correction to a handful of explicit (runId, nodeId) scenarios on the one
// run the Workbench suite already binds for "This run" coverage
// (run_1787492010814_kxdbeb) — enough to exercise every precedence tier
// outputResolution.ts defines, without changing what any other run/node
// answers. Every fixture node outside these maps still answers "nothing
// recorded" for node_list_outputs / stage_list_outputs, same as before.
const RUN_A = 'run_1787492010814_kxdbeb';

/** Canonical run-artifact scenarios — node_list_outputs entries with an
 * ordinary `type` (never 'operator_override'). `input_triage` and
 * `draft_writer` carry a canonical artifact and NO stage-store record (the
 * common case this fix restores); `publish_payload` carries a canonical
 * artifact AND a stage-store record for the same run, to prove precedence
 * picks the canonical one. */
const CANONICAL_ARTIFACTS: Record<string, { type: string }> = {
  [`${RUN_A}:input_triage`]: { type: 'content_source.v1' },
  [`${RUN_A}:draft_writer`]: { type: 'draft.v1' },
  [`${RUN_A}:publish_payload`]: { type: 'publish_payload.v1' },
};

/** Legacy stage-store scenarios — `stage_list_outputs` entries.
 * `publish_payload`'s id is shaped `${runId}:${nodeId}` (the executor's own
 * convention) so it's attributable to this run, but still loses to the
 * canonical artifact above (tier 2 beats tier 3). `research` carries ONLY a
 * legacy record, with a random `stage_*` id (the pre-canonical-artifact
 * convention) that proves nothing about which run wrote it — the
 * stage-only compatibility-fallback case. */
const LEGACY_STAGE_RECORDS: Record<string, { id: string; runScoped: boolean }> = {
  [`${RUN_A}:publish_payload`]: { id: `${RUN_A}:publish_payload`, runScoped: true },
  [`${RUN_A}:research`]: { id: 'stage_legacy_9f2k3q', runScoped: false },
  // tests/verbargs.spec.ts's pre-existing regression guard for
  // stageGetOutput's (runId, nodeId) composition predates this fixture
  // correction and needs a "present" record to resolve against — kept as
  // its own run-scoped entry rather than widening the blanket synthesis
  // this whole change removed.
  'run_1787567811920_hevotl:input_triage': { id: 'run_1787567811920_hevotl:input_triage', runScoped: true },
};

export interface RunFilter {
  workflowId?: string;
  projectId?: string;
  status?: string;
  limit?: number;
}

/** U2/U4 — one change event, live shape (see fixtures/changes.json). */
export interface MockChangeEvent {
  eventId: string;
  type: string;
  operation?: string;
  target?: { type: string; id: string };
  actor?: { kind: string; id?: string; label?: string };
  source?: string;
  reason?: string;
  parentRevisionId?: string;
  resultingRevisionId?: string;
  workspaceVersion?: string;
  riskLevel?: string;
  before?: unknown;
  after?: unknown;
  correlation?: { requestId?: string };
  createdAt: string;
}

class MockStore {
  private workflows: Record<string, Workflow>;
  private nodes: RawWorkflowNode[];
  private projects: RawProject[];
  private runs: RawRun[];
  /** runId -> ledger, from fixtures/runCosts.json (a subset — see its own
   *  `_comment`) overlaid with any test-applied override (see updateRun()). */
  private costLedgers: Map<string, RawRunCostLedger>;
  private costOverrides: Map<string, Partial<RawRunCostLedger>>;
  private tools: RawToolDef[];
  private skills: RawSkill[];
  private observations: RawObservation[];
  private rubrics: RawRubric[];
  private regressionReports: RawRegressionReport[];
  private datasets: RawDataset[];
  private comparePairs: ComparePair[];
  private usageOverall: RawUsageSummary;
  private usageByWorkflowId: Record<string, RawUsageSummary>;
  private readiness: RawFinetuneReadiness;
  private agents: RawAgent[];
  /** nodeId -> workflowId, built from each workflow's phases (mockup-config,
   *  not live — see workflowCatalog.ts). Used only to let the mock filter
   *  workspace_get_nodes / dataset stage listings by workflow the same way
   *  verbs.ts does client-side for the live transport. */
  private nodeWorkflow: Map<string, string>;
  /** U2/U4 — fixture change history (fixtures/changes.json). Live shape,
   *  authored contents; see that file's own `_comment`. */
  private changeEvents: MockChangeEvent[];
  /** U3 — operator output overrides written this session, keyed
   *  `${runId}:${nodeId}`. In-memory only, exactly like every other mock
   *  mutation: a mock save is not a real one. */
  private stageOverrides: Map<string, { value: unknown; note?: string; savedAt: string }>;

  constructor() {
    this.workflows = WORKFLOW_CATALOG;
    this.nodes = clone((nodesJson as unknown as { nodes: RawWorkflowNode[] }).nodes);
    this.changeEvents = clone((changesJson as unknown as { events: MockChangeEvent[] }).events);
    this.stageOverrides = new Map();
    this.projects = clone((projectsJson as unknown as { projects: RawProject[] }).projects);
    this.runs = clone((runsJson as unknown as { runs: RawRun[] }).runs);
    this.costLedgers = new Map(
      Object.entries(clone((runCostsJson as unknown as { byRunId: Record<string, RawRunCostLedger> }).byRunId)),
    );
    this.costOverrides = new Map();
    this.tools = clone((toolsJson as unknown as { tools: RawToolDef[] }).tools);
    this.skills = clone((skillsJson as unknown as { skills: RawSkill[] }).skills);
    this.observations = clone((observationsJson as unknown as { observations: RawObservation[] }).observations);
    this.rubrics = clone((rubricsJson as unknown as { rubrics: RawRubric[] }).rubrics);
    this.regressionReports = clone((regressionReportsJson as unknown as { reports: RawRegressionReport[] }).reports);
    this.datasets = clone((datasetsJson as unknown as { datasets: RawDataset[] }).datasets);
    this.comparePairs = clone(comparePairsJson as ComparePair[]);
    const usage = usageJson as { overall: RawUsageSummary; byWorkflowId: Record<string, RawUsageSummary> };
    this.usageOverall = clone(usage.overall);
    this.usageByWorkflowId = clone(usage.byWorkflowId);
    this.readiness = clone((readinessJson as unknown as { readiness: RawFinetuneReadiness }).readiness);
    this.agents = clone((agentsJson as unknown as { agents: RawAgent[] }).agents);

    this.nodeWorkflow = new Map();
    for (const wf of Object.values(this.workflows)) {
      for (const [, ids] of wf.phases) {
        for (const id of ids) this.nodeWorkflow.set(id, wf.id);
      }
    }
  }

  // --- workflow catalog (config, not live — see workflowCatalog.ts) --------

  getWorkflows(): Workflow[] {
    return Object.values(this.workflows);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows[id];
  }

  getWorkflowIdForNode(nodeId: string): string | undefined {
    return this.nodeWorkflow.get(nodeId);
  }

  // --- changes / attention / overrides (U1-U4) -----------------------------

  getChangeEvents(): MockChangeEvent[] {
    return this.changeEvents;
  }

  /**
   * Fixture attention items. Derived from the fixture runs so they are
   * consistent with what the rest of the app shows, and shaped like the
   * live verb's items — every one carries its own evidence string, because
   * an attention item without evidence is just a red dot.
   */
  getAttention(): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];
    for (const run of this.runs) {
      if (run.status === 'failed' || run.errors.length > 0) {
        items.push({
          kind: 'failed_run',
          severity: 'blocker',
          runId: run.runId,
          projectId: run.projectId,
          nodeId: run.nodes.find((n) => n.status === 'failed')?.nodeId,
          title: `Run ${run.runId} failed`,
          reason: run.errors[0] ?? 'the run recorded a failure',
          evidence: run.errors[0] ?? `status=${run.status}`,
        });
      } else if (run.status === 'blocked') {
        items.push({
          kind: 'pending_approval',
          severity: 'attention',
          runId: run.runId,
          projectId: run.projectId,
          nodeId: run.nodes.find((n) => n.status === 'blocked')?.nodeId ?? run.currentNodeId ?? undefined,
          title: `Run ${run.runId} is waiting on a decision`,
          reason: 'a gate node is holding this run until an operator decides',
          evidence: `status=blocked, ${run.nodes.filter((n) => n.status === 'completed').length}/${run.nodes.length} nodes done`,
        });
      }
    }
    return items.slice(0, 12);
  }

  /** U3 — validates a proposed output against the node's declared output schema. */
  validateNodeOutput(nodeId: string, output: unknown): { valid: boolean; issues: Array<{ path: string; message: string }> } {
    const node = this.getNode(nodeId);
    const schema = (node?.outputSchema ?? null) as null | {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    const issues: Array<{ path: string; message: string }> = [];
    if (!schema) return { valid: true, issues };
    if (output === null || typeof output !== 'object' || Array.isArray(output)) {
      return { valid: false, issues: [{ path: '(root)', message: 'expected an object' }] };
    }
    const obj = output as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) issues.push({ path: key, message: `required property "${key}" is missing` });
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) issues.push({ path: key, message: `"${key}" is not allowed by the schema` });
      }
    }
    return { valid: issues.length === 0, issues };
  }

  /**
   * U3 / Defect A fixture correction — prior recorded outputs for a node,
   * newest first. Two sources, exactly mirroring the live shape
   * `node_list_outputs` actually returns (canonical artifacts pushed by an
   * executor completion, plus any operator override on top):
   *
   *   - a node whose (runId, nodeId) pair is in CANONICAL_ARTIFACTS gets an
   *     ordinary artifact entry — this is the "every completed node gets a
   *     canonical run artifact" fact this fixture set used to contradict
   *     (`n.output` was never set on any fixture row);
   *   - a saved operator override (this session's own `saveStageOutput`
   *     calls) is always unshifted to the front, regardless of whether a
   *     canonical entry exists for that node — it must win precedence
   *     whether or not the node has completed yet (drive mode overrides a
   *     node's output before it has run at all).
   */
  listNodeOutputs(nodeId: string, runId?: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const run of this.runs) {
      if (runId && run.runId !== runId) continue;
      const hit = run.nodes.find((n) => n.nodeId === nodeId);
      if (!hit) continue;
      const canonical = CANONICAL_ARTIFACTS[`${run.runId}:${nodeId}`];
      if (canonical) {
        out.push({
          id: `${run.runId}:${nodeId}:artifact`,
          runId: run.runId,
          nodeId,
          type: canonical.type,
          createdAt: hit.completedAt ?? run.startedAt,
          value: {
            artifact: canonical.type,
            nodeId,
            runId: run.runId,
            note: 'Fixture-mode canonical artifact placeholder — no live content captured for this node.',
          },
        });
        continue;
      }
      // node-default-output (W4) generalization — a run-node's own
      // `.output` field is a canonical artifact too, exactly like a
      // CANONICAL_ARTIFACTS entry, just written by a real mutation
      // (applyDefaultOutputToRun below, or saveStageOutput's operator
      // override) instead of hand-authored fixture data. `operatorOverride`
      // rows are skipped here — they're unshifted back on below with their
      // own `type: 'operator_override'` tag, which must still win
      // precedence over an ordinary artifact for the same node.
      if (hit.output !== undefined && !(hit as Record<string, unknown>).operatorOverride) {
        const node = this.getNode(nodeId);
        out.push({
          id: `${run.runId}:${nodeId}:artifact`,
          runId: run.runId,
          nodeId,
          type: node?.produces?.[0] ?? 'mock_output',
          createdAt: (hit.outputProvenance?.updatedAt as string | undefined) ?? hit.completedAt ?? run.startedAt,
          value: hit.output,
        });
      }
    }
    const override = this.stageOverrides.get(`${runId ?? ''}:${nodeId}`);
    if (override) {
      out.unshift({
        id: `${runId}:${nodeId}:override`,
        runId,
        nodeId,
        type: 'operator_override',
        createdAt: override.savedAt,
        value: override.value,
        note: override.note,
      });
    }
    return out;
  }

  /**
   * Defect A fixture correction — the legacy stage-store, scoped by stage
   * (== nodeId) only, never by run (mirrors the live `stage_list_outputs`
   * contract — see verbs.ts's own doc comment on stageListOutputs). Only
   * the handful of (runId, nodeId) pairs in LEGACY_STAGE_RECORDS answer
   * anything; everything else in the fixture set has no legacy record, same
   * as most completed nodes do live.
   */
  listLegacyStageOutputs(stage?: string): Array<{ id: string; stage: string; value: unknown; createdAt: string }> {
    const out: Array<{ id: string; stage: string; value: unknown; createdAt: string }> = [];
    for (const [key, rec] of Object.entries(LEGACY_STAGE_RECORDS)) {
      const sep = key.indexOf(':');
      const runId = key.slice(0, sep);
      const nodeId = key.slice(sep + 1);
      if (stage && nodeId !== stage) continue;
      const run = this.runs.find((r) => r.runId === runId);
      const hit = run?.nodes.find((n) => n.nodeId === nodeId);
      out.push({
        id: rec.id,
        stage: nodeId,
        value: {
          note: rec.runScoped
            ? 'Legacy stage-store record for this run — a compatibility fallback, superseded by the canonical run artifact when one exists.'
            : "Legacy stage-store record — its id doesn't prove which run wrote it (pre-canonical-artifact convention).",
        },
        createdAt: hit?.completedAt ?? run?.startedAt ?? new Date(0).toISOString(),
      });
    }
    return out;
  }

  // Adversarial-review fix (post-W4, server-contract follow-up) — a node
  // that writes to a live client (a real publish, a real release, a real
  // emission) can never have its output SUPPLIED — override or default —
  // instead of produced, on a run whose model turns actually reach a live
  // client. Mirrors the server's own predicate exactly (same fields
  // components/drive/overrideStatus.ts's UI-shaped isPublishTailNode checks,
  // just off the RAW field names this store actually holds) and its
  // classified refusal code, `defaulted_publish_node_refused`. Mock runs
  // (`executionMode !== 'openai'`) are explicitly exempt, same as live.
  private static readonly PUBLISH_TAIL_KINDS = new Set(['publisher', 'releaser', 'emission']);

  private isPublishTailNode(node: RawWorkflowNode | undefined): boolean {
    if (!node) return false;
    if (node.riskLevel === 'publish' || node.riskLevel === 'admin') return true;
    return MockStore.PUBLISH_TAIL_KINDS.has(node.kind);
  }

  private isLiveRun(run: RawRun): boolean {
    return (run.mode?.executionMode ?? run.executionMode) === 'openai';
  }

  private refuseIfDefaultedPublishNode(run: RawRun, nodeId: string): void {
    if (!this.isLiveRun(run)) return;
    const node = this.getNode(nodeId);
    if (!this.isPublishTailNode(node)) return;
    throw new Error(
      `defaulted_publish_node_refused: ${nodeId} writes to a live client (riskLevel=${node?.riskLevel}, kind=${node?.kind}) and ${run.runId} is a live run — its output can never be supplied instead of produced.`,
    );
  }

  /** Adversarial-review fix (post-W4, server-contract follow-up) — a
   *  supplied value (override or default) that fails the node's CURRENT
   *  output schema still gets stored (the operator/default author is the
   *  authority — same principle the Default output tab's own second
   *  confirmation already applies), but the server now flags it with a
   *  `supplied_output_schema_invalid:<first issue>` warning rather than
   *  silently accepting it. Returns the warning string, or undefined when
   *  the value validates (or the node has no output schema to check against). */
  private suppliedOutputSchemaWarning(nodeId: string, value: unknown): string | undefined {
    const validation = this.validateNodeOutput(nodeId, value);
    if (validation.valid) return undefined;
    const first = validation.issues[0];
    return `supplied_output_schema_invalid:${first ? `${first.path}: ${first.message}` : 'value does not match the declared output schema'}`;
  }

  /** U3 — writes an operator override into the run's stage outputs.
   *
   *  Adversarial-review fix (post-W4) — this used to be strictly MORE
   *  generous than the live server: it never stamped `outputProvenance` on
   *  the run node at all, relying entirely on the synthesized
   *  `operator_override`-typed row in listNodeOutputs() below to mark an
   *  override — a row the real server never produces (see
   *  overrideStatus.ts's header on suppliedOutputMarker for the whole
   *  story). Now stamps `outputProvenance` + the `output_source:
   *  operator_override` warning on the run node, exactly like a default
   *  does, so every marker surface that reads the run record first (which
   *  is now all of them) sees a real override here too. The synthesized
   *  row itself is KEPT — OverrideOutputModal.tsx's "prior variant" picker
   *  still needs the actual VALUE list (and its type label), which nothing
   *  else provides — but it is no longer load-bearing for "is this
   *  overridden", only for "what did a prior override actually contain". */
  saveStageOutput(runId: string, nodeId: string, value: unknown, note?: string): Record<string, unknown> {
    const run = this.runs.find((r) => r.runId === runId);
    if (run) this.refuseIfDefaultedPublishNode(run, nodeId);
    const savedAt = new Date().toISOString();
    this.stageOverrides.set(`${runId}:${nodeId}`, { value, note, savedAt });
    const target = run?.nodes.find((n) => n.nodeId === nodeId);
    if (target) {
      const schemaWarning = this.suppliedOutputSchemaWarning(nodeId, value);
      const warnings = ['output_source:operator_override', ...(schemaWarning ? [schemaWarning] : [])];
      target.output = value;
      target.status = 'completed';
      target.outputProvenance = { source: 'operator_override', updatedAt: savedAt, note };
      target.warnings = [...new Set([...(target.warnings ?? []), ...warnings])];
      (target as Record<string, unknown>).operatorOverride = true;
      // A model-execution `provenance` (this run node's own prior real
      // dispatch record, if any) is deleted the moment its output is
      // supplied rather than produced — mirrors the server exactly; see
      // applyDefaultOutputToRun's matching comment.
      delete (target as Record<string, unknown>).provenance;
    }
    return { saved: true, runId, nodeId, savedAt, source: 'operator_override', note: note ?? null };
  }

  // --- node-default-output (W4) ---------------------------------------------

  /** `workspace_update_node_default_output` — sets or (passing `null`) clears
   *  a node's standing default. Mirrors buildNodeDefaultOutput's stored
   *  shape (src/agent/workspace/defaultOutput.ts, read-only) but does no
   *  schema validation of its own: the tab does that proactively client-side
   *  (node_validate_output, same as the override modal), so by the time this
   *  is called the value is already known-valid, or the operator already
   *  confirmed saving it invalid — `force`/`schemaValidAt` are the caller's
   *  business, passed straight through in the `defaultOutput` it hands us. */
  setNodeDefaultOutput(nodeId: string, defaultOutput: NodeDefaultOutput | null): RawWorkflowNode | undefined {
    return this.updateNode(nodeId, { defaultOutput: defaultOutput ?? undefined });
  }

  /** `workspace_adopt_output_as_default` — adopts a node's last recorded
   *  output (scoped to `runId` when given, else the most recent across
   *  every run) as its new standing default. Reuses listNodeOutputs — the
   *  same canonical-artifact-or-override source "This run" and the override
   *  modal already read — rather than a second output history, so "last
   *  good output" means the same thing everywhere in this app. */
  adoptOutputAsDefault(nodeId: string, runId: string | undefined, note: string | undefined): RawWorkflowNode | undefined {
    const list = [...this.listNodeOutputs(nodeId, runId)].sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    );
    const latest = list[0];
    if (!latest) return undefined;
    return this.setNodeDefaultOutput(nodeId, {
      value: latest.value,
      note,
      updatedAt: new Date().toISOString(),
      updatedBy: 'human',
      schemaValidAt: null,
    });
  }

  /** `workflow_run_node` / `workflow_retry_node` with `useDefaultOutput:
   *  true` — pushes a node's standing default straight into a run, mirroring
   *  the server's applyRunOutputFromDefault (src/agent/workspace/
   *  defaultOutput.ts, read-only): the node completes with durationMs 0 and
   *  no model turn, carries `outputProvenance` and the
   *  `output_source:default_output` warning, and `run.defaultedNodeIds` /
   *  `run.currentNodeId` advance exactly as a real completion would — one
   *  step forward in this workflow's own node order, the same "one step"
   *  contract `workflow_run_next_node`'s mock already simulates.
   *
   *  Returns undefined when the run itself isn't found. Throws
   *  `defaulted_publish_node_refused` (see the comment above
   *  refuseIfDefaultedPublishNode) BEFORE the missing-default check — a
   *  publish-tail node on a live run is refused regardless of whether it
   *  even has a default to push. Throws `default_output_missing` when the
   *  run is found, the node passes that check, but it carries no standing
   *  default — mirroring the server's own refusal as a plain Error message
   *  (this mock plane has no structured McpError to throw instead; see
   *  handlers.ts's own use of plain Error for every other refusal). */
  applyDefaultOutputToRun(runId: string, nodeId: string): RawRun | undefined {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) return undefined;
    this.refuseIfDefaultedPublishNode(run, nodeId);
    const node = this.getNode(nodeId);
    const def = node?.defaultOutput;
    if (!def) {
      throw new Error(
        `default_output_missing: ${nodeId} carries no standing default output to push through in ${runId}.`,
      );
    }
    const now = new Date().toISOString();
    const provenance = { source: 'default_output' as const, updatedAt: now, note: def.note };
    const schemaWarning = this.suppliedOutputSchemaWarning(nodeId, def.value);
    const idx = run.nodes.findIndex((n) => n.nodeId === nodeId);
    const patched: RawRunNode = {
      nodeId,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      warnings: ['output_source:default_output', ...(schemaWarning ? [schemaWarning] : [])],
      outputProvenance: provenance,
      output: def.value,
    };
    // A model-execution `provenance` (this node's own prior real dispatch
    // record in this run, if any) is deleted the moment its output is
    // supplied from the default instead of produced — mirrors the server
    // exactly; the `{...n, ...patched}` merge below otherwise carries a
    // pre-existing one straight through untouched.
    if (idx === -1) run.nodes = [...run.nodes, patched];
    else
      run.nodes = run.nodes.map((n, i) => {
        if (i !== idx) return n;
        const merged: Record<string, unknown> = { ...n, ...patched };
        delete merged.provenance;
        return merged as RawRunNode;
      });
    run.defaultedNodeIds = [...new Set([...(run.defaultedNodeIds ?? []), nodeId])];

    const wf = this.workflows[run.workflowId];
    const order: string[] = wf ? wf.phases.flatMap(([, ids]) => ids) : [];
    const posIdx = order.indexOf(nodeId);
    const nextId = posIdx >= 0 && posIdx + 1 < order.length ? order[posIdx + 1] : null;
    run.currentNodeId = nextId;
    run.status = nextId ? 'running' : 'completed';
    return run;
  }

  /** Adversarial-review fix (post-W4, server-contract follow-up) —
   *  `workflow_retry_node` WITHOUT `useDefaultOutput` on a
   *  `defaults_where_set`/`defaults_only` run marks the node with a
   *  durable `defaultOutputOverride: true` so its NEXT dispatch runs it
   *  live instead of silently re-applying the standing default — the
   *  operator asked for a real retry, and a defaults-mode run must not
   *  quietly hand them the default again. No mock dispatch engine here
   *  currently re-applies a default automatically (fixture mode has none —
   *  see handlers.ts's own workflow_run_next_node comment), so this is a
   *  data-fidelity mirror of the server's node-state shape, not a behavior
   *  change to any existing mock flow. A no-op for a `live` (or unset)
   *  outputMode run, same as the server. */
  markDefaultOutputOverride(runId: string, nodeId: string): RawRun | undefined {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) return undefined;
    if (!run.outputMode || run.outputMode === 'live') return run;
    const idx = run.nodes.findIndex((n) => n.nodeId === nodeId);
    if (idx === -1) run.nodes = [...run.nodes, { nodeId, status: 'queued', defaultOutputOverride: true }];
    else run.nodes = run.nodes.map((n, i) => (i === idx ? { ...n, defaultOutputOverride: true } : n));
    return run;
  }

  // --- workspace / nodes ---------------------------------------------------

  getNodes(workflowId?: string): RawWorkflowNode[] {
    if (!workflowId) return this.nodes;
    return this.nodes.filter((n) => this.nodeWorkflow.get(n.id) === workflowId);
  }

  getNode(nodeId: string): RawWorkflowNode | undefined {
    return this.nodes.find((n) => n.id === nodeId);
  }

  updateNode(nodeId: string, patch: Partial<RawWorkflowNode>): RawWorkflowNode | undefined {
    const idx = this.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return undefined;
    this.nodes[idx] = { ...this.nodes[idx], ...patch, id: this.nodes[idx].id };
    return this.nodes[idx];
  }

  // --- projects / registry --------------------------------------------------

  getProjects(): RawProject[] {
    return this.projects;
  }

  getProject(id: string): RawProject | undefined {
    return this.projects.find((p) => p.projectId === id);
  }

  getTools(): RawToolDef[] {
    return this.tools;
  }

  getTool(id: string): RawToolDef | undefined {
    return this.tools.find((t) => t.toolId === id);
  }

  getSkills(): RawSkill[] {
    return this.skills;
  }

  getSkill(id: string): RawSkill | undefined {
    return this.skills.find((s) => s.skillId === id);
  }

  updateSkill(id: string, patch: Partial<RawSkill>): RawSkill | undefined {
    const idx = this.skills.findIndex((s) => s.skillId === id);
    if (idx === -1) return undefined;
    this.skills[idx] = { ...this.skills[idx], ...patch, skillId: this.skills[idx].skillId };
    return this.skills[idx];
  }

  assignSkill(nodeId: string, skillId: string): RawSkill | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;
    const node = this.getNode(nodeId);
    if (node && !node.assignedSkills.includes(skillId)) {
      this.updateNode(nodeId, { assignedSkills: [...node.assignedSkills, skillId] });
    }
    return skill;
  }

  unassignSkill(nodeId: string, skillId: string): RawSkill | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;
    const node = this.getNode(nodeId);
    if (node) {
      this.updateNode(nodeId, { assignedSkills: node.assignedSkills.filter((s) => s !== skillId) });
    }
    return skill;
  }

  /** skillId -> node ids that assign it — the live source for Skill.assignedTo. */
  assignedToFor(skillId: string): string[] {
    return this.nodes.filter((n) => n.assignedSkills.includes(skillId)).map((n) => n.id);
  }

  getAgents(): RawAgent[] {
    return this.agents;
  }

  getAgent(id: string): RawAgent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  // --- runs ------------------------------------------------------------------

  getRuns(filter: RunFilter = {}): RawRun[] {
    let out = this.runs;
    if (filter.workflowId) out = out.filter((r) => r.workflowId === filter.workflowId);
    if (filter.projectId) out = out.filter((r) => r.projectId === filter.projectId);
    if (filter.status) out = out.filter((r) => r.status === filter.status);
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  getRun(id: string): RawRun | undefined {
    return this.runs.find((r) => r.runId === id);
  }

  /**
   * Test-support — patches one node entry's raw status (and, when given,
   * the run's own top-level status alongside it). The static fixture set
   * carries no 'running' or 'paused' RUN, and no per-node status this
   * session hasn't already settled — this is how tests/thisRunOutput.spec.ts
   * sets those up, and how it simulates a node crossing into a terminal
   * state to exercise Defect B's "refresh without reload" path.
   */
  setNodeStatus(runId: string, nodeId: string, patch: Partial<RawRunNode>, runStatus?: string): RawRun | undefined {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) return undefined;
    const idx = run.nodes.findIndex((n) => n.nodeId === nodeId);
    if (idx === -1) return undefined;
    run.nodes[idx] = { ...run.nodes[idx], ...patch };
    if (runStatus !== undefined) run.status = runStatus;
    return run;
  }

  /** Raw-field patch, used by the mutating-verb mock handlers. */
  updateRunRaw(id: string, patch: Partial<RawRun>): RawRun | undefined {
    const idx = this.runs.findIndex((r) => r.runId === id);
    if (idx === -1) return undefined;
    this.runs[idx] = { ...this.runs[idx], ...patch, runId: this.runs[idx].runId };
    return this.runs[idx];
  }

  /**
   * UI-shape (`Partial<Run>`) compat entry point — `runcontrol.spec.ts`
   * calls this directly (`mockStore.updateRun(id, {cost, budget})`) to
   * synthesize an over-budget scenario. `cost`/`budget` have no home on the
   * raw run row itself (see toRun()'s doc comment — they only ever come
   * from a separate cost-ledger lookup), so those two keys go into
   * `costOverrides` instead of the row; every other key here has a direct
   * raw-field equivalent.
   */
  updateRun(id: string, patch: Partial<Run>): RawRun | undefined {
    const rawPatch: Partial<RawRun> = {};
    if (patch.status !== undefined) rawPatch.status = patch.status;
    if (patch.cur !== undefined) rawPatch.currentNodeId = patch.cur;
    if (patch.dry !== undefined) rawPatch.dryRun = patch.dry;
    if (patch.requestId !== undefined) rawPatch.requestId = patch.requestId;
    if (patch.cost !== undefined || patch.budget !== undefined) {
      const existing = this.costOverrides.get(id) ?? {};
      this.costOverrides.set(id, {
        ...existing,
        runId: id,
        totalCostUsdEstimate: patch.cost ?? existing.totalCostUsdEstimate ?? 0,
        budget: patch.budget !== undefined ? { budgetUsd: patch.budget } : existing.budget,
      });
    }
    return Object.keys(rawPatch).length ? this.updateRunRaw(id, rawPatch) : this.getRun(id);
  }

  /** Adds a brand-new run (used by workflow_start_dry_run in mock mode). */
  addRun(run: RawRun): RawRun {
    this.runs = [run, ...this.runs];
    return run;
  }

  getCostLedger(runId: string): RawRunCostLedger | undefined {
    const base = this.costLedgers.get(runId);
    const override = this.costOverrides.get(runId);
    if (!base && !override) return undefined;
    return { runId, totalCostUsdEstimate: 0, ...base, ...override };
  }

  // --- learning / evaluation / datasets --------------------------------------

  getObservations(nodeId?: string): RawObservation[] {
    if (!nodeId) return this.observations;
    return this.observations.filter((o) => o.nodeId === nodeId);
  }

  addObservation(obs: RawObservation): RawObservation {
    this.observations = [obs, ...this.observations];
    return obs;
  }

  archiveObservation(id: string): RawObservation | undefined {
    const obs = this.observations.find((o) => o.id === id);
    if (!obs) return undefined;
    this.observations = this.observations.filter((o) => o.id !== id);
    return obs;
  }

  getRubrics(): RawRubric[] {
    return this.rubrics;
  }

  getRubric(nodeId: string): RawRubric | undefined {
    return this.rubrics.find((r) => r.nodeId === nodeId);
  }

  updateRubric(nodeId: string, patch: Partial<RawRubric>): RawRubric | undefined {
    const idx = this.rubrics.findIndex((r) => r.nodeId === nodeId);
    if (idx === -1) return undefined;
    this.rubrics[idx] = { ...this.rubrics[idx], ...patch, nodeId: this.rubrics[idx].nodeId };
    return this.rubrics[idx];
  }

  getRegressionReports(nodeId?: string): RawRegressionReport[] {
    if (!nodeId) return this.regressionReports;
    return this.regressionReports.filter((r) => r.nodeId === nodeId);
  }

  getDatasets(): RawDataset[] {
    return this.datasets;
  }

  getDataset(id: string): RawDataset | undefined {
    return this.datasets.find((d) => d.datasetId === id);
  }

  addDataset(ds: RawDataset): RawDataset {
    this.datasets = [ds, ...this.datasets];
    return ds;
  }

  getComparePairs(): ComparePair[] {
    return this.comparePairs;
  }

  getUsageOverall(): RawUsageSummary {
    return this.usageOverall;
  }

  getUsageByWorkflow(workflowId: string): RawUsageSummary | undefined {
    return this.usageByWorkflowId[workflowId];
  }

  getReadiness(): RawFinetuneReadiness {
    return this.readiness;
  }

  /** Compare (A/B) verdicts nudge finetune readiness — Phase 5 wires the UI. */
  recordPreferencePair(): RawFinetuneReadiness {
    this.readiness = { ...this.readiness, preferencePairs: this.readiness.preferencePairs + 1 };
    return this.readiness;
  }
}

export const mockStore = new MockStore();
