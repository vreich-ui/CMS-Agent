// Tolerant deep-search helpers over MCP tool results, shared by the per-project publish execution
// hooks and the generic publisher. Result envelope shapes vary across MCP servers (raw result vs.
// { structuredContent } vs. nested data), so these searches are intentionally forgiving: they walk
// the whole result object (bounded depth) for the first value under a matching key rather than
// pinning one envelope shape per client.

// Depth-first search for the first child value whose (key, value) pair satisfies `match`. Returns
// undefined when nothing matches — matched values that are themselves falsy (e.g. `valid: false`)
// still propagate correctly.
export const findDeep = (value: unknown, match: (key: string, child: unknown) => boolean, depth = 0): unknown => {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (match(key, child)) return child;
    const found = findDeep(child, match, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

// Deep-search a tool result for a checkout's lock token.
//
// BOTH SPELLINGS, and that is not defensive padding — it is the actual wire.
// `object_checkout` INPUTS take `lock_token` everywhere, and every other verb (patch, publish,
// checkin, refresh_lock, site_apply_theme) takes `lock_token` too, so snake_case reads as the
// obvious and only shape. But the checkout RESPONSE returns the token as `lockToken`
// (object-lock.ts: `result(200, { action: "checkout", lockToken: lock.token, ... })`). One key, two
// cases, on opposite sides of the same call.
//
// Matching only `lock_token` therefore found nothing on a checkout that had in fact SUCCEEDED and
// taken the lock — run_1787930929962_njffct, 2026-08-28: object_create ok, object_checkout ok, and
// then `checkout_missing_lock_token`, with the lock genuinely held on the client for its full lease
// and a half-written object left behind. The sibling reader in objectPublishExecution.ts already
// accepted both (`record.lockToken ?? record.lock_token`); this one, the one every project's publish
// hook actually calls, did not — which is why no publish through the hook path had ever completed.
//
// This is the same tolerance findObjectId already applies to `object_id` / `id`. Fixing it here
// rather than renaming the platform's response key is deliberate: the response shape is fleet-wide
// (packages/core serves every site), so changing it would break any client already reading
// `lockToken`, while a tolerant reader breaks nothing and costs one comparison.
const LOCK_TOKEN_KEYS = new Set(["lock_token", "lockToken"]);
export const findLockToken = (value: unknown): string | undefined =>
  findDeep(value, (key, child) => LOCK_TOKEN_KEYS.has(key) && typeof child === "string" && child !== "") as string | undefined;
