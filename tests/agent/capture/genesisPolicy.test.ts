import { afterEach, describe, expect, it } from "vitest";
import {
  FLEET_GENESIS_POLICY,
  GENESIS_ARTIFACTS,
  GENESIS_ARTIFACT_CLI_FLAGS,
  GENESIS_ARTIFACT_INPUT_FIELDS,
  activeGenesisPolicy,
  clearGenesisPolicyProviderForTests,
  genesisArtifactCliArgs,
  genesisArtifactRefusalMessage,
  genesisArtifactWaysOut,
  missingGenesisArtifacts,
  resolveGenesisPolicy,
  setGenesisPolicyProvider
} from "../../../src/agent/capture/genesisPolicy.js";

// W3 (Wolf, 2026-09-09) — the SHARED-VOCABULARY pin for the genesis policy.
//
// The law lives in the platform repo (packages/core/lib/genesis-policy.ts, mirrored for the ops
// CLIs in packages/core/cli/genesis-manifest.mjs). This repo cannot import either — two separately
// deployed services, no shared package — so the enum and the artifact -> input-field map are spelled
// out here, LITERALLY rather than derived, and the platform pins the identical literals on its two
// copies. That is the whole mechanism: a one-sided change turns a test red instead of quietly
// teaching `site.duplicate` to refuse something `create-site` allows, or the reverse.

describe("genesis policy (CMS-Agent mirror of the platform's fleet law)", () => {
  afterEach(() => clearGenesisPolicyProviderForTests());

  it("ships EMPTY — nothing is required until the fleet default is changed on BOTH sides", () => {
    expect([...FLEET_GENESIS_POLICY.requiredArtifacts]).toEqual([]);
    expect([...activeGenesisPolicy().requiredArtifacts]).toEqual([]);
  });

  it("pins the closed artifact enum, character for character, against the platform's", () => {
    expect([...GENESIS_ARTIFACTS]).toEqual([
      "editorial_strategy",
      "editorial_voice",
      "visual_standard",
      "logo",
      "tracking_config"
    ]);
  });

  it("pins the artifact -> INPUT FIELD map — what missing[] names, and what a caller types", () => {
    expect({ ...GENESIS_ARTIFACT_INPUT_FIELDS }).toEqual({
      editorial_strategy: "editorialStrategy",
      editorial_voice: "editorialVoice",
      visual_standard: "visualStandard",
      logo: "logo",
      tracking_config: "trackingConfig"
    });
  });

  it("pins the platform CLI flag each artifact travels to the scaffold under", () => {
    expect({ ...GENESIS_ARTIFACT_CLI_FLAGS }).toEqual({
      editorial_strategy: "--editorial-strategy",
      editorial_voice: "--editorial-voice",
      visual_standard: "--visual-standard",
      logo: "--logo",
      tracking_config: "--tracking-config"
    });
  });

  it("a malformed policy THROWS rather than resolving to the permissive default", () => {
    // The permissive default is `[]`, so a silent fallback would turn "the fleet requires a
    // strategy" into "nothing is required" with no output at all.
    expect(() => resolveGenesisPolicy({})).toThrow(/Invalid genesis-policy config/);
    expect(() => resolveGenesisPolicy({ requiredArtifacts: "editorial_strategy" })).toThrow(/Invalid genesis-policy/);
    expect(() => resolveGenesisPolicy({ requiredArtifacts: ["editorial_stratgy"] })).toThrow(/Invalid genesis-policy/);
    expect(() => resolveGenesisPolicy({ requiredArtifacts: ["logo", "logo"] })).toThrow(/Invalid genesis-policy/);
    expect(() => resolveGenesisPolicy({ requiredArtifacts: [], extra: true })).toThrow(/Invalid genesis-policy/);

    setGenesisPolicyProvider(() => ({ requiredArtifacts: ["nope"] }));
    expect(() => activeGenesisPolicy()).toThrow(/Invalid genesis-policy config/);
  });

  it("the pure resolver reports INPUT FIELD names, in policy order, for what was not supplied", () => {
    const policy = resolveGenesisPolicy({ requiredArtifacts: ["editorial_strategy", "logo"] });
    expect(missingGenesisArtifacts(policy, {})).toEqual(["editorialStrategy", "logo"]);
    expect(missingGenesisArtifacts(policy, { editorialStrategy: { goal: "x" } })).toEqual(["logo"]);
    expect(missingGenesisArtifacts(policy, { editorialStrategy: {}, logo: { text: "A" } })).toEqual([]);
    // A parsed tool input carries keys set to undefined for anything omitted.
    expect(missingGenesisArtifacts(policy, { editorialStrategy: undefined, logo: undefined })).toEqual([
      "editorialStrategy",
      "logo"
    ]);
    expect(missingGenesisArtifacts(FLEET_GENESIS_POLICY, {})).toEqual([]);
  });

  it("the refusal names BOTH ways out, in the caller's own vocabulary", () => {
    const message = genesisArtifactRefusalMessage(["editorialStrategy"]);
    expect(message).toMatch(/SUPPLY NOW/);
    expect(message).toMatch(/LOWER THE POLICY/);
    expect(message).toMatch(/editorialStrategy/);
    expect(message).toMatch(/--editorial-strategy/);
    // It must state that nothing was provisioned — the difference between a refusal and a failure.
    expect(message).toMatch(/Nothing was provisioned/);
    // Object-type names never appear: a caller sent looking for `editorial_strategy` finds no field.
    expect(message).not.toMatch(/editorial_strategy/);

    const waysOut = genesisArtifactWaysOut(["editorialStrategy"]);
    expect(waysOut).toHaveLength(2);
    expect(waysOut[0]).toMatch(/^supply now:/);
    expect(waysOut[1]).toMatch(/^lower the policy:/);
  });

  it("every artifact the policy can require is supplyable — a refusal with one door is not a refusal", () => {
    // The closed enum's other half: each member has a field AND a flag, so "SUPPLY NOW" is always
    // a real door. `genesisArtifactCliArgs` is what carries a supplied body to the platform mint,
    // so the same inputs that satisfy this side satisfy the platform's own copy of the policy.
    for (const artifact of GENESIS_ARTIFACTS) {
      const field = GENESIS_ARTIFACT_INPUT_FIELDS[artifact];
      expect(field).toBeTruthy();
      expect(GENESIS_ARTIFACT_CLI_FLAGS[artifact]).toBeTruthy();
      expect(genesisArtifactCliArgs({ [field]: { a: 1 } })).toEqual([GENESIS_ARTIFACT_CLI_FLAGS[artifact], '{"a":1}']);
    }
    expect(genesisArtifactCliArgs({})).toEqual([]);
    // Order follows the enum, not the caller's key order — deterministic argv for the subprocess.
    expect(genesisArtifactCliArgs({ logo: { text: "A" }, editorialVoice: { name: "v" } })).toEqual([
      "--editorial-voice",
      '{"name":"v"}',
      "--logo",
      '{"text":"A"}'
    ]);
  });
});
