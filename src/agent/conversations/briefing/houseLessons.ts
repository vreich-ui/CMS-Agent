// CMP-W4 — the tenant's CURATED lessons, rendered into the briefing.
//
// Corrections an editor makes in chat currently die in the transcript: the next conversation repeats
// the mistake, and the editor corrects it again. The improvement machinery already has the right
// shape for fixing that — ACE-style playbooks (improvement/playbook.ts), budgeted, deduplicated,
// with helpful/harmful counters and an explicit curation step.
//
// CURATED ONLY. A raw learning OBSERVATION is not a lesson; it is one run's opinion, unreviewed. The
// separation here is structural rather than a filter anyone has to remember: observations live in
// the learning store and become playbook items ONLY by passing through `curator.ts`
// (`playbook_curate`). This module reads the playbook, so an uncurated observation has no path into
// the prompt at all.
import { renderPlaybookForPrompt } from "../../improvement/playbook.js";
import type { NodePlaybook } from "../../improvement/improvementTypes.js";
import type { PolicyScope } from "../../scope/policyScope.js";

// The plan's ceiling. The playbook's own `budget.maxItems` is 12 by default and its renderer already
// truncates on characters; this is the briefing's own independent bound, so a tenant whose playbook
// budget was raised cannot quietly take over the prompt.
export const MAX_HOUSE_LESSONS = 20;

/**
 * Client Manager is an AGENT, not a node, and its lessons are per TENANT — the same correction on two
 * tenants is two different lessons, because the house is what makes it true. A single shared playbook
 * across every tenant would let one house's editorial correction reach another house's chat, which is
 * the fleet's worst cross-tenant failure mode.
 *
 * C2 (part 2) — that is now said in the scope vocabulary rather than in a string. The record is
 * `chat_client_manager` scoped to `{ site: projectId }`; the id below is the LEGACY convention this
 * module invented before there was a vocabulary to say it in, kept for exactly two purposes: reading
 * a tenant whose lessons have not been migrated yet, and `playbook_migrate_scope`, which moves them.
 * Nothing new is written under it.
 */
export const CLIENT_MANAGER_PLAYBOOK_NODE_ID = "chat_client_manager";
export const clientManagerPlaybookScope = (projectId: string): PolicyScope => ({ site: projectId });
export const legacyClientManagerPlaybookNodeId = (projectId: string): string => `chat_client_manager:${projectId}`;

/**
 * The tenant's curated chat lessons, from the scoped record, falling back to the legacy key while an
 * unmigrated tenant still has them there.
 *
 * The fallback reads the LEGACY record only — it never falls back to the FLEET playbook. A tenant
 * with no lessons of its own has no lessons of its own; borrowing another scope's would be the
 * cross-tenant leak, arrived at politely.
 */
export async function readClientManagerPlaybook(
  projectId: string,
  repository: { getPlaybook(nodeId: string, scope?: PolicyScope): Promise<NodePlaybook | undefined> }
): Promise<NodePlaybook | undefined> {
  return (await repository.getPlaybook(CLIENT_MANAGER_PLAYBOOK_NODE_ID, clientManagerPlaybookScope(projectId)))
    ?? (await repository.getPlaybook(legacyClientManagerPlaybookNodeId(projectId)));
}

/**
 * The `### What this house has learned` block, or "" when there is nothing curated.
 *
 * Empty renders as nothing at all. A "no lessons yet" line would cost tokens on every turn of every
 * conversation on every tenant to say something the model cannot act on.
 */
export const renderHouseLessons = (playbook?: NodePlaybook): string => {
  if (!playbook) return "";
  const bounded: NodePlaybook = { ...playbook, items: playbook.items.filter((item) => item.status === "active").slice(0, MAX_HOUSE_LESSONS) };
  const body = renderPlaybookForPrompt(bounded);
  if (!body.trim()) return "";
  return [
    "### What this house has learned",
    "Corrections an editor has already made here, curated. Follow them; do not make the editor say them again.",
    body
  ].join("\n");
};
