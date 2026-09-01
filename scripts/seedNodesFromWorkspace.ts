#!/usr/bin/env tsx
/**
 * Regenerate src/agent/workspace/nodes.ts — the CANONICAL Publishing Conductor definitions — from the
 * live workspace store.
 *
 * WHY THIS FILE EXISTS (R-22)
 *
 * `resolveConductorNodes()` resolves the node list one of two ways. Static (the default) is exactly
 * `listWorkspaceNodes()` from nodes.ts. Store mode (WORKSPACE_NODES_SOURCE=store) OVERLAYS each canonical
 * node with its stored counterpart. It was recorded that R-22 could be settled either by flipping that
 * default or by re-seeding nodes.ts. It cannot. Store mode is not capable of delivering a rebuilt
 * pipeline, for two reasons in the code itself:
 *
 *   1. `resolveConductorNodes` maps over `canonical`, so a store node with no canonical counterpart is
 *      IGNORED. Three live nodes have none — contract_intelligence, artifact_plan, publish_executor.
 *   2. `overlayStoreNode` deliberately pins the fields that define the graph — dependsOn, produces,
 *      riskLevel, position, status — to the canonical definition, so a store edit "can never rewire the
 *      graph or downgrade a publish-risk gate". Four live edges differ from canonical and would all be
 *      discarded.
 *
 * That pinning is correct and worth keeping: it is what stops a promoted prompt from quietly rewiring a
 * publish gate. It also means the ONLY way live topology reaches a conductor run is for an operator to
 * re-seed the canonical definitions deliberately — which is this script.
 *
 * And it must be a script, not a hand-edit. "Workspace fix ≠ fixed" is a trap this project has paid for
 * three times (snoocle, fourteen ungrantable grants, and the entire node set). It bites precisely because
 * code-defined defaults drift away from the store with nothing watching. A hand-transcribed nodes.ts drifts
 * again on the next authoring edit; a generator plus `--check` in CI does not.
 *
 * Usage:
 *   npm run nodes:check                     # exit 1 if nodes.ts differs from the source (drift gate)
 *   npm run nodes:update                    # rewrite nodes.ts from the live workspace
 *   tsx scripts/seedNodesFromWorkspace.ts --from snapshot.json --write
 *   npm run nodes:update -- --allow-prompt-shrink   # confirm a deliberate prompt cut (see MAX_PROMPT_SHRINK)
 *
 * `--from` accepts a workspace.get_nodes / workspace.export_workspace payload: `{ok,data:{nodes}}`,
 * `{nodes}`, or a bare array — no credentials needed, which makes it the route for anyone holding an
 * MCP session but not a GCP one. Without it the live WorkspaceRepository is read, which needs
 * WORKSPACE_STORE=gcs plus GCS_BUCKET and GCP credentials (or WORKSPACE_STORE=blobs plus
 * NETLIFY_BLOBS_SITE_ID/TOKEN). An unset WORKSPACE_STORE is refused by name rather than silently
 * read as an empty workspace — see liveRepositoryManager below.
 *
 * SAFETY. The script refuses rather than writes when the incoming set would weaken the conductor:
 * a canonical node disappearing, a riskLevel stepping DOWN the ladder, a publish-risk node acquiring
 * project.call_tool, a graph that fails validateWorkspaceGraph, or a node missing a field the runtime
 * spreads. A re-seed is allowed to add gates and change edges; it is not allowed to remove a gate.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureConductorNodes } from "../src/agent/workspace/captureConductorNodes.js";
import { cloneConductorNodes } from "../src/agent/workspace/cloneConductorNodes.js";
import { getWorkspaceNode, listWorkspaceNodes, validateWorkspaceGraph } from "../src/agent/workspace/nodes.js";
import { publishingTailConformanceIssues } from "../src/agent/workspace/publishingTail.js";
import { recipeAuthorityConformanceIssues } from "../src/agent/workspace/publishableTypeCharter.js";
import { seededSkillDefinitions } from "../src/agent/skills/seededSkills.js";
import type { SkillDefinition } from "../src/agent/skills/skillTypes.js";
import type { WorkspaceNode } from "../src/agent/workspace/nodeTypes.js";

const NODES_PATH = fileURLToPath(new URL("../src/agent/workspace/nodes.ts", import.meta.url));
const SKILLS_PATH = fileURLToPath(new URL("../src/agent/skills/seededSkills.ts", import.meta.url));
const OPEN_MARKER = "export const publishingConductorNodes = [";
const CLOSE_MARKER = "] satisfies WorkspaceNode[];";

// Ascending order of authority. A re-seed may raise a node's rung (adding a gate) but never lower it.
const RISK_LADDER = ["read", "write", "publish", "admin"];

// A re-seed may tighten a prompt; it may not gut one.
//
// 2026-08-10 incident. A session rewrote three live prompts and a re-seed carried them into code with
// no complaint, because every guard below this line watches TOPOLOGY — nodes, edges, risk rungs, tool
// grants — and nothing watched PROSE. article_body went 7271 -> 2473 chars (-66%), losing the private
// annotation policy, the reader-projection leak rule, the media placement rule this store elsewhere
// records as a build-breaker, and the clientProjectId cross-client guard. contract_intelligence went
// 5738 -> 1854 (-68%), losing taxonomy, constraint severity and pin rules that two downstream nodes
// still block on — leaving them blocked on facts nobody produces. None of it moved to canonicalRules
// or the schemas; it simply stopped existing.
//
// The threshold is deliberately loose. Real editing passes tighten a prompt by a few percent; a rewrite
// that removes a third of a node's operating rules is a different act and should be stated out loud.
// `--allow-prompt-shrink` is the way to say it out loud, and it is recorded in the run output.
const MAX_PROMPT_SHRINK = 0.4;
const ALLOW_SHRINK_FLAG = "--allow-prompt-shrink";

// Fields listWorkspaceNodes() spreads or copies. A node missing any of them would crash the runtime or
// silently lose data, so an incomplete source is refused rather than emitted.
export const REQUIRED_FIELDS = ["id", "name", "kind", "description", "prompt", "schema", "inputSchema", "outputSchema", "allowedTools", "assignedSkills", "requiredInputs", "produces", "riskLevel", "dependsOn", "status", "position"] as const;

// Key order in the emitted literal. Fixed so a re-run produces a byte-identical file and `--check` reports
// real drift instead of key shuffling.
const KEY_ORDER = [...REQUIRED_FIELDS, "updatedAt", "metadata"];

const say = (message: string) => process.stdout.write(`${message}\n`);
const die = (message: string, detail: string[] = []): never => {
  process.stderr.write(`\n✗ ${message}\n`);
  for (const line of detail) process.stderr.write(`    ${line}\n`);
  process.stderr.write("\nnodes.ts was NOT written.\n");
  process.exit(1);
};

// T15.16 (#195) seeded capture_conductor's and clone_conductor's OWN upstream nodes into the SAME
// workspace store document as publishing_conductor's (see workspaceStoreNodes.ts), so that ids like
// block_classifier and fit_adjudicator became GOVERNABLE through the workspace.* surface instead of
// reading back null. This script predates that and reads the store WHOLE, treating every row it gets
// back as a publishing_conductor node: it runs every guard over them and renders them into
// publishingConductorNodes.
//
// Since #195 that is wrong in both directions, and the live store now returns 49 rows where this
// script assumes publishing_conductor's own 25:
//
//   1. `npm run nodes:check` refuses on 24 rows for a missing `schema` — a field REQUIRED_FIELDS
//      still demands but which nodeTypes.ts marks @deprecated and optional, which capture/clone
//      therefore correctly never declared, and which nothing in src/ or netlify/ reads except
//      overlayStoreNode's `stored.schema ?? canonical.schema`. So the LIVE drift gate does not run at
//      all. `nodes:check:offline` (--from-canonical) never reads the store, so CI stayed green and
//      nothing said the gate was down — precisely the "workspace fix != fixed" shape this file exists
//      to catch, running one level up.
//   2. Were that refusal satisfied (by backfilling `schema` onto those 24, the obvious wrong fix), the
//      very NEXT `nodes:update` would fold all 24 into publishing_conductor's canonical array — the
//      tail-forking hazard workspaceStoreNodes.ts's own header exists to prevent, written into code.
//
// So the source is scoped here, ONCE, before any guard or the renderer sees it.
//
// By EXCLUSION, never by an allowlist of publishing's current ids. Adding a node in the store and
// re-seeding it into nodes.ts is a supported act this script reports as `nodes added`; an inclusion
// list would silently swallow exactly that. And the excluded set is read from the capture/clone node
// modules themselves rather than a second hand-kept list here, so a capture/clone node added later is
// excluded automatically instead of drifting back in the day someone forgets this file exists.
const OTHER_WORKFLOW_NODE_IDS = new Set([...captureConductorNodes, ...cloneConductorNodes].map((node) => node.id));

export const scopeToPublishingConductor = (source: WorkspaceNode[]): { scoped: WorkspaceNode[]; excluded: string[] } => {
  // The RAW capture/clone arrays declare no shared-tail node — they only depend on tail ids
  // (publish_executor, release_executor) that resolve against the tail's own canonical row.
  // workspaceStoreNodes.ts relies on the same property to merge the three sets without a collision.
  // If it ever stops holding, excluding these ids would silently DELETE a publishing node from
  // nodes.ts, so it is checked rather than assumed.
  const collisions = listWorkspaceNodes().filter((node) => OTHER_WORKFLOW_NODE_IDS.has(node.id)).map((node) => node.id);
  if (collisions.length) {
    die(`Cannot scope the source: ${collisions.length} publishing_conductor node(s) share an id with a capture/clone node.`, [
      ...collisions,
      "The raw capture/clone arrays are supposed to declare no shared-tail node (workspaceStoreNodes.ts).",
      "Excluding them would delete these from nodes.ts. Fix the id collision before re-seeding."
    ]);
  }
  return {
    scoped: source.filter((node) => !OTHER_WORKFLOW_NODE_IDS.has(node.id)),
    excluded: source.filter((node) => OTHER_WORKFLOW_NODE_IDS.has(node.id)).map((node) => node.id)
  };
};

// S3: `--from-canonical` feeds the generator the COMPILED canonical set (nodes.ts as built), so the
// drift gate can run offline (`npm run nodes:check:offline`, CI): it proves nodes.ts round-trips
// through the generator byte-for-byte — a hand-edit the generator would not reproduce fails here.
// It does NOT prove parity with the LIVE store; `npm run nodes:check` (credentials) still does that.
const FROM_CANONICAL_FLAG = "--from-canonical";
// THE LIVE READ, MADE ACTUALLY POSSIBLE.
//
// Before this, `npm run nodes:check` / `nodes:update` could not read the production store from
// anywhere — not a laptop, not Cloud Shell, not CI:
//
//   * with no env, WORKSPACE_STORE defaults to "memory". The read returned an EMPTY workspace, the
//     generator saw every canonical node "disappear", and refused. A correct refusal about garbage
//     input, which reads exactly like a broken script.
//   * with WORKSPACE_STORE=gcs, blobClient.ts threw outright: the GCS store factory is registered by
//     an ENTRYPOINT (bootstrapWorkspaceStore in runConductorJob.ts) and this script is not one.
//
// So the drift gate this script exists to be could never run against live, which is why canonical
// and the store were free to diverge unobserved. Both holes are closed here: the same
// bootstrapWorkspaceStore the Cloud Run entrypoint uses is called before the repositories are
// touched (construction is lazy — see runtime/repositories.ts — so importing it registers nothing
// and builds nothing), and an unconfigured store is refused BY NAME instead of being read as empty.
const liveRepositoryManager = async () => {
  const store = (process.env.WORKSPACE_STORE ?? "memory").trim();
  if (store === "" || store === "memory") {
    die(
      'WORKSPACE_STORE is unset, so it defaults to "memory" — reading the live workspace would return an EMPTY node set and this generator would report every canonical node as deleted. ' +
      "Either point it at the production store (WORKSPACE_STORE=gcs GCS_BUCKET=<bucket> [GCS_KEY_PREFIX=...], with GCP credentials), " +
      "or pass --from <snapshot.json> holding a workspace.export_workspace / workspace.get_nodes payload, which needs no credentials at all."
    );
  }
  // Registers the GCS store factory for WORKSPACE_STORE=gcs and validates the blobs credentials for
  // WORKSPACE_STORE=blobs. Reused rather than re-implemented: "how to reach the production store" is
  // defined once, in the entrypoint, and this script is now a second caller of that one definition.
  const { bootstrapWorkspaceStore } = await import("../src/agent/entrypoints/runConductorJob.js");
  bootstrapWorkspaceStore();
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  return repositoryManager;
};

const readSource = async (from?: string, fromCanonical = false): Promise<WorkspaceNode[]> => {
  if (fromCanonical) return JSON.parse(JSON.stringify(listWorkspaceNodes())) as WorkspaceNode[];
  if (from) {
    const parsed = JSON.parse(await readFile(from, "utf8"));
    const nodes = Array.isArray(parsed) ? parsed : parsed?.data?.nodes ?? parsed?.nodes;
    if (!Array.isArray(nodes)) die(`${from} does not contain a node array (looked at the root, .nodes and .data.nodes).`);
    return nodes as WorkspaceNode[];
  }
  return (await liveRepositoryManager()).getWorkspaceRepository().getNodes();
};

const readSkillSource = async (from?: string): Promise<SkillDefinition[] | undefined> => {
  if (from) {
    const parsed = JSON.parse(await readFile(from, "utf8"));
    const skills = Array.isArray(parsed) ? parsed : parsed?.data?.skills ?? parsed?.skills;
    if (!Array.isArray(skills)) die(`${from} does not contain a skill array (looked at the root, .skills and .data.skills).`);
    return skills as SkillDefinition[];
  }
  return (await liveRepositoryManager()).getSkillRepository().list();
};

// Nodes reference skills by id, so re-seeding nodes alone can leave the canonical graph pointing at skills
// the code-defined defaults do not ship. That is not hypothetical: re-seeding the 21 live nodes against the
// old skill defaults produced THIRTEEN blocker-severity attention items in a fresh workspace — ten
// "Assigned skill not found" (dr_lurie_contract_intelligence, dr_lurie_dtc_science_editorial) and five
// "Skill output schema is incompatible", because five generic skills had their output schemas relaxed in
// the live workspace on 2026-07-26 and that fix never reached code. Live was clean the whole time, which is
// exactly why nobody saw it. Both halves are re-seeded together, and this check refuses the mismatch.
const skillIntegrityProblems = (nodes: WorkspaceNode[], skills: SkillDefinition[]): string[] => {
  const available = new Set(skills.map((skill) => skill.skillId));
  const problems: string[] = [];
  for (const node of nodes) {
    for (const skillId of node.assignedSkills ?? []) {
      if (!available.has(skillId)) problems.push(`${node.id}: assigned skill "${skillId}" is not in the seeded skill set. A fresh workspace would raise a blocker-severity conflict for it.`);
    }
  }
  return problems;
};

// Dependency-respecting order, tie-broken by the existing canonical order so a re-seed is the smallest
// possible diff. The store returns nodes in write order (input_triage arrives fifth live), which would
// churn the file and change which node the conductor considers "first runnable" for no reason.
const topologicallyOrdered = (nodes: WorkspaceNode[]): WorkspaceNode[] => {
  const canonicalIndex = new Map(listWorkspaceNodes().map((node, index) => [node.id, index]));
  const rank = (node: WorkspaceNode) => canonicalIndex.get(node.id) ?? Number.MAX_SAFE_INTEGER;
  const remaining = [...nodes].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const emitted: WorkspaceNode[] = [];
  const emittedIds = new Set<string>();
  const present = new Set(nodes.map((node) => node.id));
  while (remaining.length) {
    // Only dependencies that exist in this set can gate emission; a dangling dependency is reported by
    // validateWorkspaceGraph rather than deadlocking this loop.
    const index = remaining.findIndex((node) => node.dependsOn.every((dependency) => !present.has(dependency) || emittedIds.has(dependency)));
    if (index === -1) {
      // A cycle. Emit the rest in stable order and let validateWorkspaceGraph name it precisely.
      emitted.push(...remaining);
      break;
    }
    const [next] = remaining.splice(index, 1);
    emitted.push(next);
    emittedIds.add(next.id);
  }
  return emitted;
};

const orderKeys = (node: WorkspaceNode): Record<string, unknown> => {
  const entry = node as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (entry[key] !== undefined) ordered[key] = entry[key];
  // Anything the store grows later still travels, just after the known keys, so a new field is never
  // silently dropped on the floor by this script.
  for (const key of Object.keys(entry).sort()) if (!(key in ordered) && entry[key] !== undefined) ordered[key] = entry[key];
  return ordered;
};

/**
 * Prompt erosion and gate regression — the two ways a re-seed can weaken the pipeline without
 * touching a single edge, and the two the topology guards below are blind to.
 *
 * Erosion runs workspace -> code: a gutted live prompt gets baked into the canonical definitions.
 * Regression runs the other way and is the older bug: a gate opened in the LIVE workspace and never
 * re-seeded means code still ships the closed version, so every fresh workspace and every static-mode
 * run silently gets the blocked node. publish_executor carried exactly that for eleven days — the
 * 2026-07-31 go-live removed its draft gate live, code kept `status: "draft"` and
 * `activationRequired: true`, and nothing compared them. This is the "workspace fix ≠ fixed" trap
 * this file's own header names, caught in the direction the header did not cover.
 */
const promptAndGateProblems = (incoming: WorkspaceNode[], allowShrink: boolean): string[] => {
  const problems: string[] = [];
  const canonicalById = new Map(listWorkspaceNodes().map((node) => [node.id, node]));

  for (const node of incoming) {
    const existing = canonicalById.get(node.id);
    if (!existing) continue;

    const before = (existing.prompt ?? "").length;
    const after = (node.prompt ?? "").length;
    if (before > 0 && after < before) {
      const shrink = (before - after) / before;
      if (shrink > MAX_PROMPT_SHRINK && !allowShrink) {
        problems.push(
          `${node.id}: prompt would shrink ${before} -> ${after} chars (-${Math.round(shrink * 100)}%), past the ${Math.round(MAX_PROMPT_SHRINK * 100)}% ceiling. ` +
          `A prompt carries this node's operating rules; losing a third of it loses rules that nothing else enforces. ` +
          `Diff it, move anything still wanted into canonicalRules or the schemas, then re-run with ${ALLOW_SHRINK_FLAG} to confirm the cut is intended.`
        );
      }
    }

    // A canonical rule is the distilled, load-bearing half of a prompt. Dropping one during a re-seed
    // is the same class of loss as erosion, and cheaper to detect precisely.
    const beforeRules: string[] = (existing.metadata as { canonicalRules?: string[] } | undefined)?.canonicalRules ?? [];
    const afterRules: string[] = (node.metadata as { canonicalRules?: string[] } | undefined)?.canonicalRules ?? [];
    const droppedRules = beforeRules.filter((rule) => !afterRules.includes(rule));
    if (droppedRules.length && !allowShrink) {
      problems.push(`${node.id}: would drop ${droppedRules.length} canonicalRule(s): ${droppedRules.map((rule) => JSON.stringify(rule)).join("; ")}. Re-run with ${ALLOW_SHRINK_FLAG} if the rule is genuinely retired.`);
    }

    // Gate regression. Never blocked — code is being brought INTO line with live here, which is the
    // whole point of the script — but it must be said, loudly, because it is invisible otherwise.
    if (existing.status !== node.status) {
      problems.push(`NOTE ${node.id}: status ${existing.status} -> ${node.status}. Canonical and live disagreed; the re-seed adopts live.`);
    }
    const beforeActivation = (existing.metadata as { activationRequired?: boolean } | undefined)?.activationRequired ?? false;
    const afterActivation = (node.metadata as { activationRequired?: boolean } | undefined)?.activationRequired ?? false;
    if (beforeActivation !== afterActivation) {
      problems.push(`NOTE ${node.id}: activationRequired ${beforeActivation} -> ${afterActivation}. Canonical and live disagreed; the re-seed adopts live.`);
    }
  }
  return problems;
};

const refuseUnsafe = (incoming: WorkspaceNode[], allowShrink = false): void => {
  const problems: string[] = [];
  const canonical = listWorkspaceNodes();
  const incomingById = new Map(incoming.map((node) => [node.id, node]));

  // NOTE-prefixed entries are reported but never block: they record a real divergence the operator
  // should see, in a direction that is safe to adopt.
  const promptProblems = promptAndGateProblems(incoming, allowShrink);
  for (const note of promptProblems.filter((problem) => problem.startsWith("NOTE "))) say(`divergence        ${note.slice(5)}`);
  problems.push(...promptProblems.filter((problem) => !problem.startsWith("NOTE ")));

  for (const node of incoming) {
    const missing = REQUIRED_FIELDS.filter((field) => (node as unknown as Record<string, unknown>)[field] === undefined);
    if (missing.length) problems.push(`${node.id}: missing ${missing.join(", ")} — the runtime spreads these and would lose or crash on them.`);
  }

  for (const existing of canonical) {
    const replacement = incomingById.get(existing.id);
    if (!replacement) {
      problems.push(`${existing.id}: present in canonical nodes.ts but absent from the source. A re-seed must not delete a conductor node — export the workspace and check the node was not renamed.`);
      continue;
    }
    const before = RISK_LADDER.indexOf(existing.riskLevel);
    const after = RISK_LADDER.indexOf(replacement.riskLevel);
    if (after < before) problems.push(`${existing.id}: riskLevel would drop ${existing.riskLevel} -> ${replacement.riskLevel}. A re-seed may add a gate, never remove one.`);
  }

  // project.call_tool on a publish-risk node is a deliberate decision in BOTH directions, so a re-seed
  // may not make it by accident either way.
  //
  //   Gaining it: opening a capability on a publish-risk node is a reviewed act, not a side effect of
  //   syncing from a store someone edited.
  //
  //   Losing it: publish_executor and publication_controller hold it canonically as of 2026-07-29,
  //   because without it a publisher cannot reach the client at all — both nodes resolved allowed:false
  //   with ["node_tool_not_allowed","approval_required"]. A re-seed from a store that predates that
  //   change would silently take it back, which is precisely the "workspace fix ≠ fixed" drift this
  //   script exists to catch, running in the other direction.
  for (const node of incoming) {
    if (node.riskLevel !== "publish" && node.riskLevel !== "admin") continue;
    const canonicalGrant = listWorkspaceNodes().find((existing) => existing.id === node.id)?.allowedTools.includes("project.call_tool") ?? false;
    const incomingGrant = node.allowedTools.includes("project.call_tool");
    if (incomingGrant === canonicalGrant) continue;
    problems.push(incomingGrant
      ? `${node.id}: publish-risk node would GAIN project.call_tool, which canonical does not grant. Open that capability deliberately, not through a re-seed.`
      : `${node.id}: publish-risk node would LOSE project.call_tool, which canonical grants deliberately — without it this node cannot reach the client at all. Grant the tool in the live workspace first (workspace.update_node_tools), then re-seed.`);
  }

  const validation = validateWorkspaceGraph(incoming);
  if (!validation.valid) problems.push(...validation.issues.map((issue) => `graph: ${issue}`));

  // §2.23: the publishing tail (contract_intelligence → … → learning_recorder) is a SHARED sub-graph
  // declared once in src/agent/workspace/publishingTail.ts and reused by every workflow. A re-seed
  // whose tail diverges from that declaration would fork the tail for this workflow only — every
  // future gate/fix would then have to land N times — so it refuses here. A deliberate tail change is
  // still possible: update publishingTail.ts in the same change, then re-seed.
  problems.push(...publishingTailConformanceIssues(incoming).map((issue) => `tail: ${issue} — the tail is declared in src/agent/workspace/publishingTail.ts; a deliberate tail change must update that declaration in the same change.`));

  // T15.29 (#205; ADR-2026-08-25-structure-studio §2.2) — enforcement point 1's reseed-time twin,
  // the same reasoning as the tail check just above: this script seeds publishing_conductor's OWN
  // canonical node array into nodes.ts, so a re-seed that would grant it a recipe-authoring verb
  // (object_create/object_patch/site_apply_theme against theme/site/section_template/template) is
  // caught here, before it ever reaches the store — not just in the CI conformance test.
  problems.push(...recipeAuthorityConformanceIssues(incoming, "publishing_conductor").map((issue) => `structure authority: ${issue} — ADR-2026-08-25-structure-studio §2.2: only the studio (clone_conductor) authors structure.`));

  if (problems.length) die(`Refusing to re-seed ${problems.length} problem(s):`, problems);
};

// W6.5 / S3: nodes.ts references two SHARED enum property objects by identifier
// (`TRAFFIC_SOURCE_ENUM_PROPERTY`, `AWARENESS_STAGE_ENUM_PROPERTY`, both derived from
// aggressionVector.ts's canonical value lists) instead of inlining a copy of the enum into every
// schema that validates the field. The store holds the inlined values (JSON has no identifiers), so
// the renderer re-substitutes the identifier wherever a schema property deep-equals the shared
// object. This is what lets the generator round-trip nodes.ts byte-for-byte (the offline drift gate,
// `npm run nodes:check:offline`) and keeps a re-seed from silently forking the enum 2×N times.
// The shared objects are read off a node that references them by identifier (brief_architect's
// outputSchema), so nodes.ts need not export them and this list can never disagree with the file.
const sharedProperty = (name: string): unknown => ((getWorkspaceNode("brief_architect")?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})[name];
const SHARED_SCHEMA_PROPERTIES: Array<{ identifier: string; value: unknown }> = [
  { identifier: "TRAFFIC_SOURCE_ENUM_PROPERTY", value: sharedProperty("trafficSource") },
  { identifier: "AWARENESS_STAGE_ENUM_PROPERTY", value: sharedProperty("awarenessStage") }
].filter((entry) => entry.value !== undefined);
const SHARED_PLACEHOLDER = (identifier: string): string => `__SHARED_SCHEMA_PROPERTY__${identifier}__`;
const substituteSharedProperties = (value: unknown): unknown => {
  for (const shared of SHARED_SCHEMA_PROPERTIES) if (JSON.stringify(value) === JSON.stringify(shared.value)) return SHARED_PLACEHOLDER(shared.identifier);
  if (Array.isArray(value)) return value.map(substituteSharedProperties);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, substituteSharedProperties(child)]));
  return value;
};
const restoreSharedIdentifiers = (rendered: string): string =>
  SHARED_SCHEMA_PROPERTIES.reduce((text, shared) => text.split(JSON.stringify(SHARED_PLACEHOLDER(shared.identifier))).join(shared.identifier), rendered);

const render = (nodes: WorkspaceNode[], original: string): string => {
  const open = original.indexOf(OPEN_MARKER);
  const close = original.indexOf(CLOSE_MARKER, open);
  if (open === -1 || close === -1) die("Could not find the publishingConductorNodes array literal in nodes.ts. The file's shape changed; update OPEN_MARKER / CLOSE_MARKER.");
  const body = nodes.map((node) => restoreSharedIdentifiers(JSON.stringify(substituteSharedProperties(orderKeys(node)), null, 2)).split("\n").map((line) => `  ${line}`).join("\n")).join(",\n");
  return `${original.slice(0, open)}${OPEN_MARKER}\n${body}\n${original.slice(close)}`;
};

const renderSkills = (skills: SkillDefinition[]): string => {
  const body = [...skills]
    .sort((a, b) => a.skillId.localeCompare(b.skillId))
    .map((skill) => JSON.stringify(skill, null, 2).split("\n").map((line) => `  ${line}`).join("\n"))
    .join(",\n");
  return `// GENERATED by scripts/seedNodesFromWorkspace.ts — do not edit by hand.
//
// The skill definitions a fresh workspace is seeded with, captured from the live workspace store. They live
// in their own generated file (rather than hand-written in skillRegistry.ts) for the same reason nodes.ts is
// generated: a skill edited in the workspace and not mirrored here means every fresh workspace re-seeds the
// old definition, and nothing notices — the workspace looks fixed while the code still ships the defect.
//
// Re-seed with:  npm run nodes:update
// Check drift:   npm run nodes:check
import type { SkillDefinition } from "./skillTypes.js";

export const seededSkillDefinitions: SkillDefinition[] = [
${body}
];
`;
};

const main = async () => {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const allowShrink = args.includes(ALLOW_SHRINK_FLAG);
  const fromIndex = args.indexOf("--from");
  const from = fromIndex === -1 ? undefined : args[fromIndex + 1];
  const skillsIndex = args.indexOf("--skills");
  const skillsFrom = skillsIndex === -1 ? undefined : args[skillsIndex + 1];

  const fromCanonical = args.includes(FROM_CANONICAL_FLAG);
  const source = await readSource(from, fromCanonical);
  say(`source            ${source.length} nodes from ${fromCanonical ? "the compiled canonical set (nodes.ts)" : from ?? "the live workspace store"}`);

  // #195 scoping — see scopeToPublishingConductor. The live store holds all three workflows' nodes;
  // this script seeds publishing_conductor's canonical array only.
  const { scoped, excluded } = scopeToPublishingConductor(source);
  if (excluded.length) say(`scoped            ${excluded.length} capture/clone node(s) excluded — this script seeds publishing_conductor only: ${excluded.join(", ")}`);

  const ordered = topologicallyOrdered(scoped);
  refuseUnsafe(ordered, allowShrink);
  if (allowShrink) say(`prompt guard      DISABLED via ${ALLOW_SHRINK_FLAG} — prompt shrink and canonicalRule removal were explicitly permitted for this run`);

  // Skills travel with the nodes that reference them, or the graph points at things that do not exist.
  const skills = ((from || fromCanonical) && !skillsFrom) ? seededSkillDefinitions : (await readSkillSource(skillsFrom)) ?? seededSkillDefinitions;
  say(`skills            ${skills.length} from ${skillsFrom ?? (from ? "the current seeded set (no --skills given)" : "the live workspace store")}`);
  const integrity = skillIntegrityProblems(ordered, skills);
  if (integrity.length) die(`Refusing to re-seed — ${integrity.length} node/skill reference problem(s):`, [...new Set(integrity)]);

  const original = await readFile(NODES_PATH, "utf8");
  const rendered = render(ordered, original);
  const originalSkills = await readFile(SKILLS_PATH, "utf8").catch(() => "");
  const renderedSkills = renderSkills(skills);
  const canonical = listWorkspaceNodes();

  const added = ordered.filter((node) => !canonical.some((existing) => existing.id === node.id)).map((node) => node.id);
  const edgeChanges = ordered
    .map((node) => ({ node, existing: canonical.find((candidate) => candidate.id === node.id) }))
    .filter(({ node, existing }) => existing && JSON.stringify([...existing.dependsOn].sort()) !== JSON.stringify([...node.dependsOn].sort()))
    .map(({ node, existing }) => `${node.id}: [${existing!.dependsOn.join(", ")}] -> [${node.dependsOn.join(", ")}]`);

  say(`graph             valid`);
  say(`nodes added       ${added.length ? added.join(", ") : "none"}`);
  say(`edges changed     ${edgeChanges.length ? "" : "none"}`);
  for (const change of edgeChanges) say(`                  ${change}`);
  say(`publish-risk      ${ordered.filter((node) => node.riskLevel === "publish" || node.riskLevel === "admin").map((node) => node.id).join(", ")}`);

  // Hand-written `//` notes inside the array literal (edge-history comments next to a dependsOn) are
  // not data the generator can reproduce; they are ignored for the drift verdict, and preserved when
  // nothing else changed (the file is only rewritten when the DATA drifted).
  const stripArrayComments = (text: string): string => text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  const nodesDrifted = stripArrayComments(rendered) !== stripArrayComments(original);
  const skillsDrifted = renderedSkills !== originalSkills;
  if (!nodesDrifted && !skillsDrifted) {
    say("nodes.ts          up to date");
    say("seededSkills.ts   up to date");
    return;
  }
  if (!write) {
    say("");
    if (nodesDrifted) say("nodes.ts          DRIFTED from the source");
    if (skillsDrifted) say("seededSkills.ts   DRIFTED from the source");
    say("                  Re-seed with:");
    say("                    npm run nodes:update && git add src/agent/workspace/nodes.ts src/agent/skills/seededSkills.ts");
    process.exit(1);
  }
  if (nodesDrifted) { await writeFile(NODES_PATH, rendered, "utf8"); say(`nodes.ts          written  ${ordered.length} nodes`); }
  else say("nodes.ts          up to date");
  if (skillsDrifted) { await writeFile(SKILLS_PATH, renderedSkills, "utf8"); say(`seededSkills.ts   written  ${skills.length} skills`); }
  else say("seededSkills.ts   up to date");
};

// Only self-execute when run directly (`tsx scripts/seedNodesFromWorkspace.ts`), so the pure scoping
// logic above stays importable from tests without reading the live store or calling process.exit —
// the same guard scripts/reseedStoreFromCanonical.ts and scripts/twoPlaneDrift.ts use.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) await main();
