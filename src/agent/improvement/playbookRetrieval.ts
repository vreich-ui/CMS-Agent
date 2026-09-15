// C2 (part 2) — READING A PLAYBOOK CHAIN. One function, because two runners plus the chat briefing
// plus the MCP read tool all have to agree on which lessons a dispatch gets, and three hand-written
// copies of a two-step walk is how they stop agreeing.
//
// `playbook.ts` stays pure (the runners import it, so it must not pull in repository code); this is
// the thin layer that does the reads.
import { composeScopedPlaybooksForPrompt, playbookScopeChain } from "./playbook.js";
import type { NodePlaybook } from "./improvementTypes.js";
import { scopeKey, type PolicyScope } from "../scope/policyScope.js";
import type { ImprovementRepository } from "../repository/interfaces/ImprovementRepository.js";

export type ComposedPlaybook = {
  /** The rendered prompt block, most specific first. "" when the chain holds nothing. */
  text: string;
  /** Which scopes actually contributed, in order — so a caller can SAY whose lessons these are. */
  scopeKeys: string[];
  /** Scopes whose read threw. Named rather than swallowed: fewer lessons is a degraded prompt, not a normal one. */
  unreadableScopeKeys: string[];
};

/**
 * Compose the playbooks that apply to one node in one situation.
 *
 * A read that FAILS degrades to what the rest of the chain holds, which is what both runners already
 * did with their single read (`.catch(() => undefined)`) — a playbook has never been allowed to fail
 * a dispatch. What changes is that the failure is now reported rather than invisible.
 */
export async function composePlaybookForDispatch(
  nodeId: string,
  context: { site?: string },
  repository: ImprovementRepository
): Promise<ComposedPlaybook> {
  const chain = playbookScopeChain(context);
  const found: NodePlaybook[] = [];
  const scopeKeys: string[] = [];
  const unreadableScopeKeys: string[] = [];
  for (const scope of chain) {
    let playbook: NodePlaybook | undefined;
    try {
      playbook = await repository.getPlaybook(nodeId, scope as PolicyScope);
    } catch {
      unreadableScopeKeys.push(scopeKey(scope));
      continue;
    }
    if (!playbook) continue;
    found.push(playbook);
    scopeKeys.push(scopeKey(scope));
  }
  return { text: composeScopedPlaybooksForPrompt(found), scopeKeys, unreadableScopeKeys };
}
