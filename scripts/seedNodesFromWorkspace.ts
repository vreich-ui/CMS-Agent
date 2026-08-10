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
 *
 * `--from` accepts a workspace.get_nodes / workspace.export_workspace payload: `{ok,data:{nodes}}`,
 * `{nodes}`, or a bare array. Without it the live WorkspaceRepository is read, which needs store
 * credentials.
 *
 * SAFETY. The script refuses rather than writes when the incoming set would weaken the conductor:
 * a canonical node disappearing, a riskLevel stepping DOWN the ladder, a publish-risk node acquiring
 * project.call_tool, a graph that fails validateWorkspaceGraph, or a node missing a field the runtime
 * spreads. A re-seed is allowed to add gates and change edges; it is not allowed to remove a gate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listWorkspaceNodes, validateWorkspaceGraph } from "../src/agent/workspace/nodes.js";
import { publishingTailConformanceIssues } from "../src/agent/workspace/publishingTail.js";
import { seededSkillDefinitions } from "../src/agent/skills/seededSkills.js";
import type { SkillDefinition } from "../src/agent/skills/skillTypes.js";
import type { WorkspaceNode } from "../src/agent/workspace/nodeTypes.js";

const NODES_PATH = fileURLToPath(new URL("../src/agent/workspace/nodes.ts", import.meta.url));
const SKILLS_PATH = fileURLToPath(new URL("../src/agent/skills/seededSkills.ts", import.meta.url));
const OPEN_MARKER = "export const publishingConductorNodes = [";
const CLOSE_MARKER = "] satisfies WorkspaceNode[];";

// Ascending order of authority. A re-seed may raise a node's rung (adding a gate) but never lower it.
const RISK_LADDER = ["read", "write", "publish", "admin"];

// Fields listWorkspaceNodes() spreads or copies. A node missing any of them would crash the runtime or
// silently lose data, so an incomplete source is refused rather than emitted.
const REQUIRED_FIELDS = ["id", "name", "kind", "description", "prompt", "schema", "inputSchema", "outputSchema", "allowedTools", "assignedSkills", "requiredInputs", "produces", "riskLevel", "dependsOn", "status", "position"] as const;

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

const readSource = async (from?: string): Promise<WorkspaceNode[]> => {
  if (from) {
    const parsed = JSON.parse(await readFile(from, "utf8"));
    const nodes = Array.isArray(parsed) ? parsed : parsed?.data?.nodes ?? parsed?.nodes;
    if (!Array.isArray(nodes)) die(`${from} does not contain a node array (looked at the root, .nodes and .data.nodes).`);
    return nodes as WorkspaceNode[];
  }
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  return repositoryManager.getWorkspaceRepository().getNodes();
};

const readSkillSource = async (from?: string): Promise<SkillDefinition[] | undefined> => {
  if (from) {
    const parsed = JSON.parse(await readFile(from, "utf8"));
    const skills = Array.isArray(parsed) ? parsed : parsed?.data?.skills ?? parsed?.skills;
    if (!Array.isArray(skills)) die(`${from} does not contain a skill array (looked at the root, .skills and .data.skills).`);
    return skills as SkillDefinition[];
  }
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  return repositoryManager.getSkillRepository().list();
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

const refuseUnsafe = (incoming: WorkspaceNode[]): void => {
  const problems: string[] = [];
  const canonical = listWorkspaceNodes();
  const incomingById = new Map(incoming.map((node) => [node.id, node]));

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

  if (problems.length) die(`Refusing to re-seed ${problems.length} problem(s):`, problems);
};

const render = (nodes: WorkspaceNode[], original: string): string => {
  const open = original.indexOf(OPEN_MARKER);
  const close = original.indexOf(CLOSE_MARKER, open);
  if (open === -1 || close === -1) die("Could not find the publishingConductorNodes array literal in nodes.ts. The file's shape changed; update OPEN_MARKER / CLOSE_MARKER.");
  const body = nodes.map((node) => JSON.stringify(orderKeys(node), null, 2).split("\n").map((line) => `  ${line}`).join("\n")).join(",\n");
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
  const fromIndex = args.indexOf("--from");
  const from = fromIndex === -1 ? undefined : args[fromIndex + 1];
  const skillsIndex = args.indexOf("--skills");
  const skillsFrom = skillsIndex === -1 ? undefined : args[skillsIndex + 1];

  const source = await readSource(from);
  say(`source            ${source.length} nodes from ${from ?? "the live workspace store"}`);

  const ordered = topologicallyOrdered(source);
  refuseUnsafe(ordered);

  // Skills travel with the nodes that reference them, or the graph points at things that do not exist.
  const skills = (from && !skillsFrom) ? seededSkillDefinitions : (await readSkillSource(skillsFrom)) ?? seededSkillDefinitions;
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

  const nodesDrifted = rendered !== original;
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

await main();
