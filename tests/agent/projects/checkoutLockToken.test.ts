import { describe, expect, it } from "vitest";
import { findLockToken } from "../../../src/agent/projects/toolResultSearch.js";

// run_1787930929962_njffct, 2026-08-28 — the publish that got two calls in and stopped.
//
// object_create ok. object_checkout ok. Then `checkout_missing_lock_token`, and a lock genuinely
// held on the client for its full fifteen-minute lease with a half-written object left behind.
//
// The token was there. The platform's checkout response returns it as `lockToken`
// (packages/core object-lock.ts: `result(200, { action: "checkout", lockToken: lock.token, ... })`)
// while every verb that CONSUMES it — patch, publish, checkin, refresh_lock — takes `lock_token`.
// One key, two cases, on opposite sides of the same call. This reader matched only the snake_case
// spelling, so it found nothing on a checkout that had succeeded.
//
// The sibling reader in objectPublishExecution.ts already accepted both spellings. This one — the
// one every project's publish hook actually calls — did not, which is why no publish through the
// hook path had ever completed.
describe("findLockToken accepts the spelling the checkout response actually uses", () => {
  const TOKEN = "8f3c1d2e-4b5a-4c6d-9e7f-0a1b2c3d4e5f";

  // The exact shape platform returns, wrapped the way an MCP result arrives.
  it("finds lockToken in a real platform checkout response", () => {
    const checkout = {
      content: [{ type: "text", text: "{}" }],
      structuredContent: { action: "checkout", lockToken: TOKEN, record_version: 2, lock: { owner_id: "unattributed-agent", expires_at: "2026-08-28T16:08:00.588Z" } }
    };
    expect(findLockToken(checkout)).toBe(TOKEN);
  });

  it("still finds the snake_case spelling", () => {
    expect(findLockToken({ result: { data: { lock_token: TOKEN } } })).toBe(TOKEN);
  });

  // The refusals that must stay refusals: a token that is absent, empty, or not a string is not a
  // token, and inventing one would take a lock the client never granted.
  it("returns undefined when there is no usable token", () => {
    expect(findLockToken({ action: "checkout", lock: { owner_id: "x" } })).toBeUndefined();
    expect(findLockToken({ lockToken: "" })).toBeUndefined();
    expect(findLockToken({ lock_token: "" })).toBeUndefined();
    expect(findLockToken({ lockToken: 12345 })).toBeUndefined();
    expect(findLockToken({ lockToken: null })).toBeUndefined();
    expect(findLockToken(undefined)).toBeUndefined();
  });

  // A 423 "already locked" response carries the lock's metadata but NO token — it must not be read
  // as a successful checkout.
  it("returns undefined for a 423 locked response, which carries a lock but no token", () => {
    const locked = { structuredContent: { action: "checkout", locked: true, lock: { owner_id: "someone-else", acquired_at: "2026-08-28T15:53:00.588Z", expires_at: "2026-08-28T16:08:00.588Z" } } };
    expect(findLockToken(locked)).toBeUndefined();
  });
});
