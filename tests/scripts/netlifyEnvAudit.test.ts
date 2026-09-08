import { describe, expect, it } from "vitest";
import { findShadows, renderReport, runAudit, summariseEnvVar } from "../../scripts/netlify-env-audit.js";

// C-18: a site-level Netlify variable OVERRIDES the account-level one of the same name, and genesis
// wrote per-site copies of variables the account already held. The fleet therefore has two sources
// of truth for the sink credential, and rotating the account value would leave every shadowing site
// on the old one — 401s from sites that look correctly configured.
//
// The audit's two obligations are asserted here: it must find the shadows, and no value may ever
// reach its output. The fixture's values are distinctive strings so the second is provable.

const SECRET_LOOKING = "tok_live_DO_NOT_PRINT_ME_0001";
const URL_LOOKING = "https://kugel-data.netlify.app/api/tracking-sink";

const accountVar = (key: string, isSecret: boolean, valueIds: string[], value: string) => ({
  key,
  is_secret: isSecret,
  scopes: ["builds", "functions", "post_processing", "runtime"],
  updated_at: "2026-09-01T00:00:00.000Z",
  values: valueIds.map((id) => ({ id, context: "all", role: null, value })),
});

const siteVar = (key: string, isSecret: boolean, valueIds: string[], value: string) => ({
  key,
  is_secret: isSecret,
  scopes: ["builds", "functions"],
  values: valueIds.map((id, index) => ({ id, context: ["production", "deploy-preview", "branch-deploy", "dev"][index] ?? "production", value })),
});

const ACCOUNT = [
  accountVar("TRACKING_SINK_TOKEN", false, ["acct-token-1"], SECRET_LOOKING),
  accountVar("TRACKING_SINK_URL", false, ["acct-url-1"], URL_LOOKING),
];

const SITES = [
  // Shadows the token with its own copy; inherits the URL.
  { site: "drluriescience", vars: [siteVar("TRACKING_SINK_TOKEN", true, ["site-token-1", "site-token-2"], SECRET_LOOKING), accountVar("TRACKING_SINK_URL", false, ["acct-url-1"], URL_LOOKING)].map(summariseEnvVar) },
  // Inherits both.
  { site: "kugel-platform", vars: ACCOUNT.map(summariseEnvVar) },
];

describe("summariseEnvVar", () => {
  it("keeps identity and drops the value", () => {
    const summary = summariseEnvVar(accountVar("TRACKING_SINK_TOKEN", false, ["acct-token-1"], SECRET_LOOKING));
    expect(summary).toEqual({ key: "TRACKING_SINK_TOKEN", isSecret: false, scopes: ["builds", "functions", "post_processing", "runtime"], contexts: ["all"], valueIds: ["acct-token-1"] });
    expect(JSON.stringify(summary)).not.toContain(SECRET_LOOKING);
  });

  it("survives a variable shaped unlike the documentation", () => {
    expect(summariseEnvVar(null)).toEqual({ key: "", isSecret: false, scopes: [], contexts: [], valueIds: [] });
    expect(summariseEnvVar({ key: "X", values: "not an array" })).toEqual({ key: "X", isSecret: false, scopes: [], contexts: [], valueIds: [] });
  });
});

describe("findShadows", () => {
  it("reports a site with its own copy and stays quiet about a site that inherits", () => {
    const shadows = findShadows(ACCOUNT.map(summariseEnvVar), SITES);
    expect(shadows).toEqual([
      { site: "drluriescience", key: "TRACKING_SINK_TOKEN", contexts: ["production", "deploy-preview"], isSecret: true, accountIsSecret: false },
    ]);
  });
});

describe("renderReport", () => {
  const report = renderReport("vreich", ACCOUNT.map(summariseEnvVar), SITES);

  it("never prints a value", () => {
    expect(report).not.toContain(SECRET_LOOKING);
    expect(report).not.toContain(URL_LOOKING);
    expect(report).not.toMatch(/\bvalue\b\s*[:=]/);
  });

  it("names the shadow and the credential-shaped account variable that is not marked secret", () => {
    expect(report).toContain("drluriescience");
    expect(report).toContain("TRACKING_SINK_TOKEN");
    expect(report).toContain("NOT marked is_secret");
    expect(report).toContain("✗ 1 shadow(s)");
  });

  it("says so plainly when there is nothing to report", () => {
    const clean = renderReport("vreich", ACCOUNT.map(summariseEnvVar), [{ site: "kugel-platform", vars: ACCOUNT.map(summariseEnvVar) }]);
    expect(clean).toContain("✓ No shadows");
  });
});

describe("runAudit", () => {
  it("refuses a team slug the token cannot see, rather than auditing the wrong team", async () => {
    const fetcher = async () => ({ ok: true, status: 200, json: async () => [{ id: "acct_1", slug: "someone-else" }] });
    await expect(runAudit(fetcher, "token", "vreich")).rejects.toThrow(/No Netlify team with slug "vreich"/);
  });

  it("reports the failing call by path and status, never by body", async () => {
    const fetcher = async () => ({ ok: false, status: 401, json: async () => ({ secret: SECRET_LOOKING }) });
    await expect(runAudit(fetcher, "token", "vreich")).rejects.toThrow("Netlify GET /api/v1/accounts failed: HTTP 401");
  });
});
