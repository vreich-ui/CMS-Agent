// ACE-style per-node playbooks (docs/improvement/STRATEGY.md §2): a curated, budgeted list of
// bullet lessons with helpful/harmful counters, updated by small deltas instead of wholesale
// rewrites (avoids context collapse). This replaces the documented anti-pattern of injecting every
// global learning observation into every prompt (data-model-gaps §6): injection is per-node,
// deduplicated, and size-bounded. Pure functions only — the runner imports this module, so it must
// not pull in execution or repository code.
import { isFleetScope, normalizeScope, scopeKey, scopeLabel, type PolicyScope } from "../scope/policyScope.js";
import { makeImprovementId, type NodePlaybook, type PlaybookDelta, type PlaybookItem } from "./improvementTypes.js";

export const DEFAULT_PLAYBOOK_BUDGET = { maxItems: 12, maxChars: 2000 } as const;

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const netHelpfulness = (item: PlaybookItem): number => item.helpfulCount - item.harmfulCount;

export const createEmptyPlaybook = (nodeId: string, nowIso: string, scope?: PolicyScope): NodePlaybook =>
  ({ nodeId, items: [], budget: { ...DEFAULT_PLAYBOOK_BUDGET }, version: 0, updatedAt: nowIso, ...(isFleetScope(scope) ? {} : { scope: normalizeScope(scope) }) });

// C2 (part 2) — WHOSE LESSONS A DISPATCH READS, most specific first.
//
// Two entries, and the bound is deliberate rather than an oversight: every entry is one blob read on
// a hot path (both runners call this on every dispatch), and the vocabulary's third dimension has no
// playbook WRITER. Walking `objective` would spend a round trip per dispatch, on every node, to find
// nothing. When something writes objective-scoped lessons, this function grows — and its tests say
// so out loud rather than a comment somewhere promising it.
//
// The fleet entry is always last and always present: composition ADDS the house's lessons, it does
// not replace the craft lessons a node already had. A node on a tenant with no lessons of its own
// reads exactly what it read before this existed.
/**
 * A playbook scope may narrow by `site` (and, when something writes them, `objective`) but NEVER by
 * `task`: the record is already addressed by its nodeId. Enforced at the repository boundary so the
 * two backends cannot disagree about it, and so a caller that means `{ site }` cannot accidentally
 * store a second, unreachable copy under `{ site, task }`.
 */
export const assertPlaybookScope = (scope: PolicyScope | undefined): void => {
  const normalized = normalizeScope(scope);
  if (normalized.task) throw new Error(`A playbook scope must not name a task (received "${normalized.task}"): the playbook's nodeId already addresses the task.`);
};

export const playbookScopeChain = (context: { site?: string } = {}): PolicyScope[] =>
  [...(context.site ? [{ site: context.site }] : []), {}];

// Apply a delta: adds dedup against existing items by normalized text (a duplicate add increments
// helpfulCount instead of inserting), counters move by item id, retire flips status, and the
// budget evicts the lowest net-helpfulness active items first (never the ones this delta added).
export function applyPlaybookDelta(existing: NodePlaybook | undefined, nodeId: string, delta: PlaybookDelta, nowIso: string, scope?: PolicyScope): NodePlaybook {
  // The scope is a property of the RECORD, fixed when it is created. A delta applied with a
  // different scope than the record carries is a caller reading one playbook and writing another —
  // refused here rather than silently re-attributing a tenant's lessons to the fleet, or the fleet's
  // to a tenant, which is the exact leak this half of C2 exists to close.
  if (existing && scopeKey(existing.scope) !== scopeKey(scope)) {
    throw new Error(`Playbook scope mismatch for node ${nodeId}: the stored playbook belongs to ${scopeLabel(existing.scope)}, the delta was applied for ${scopeLabel(scope)}.`);
  }
  const playbook = existing ? structuredClone(existing) : createEmptyPlaybook(nodeId, nowIso, scope);
  const byNormalizedText = new Map(playbook.items.map((item) => [normalize(item.text), item]));
  const addedIds = new Set<string>();

  for (const addition of delta.add ?? []) {
    const duplicate = byNormalizedText.get(normalize(addition.text));
    if (duplicate) {
      duplicate.helpfulCount += 1;
      duplicate.status = "active";
      duplicate.updatedAt = nowIso;
      continue;
    }
    const item: PlaybookItem = { itemId: makeImprovementId("pb"), text: addition.text.trim(), kind: addition.kind, helpfulCount: 1, harmfulCount: 0, status: "active", provenance: addition.provenance ?? { source: "reflector" }, createdAt: nowIso, updatedAt: nowIso };
    playbook.items.push(item);
    byNormalizedText.set(normalize(item.text), item);
    addedIds.add(item.itemId);
  }
  for (const itemId of delta.markHelpful ?? []) { const item = playbook.items.find((candidate) => candidate.itemId === itemId); if (item) { item.helpfulCount += 1; item.updatedAt = nowIso; } }
  for (const itemId of delta.markHarmful ?? []) { const item = playbook.items.find((candidate) => candidate.itemId === itemId); if (item) { item.harmfulCount += 1; item.updatedAt = nowIso; } }
  for (const itemId of delta.retire ?? []) { const item = playbook.items.find((candidate) => candidate.itemId === itemId); if (item) { item.status = "retired"; item.updatedAt = nowIso; } }

  const active = playbook.items.filter((item) => item.status === "active");
  if (active.length > playbook.budget.maxItems) {
    const evictable = active.filter((item) => !addedIds.has(item.itemId)).sort((a, b) => netHelpfulness(a) - netHelpfulness(b));
    for (const item of evictable.slice(0, active.length - playbook.budget.maxItems)) { item.status = "retired"; item.updatedAt = nowIso; }
  }

  playbook.version += 1;
  playbook.updatedAt = nowIso;
  return playbook;
}

// Compact bullet rendering for prompt injection: active items by net helpfulness, hard-truncated
// to the character budget so a runaway playbook can never crowd out the node prompt.
export function renderPlaybookForPrompt(playbook: NodePlaybook): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of playbook.items.filter((candidate) => candidate.status === "active").sort((a, b) => netHelpfulness(b) - netHelpfulness(a))) {
    const line = `- (${item.kind}) ${item.text}`;
    if (used + line.length + 1 > playbook.budget.maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * C2 (part 2) — render a CHAIN of playbooks as one prompt block, most specific first.
 *
 * Three rules, each with a reason a reviewer can check:
 *   * ORDER IS CHAIN ORDER, not merged helpfulness. The house's lessons lead, because a lesson that
 *     was learned here beats a fleet generality about the same subject, and because truncation then
 *     drops the fleet's tail rather than the tenant's corrections.
 *   * DEDUP IS FIRST-WINS on normalized text — the same rule `applyPlaybookDelta` dedupes adds by, so
 *     a lesson promoted both fleet-wide and on one site is rendered once, as the site's.
 *   * THE BUDGET IS THE LARGEST IN THE CHAIN. Composition must never hand a node LESS room than it
 *     had before it had a second playbook; a fleet-only node is byte-identical to today's output.
 */
export function composeScopedPlaybooksForPrompt(playbooks: readonly NodePlaybook[]): string {
  const present = playbooks.filter((playbook): playbook is NodePlaybook => Boolean(playbook));
  if (!present.length) return "";
  const maxChars = Math.max(...present.map((playbook) => playbook.budget.maxChars));
  const seen = new Set<string>();
  const lines: string[] = [];
  let used = 0;
  for (const playbook of present) {
    for (const item of playbook.items.filter((candidate) => candidate.status === "active").sort((a, b) => netHelpfulness(b) - netHelpfulness(a))) {
      const key = normalize(item.text);
      if (seen.has(key)) continue;
      const line = `- (${item.kind}) ${item.text}`;
      if (used + line.length + 1 > maxChars) return lines.join("\n");
      seen.add(key);
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines.join("\n");
}
