// Shared provider-HTTP-error classification (2026-08-29 incident: OpenAI returned 429
// credit_balance_exhausted; it surfaced as budget_exceeded on the run and a generic "service
// unavailable" in the chat — an hour was lost looking for a code bug that was actually an empty
// wallet). Every place a provider's raw HTTP response reaches CMS-Agent — OpenAINodeRunner,
// AnthropicNodeRunner, and the agent_converse HTTP path — runs the SAME 429 body through this one
// classifier, so "out of credit" and "merely rate-limited" get the two different operator remedies
// they actually need instead of collapsing into one opaque model_error (or worse, our OWN
// budget_exceeded, which must only ever mean OUR usd budget guard tripped).
export const PROVIDER_MESSAGE_MAX_CHARS = 500;

const QUOTA_SIGNAL = /insufficient_quota|credit_balance_exhausted|billing/i;

export type ProviderHttpErrorCode = "provider_quota" | "provider_rate_limit";

// Only a 429 is ever reclassified here; every other status keeps whatever code its call site already
// assigns (model_error, etc.) — "leave every other code as is".
export function classifyProviderHttpError(status: number | undefined, signalText: string): ProviderHttpErrorCode | undefined {
  if (status !== 429) return undefined;
  return QUOTA_SIGNAL.test(signalText) ? "provider_quota" : "provider_rate_limit";
}

export const truncateProviderMessage = (text: string): string =>
  text.length > PROVIDER_MESSAGE_MAX_CHARS ? text.slice(0, PROVIDER_MESSAGE_MAX_CHARS) : text;

// retryHint names the concrete next action available in THIS call's context: a node execution names
// `workflow.retry_node <nodeId>`; a conversational turn has no node to retry, so it names the turn.
export function operatorActionForProviderHttpError(code: ProviderHttpErrorCode, provider: string, retryHint: string): string {
  return code === "provider_quota"
    ? `Top up ${provider} credit for this project's key, then ${retryHint}.`
    : `Wait and retry ${retryHint}.`;
}

// budget_exceeded's operatorAction is the same sentence regardless of which of our own guards tripped
// (the pre-flight reserve check or the mid-loop guard) — it is always OUR ceiling, never a provider's.
export function operatorActionForBudgetExceeded(budgetUsd: number, spentUsd: number): string {
  return `Run budget ${budgetUsd} USD reached (spent ${spentUsd}). Raise the budget or stop.`;
}

// Request-shape rejection (2026-09-03 admin-chat incident). A provider 400/422 that complains about
// the SHAPE of the request — an unanswered `tool_use`, an unmatched `tool_result`, an empty content
// block — is the one provider failure a retry can actually fix, because we control the shape. It has
// to be told apart from the other things a 400 can mean: Anthropic returns 400 for an exhausted
// credit balance too, and re-sending a differently-shaped transcript would not help there.
const SHAPE_SIGNAL = /tool_use|tool_result|tool_call|content block|non-?empty|must alternate|roles must|messages\.|messages\[|"messages"|invalid_request_error/i;
const NOT_SHAPE_SIGNAL = /credit|billing|quota|payment|overloaded|rate.?limit|api.?key|authentication|permission|not_found|model.{0,12}(not found|does not exist)/i;

export function isProviderRequestShapeRejection(status: number | undefined, signalText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  if (NOT_SHAPE_SIGNAL.test(signalText)) return false;
  return SHAPE_SIGNAL.test(signalText);
}
