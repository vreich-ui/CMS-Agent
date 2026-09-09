// W3 (Wolf, 2026-09-09) — the CMS-Agent half of the fleet genesis policy: which baseline artifacts
// a mint must supply, or the tenant is not born at all.
//
// WHY THIS FILE IS A COPY, AND WHAT KEEPS IT HONEST
// ------------------------------------------------
// The law lives in the platform repo, at `packages/core/lib/genesis-policy.ts`, with a plain-.mjs
// mirror at `packages/core/cli/genesis-manifest.mjs` that `create-site.mjs` reads at buildPlan
// time. This repo cannot import either: they are two separately-deployed services with no shared
// package, which is the same reason `publishing-policy.ts`'s `autonomyMode` is duplicated on both
// sides (platform's own module says so in its header). So the vocabulary — the closed artifact
// enum and the artifact -> INPUT FIELD map — is spelled out here and pinned by
// `tests/agent/capture/genesisPolicy.test.ts`, exactly as the platform side pins its two copies.
// Change one, change all three, in one wave. A one-sided change makes two surfaces refuse
// different things, which is worse than neither refusing.
//
// WHY THE CHECK HAPPENS HERE AND NOT ONLY DOWNSTREAM
// -------------------------------------------------
// `create-site.mjs` enforces the same policy at its own buildPlan, so a scaffold driven through
// the platform seam would be refused there too. That is not sufficient. `runSiteGenesis` reaches
// the scaffold only when a platform checkout is mounted (`PLATFORM_REPO_ROOT`); without one it
// skips straight past it and goes on to CREATE A NETLIFY SITE, a build hook, env vars and a
// registry project. A refusal that only fires in the checkout-mounted case would let the
// checkout-less case provision live infrastructure for a tenant the policy says may not exist.
// So the gate is the FIRST thing `runSiteGenesis` does, before any side effect of any kind.
//
// SCOPE. This is FLEET-wide, not per-project: it is asked once per tenant, at birth, about a
// project record that does not exist yet. There is no per-project record to hang it on and none is
// invented. The committed default below ships EMPTY — nothing required — and a fleet-wide change
// is an edit to this constant AND to the platform's `FLEET_GENESIS_POLICY`, deployed together.

import { z } from "zod";

/**
 * The closed set of baseline artifacts a mint can be required to supply. CLOSED on purpose: an
 * open list would let a policy require something no mint path can accept, producing a refusal with
 * only one way out — which is an outage wearing a policy's clothes, not a refusal. Every member is
 * supplyable through `site.duplicate`'s `newSite` and through a `create-site` flag.
 *
 * MIRRORS platform `packages/core/lib/genesis-policy.ts:GENESIS_ARTIFACTS`.
 */
export const GENESIS_ARTIFACTS = [
  "editorial_strategy",
  "editorial_voice",
  "visual_standard",
  "logo",
  "tracking_config"
] as const;

export type GenesisArtifact = (typeof GENESIS_ARTIFACTS)[number];

/**
 * Artifact (an OBJECT TYPE name) -> the INPUT FIELD name a caller supplies it under, which is what
 * a refusal's `missing[]` names. `missing: ["editorial_strategy"]` tells an operator what the
 * tenant lacks; `missing: ["editorialStrategy"]` tells them what to TYPE — and on this surface
 * that is a `newSite.editorialStrategy` key, the same name platform's CLI parses `--editorial-
 * strategy` into. Deliberately the same names on both sides.
 *
 * MIRRORS platform `GENESIS_ARTIFACT_INPUT_FIELDS`.
 */
export const GENESIS_ARTIFACT_INPUT_FIELDS: Readonly<Record<GenesisArtifact, string>> = Object.freeze({
  editorial_strategy: "editorialStrategy",
  editorial_voice: "editorialVoice",
  visual_standard: "visualStandard",
  logo: "logo",
  tracking_config: "trackingConfig"
});

/** The platform CLI flag each artifact travels to the scaffold under. MIRRORS `GENESIS_ARTIFACT_CLI_FLAGS`. */
export const GENESIS_ARTIFACT_CLI_FLAGS: Readonly<Record<GenesisArtifact, string>> = Object.freeze({
  editorial_strategy: "--editorial-strategy",
  editorial_voice: "--editorial-voice",
  visual_standard: "--visual-standard",
  logo: "--logo",
  tracking_config: "--tracking-config"
});

/** `strictObject` + closed enum: a typo'd artifact or a stray key FAILS THE PARSE, never resolves permissively. */
export const genesisPolicySchema = z
  .strictObject({
    requiredArtifacts: z
      .array(z.enum(GENESIS_ARTIFACTS))
      .refine((list) => new Set(list).size === list.length, { message: "requiredArtifacts must not repeat an artifact" })
  })
  .strict();

export type GenesisPolicy = z.infer<typeof genesisPolicySchema>;

/** THE COMMITTED FLEET DEFAULT: nothing is required. Kept in lockstep with platform's FLEET_GENESIS_POLICY. */
export const FLEET_GENESIS_POLICY: GenesisPolicy = Object.freeze({
  requiredArtifacts: Object.freeze([]) as unknown as GenesisArtifact[]
});

/**
 * Validate a policy value. THROWS on anything malformed rather than falling back — the permissive
 * default is `[]`, so a silent fallback would turn "the fleet requires a strategy" into "nothing is
 * required" with no output at all.
 */
export const resolveGenesisPolicy = (config: unknown): GenesisPolicy => {
  const parsed = genesisPolicySchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid genesis-policy config (src/agent/capture/genesisPolicy.ts): ${parsed.error.message}`);
  }
  return parsed.data;
};

/**
 * THE PURE RESOLVER. `supplied` is keyed by INPUT FIELD name, so a tool's parsed `newSite` drops
 * straight in; a key present but `undefined` counts as not supplied. Returns input-field names in
 * policy order — never object-type names.
 */
export const missingGenesisArtifacts = (policy: GenesisPolicy, supplied: Readonly<Record<string, unknown>>): string[] =>
  policy.requiredArtifacts
    .filter((artifact) => supplied[GENESIS_ARTIFACT_INPUT_FIELDS[artifact]] === undefined)
    .map((artifact) => GENESIS_ARTIFACT_INPUT_FIELDS[artifact]);

/**
 * The refusal message. Per the 2026-09-07 blockage contract a blockage is CLASSIFIED (the code
 * `genesis_artifact_required`, which the caller branches on) and ACTIONABLE (it names BOTH ways
 * out, so nobody has to guess which door is unlocked): supply the baseline now, or lower the
 * policy. Deliberately NOT a third door — "mint it now and fill it in later" is the second door
 * wearing a disguise, and offering it separately is how a required artifact stops being required.
 *
 * Word-for-word alignment with the platform's `genesisArtifactRefusal` is intentional: an operator
 * who meets this refusal from `site.duplicate` and then from `create-site` must recognize it as the
 * same rule, not read it as two unrelated failures.
 */
export const genesisArtifactRefusalMessage = (missing: readonly string[]): string => {
  const fields = missing.join(", ");
  const flags = missing
    .map((field) => {
      const artifact = GENESIS_ARTIFACTS.find((name) => GENESIS_ARTIFACT_INPUT_FIELDS[name] === field);
      return artifact ? GENESIS_ARTIFACT_CLI_FLAGS[artifact] : `--${field}`;
    })
    .join(" ");
  return (
    `Genesis policy requires ${missing.length === 1 ? "a baseline" : "baselines"} this mint did not supply: ${fields}. ` +
    "Nothing was provisioned: no Netlify site, no build hook, no project record. Two ways out: " +
    `SUPPLY NOW — pass ${fields} on newSite as a partial body (they travel to the platform scaffold as ${flags}), and the tenant is born with it marked provenance.set_by:"agent"; ` +
    "or LOWER THE POLICY — take it off genesisPolicy.requiredArtifacts and the tenant is born with the genesis_default placeholder the fleet warns about instead of blocking on."
  );
};

/** The two ways out, machine-readable, in the order an operator should consider them. */
export const genesisArtifactWaysOut = (missing: readonly string[]): [string, string] => {
  const fields = missing.join(", ");
  return [
    `supply now: pass ${fields} on newSite as a partial body.`,
    "lower the policy: remove the artifact from genesisPolicy.requiredArtifacts (platform genesis_policy_set, or the committed FLEET_GENESIS_POLICY on both sides)."
  ];
};

/**
 * Provider-injection seam, mirroring the platform module. An ABSENT provider is never an error —
 * the committed fleet default is a complete policy and a deployment that registered nothing must
 * behave exactly as it says. A provider returning something MALFORMED throws: absence is a
 * configuration somebody chose, malformation is a configuration nobody chose.
 */
let genesisPolicyProvider: (() => unknown) | undefined;

export const setGenesisPolicyProvider = (provider: () => unknown): void => {
  genesisPolicyProvider = provider;
};

/** Test-only: drop a registered provider so one test cannot leak into another's assertions. */
export const clearGenesisPolicyProviderForTests = (): void => {
  genesisPolicyProvider = undefined;
};

/** The policy in force: the registered provider's config, else the committed fleet default. */
export const activeGenesisPolicy = (): GenesisPolicy =>
  genesisPolicyProvider ? resolveGenesisPolicy(genesisPolicyProvider()) : FLEET_GENESIS_POLICY;

/** The CLI flags a supplied `newSite` contributes to the platform scaffold, in enum order. */
export const genesisArtifactCliArgs = (supplied: Readonly<Record<string, unknown>>): string[] =>
  GENESIS_ARTIFACTS.flatMap((artifact) => {
    const value = supplied[GENESIS_ARTIFACT_INPUT_FIELDS[artifact]];
    return value === undefined ? [] : [GENESIS_ARTIFACT_CLI_FLAGS[artifact], JSON.stringify(value)];
  });
