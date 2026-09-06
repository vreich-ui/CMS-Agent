import { describe, expect, it } from "vitest";
import { MAX_CONVERSATION_TOOLS, MAX_TOOLS_CHARS } from "../../../src/agent/conversations/conversationContract.js";

describe("conversation tool bound (W19, W21)", () => {
  it("leaves the caller real headroom above its registry", () => {
    // Platform's chat registry stood at 63 tools plus one learning-mode tool
    // when this was first raised: the old ceiling of 64, with nothing spare. It
    // happened again in W21 — three new tenant analytics tools took the
    // admin-chat wire to 97 against a bound of 96, silently dropping the whole
    // 16-tool membership family from every turn. A bound a caller is already
    // touching is a bound that truncates silently, so this floor moves with
    // Platform's `CMS_AGENT_BOUNDS.maxTools` and never lags it: below 99 the
    // caller engages its `legacyMaxTools=64` fallback.
    expect(MAX_CONVERSATION_TOOLS).toBeGreaterThanOrEqual(99);
  });

  it("keeps the character bound as the real payload guard", () => {
    // Raising the COUNT must not become a way to send a bigger payload — this
    // is the limit that actually protects cost, and it did not move.
    expect(MAX_TOOLS_CHARS).toBe(256_000);
  });
});
