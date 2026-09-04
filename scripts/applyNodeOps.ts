#!/usr/bin/env tsx
/**
 * Apply the store operations recorded in a "node ops doc" (docs/plan/brand-imagery-node-ops.md is
 * the first one) to the live WORKSPACE_STORE — the tooling gap D5 names: those docs record W7
 * config-session steps (workspace.update_node_prompt / *_schema / *_metadata / create_node calls) that
 * were never applied because applying them was a manual, undiffable, un-idempotent chore.
 *
 * WHY THIS IS A SEPARATE SCRIPT FROM seedNodesFromWorkspace.ts / reseedStoreFromCanonical.ts
 *
 * Those two move data between nodes.ts (canonical, in code) and the live store, in opposite
 * directions. This script's source is neither of those — it is a THIRD place changes get recorded,
 * a markdown doc written when a session had no live store to write to. It parses that doc's own
 * documented format (see PARSING CONTRACT below) into the same per-field writes the other two
 * scripts already know how to plan and apply, and it takes their erosion guards from source rather
 * than re-deriving them: MAX_PROMPT_SHRINK, ALLOW_SHRINK_FLAG, ALLOW_CAPABILITY_LOSS_FLAG and
 * lostEntries are all imported from scripts/reseedStoreFromCanonical.ts, which exports them for
 * exactly this reason — see its own header on why a prompt shrink past that ceiling, or a whole-object
 * field write that removes a key the store carries, is refused rather than silently applied. The one
 * guard written here rather than imported is canonicalRulesDropProblem, which looks one level deeper
 * than lostEntries can (inside metadata.canonicalRules) and has no counterpart to import.
 *
 * PARSING CONTRACT — the doc format this script accepts, verbatim, nothing invented:
 *
 *   - Each op is a level-3 heading: "### <n>. `<tool>` — node `<nodeId>`", tools being one of
 *     workspace_update_node_input_schema, workspace_update_node_output_schema,
 *     workspace_update_node_prompt, workspace_update_node_metadata, workspace_create_node.
 *   - The op's payload is the LAST fenced code block (```json or ```text) before the next heading.
 *     "Last" matters: two ops (11 and 12 in the brand-imagery doc) print a short illustrative "diff"
 *     block first and the actual whole-field replacement last, because workspace.update_node_prompt
 *     has no partial-edit mode and the doc says so explicitly ("the FULL prompt to send as `prompt`").
 *     A first-block reader would silently apply the diff snippet as the entire prompt.
 *   - workspace_update_node_input_schema / _output_schema: the block IS the `schema` argument value
 *     (JSON).
 *   - workspace_update_node_prompt: the block's lines, joined with "\n", ARE the `prompt` argument
 *     value (plain text, one policy paragraph per line — this is how the doc itself writes a prompt
 *     that is stored as a single string with embedded "\n"s).
 *   - workspace_update_node_metadata: the block IS `patch.metadata` (the doc's own table: "The
 *     metadata object goes under `patch.metadata`" — the printed block is that inner object, not the
 *     `{patch:{metadata:...}}` wrapper).
 *   - workspace_create_node: the block already carries the `{"node": {...}}` wrapper verbatim (the
 *     doc says so: "Ops 8–9 already print the `{"node": …}` wrapper; send those blocks as-is").
 *
 * DRIFT
 *
 *   - workspace_create_node: if the node already exists in the store, its current value must match
 *     the op's `node` object field-for-field (ignoring `updatedAt`) — exactly what the doc itself
 *     instructs a W7 session to do ("verify against workspace_get_node(...) ... apply an op only
 *     where the store disagrees"). A mismatch refuses, naming the differing fields.
 *   - A later op in an explicit doc-declared chain (op 11 replaces what op 3 set, op 12 replaces what
 *     op 10 set, op 13 replaces what op 4 set) must find the field currently holding EXACTLY what the
 *     earlier op in the chain set it to (or already hold this op's own payload, meaning it was already
 *     applied). Anything else refuses as drift: the store was edited by something this doc does not
 *     know about, and overwriting it would silently discard that edit. Because this script always
 *     applies the whole doc in one run, the earlier half of every chain always runs first in the same
 *     invocation, so this check is exact, not a length heuristic.
 *   - Every other field write (an op's FIRST touch of a given node+field, with no predecessor
 *     recorded earlier in this same doc) has no doc-given exact "before" text to diff against — the
 *     doc only asserts these are additive edits over whatever the store currently holds, with no
 *     literal base included. For those, the erosion guard (shrink ratio / dropped canonicalRules) is
 *     the only base-mismatch signal this doc's format makes available, and that is what runs. This is
 *     a real gap in what full "was this the expected base" drift detection can prove for a first-touch
 *     field, and it is not papered over here: see the script's printed output, which labels such a
 *     write "first touch (erosion-guard only)" rather than claiming an exact-base match it did not
 *     check. Note how thin that signal is per field: a first-touch PROMPT gets the shrink ratio, a
 *     first-touch METADATA gets the two removal guards below, and a first-touch input/output SCHEMA
 *     gets NOTHING — there is no coherent generic "erosion" notion for a schema object, so a
 *     first-touch schema op overwrites whatever is there. Diff the dry run before `--write`.
 *
 * IDEMPOTENCE. Before doing anything else, every op compares its payload to the field's CURRENT value
 * (post any earlier op in this same run) and skips as "up to date" on an exact match — so a second run
 * against an already-applied store reports zero writes and exits 0.
 *
 * NEVER PARTIAL FOR A REFUSAL. Every op is planned first, and if ANY op refuses nothing is written at
 * all, `--write` or not — no op in the doc can land on a plan that another op rejected.
 * A mid-apply FAILURE is the one case that can leave the store half-applied, because the workspace
 * repository offers no multi-node transaction to wrap these writes in: if the Nth write throws, the
 * N-1 before it are already durable. That is reported rather than swallowed — the error line names
 * which writes had already landed — and a re-run resumes cleanly, because every landed write reads
 * back as "up to date" on the next plan.
 *
 * Usage:
 *   npm run nodes:apply -- docs/plan/brand-imagery-node-ops.md                 # dry run (default)
 *   npm run nodes:apply -- docs/plan/brand-imagery-node-ops.md --write         # apply
 *   npm run nodes:apply -- docs/plan/brand-imagery-node-ops.md --allow-prompt-shrink
 *   npm run nodes:apply -- docs/plan/brand-imagery-node-ops.md --allow-capability-loss
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW_CAPABILITY_LOSS_FLAG, ALLOW_SHRINK_FLAG, lostEntries, MAX_PROMPT_SHRINK } from "./reseedStoreFromCanonical.js";
import type { WorkspaceNode } from "../src/agent/workspace/nodeTypes.js";
import type { WorkspaceMutationMeta } from "../src/agent/mcp/workspace/store.js";

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export type OpKind = "input_schema" | "output_schema" | "prompt" | "metadata" | "create_node";

export type ParsedOp = {
  index: number;
  tool: string;
  nodeId: string;
  kind: OpKind;
  schema?: unknown; // input_schema | output_schema
  prompt?: string; // prompt
  metadataPatch?: Record<string, unknown>; // metadata
  node?: WorkspaceNode; // create_node
};

const TOOL_KIND: Record<string, OpKind> = {
  workspace_update_node_input_schema: "input_schema",
  workspace_update_node_output_schema: "output_schema",
  workspace_update_node_prompt: "prompt",
  workspace_update_node_metadata: "metadata",
  workspace_create_node: "create_node"
};

const HEADING_RE = /^### (\d+)\. `(workspace_[a-z_]+)` — node `([a-zA-Z0-9_]+)`\s*$/;

type Heading = { line: number; index: number; tool: string; nodeId: string };

const findHeadings = (lines: string[]): Heading[] => {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (match) headings.push({ line: i, index: Number(match[1]), tool: match[2], nodeId: match[3] });
  }
  return headings;
};

// All fenced ```json / ```text blocks in a section (content lines only, fences excluded). A section
// can carry more than one (an illustrative "diff" snippet followed by the real payload) — callers
// take the LAST one, per the PARSING CONTRACT above.
const findFencedBlocks = (lines: string[]): string[][] => {
  const blocks: string[][] = [];
  let inBlock = false;
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!inBlock && (trimmed === "```json" || trimmed === "```text" || trimmed === "```")) {
      inBlock = true;
      current = [];
      continue;
    }
    if (inBlock && trimmed === "```") {
      inBlock = false;
      blocks.push(current);
      continue;
    }
    if (inBlock) current.push(line);
  }
  return blocks;
};

export const parseOpsDoc = (markdown: string): ParsedOp[] => {
  const lines = markdown.split("\n");
  const headings = findHeadings(lines);
  if (headings.length === 0) throw new Error("No op headings found (expected lines like \"### 1. `workspace_update_node_prompt` — node `some_node`\").");

  const ops: ParsedOp[] = [];
  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h];
    const sectionEnd = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    const sectionLines = lines.slice(heading.line + 1, sectionEnd);
    const blocks = findFencedBlocks(sectionLines);
    if (blocks.length === 0) throw new Error(`Op ${heading.index} (${heading.tool} — node ${heading.nodeId}): no fenced code block found in its section.`);
    const payloadLines = blocks[blocks.length - 1];

    const kind = TOOL_KIND[heading.tool];
    if (!kind) throw new Error(`Op ${heading.index}: unrecognized tool "${heading.tool}".`);

    const op: ParsedOp = { index: heading.index, tool: heading.tool, nodeId: heading.nodeId, kind };
    if (kind === "prompt") {
      op.prompt = payloadLines.join("\n");
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadLines.join("\n"));
      } catch (error) {
        throw new Error(`Op ${heading.index} (${heading.tool} — node ${heading.nodeId}): payload block is not valid JSON: ${(error as Error).message}`);
      }
      if (kind === "create_node") {
        const wrapper = parsed as { node?: WorkspaceNode };
        if (!wrapper || typeof wrapper !== "object" || !wrapper.node) throw new Error(`Op ${heading.index}: workspace_create_node payload must be {"node": {...}}.`);
        if (wrapper.node.id !== heading.nodeId) throw new Error(`Op ${heading.index}: heading names node "${heading.nodeId}" but the payload's node.id is "${wrapper.node.id}".`);
        op.node = wrapper.node;
      } else if (kind === "metadata") {
        op.metadataPatch = parsed as Record<string, unknown>;
      } else {
        op.schema = parsed;
      }
    }
    ops.push(op);
  }
  return ops;
};

// ---------------------------------------------------------------------------------------------
// Planning (pure — no I/O, no process.exit; exercised directly by tests)
// ---------------------------------------------------------------------------------------------

export type PlannedWrite = {
  opIndex: number;
  nodeId: string;
  field: string;
  kind: "create" | "update";
  afterValue: unknown;
  basis: "already_up_to_date_skip" | "chain_match" | "first_touch";
};

export type Refusal = { opIndex: number; nodeId: string; field?: string; reason: string };

export type ApplyPlan = {
  writes: PlannedWrite[]; // real, non-no-op writes, in apply order
  upToDate: { opIndex: number; nodeId: string; field: string }[];
  refusals: Refusal[];
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

// Same class of check promptAndGateProblems (seedNodesFromWorkspace.ts) runs, reusing the SAME
// threshold/flag (imported, not redefined): a prompt op past this ceiling refuses rather than lands.
const promptShrinkProblem = (before: string, after: string, allowShrink: boolean): string | undefined => {
  if (before.length === 0 || after.length >= before.length) return undefined;
  const shrink = (before.length - after.length) / before.length;
  if (shrink <= MAX_PROMPT_SHRINK || allowShrink) return undefined;
  return `prompt would shrink ${before.length} -> ${after.length} chars (-${Math.round(shrink * 100)}%), past the ${Math.round(MAX_PROMPT_SHRINK * 100)}% ceiling. Re-run with ${ALLOW_SHRINK_FLAG} to confirm the cut is intended.`;
};

// TWO removal guards on metadata, because `workspace.update_node_metadata` REPLACES the whole object
// (tools.ts) and so does this script — a patch that names three keys deletes every key it does not
// name, and a patch that names `canonicalRules` deletes every rule it does not repeat.
//
//   * lostEntries — reseedStoreFromCanonical.ts's OWN capability-loss check, imported rather than
//     re-derived: which top-level metadata KEYS the write would remove. This is the one that catches a
//     doc op whose metadata block says {"contractPrefetch": true} landing on a node whose store row
//     carries {sitePrefetch, voicePrefetch}: without it the write silently strips both, and the
//     conductor stops prefetching for that node with nothing anywhere saying why.
//   * canonicalRulesDropProblem — one level deeper, inside the key: an entry dropped from the
//     canonicalRules ARRAY while the key itself survives, which lostEntries cannot see.
//
// Both are removals, so both answer to ALLOW_CAPABILITY_LOSS_FLAG (the flag the sibling script uses
// for exactly this), NOT to the prompt-shrink flag: confirming a deliberate prompt cut must not
// silently also confirm a metadata deletion nobody looked at.
const metadataKeyLossProblem = (before: unknown, after: unknown, allowCapabilityLoss: boolean): string | undefined => {
  const lost = lostEntries("metadata", before, after);
  if (!lost.length || allowCapabilityLoss) return undefined;
  return `would REMOVE ${lost.length} metadata key(s) the store currently carries: ${lost.join(", ")} — this tool replaces the whole metadata object, it does not merge. Re-run with ${ALLOW_CAPABILITY_LOSS_FLAG} if the removal is intended.`;
};

const canonicalRulesDropProblem = (before: unknown, after: unknown, allowCapabilityLoss: boolean): string | undefined => {
  const beforeRules = (before as { canonicalRules?: string[] } | undefined)?.canonicalRules ?? [];
  const afterRules = (after as { canonicalRules?: string[] } | undefined)?.canonicalRules ?? [];
  const dropped = beforeRules.filter((rule) => !afterRules.includes(rule));
  if (!dropped.length || allowCapabilityLoss) return undefined;
  return `would drop ${dropped.length} canonicalRule(s): ${dropped.map((rule) => JSON.stringify(rule)).join("; ")}. Re-run with ${ALLOW_CAPABILITY_LOSS_FLAG} if the rule is genuinely retired.`;
};

const fieldOf = (node: WorkspaceNode, kind: OpKind): unknown => {
  switch (kind) {
    case "input_schema": return node.inputSchema;
    case "output_schema": return node.outputSchema;
    case "prompt": return node.prompt;
    case "metadata": return node.metadata;
    default: return undefined;
  }
};

const fieldName = (kind: OpKind): string => ({ input_schema: "inputSchema", output_schema: "outputSchema", prompt: "prompt", metadata: "metadata", create_node: "node" }[kind]);

// Fields a create_node op contributes that a LATER op in the same doc can also touch (op 8 -> op 10
// -> op 12's shape). Every other field a create_node sets (name, kind, riskLevel, allowedTools, ...)
// is never revisited by this doc's format, so it is compared exactly, with no notion of "position".
const CHAIN_FIELDS = ["prompt", "inputSchema", "outputSchema", "metadata"] as const;
type ChainField = typeof CHAIN_FIELDS[number];

const payloadOf = (op: ParsedOp): unknown =>
  op.kind === "metadata" ? op.metadataPatch : op.kind === "prompt" ? op.prompt : op.kind === "create_node" ? undefined : op.schema;

export const planApply = (ops: ParsedOp[], storeNodes: WorkspaceNode[], options: { allowPromptShrink?: boolean; allowCapabilityLoss?: boolean } = {}): ApplyPlan => {
  const allowShrink = options.allowPromptShrink ?? false;
  const allowCapabilityLoss = options.allowCapabilityLoss ?? false;
  const working = new Map(storeNodes.map((node) => [node.id, structuredClone(node)]));

  // PASS 1 (static, doc-order only — no store, no runtime outcome): for every "nodeId::field" this
  // doc ever touches, the FULL ordered sequence of values the doc's own ops assign it, e.g.
  // brand_imagery_writer::prompt -> [op8's created prompt, op10's payload, op12's payload]. This is
  // literally the "what the doc expects as its base, at every point" the DRIFT section below needs:
  // a store already sitting on ANY value in this sequence is on the doc's own path (whether it is
  // only partly applied or fully converged past the op currently being planned); a store sitting on
  // anything else is drift.
  const chainByKey = new Map<string, unknown[]>();
  const pushChain = (key: string, value: unknown) => {
    const arr = chainByKey.get(key);
    if (arr) arr.push(value); else chainByKey.set(key, [value]);
  };
  for (const op of ops) {
    if (op.kind === "create_node") {
      for (const f of CHAIN_FIELDS) pushChain(`${op.nodeId}::${f}`, (op.node as unknown as Record<string, unknown>)[f]);
    } else {
      pushChain(`${op.nodeId}::${fieldName(op.kind)}`, payloadOf(op));
    }
  }
  // Running position pointer per key, advanced as PASS 2 (below) encounters each op for that key —
  // walks the SAME chain built above, in the SAME order, so position i here is exactly index i there.
  const position = new Map<string, number>();
  const nextPosition = (key: string): number => {
    const at = position.get(key) ?? 0;
    position.set(key, at + 1);
    return at;
  };

  const writes: PlannedWrite[] = [];
  const upToDate: ApplyPlan["upToDate"] = [];
  const refusals: Refusal[] = [];

  for (const op of ops) {
    if (op.kind === "create_node") {
      const existing = working.get(op.nodeId);
      const incoming = op.node!;
      const positions = Object.fromEntries(CHAIN_FIELDS.map((f) => [f, nextPosition(`${op.nodeId}::${f}`)])) as Record<ChainField, number>;

      if (!existing) {
        writes.push({ opIndex: op.index, nodeId: op.nodeId, field: "node", kind: "create", afterValue: incoming, basis: "first_touch" });
        working.set(op.nodeId, structuredClone(incoming));
      } else {
        const nonChainDiff = [...new Set([...Object.keys(existing), ...Object.keys(incoming)])]
          .filter((k) => k !== "updatedAt" && !(CHAIN_FIELDS as readonly string[]).includes(k))
          .filter((k) => !deepEqual((existing as Record<string, unknown>)[k], (incoming as Record<string, unknown>)[k]));
        // A chain field is acceptable if the store's current value is this op's own contribution OR
        // anything a LATER op in this doc's chain would produce — the store may already be further
        // along than this create's bare literal (a doc applied end-to-end already, or partially, in
        // an earlier run), and that is success, not drift.
        const chainDiff = CHAIN_FIELDS.filter((f) => {
          const key = `${op.nodeId}::${f}`;
          const rest = (chainByKey.get(key) ?? []).slice(positions[f]);
          return !rest.some((value) => deepEqual(value, (existing as Record<string, unknown>)[f]));
        });
        const diffFields = [...nonChainDiff, ...chainDiff];
        if (diffFields.length === 0) {
          upToDate.push({ opIndex: op.index, nodeId: op.nodeId, field: "node" });
        } else {
          refusals.push({
            opIndex: op.index,
            nodeId: op.nodeId,
            reason: `node already exists in the store and differs from this op's payload in: ${diffFields.join(", ")}. Per the doc: verify with workspace_get_node and apply only where the store disagrees — refusing rather than silently overwriting.`
          });
        }
      }
      continue;
    }

    const field = fieldName(op.kind);
    const key = `${op.nodeId}::${field}`;
    const pos = nextPosition(key);
    const existing = working.get(op.nodeId);
    if (!existing) {
      refusals.push({ opIndex: op.index, nodeId: op.nodeId, field, reason: `node "${op.nodeId}" does not exist in the store, and this op updates a field rather than creating it. Apply the node's workspace_create_node op first (or confirm the id).` });
      continue;
    }

    const payload = payloadOf(op);
    const currentValue = fieldOf(existing, op.kind);
    const chain = chainByKey.get(key) ?? [];
    const rest = chain.slice(pos); // this op's own payload, plus every later op's, in order

    if (rest.some((value) => deepEqual(value, currentValue))) {
      // Current value is this op's own contribution or a later one already landed — nothing to do.
      upToDate.push({ opIndex: op.index, nodeId: op.nodeId, field });
      continue;
    }

    // DRIFT: an earlier op in this doc's chain for this field exists (pos > 0), and the store's
    // current value is not what that immediately preceding op set it to — and (checked just above)
    // not this op's own payload or anything further along either. Something outside this doc changed
    // it; refuse rather than build on an unverified base.
    if (pos > 0 && !deepEqual(currentValue, chain[pos - 1])) {
      refusals.push({
        opIndex: op.index,
        nodeId: op.nodeId,
        field,
        reason: `current stored ${field} does not match what op ${op.index} expects as its base (the value the doc's earlier op on this field set). The store was changed by something outside this doc — refusing rather than overwriting that edit.`
      });
      continue;
    }

    // Erosion guard — reused, not re-implemented (see MAX_PROMPT_SHRINK / ALLOW_SHRINK_FLAG import).
    // For a field's FIRST touch in this doc (pos === 0, no predecessor to diff against above) this is
    // the ONLY base-mismatch signal this doc's format makes available: a materially larger prior
    // value trips it; a shorter or similarly-sized one does not, which is a real limit — see the file
    // header's DRIFT section.
    if (op.kind === "prompt") {
      const problem = promptShrinkProblem(String(currentValue ?? ""), String(payload ?? ""), allowShrink);
      if (problem) { refusals.push({ opIndex: op.index, nodeId: op.nodeId, field, reason: problem }); continue; }
    }
    if (op.kind === "metadata") {
      const problem = metadataKeyLossProblem(currentValue, payload, allowCapabilityLoss)
        ?? canonicalRulesDropProblem(currentValue, payload, allowCapabilityLoss);
      if (problem) { refusals.push({ opIndex: op.index, nodeId: op.nodeId, field, reason: problem }); continue; }
    }

    writes.push({ opIndex: op.index, nodeId: op.nodeId, field, kind: "update", afterValue: payload, basis: pos > 0 ? "chain_match" : "first_touch" });
    const patch: Partial<WorkspaceNode> = op.kind === "output_schema" ? { outputSchema: payload, schema: payload } : { [field]: payload } as Partial<WorkspaceNode>;
    working.set(op.nodeId, { ...existing, ...patch });
  }

  return { writes, upToDate, refusals };
};

// ---------------------------------------------------------------------------------------------
// CLI (real I/O — never imported by tests)
// ---------------------------------------------------------------------------------------------

const say = (line: string) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`${line}\n`);

const eventTypeFor = (kind: OpKind): string => ({
  input_schema: "node.input_schema_updated",
  output_schema: "node.output_schema_updated",
  prompt: "node.prompt_updated",
  metadata: "node.updated",
  create_node: "node.created"
}[kind]);

const buildMutationMeta = (nodeId: string, field: string, opIndex: number): WorkspaceMutationMeta => ({
  actor: { kind: "system", label: "applyNodeOps" },
  source: "system",
  reason: `node ops doc apply: op ${opIndex} — ${nodeId}.${field}`
});

const main = async () => {
  const args = process.argv.slice(2);
  const docPath = args.find((arg) => !arg.startsWith("--"));
  const write = args.includes("--write");
  const allowPromptShrink = args.includes(ALLOW_SHRINK_FLAG);
  const allowCapabilityLoss = args.includes(ALLOW_CAPABILITY_LOSS_FLAG);

  if (!docPath) {
    warn(`Usage: npm run nodes:apply -- <path/to/ops-doc.md> [--write] [${ALLOW_SHRINK_FLAG}] [${ALLOW_CAPABILITY_LOSS_FLAG}]`);
    process.exit(1);
  }

  const markdown = await readFile(path.resolve(docPath), "utf8");
  const ops = parseOpsDoc(markdown);
  say(`parsed            ${ops.length} op(s) from ${docPath}`);
  for (const op of ops) say(`  op ${String(op.index).padStart(2, " ")}          ${op.tool}  —  node ${op.nodeId}`);
  say("");

  const backend = (process.env.WORKSPACE_STORE ?? "").trim().toLowerCase();
  if (backend !== "blobs" && backend !== "gcs") {
    // Same posture as nodes:check / store:check: a memory-backed store makes drift/erosion/write
    // checks meaningless (see their own headers — comparing canonical to canonical always reports
    // "up to date" and a --write would land nowhere real). Unlike those, a plain parse-only dry run
    // still has real value with no store at all — it is the doc's own PARSING CONTRACT that this
    // script exists to prove, independent of which store a session happens to be pointed at — so it
    // is not refused here; only --write (or a store-comparing dry run) needs a real store.
    if (write) {
      warn(`✗ WORKSPACE_STORE is ${backend ? `"${backend}"` : "unset"}, so the repositories resolve to an in-memory store seeded from nodes.ts itself.`);
      warn("  Writing against that store is meaningless by construction — it would report success and write nothing real.");
      warn("  Point this at the real store, e.g.:");
      warn("    WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state npm run nodes:apply -- " + docPath + " --write");
      process.exit(1);
    }
    warn(`WORKSPACE_STORE is ${backend ? `"${backend}"` : "unset"} — the doc parsed cleanly (${ops.length} op(s) above), but drift/erosion checks against a real store did not run.`);
    warn("  Point this at the real store to actually diff, e.g.:");
    warn("    WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state npm run nodes:apply -- " + docPath);
    return;
  }

  const { bootstrapWorkspaceStore } = await import("../src/agent/entrypoints/runConductorJob.js");
  bootstrapWorkspaceStore();
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  const workspaceRepository = repositoryManager.getWorkspaceRepository();
  const store = await workspaceRepository.getNodes();
  say(`store             ${store.length} nodes from WORKSPACE_STORE=${backend}`);
  say("");

  const plan = planApply(ops, store, { allowPromptShrink, allowCapabilityLoss });

  for (const item of plan.upToDate) say(`up to date        op ${item.opIndex}  ${item.nodeId}.${item.field}`);
  for (const item of plan.writes) say(`${item.kind === "create" ? "create" : "update"}            op ${item.opIndex}  ${item.nodeId}.${item.field}${item.kind === "update" ? ` (${item.basis})` : ""}`);
  for (const item of plan.refusals) say(`refuse            op ${item.opIndex}  ${item.nodeId}${item.field ? `.${item.field}` : ""}  ${item.reason}`);
  say("");

  if (plan.refusals.length) {
    warn(`✗ Refusing ${plan.refusals.length} op(s). Nothing was written.`);
    process.exit(1);
  }

  if (!write) {
    if (plan.writes.length === 0) { say("store matches every op in the doc already — no changes."); return; }
    warn(`✗ store DRIFTED for ${plan.writes.length} op(s). Re-run with --write to apply, e.g.:`);
    warn(`    npm run nodes:apply -- ${docPath} --write`);
    process.exit(1);
  }

  const applied: string[] = [];
  for (const item of plan.writes) {
    const label = `op ${item.opIndex} ${item.nodeId}.${item.field}`;
    try {
      if (item.kind === "create") {
        await workspaceRepository.createNode(item.afterValue as WorkspaceNode, buildMutationMeta(item.nodeId, item.field, item.opIndex), eventTypeFor("create_node"));
      } else {
        const patch: Partial<WorkspaceNode> = item.field === "outputSchema" ? { outputSchema: item.afterValue, schema: item.afterValue } : ({ [item.field]: item.afterValue } as Partial<WorkspaceNode>);
        await workspaceRepository.updateNode(item.nodeId, patch, buildMutationMeta(item.nodeId, item.field, item.opIndex), eventTypeFor(item.field === "outputSchema" ? "output_schema" : item.field === "inputSchema" ? "input_schema" : item.field === "prompt" ? "prompt" : "metadata"));
      }
      applied.push(label);
      say(`written           ${label}`);
    } catch (error) {
      warn(`✗ write failed at ${label}: ${(error as Error).message}`);
      warn(`    already written: ${applied.length ? applied.join(", ") : "none"}`);
      process.exit(1);
    }
  }
  say(`${plan.writes.length} op(s) written.`);
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    warn("applyNodeOps.ts failed to run:");
    warn(String((error as Error)?.stack ?? error));
    process.exit(1);
  });
}
