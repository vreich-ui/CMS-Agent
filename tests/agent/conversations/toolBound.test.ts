import { describe, expect, it } from "vitest";
import { MAX_CONVERSATION_TOOLS, MAX_TOOLS_CHARS } from "../../../src/agent/conversations/conversationContract.js";

describe("conversation tool bound (W19)", () => {
  it("leaves the caller real headroom above its registry", () => {
    // Platform's chat registry stood at 63 tools plus one learning-mode tool
    // when this was raised: the old ceiling of 64, with nothing spare. A bound
    // a caller is already touching is a bound that truncates silently.
    expect(MAX_CONVERSATION_TOOLS).toBeGreaterThanOrEqual(96);
  });

  it("keeps the character bound as the real payload guard", () => {
    // Raising the COUNT must not become a way to send a bigger payload — this
    // is the limit that actually protects cost, and it did not move.
    expect(MAX_TOOLS_CHARS).toBe(256_000);
  });
});
