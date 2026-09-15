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

// The plan's ceiling. The playbook's own `budget.maxItems` is 12 by default and its renderer already
// truncates on characters; this is the briefing's own independent bound, so a tenant whose playbook
// budget was raised cannot quietly take over the prompt.
export const MAX_HOUSE_LESSONS = 20;

/**
 * Playbooks are keyed by a plain `nodeId` string. Client Manager is an AGENT, not a node, and its
 * lessons are per TENANT — the same correction on two tenants is two different lessons, because the
 * house is what makes it true. So the key is the agent and the project together, in one conventional
 * shape, defined once here rather than assembled at each call site.
 *
 * Deliberately NOT the bare agent id: a single shared playbook across every tenant would let one
 * house's editorial correction reach another house's chat, which is the fleet's worst cross-tenant
 * failure mode.
 */
export const clientManagerPlaybookNodeId = (projectId: string): string => `chat_client_manager:${projectId}`;

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
