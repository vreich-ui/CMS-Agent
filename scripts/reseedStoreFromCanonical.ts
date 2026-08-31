#!/usr/bin/env tsx
/**
 * Push canonical node definitions — src/agent/workspace/nodes.ts — INTO the live workspace store,
 * field by field, for an explicit and hardcoded allowlist of (nodeId, field) pairs.
 *
 * WHY THIS DIRECTION EXISTS (mirror image of scripts/seedNodesFromWorkspace.ts)
 *
 * `resolveConductorNodes` (executor.ts ~L245-291) resolves each conductor node by overlaying the
 * canonical definition with its stored counterpart: `overlayStoreNode` PINS id, dependsOn, produces,
 * riskLevel, position and status to canonical — a store edit can never rewire the graph or downgrade
 * a publish-risk gate — but it lets the store's name, description, prompt, schema, inputSchema,
 * outputSchema, allowedTools, assignedSkills, modelConfig, executionConfig and metadata OVERRIDE
 * canonical outright. allowedTools and metadata are replaced WHOLESALE, not merged: a stale store row
 * silently wins over a just-committed canonical fix in exactly those two fields.
 *
 * That is precisely the failure this script removes. Four waves changed canonical prompts, an output
 * schema and a tool grant; every one of those changes is invisible to a live run until the matching
 * store field is brought into line — no amount of editing nodes.ts does that by itself.
 * `run_1786557897658_elj34j` (2026-08-12) is the concrete cost: `artifact_plan` was skipped on a
 * media run and the published body carried no image, traced (Wave 3 T8) to topology that the store
 * still cannot deliver — topology needs the redeploy this script's closing summary names — but the
 * surrounding prompt/schema fixes for that same incident DO reach a run through exactly the field
 * writes below.
 *
 * METADATA IS THE ONE FIELD THIS SCRIPT DOES NOT BLIND-COPY. `grep -oE '"[a-zA-Z]*Deterministic":
 * [a-z"]+' src/agent/workspace/nodes.ts` shows canonical currently sets contractIntelligenceDeterministic,
 * placementResolverDeterministic and publishPayloadDeterministic — but NOT publishExecutorDeterministic
 * or publicationControllerDeterministic. Those two flags exist only in the LIVE STORE's metadata today.
 * Because overlayStoreNode replaces metadata WHOLESALE, a canonical->store copy of publish_executor's
 * metadata would silently DISABLE whichever deterministic route the store currently has switched on —
 * a capability loss dressed as a re-seed, the exact failure class this script's refusals exist to
 * prevent. So publish_executor.metadata is NOT in RESEED_ALLOWLIST; the one supported way to change
 * that single flag is --set-publish-executor-mode, a merge-only operation (see below) that touches
 * publishExecutorDeterministic alone and leaves every sibling metadata key byte-for-byte intact.
 *
 * WHAT THIS SCRIPT WILL NEVER TOUCH. id, dependsOn, produces, riskLevel, position and status are
 * TOPOLOGY — pinned by overlayStoreNode as described above — so a store write to any of them can
 * never rewire a run; it reaches a run only through a re-seed of nodes.ts (npm run nodes:update)
 * followed by a REDEPLOY. Requesting one of these fields is refused loudly, both here and at the
 * refusal site itself, because an operator who wrote dependsOn into the store and believes it took
 * effect is the exact failure this whole plan exists to remove.
 *
 * Usage:
 *   npm run store:check                        # exit 1 if the store drifts from canonical (CI gate)
 *   npm run store:update                       # write every allowlisted, non-refused drift
 *   npm run store:update -- --node artifact_plan     # land one node at a time
 *   npm run store:update -- --allow-prompt-shrink    # confirm a deliberate prompt cut
 *   npm run store:update -- --allow-capability-loss  # confirm a deliberate key/tool removal
 *   npm run store:check -- --json              # machine-readable plan
 *   npm run store:update -- --set-publish-executor-mode gate     # merge-only: "gate" (deterministic refusal only)
 *   npm run store:update -- --set-publish-executor-mode execute  # merge-only: "execute" (engine performs the publish)
 *
 * SAFETY. Refuses (exit non-zero, applies nothing, names the reason) when: the node does not exist
 * in the store; the node does not exist in canonical; the (node, field) pair is not in the hardcoded
 * allowlist below; a topology field is requested (see above); a prompt would shrink past the same
 * threshold seedNodesFromWorkspace.ts enforces, unless --allow-prompt-shrink; the write would GRANT
 * project.call_tool to a publish- or admin-risk node; the canonical metadata/allowedTools value is
 * undefined (writing undefined over a populated store row is a silent capability loss, not a re-seed);
 * or canonical would REMOVE a key/tool the store currently has, for any allowlisted metadata/
 * allowedTools field, unless --allow-capability-loss (see METADATA note above for why this exists).
 * --set-publish-executor-mode additionally refuses a value other than "gate"/"execute" by name, and
 * refuses outright if the store's publish_executor node carries no metadata object at all. Writes are
 * sequential, never parallel, and stop at the first failure — reported writes are exactly the writes
 * that landed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceNode } from "../src/agent/workspace/nodeTypes.js";
import type { WorkspaceMutationMeta } from "../src/agent/mcp/workspace/store.js";

// Fields overlayStoreNode PINS to canonical. Requesting a write to any of these is refused, loudly,
// naming the redeploy requirement — never silently dropped, so an operator cannot mistake "refused"
// for "applied".
export const TOPOLOGY_FIELDS = ["id", "dependsOn", "produces", "riskLevel", "position", "status"] as const;

// Fields overlayStoreNode lets the store override wholesale. Only fields in this set are ever
// candidates for RESEED_ALLOWLIST entries below.
const STORE_OWNED_FIELDS = ["name", "description", "prompt", "schema", "inputSchema", "outputSchema", "allowedTools", "assignedSkills", "modelConfig", "executionConfig", "metadata"] as const;
export type ReseedField = typeof STORE_OWNED_FIELDS[number];

export type ReseedAllowlistEntry = { nodeId: string; field: ReseedField; note: string };

// THE allowlist. Exactly these five (nodeId, field) pairs — hardcoded, reviewed, one comment each
// naming the wave that needs it. This script pushes nothing else, ever; widening scope means adding
// a line here deliberately, not passing a flag.
export const RESEED_ALLOWLIST: ReseedAllowlistEntry[] = [
  // Wave 1 T3 — drop the stray workspace.get_node grant.
  { nodeId: "topic_opportunity", field: "allowedTools", note: "Wave 1 T3 — drop the stray workspace.get_node grant" },
  // Wave 3 T8 — the required mediaSlots[].
  { nodeId: "brief_architect", field: "outputSchema", note: "Wave 3 T8 — the required mediaSlots[]" },
  // Wave 3 T8 — the required mediaSlots[] (prompt half of the same change).
  { nodeId: "brief_architect", field: "prompt", note: "Wave 3 T8 — the required mediaSlots[]" },
  // Wave 3 T8 — materialize slots via create_agent_artifact_job.
  { nodeId: "artifact_plan", field: "prompt", note: "Wave 3 T8 — materialize slots via create_agent_artifact_job" },
  // Wave 3 T8 — bind verified refs into body.image.
  { nodeId: "article_body", field: "prompt", note: "Wave 3 T8 — bind verified refs into body.image" },
  // W8 (2026-08-31) — artifact_plan stops materializing and becomes ONE tool-less planning turn.
  //
  // Topology travelled with the redeploy (overlayStoreNode pins it), so artifact_materializer is live
  // the moment the code is. These five fields did NOT: overlayStoreNode lets the store's copy override
  // canonical outright, and the store still holds the gpt-5.5 tool-loop row. Without these writes a
  // live run dispatches artifact_plan with the OLD prompt, the OLD project.call_tool grant and the OLD
  // 8-call/$2 budget, validates its output against the OLD artifact_plan.v1 schema — which the new
  // materialization_spec.v1 fails — and the whole point of W8 is bought and not delivered. The
  // outputSchema entry is the one that turns a wasted run into a failed node, so it is not optional.
  //
  // Two of these are CAPABILITY LOSSES by this script's own definition and will refuse without
  // --allow-capability-loss: allowedTools drops project.call_tool (deliberate — a planner that can call
  // the bridge is the tool loop W8 removed) and assignedSkills drops contract_intelligence (its skill
  // requests project.call_tool, which this node now denies). Say it out loud, as the flag intends.
  { nodeId: "artifact_plan", field: "outputSchema", note: "W8 — emits materialization_spec.v1; the old schema rejects it" },
  { nodeId: "artifact_plan", field: "schema", note: "W8 — the legacy alias must not disagree with outputSchema" },
  { nodeId: "artifact_plan", field: "allowedTools", note: "W8 — plans only; allowedTools is empty by design (capability loss, deliberate)" },
  { nodeId: "artifact_plan", field: "assignedSkills", note: "W8 — the contract skill requests a tool this node now denies (capability loss, deliberate)" },
  { nodeId: "artifact_plan", field: "modelConfig", note: "W8 — maxTurns 1, toolCallLimit 0, budget $0.50" }
  // NOT HERE: publish_executor.metadata (Wave 2a T4's publishExecutorDeterministic flag). `grep -oE
  // '"[a-zA-Z]*Deterministic": [a-z"]+' src/agent/workspace/nodes.ts` shows canonical never set that
  // flag (or publicationControllerDeterministic) — only contractIntelligenceDeterministic,
  // placementResolverDeterministic and publishPayloadDeterministic exist there. The flag lives ONLY
  // in the live store's metadata today, so a blind canonical->store copy would DISABLE it — a
  // capability loss dressed as a re-seed. Use --set-publish-executor-mode instead (see below), which
  // merges just that one key and leaves every other store metadata key untouched.
];

// Same ceiling seedNodesFromWorkspace.ts uses, in the direction this script travels: a re-seed may
// tighten a prompt, it may not gut one, unless the operator says so out loud.
export const MAX_PROMPT_SHRINK = 0.4;
export const ALLOW_SHRINK_FLAG = "--allow-prompt-shrink";
// A re-seed may ADD a key/tool; it may not silently REMOVE one a store row currently carries, unless
// the operator says so out loud — the same posture as ALLOW_SHRINK_FLAG, generalized past prompts to
// every whole-object field (metadata, allowedTools) an allowlist entry can touch.
export const ALLOW_CAPABILITY_LOSS_FLAG = "--allow-capability-loss";

export type ReseedRequest = { nodeId: string; field: string };
// "allowlist_copy": canonical -> store, produced by planReseed from RESEED_ALLOWLIST.
// "publish_executor_mode": store.metadata merged with one key, produced by planPublishExecutorMode.
// Kept distinct so `--write` with no --set-publish-executor-mode flag can never emit the latter.
export type PlannedWriteKind = "allowlist_copy" | "publish_executor_mode";
export type PlannedWrite = {
  kind: PlannedWriteKind;
  nodeId: string;
  field: ReseedField;
  note: string;
  beforeValue: unknown;
  afterValue: unknown;
  beforeLength: number;
  afterLength: number;
  charDelta: number;
  firstDifference: string;
};
export type PlanRefusal = { nodeId: string; field?: string; reason: string };
export type ReseedPlan = {
  writes: PlannedWrite[];
  refusals: PlanRefusal[];
  upToDate: Array<{ nodeId: string; field: string }>;
};

// Structural equality, not string equality — the store round-trips through zod defaults and JSON
// serialization, which can reorder object keys without changing meaning. Comparing by string would
// report drift that isn't there.
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false;
    return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
};

const jsonText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2));

// Char-count delta plus the first differing line — never the whole value twice. Line-based so it
// works uniformly across a prompt string and a stringified schema/metadata object.
const firstDiffLine = (beforeText: string, afterText: string): string => {
  const beforeLines = beforeText.split("\n");
  const afterLines = afterText.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max; index++) {
    if (beforeLines[index] !== afterLines[index]) {
      const before = beforeLines[index] === undefined ? "(line absent)" : beforeLines[index].slice(0, 160);
      const after = afterLines[index] === undefined ? "(line absent)" : afterLines[index].slice(0, 160);
      return `line ${index + 1}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
    }
  }
  return "(values differ but no line-level difference found — likely whitespace-only or key ordering)";
};

export const buildFieldDiff = (kind: PlannedWriteKind, nodeId: string, field: ReseedField, beforeValue: unknown, afterValue: unknown, note: string): PlannedWrite => {
  const beforeText = jsonText(beforeValue);
  const afterText = jsonText(afterValue);
  return {
    kind,
    nodeId,
    field,
    note,
    beforeValue,
    afterValue,
    beforeLength: beforeText.length,
    afterLength: afterText.length,
    charDelta: afterText.length - beforeText.length,
    // allowedTools/metadata are short-ish objects; showing them whole is more useful than a line diff.
    firstDifference: field === "allowedTools" || field === "metadata" ? `${JSON.stringify(beforeValue)} -> ${JSON.stringify(afterValue)}` : firstDiffLine(beforeText, afterText)
  };
};

// Keys/entries present in `before` (the store's current value) that `after` (what would be written)
// does NOT carry — i.e. exactly what a write would silently remove. Scoped to the two whole-object
// fields overlayStoreNode replaces wholesale; every other allowlisted field is a scalar (prompt) or
// a schema object where "removal" is not a coherent, generically-checkable notion.
export const lostEntries = (field: ReseedField, before: unknown, after: unknown): string[] => {
  if (field === "allowedTools") {
    const beforeTools = Array.isArray(before) ? before : [];
    const afterTools = Array.isArray(after) ? after : [];
    return beforeTools.filter((tool) => !afterTools.includes(tool));
  }
  if (field === "metadata") {
    const beforeKeys = before && typeof before === "object" ? Object.keys(before as object) : [];
    const afterObject = after && typeof after === "object" ? (after as object) : {};
    return beforeKeys.filter((key) => !(key in afterObject));
  }
  return [];
};

// THE pure planner. No IO, no store access — takes two node arrays and produces a plan. `requests`
// defaults to RESEED_ALLOWLIST but accepts an explicit list so a test (or a future --field flag) can
// exercise the refusal logic against pairs that are deliberately NOT allowlisted.
export function planReseed(options: {
  canonical: WorkspaceNode[];
  store: WorkspaceNode[];
  // Defaults to the real, hardcoded RESEED_ALLOWLIST. main() never overrides this — the injection
  // point exists so tests can exercise the refusal logic (e.g. project.call_tool onto a publish-risk
  // node) against a pair the real allowlist does not happen to contain, without weakening main().
  allowlist?: ReseedAllowlistEntry[];
  requests?: ReseedRequest[];
  nodeId?: string;
  allowPromptShrink?: boolean;
  allowCapabilityLoss?: boolean;
}): ReseedPlan {
  const allowlist = options.allowlist ?? RESEED_ALLOWLIST;
  const requests = (options.requests ?? allowlist.map((entry) => ({ nodeId: entry.nodeId, field: entry.field as string })))
    .filter((request) => !options.nodeId || request.nodeId === options.nodeId);
  const canonicalById = new Map(options.canonical.map((node) => [node.id, node]));
  const storeById = new Map(options.store.map((node) => [node.id, node]));
  const writes: PlannedWrite[] = [];
  const refusals: PlanRefusal[] = [];
  const upToDate: Array<{ nodeId: string; field: string }> = [];

  for (const { nodeId, field } of requests) {
    if ((TOPOLOGY_FIELDS as readonly string[]).includes(field)) {
      refusals.push({
        nodeId,
        field,
        reason: `"${field}" is a TOPOLOGY field. overlayStoreNode (src/agent/workspace/executor.ts) pins id/dependsOn/produces/riskLevel/position/status to the canonical definition in nodes.ts on every run, so a store write here can never rewire the graph or move a gate — it reaches a run only through a re-seed of nodes.ts (npm run nodes:update) followed by a REDEPLOY. Refusing, so an operator who wrote this does not believe it took effect.`
      });
      continue;
    }
    const allowlisted = allowlist.some((entry) => entry.nodeId === nodeId && entry.field === field);
    if (!allowlisted) {
      refusals.push({ nodeId, field, reason: `(${nodeId}, ${field}) is not in RESEED_ALLOWLIST. This script pushes only an explicit, reviewed set of (nodeId, field) pairs — add the pair to RESEED_ALLOWLIST deliberately if it is genuinely needed; do not widen scope by request.` });
      continue;
    }

    const canonicalNode = canonicalById.get(nodeId);
    if (!canonicalNode) { refusals.push({ nodeId, field, reason: `"${nodeId}" does not exist in canonical (src/agent/workspace/nodes.ts). Nothing to re-seed from.` }); continue; }
    const storeNode = storeById.get(nodeId);
    if (!storeNode) { refusals.push({ nodeId, field, reason: `"${nodeId}" does not exist in the live store. Creating a node is out of scope for this script.` }); continue; }

    const canonicalValue = (canonicalNode as unknown as Record<string, unknown>)[field];
    const storeValue = (storeNode as unknown as Record<string, unknown>)[field];

    if ((field === "metadata" || field === "allowedTools") && canonicalValue === undefined) {
      refusals.push({ nodeId, field, reason: `canonical "${field}" for "${nodeId}" is undefined. Writing undefined over a populated store row would be a silent capability loss, not a re-seed — refusing.` });
      continue;
    }

    // project.call_tool on a publish/admin-risk node is a reviewed, deliberate decision — never a
    // side effect of a re-seed. riskLevel is read from canonical (topology, pinned either way).
    if (field === "allowedTools" && (canonicalNode.riskLevel === "publish" || canonicalNode.riskLevel === "admin")) {
      const before = Array.isArray(storeValue) && storeValue.includes("project.call_tool");
      const after = Array.isArray(canonicalValue) && canonicalValue.includes("project.call_tool");
      if (!before && after) {
        refusals.push({ nodeId, field, reason: `writing canonical allowedTools would GRANT "project.call_tool" to "${nodeId}" (a ${canonicalNode.riskLevel}-risk node) as a side effect of a re-seed. Open that capability deliberately (workspace.update_node_tools), not through this script.` });
        continue;
      }
    }

    // General capability-loss guard (generalizes the undefined check above): a re-seed may ADD a
    // key/tool to a whole-object field, it may not silently REMOVE one the store currently carries,
    // unless the operator says so with --allow-capability-loss. This is what would have caught the
    // publish_executor.metadata hazard even if that pair were still on the allowlist.
    if (field === "metadata" || field === "allowedTools") {
      const lost = lostEntries(field, storeValue, canonicalValue);
      if (lost.length && !options.allowCapabilityLoss) {
        refusals.push({ nodeId, field, reason: `canonical "${field}" for "${nodeId}" would REMOVE ${lost.length} entr${lost.length === 1 ? "y" : "ies"} the store currently carries: ${lost.join(", ")}. Re-run with ${ALLOW_CAPABILITY_LOSS_FLAG} to confirm the removal is intended.` });
        continue;
      }
    }

    if (field === "prompt" && typeof storeValue === "string" && typeof canonicalValue === "string" && canonicalValue.length < storeValue.length) {
      const shrink = (storeValue.length - canonicalValue.length) / storeValue.length;
      if (shrink > MAX_PROMPT_SHRINK && !options.allowPromptShrink) {
        refusals.push({ nodeId, field, reason: `prompt would shrink ${storeValue.length} -> ${canonicalValue.length} chars (-${Math.round(shrink * 100)}%), past the ${Math.round(MAX_PROMPT_SHRINK * 100)}% ceiling seedNodesFromWorkspace.ts also enforces. Re-run with ${ALLOW_SHRINK_FLAG} to confirm the cut is intended.` });
        continue;
      }
    }

    if (deepEqual(storeValue, canonicalValue)) { upToDate.push({ nodeId, field }); continue; }

    const entry = allowlist.find((candidate) => candidate.nodeId === nodeId && candidate.field === field)!;
    writes.push(buildFieldDiff("allowlist_copy", nodeId, field as ReseedField, storeValue, canonicalValue, entry.note));
  }

  return { writes, refusals, upToDate };
}

// The one supported way to change publish_executor's deterministic-route flag. Deliberately a
// SEPARATE function from planReseed: it never reads canonical at all, only merges one key into the
// store's EXISTING metadata, so it cannot fall into the same wholesale-replace hazard RESEED_ALLOWLIST
// no longer risks. readPublishExecutorDeterministicMode (publishExecution.ts) is the sole reader this
// must match: "gate" -> boolean true, "execute" -> the literal string "execute" — anything else that
// module treats as "off", so this function never writes anything else.
export const PUBLISH_EXECUTOR_MODE_VALUES = ["gate", "execute"] as const;
export type PublishExecutorMode = typeof PUBLISH_EXECUTOR_MODE_VALUES[number];
export type PublishExecutorModeResult =
  | { status: "write"; write: PlannedWrite }
  | { status: "up_to_date" }
  | { status: "refused"; refusal: PlanRefusal };

export function planPublishExecutorMode(options: { store: WorkspaceNode[]; mode: string }): PublishExecutorModeResult {
  if (!(PUBLISH_EXECUTOR_MODE_VALUES as readonly string[]).includes(options.mode)) {
    return {
      status: "refused",
      refusal: { nodeId: "publish_executor", field: "metadata", reason: `"${options.mode}" is not a valid --set-publish-executor-mode value. Accepted values are exactly ${PUBLISH_EXECUTOR_MODE_VALUES.map((value) => `"${value}"`).join(" or ")} — readPublishExecutorDeterministicMode treats anything else as "off" (the model path), which would be a bigger, silent change than the one requested.` }
    };
  }
  const mode = options.mode as PublishExecutorMode;
  const node = options.store.find((candidate) => candidate.id === "publish_executor");
  if (!node) return { status: "refused", refusal: { nodeId: "publish_executor", field: "metadata", reason: `"publish_executor" does not exist in the live store.` } };
  if (!node.metadata || typeof node.metadata !== "object") {
    return {
      status: "refused",
      refusal: { nodeId: "publish_executor", field: "metadata", reason: `the store's publish_executor node has no metadata object at all. Writing a metadata object from nothing here would invent every OTHER key (activationRequired, approvalRequired, canonicalRules, goLive, ...) rather than merge into something real — refusing and stopping instead of guessing. Populate metadata via workspace.update_node_metadata first.` }
    };
  }
  // "gate" writes boolean true; "execute" writes the literal string "execute" — never the CLI word
  // "gate" itself, which readPublishExecutorDeterministicMode would treat as an unrecognised (="off")
  // value. See that function's own comment in publishExecution.ts for the full tri-state contract.
  const modeValue: true | "execute" = mode === "gate" ? true : "execute";
  const before = node.metadata as Record<string, unknown>;
  const after = { ...before, publishExecutorDeterministic: modeValue };
  if (deepEqual(before, after)) return { status: "up_to_date" };
  return {
    status: "write",
    write: buildFieldDiff("publish_executor_mode", "publish_executor", "metadata", before, after, `--set-publish-executor-mode ${mode}: merge-only write of publishExecutorDeterministic; every sibling metadata key preserved byte-for-byte`)
  };
}

// ---- thin main: argv, IO, store access. Everything above this line is pure and unit-tested. ----

const say = (line: string) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`${line}\n`);

// Wave 3's topology (artifact_plan -> article_body) is pinned by overlayStoreNode and can only reach
// a live run through a re-seed of nodes.ts (already reflects canonical) plus a redeploy of this
// service. No store write — including everything this run just did — can deliver that edge order.
const REDEPLOY_NOTE = "REDEPLOY still required for Wave 3's topology (artifact_plan must precede article_body): that edge order is pinned by overlayStoreNode and reaches a run only through nodes.ts + a redeploy, never a store write. Nothing this script does changes that.";

const buildMutationMeta = (nodeId: string, field: string, note: string): WorkspaceMutationMeta => ({
  actor: { kind: "system", label: "reseedStoreFromCanonical" },
  source: "system",
  reason: `canonical re-seed: ${nodeId}.${field} — ${note}`
});

const main = async () => {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const json = args.includes("--json");
  const allowPromptShrink = args.includes(ALLOW_SHRINK_FLAG);
  const allowCapabilityLoss = args.includes(ALLOW_CAPABILITY_LOSS_FLAG);
  const nodeFlagIndex = args.indexOf("--node");
  const nodeId = nodeFlagIndex === -1 ? undefined : args[nodeFlagIndex + 1];
  const modeFlagIndex = args.indexOf("--set-publish-executor-mode");
  const modeValue = modeFlagIndex === -1 ? undefined : args[modeFlagIndex + 1];

  if (modeFlagIndex !== -1 && modeValue === undefined) {
    warn(`✗ --set-publish-executor-mode needs a value: ${PUBLISH_EXECUTOR_MODE_VALUES.join(" or ")}.`);
    process.exit(1);
  }
  if (nodeId && !RESEED_ALLOWLIST.some((entry) => entry.nodeId === nodeId)) {
    warn(`✗ "${nodeId}" has no entries in RESEED_ALLOWLIST. Valid ids: ${[...new Set(RESEED_ALLOWLIST.map((entry) => entry.nodeId))].join(", ")}.`);
    process.exit(1);
  }

  // THE STORE THIS RUN IS POINTED AT — checked BEFORE anything is compared, and named in the output.
  //
  // 2026-08-14: `npm run store:update` was run from a laptop and reported "store matches the
  // requested target for every pair/operation" for all five pairs. It had written nothing and could
  // not have: this repo has no dotenv loader, so WORKSPACE_STORE was unset in the shell, the backend
  // resolved to "memory", and MemoryWorkspaceRepository seeds itself from defaultWorkspaceNodes() —
  // i.e. from nodes.ts. The script compared canonical to canonical and truthfully reported no drift.
  // Production (brief_architect.updatedAt 2026-08-11T17:01:02.869Z) was untouched and still stale.
  //
  // A re-seed against an in-memory store is meaningless by construction, and a green "store matches"
  // from one is WORSE than an error, because it retires the task in the operator's head. Same failure
  // class as the continuation tick scanning an abandoned store and logging a healthy line — see
  // docs/platform/CONTINUATION_TICK.md. Refuse instead, and say which store would have been used.
  const backend = (process.env.WORKSPACE_STORE ?? "").trim().toLowerCase();
  if (backend !== "blobs" && backend !== "gcs") {
    warn(`✗ WORKSPACE_STORE is ${backend ? `"${backend}"` : "unset"}, so the repositories resolve to an in-memory store seeded from nodes.ts itself.`);
    warn("  Comparing canonical to canonical always reports \"up to date\" and writes nothing — a false green, not a re-seed.");
    warn("  Point this at the real store, e.g. the production execution plane:");
    warn("    WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state npm run store:check");
    warn("  (GCS needs application-default credentials: gcloud auth application-default login)");
    process.exit(1);
  }

  const { listWorkspaceNodes } = await import("../src/agent/workspace/nodes.js");
  const canonical = listWorkspaceNodes();

  // Registers the GCS store factory when WORKSPACE_STORE=gcs, and fails fast on a half-configured
  // store. Deliberately the SAME function the conductor job and the continuation tick call, so all
  // three bind to one store or none of them do.
  const { bootstrapWorkspaceStore } = await import("../src/agent/entrypoints/runConductorJob.js");
  bootstrapWorkspaceStore();

  // Lazy, exactly like seedNodesFromWorkspace.ts: importing the live repository needs store
  // credentials this process may not have, and every pure code path above this line must be
  // reachable — and tested — without ever touching it.
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  const workspaceRepository = repositoryManager.getWorkspaceRepository();
  const store = await workspaceRepository.getNodes();

  const plan = planReseed({ canonical, store, nodeId, allowPromptShrink, allowCapabilityLoss });
  // Distinct operation, only computed when explicitly requested — see PlannedWriteKind's comment for
  // why this can never appear from --write alone.
  const modeResult = modeValue === undefined ? undefined : planPublishExecutorMode({ store, mode: modeValue });
  const combinedWrites = [...plan.writes, ...(modeResult?.status === "write" ? [modeResult.write] : [])];
  const combinedRefusals = [...plan.refusals, ...(modeResult?.status === "refused" ? [modeResult.refusal] : [])];

  if (json) {
    say(JSON.stringify({ writes: combinedWrites, refusals: combinedRefusals, upToDate: plan.upToDate, publishExecutorModeUpToDate: modeResult?.status === "up_to_date", redeployRequired: REDEPLOY_NOTE }, null, 2));
  } else {
    say(`canonical         ${canonical.length} nodes from src/agent/workspace/nodes.ts`);
    // Naming the backend and bucket/store on every run is not decoration: the 2026-08-14 false green
    // above was indistinguishable from a real "no drift" result precisely because the output never
    // said WHICH store it had just agreed with.
    say(`store             ${store.length} nodes from WORKSPACE_STORE=${backend}${backend === "gcs" ? ` bucket=${process.env.GCS_BUCKET}` : ` store=${process.env.NETLIFY_BLOBS_STORE_NAME ?? "cms-agent"}`}`);
    say(`allowlist         ${RESEED_ALLOWLIST.length} (nodeId, field) pair(s)${nodeId ? ` (restricted to ${nodeId})` : ""}`);
    say("");
    for (const item of plan.upToDate) say(`up to date        ${item.nodeId}.${item.field}`);
    if (modeResult?.status === "up_to_date") say(`up to date        publish_executor.metadata.publishExecutorDeterministic (already "${modeValue}")`);
    for (const item of plan.writes) say(`drift             ${item.nodeId}.${item.field}  ${item.beforeLength} -> ${item.afterLength} chars (Δ${item.charDelta >= 0 ? "+" : ""}${item.charDelta})  ${item.firstDifference}`);
    if (modeResult?.status === "write") {
      say(`mode change       publish_executor.metadata (merge-only)`);
      say(`  before  ${JSON.stringify(modeResult.write.beforeValue)}`);
      say(`  after   ${JSON.stringify(modeResult.write.afterValue)}`);
    }
    for (const item of combinedRefusals) say(`refuse            ${item.nodeId}${item.field ? `.${item.field}` : ""}  ${item.reason}`);
    say("");
  }

  if (combinedRefusals.length) {
    warn(`✗ Refusing ${combinedRefusals.length} pair(s)/operation(s). Nothing was written.`);
    warn(REDEPLOY_NOTE);
    process.exit(1);
  }

  if (!write) {
    if (combinedWrites.length === 0) { say("store matches the requested target for every pair/operation."); say(REDEPLOY_NOTE); return; }
    warn(`✗ store DRIFTED for ${combinedWrites.length} pair(s)/operation(s). Re-seed with:`);
    // One `--` separator only: npm passes everything after the first one straight through, so a
    // second `--` would be handed to the script as a literal argument.
    warn(`    npm run store:update${nodeId || modeValue ? " --" : ""}${nodeId ? ` --node ${nodeId}` : ""}${modeValue ? ` --set-publish-executor-mode ${modeValue}` : ""}`);
    warn(REDEPLOY_NOTE);
    process.exit(1);
  }

  // --write: sequential, never parallel. Stop at the first failure and report exactly which pairs
  // already landed and which did not — an operator retrying must never have to diff the store by hand
  // to find out.
  const applied: string[] = [];
  for (const item of combinedWrites) {
    const label = `${item.nodeId}.${item.field}`;
    const eventType = item.kind === "publish_executor_mode" ? "node.metadata_merged" : `reseed.${item.field}_from_canonical`;
    try {
      await workspaceRepository.updateNode(item.nodeId, { [item.field]: item.afterValue } as Partial<WorkspaceNode>, buildMutationMeta(item.nodeId, item.field, item.note), eventType);
      applied.push(label);
      say(`written           ${label}`);
    } catch (error) {
      const remaining = combinedWrites.slice(combinedWrites.indexOf(item)).map((pending) => `${pending.nodeId}.${pending.field}`);
      warn(`✗ write failed at ${label}: ${(error as Error).message}`);
      warn(`    already written: ${applied.length ? applied.join(", ") : "none"}`);
      warn(`    NOT written (stopped here, sequential order): ${remaining.join(", ")}`);
      process.exit(1);
    }
  }
  say(combinedWrites.length ? `${combinedWrites.length} pair(s)/operation(s) written.` : "nothing to write; store already matched the requested target.");
  say(REDEPLOY_NOTE);
};

// Only self-execute when run directly (`tsx scripts/reseedStoreFromCanonical.ts`), so the pure
// planner above stays importable from tests without ever touching the live repository or calling
// process.exit — the same guard scripts/twoPlaneDrift.ts uses.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    warn("reseedStoreFromCanonical.ts failed to run:");
    warn(String((error as Error)?.stack ?? error));
    process.exit(1);
  });
}
