import { describe, expect, it } from "vitest";
import { NOT_SET, renderTenantBaseline, type TenantBaselineFacts } from "../../../../src/agent/conversations/briefing/tenantBaseline.js";
import type { EditorialStrategyBody } from "../../../../src/agent/projects/genesisEditorialStrategy.js";

const baseFacts: TenantBaselineFacts = {
  publicationName: "Acme Publishing",
  autonomyMode: "operator-gated",
  publishEnabled: true
};

const strategy = (overrides: Partial<EditorialStrategyBody> = {}): EditorialStrategyBody => ({
  name: "Acme strategy",
  goal: "Grow qualified readers.",
  offer: "A free consult.",
  audience_segments: ["operators"],
  topic_weights: [{ label: "onboarding", weight: 1 }],
  angle_mix: [{ angle: "explainer", share: 1 }],
  funnel_aggression: { tofu: 0.5, mofu: 0.3, bofu: 0.2 },
  cadence: "Weekly.",
  provenance: { set_by: "human", set_at: "2026-09-10T00:00:00.000Z" },
  ...overrides
});

describe("tenantBaseline — the Sep-9 rule", () => {
  // THE SEP-9 RULE ITSELF: an unset singleton renders as the exact NOT_SET string, never as an
  // omitted line that reads to the model as "nothing to know" or an error to refuse work over.
  it("renders the exact NOT_SET string for an unset strategy, never an omission", () => {
    const rendered = renderTenantBaseline({ ...baseFacts, strategy: undefined });
    expect(rendered).toContain(`- Editorial strategy: ${NOT_SET}`);
  });

  it("renders the exact NOT_SET string for an unset voice, never an omission", () => {
    const rendered = renderTenantBaseline({ ...baseFacts, voice: undefined });
    expect(rendered).toContain(`- Editorial voice: ${NOT_SET}`);
  });

  // A genesis default is USED but is NOT A DECISION — the block must say so out loud so the model
  // never cites genesis' own placeholder back to an editor as though somebody chose it.
  it("labels a genesis-default strategy as provisional", () => {
    const rendered = renderTenantBaseline({ ...baseFacts, strategy: strategy({ provenance: { set_by: "genesis_default", set_at: "2026-09-10T00:00:00.000Z" } }) });
    expect(rendered).toContain("Strategy status: provisional — written at genesis, never reviewed by a human.");
  });

  // A human-set (or agent-set) strategy carries no such caveat: it is a real decision, not a
  // placeholder, and adding the provisional line to it would be exactly as wrong as omitting it from
  // a genesis default.
  it("does not label a human-set strategy as provisional", () => {
    const rendered = renderTenantBaseline({ ...baseFacts, strategy: strategy({ provenance: { set_by: "human", set_at: "2026-09-10T00:00:00.000Z" } }) });
    expect(rendered).not.toContain("Strategy status");
  });

  // THE CHAT-RECOVERY FIX: houseStatus "none" (the read succeeded and genuinely found nothing) and
  // "unknown" (the read never completed) must render DIFFERENT lines. Collapsing them once made a
  // fresh chat on a tenant with no standard assemble a house id the id convention can never produce
  // and call object_get on it, surfacing a red "Object record not found" to the editor.
  it("renders a different line for houseStatus 'none' than for 'unknown'", () => {
    const none = renderTenantBaseline({
      ...baseFacts,
      visualStandard: { houseStatus: "none", templates: [], overridePolicy: "allow" }
    });
    const unknown = renderTenantBaseline({
      ...baseFacts,
      visualStandard: { houseStatus: "unknown", templates: [], overridePolicy: "allow" }
    });
    expect(none).not.toBe(unknown);
    expect(none).toContain(`- Visual standard: ${NOT_SET}. Imagery for this house has no standard to follow yet`);
    const unknownVisualStandardLine = unknown.split("\n").find((line) => line.startsWith("- Visual standard:"));
    expect(unknownVisualStandardLine).toBe("- Visual standard: could not be read this turn — say so rather than assuming the house has none.");
    expect(unknownVisualStandardLine).not.toContain(NOT_SET);
  });

  // Identical SHAPE for a hooked tenant (dr-lurie, fernwell) and a data-defined (genesis-minted) one:
  // the only difference permitted is one clearly-labelled extra line when hookKnowledge is present.
  // This is the invariant the `null`-printing defect (W5) violated for every tenant without a hook.
  it("renders the identical block shape for a hooked tenant and a data-defined one", () => {
    const facts: TenantBaselineFacts = {
      publicationName: "Acme Publishing",
      autonomyMode: "autonomous",
      publishEnabled: true,
      strategy: strategy(),
      voice: { name: "Acme voice", audience: "operators", tone: ["direct"], cadence: "weekly", lexicon: { prefer: [], avoid: [] }, claim_policy: "conservative", cta_policy: "soft", reader_safety_notes: "none", frameworks: [], default_framework: "default" },
      visualStandard: { houseStatus: "present", templates: [], overridePolicy: "allow" }
    };
    const dataDefined = renderTenantBaseline(facts);
    const hooked = renderTenantBaseline({ ...facts, hookKnowledge: { some: "legacy config" } });

    // The hooked tenant's block is the data-defined block PLUS exactly one more, clearly-labelled line.
    expect(hooked.startsWith(dataDefined)).toBe(true);
    const extra = hooked.slice(dataDefined.length);
    expect(extra).toContain("Registered project knowledge");
  });

  it("never omits publication, autonomy or publishing lines regardless of what else is set", () => {
    const rendered = renderTenantBaseline(baseFacts);
    expect(rendered).toContain("- Publication: Acme Publishing");
    expect(rendered).toContain("- How this house runs: operator-gated — propose the work and get one yes before starting it.");
    expect(rendered).toContain("- Publishing: enabled");
  });
});
