// ACE-style per-node playbooks (docs/improvement/STRATEGY.md §2): a curated, budgeted list of
// bullet lessons with helpful/harmful counters, updated by small deltas instead of wholesale
// rewrites (avoids context collapse). This replaces the documented anti-pattern of injecting every
// global learning observation into every prompt (data-model-gaps §6): injection is per-node,
// deduplicated, and size-bounded. Pure functions only — the runner imports this module, so it must
// not pull in execution or repository code.
import { makeImprovementId, type NodePlaybook, type PlaybookDelta, type PlaybookItem } from "./improvementTypes.js";

export const DEFAULT_PLAYBOOK_BUDGET = { maxItems: 12, maxChars: 2000 } as const;

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const netHelpfulness = (item: PlaybookItem): number => item.helpfulCount - item.harmfulCount;

export const createEmptyPlaybook = (nodeId: string, nowIso: string): NodePlaybook =>
  ({ nodeId, items: [], budget: { ...DEFAULT_PLAYBOOK_BUDGET }, version: 0, updatedAt: nowIso });

// Apply a delta: adds dedup against existing items by normalized text (a duplicate add increments
// helpfulCount instead of inserting), counters move by item id, retire flips status, and the
// budget evicts the lowest net-helpfulness active items first (never the ones this delta added).
export function applyPlaybookDelta(existing: NodePlaybook | undefined, nodeId: string, delta: PlaybookDelta, nowIso: string): NodePlaybook {
  const playbook = existing ? structuredClone(existing) : createEmptyPlaybook(nodeId, nowIso);
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
