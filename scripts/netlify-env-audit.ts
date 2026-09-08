/**
 * Netlify environment audit — NAMES ONLY (W3 / T3.1).
 *
 * WHAT IT IS FOR. C-18: genesis wrote a per-site COPY of an account-level variable, and a site-level
 * Netlify variable OVERRIDES the account-level one of the same name. So the fleet has two sources of
 * truth for the same key and no way to see it from the repository — rotating the account value
 * leaves every shadowing site on the old one, silently, until someone notices 401s. This lists the
 * shadows.
 *
 * WHY IT DOES NOT USE NetlifyGenesisClient. That class is on the live provisioning path and its
 * methods WRITE. Adding list methods to it so a read-only audit could borrow them would widen a
 * class whose whole discipline is that every method is accounted for. This is a separate read-only
 * script that borrows the constants and the redaction rule instead.
 *
 * VALUES. The Netlify API returns values for non-secret variables whether or not you want them.
 * `summariseEnvVar` is the only place a raw variable is touched, and it keeps the key, `is_secret`,
 * the scopes, the context names and the VALUE IDS — never a value. Nothing downstream of it can
 * print one because nothing downstream of it has one. `tests/scripts/netlifyEnvAudit.test.ts`
 * asserts that on a fixture whose values are distinctive strings.
 *
 * HOW A SHADOW IS DETECTED. Netlify's env objects carry no "level" field: querying
 * /accounts/{id}/env?site_id=X returns the account's variables and the site's own, merged, in the
 * same shape. But the VALUE IDS are stable and per-record, so a variable whose value ids under a
 * site are not the account's value ids is the site's own copy. That is the whole test, and it needs
 * no value.
 *
 *   npm run env:audit          # NETLIFY_AUTH_TOKEN required; NETLIFY_TEAM_SLUG defaults to vreich
 */
import { pathToFileURL } from "node:url";
import { NETLIFY_DEFAULT_ENV_SCOPES, NETLIFY_SECRET_CONTEXTS } from "../src/agent/capture/siteGenesis.js";

export type EnvVarSummary = {
  key: string;
  isSecret: boolean;
  scopes: string[];
  contexts: string[];
  /** Netlify's per-value record ids. Identity only — never a value. */
  valueIds: string[];
};

export type SiteEnv = { site: string; vars: EnvVarSummary[] };
export type Shadow = { site: string; key: string; contexts: string[]; isSecret: boolean; accountIsSecret: boolean };

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asStrings = (value: unknown): string[] => asArray(value).filter((entry): entry is string => typeof entry === "string");

/** The ONLY function that sees a raw Netlify env variable. Values stop here. */
export const summariseEnvVar = (raw: unknown): EnvVarSummary => {
  const record = asRecord(raw);
  const values = asArray(record.values).map(asRecord);
  return {
    key: typeof record.key === "string" ? record.key : "",
    isSecret: record.is_secret === true,
    scopes: asStrings(record.scopes),
    contexts: values.map((value) => (typeof value.context === "string" ? value.context : "?")),
    valueIds: values.map((value) => (typeof value.id === "string" ? value.id : "")),
  };
};

export const findShadows = (accountVars: EnvVarSummary[], sites: SiteEnv[]): Shadow[] => {
  const shadows: Shadow[] = [];
  for (const accountVar of accountVars) {
    const accountValueIds = new Set(accountVar.valueIds);
    for (const site of sites) {
      const seen = site.vars.find((candidate) => candidate.key === accountVar.key);
      if (!seen) continue;
      // Inherited: the site sees exactly the account's value records, AND we could read those ids.
      // `[].every(...)` is true, so a variable whose values came back empty, absent, or without ids
      // would otherwise be classified as inherited and never reported — a false "✓ No shadows" on a
      // fleet full of them, which is the one answer this audit must never give wrongly.
      const readable = seen.valueIds.filter((id) => id.length > 0);
      const provablyInherited = readable.length === seen.valueIds.length && readable.length > 0 && readable.every((id) => accountValueIds.has(id));
      if (provablyInherited) continue;
      shadows.push({ site: site.site, key: accountVar.key, contexts: seen.contexts, isSecret: seen.isSecret, accountIsSecret: accountVar.isSecret });
    }
  }
  return shadows.sort((a, b) => a.key.localeCompare(b.key) || a.site.localeCompare(b.site));
};

const table = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => (cell ?? "").padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
};

export const renderReport = (team: string, accountVars: EnvVarSummary[], sites: SiteEnv[]): string => {
  const shadows = findShadows(accountVars, sites);
  const out: string[] = [];
  out.push(`Netlify env audit — team ${team}, ${sites.length} site(s). Names only; no value is read into this report.`);
  out.push("");
  out.push("ACCOUNT-LEVEL VARIABLES");
  out.push(table(
    ["KEY", "IS_SECRET", "CONTEXTS", "SCOPES"],
    accountVars.map((entry) => [entry.key, String(entry.isSecret), entry.contexts.join(","), entry.scopes.join(",")])
  ));
  out.push("");
  // A secret written with context "all" is refused by Netlify, because "all" includes `dev` and the
  // dev context forbids secret values. So an account variable holding a credential at context "all"
  // is, necessarily, NOT marked secret — it is readable in the UI and in every build log that echoes
  // its environment. That is the shape this line looks for.
  const credentialShaped = accountVars.filter((entry) => /TOKEN|SECRET|KEY|PASSWORD/.test(entry.key) && !entry.isSecret);
  if (credentialShaped.length) {
    out.push(`⚠ ${credentialShaped.length} credential-shaped account variable(s) are NOT marked is_secret: ${credentialShaped.map((entry) => entry.key).join(", ")}`);
    out.push(`  A secret cannot hold context "all" (that includes dev, which forbids secrets); write it as ${NETLIFY_SECRET_CONTEXTS.join(", ")}.`);
    out.push(`  Default scopes for a tracking variable are ${NETLIFY_DEFAULT_ENV_SCOPES.join(", ")} — \`builds\` must stay, the tenant repo reads tracking env at build time.`);
    out.push("");
  }
  out.push("SITE-LEVEL SHADOWS (a site copy overriding the account variable of the same name)");
  out.push(shadows.length
    ? table(
        ["SITE", "KEY", "CONTEXTS", "IS_SECRET", "ACCOUNT IS_SECRET"],
        shadows.map((shadow) => [shadow.site, shadow.key, shadow.contexts.join(","), String(shadow.isSecret), String(shadow.accountIsSecret)])
      )
    : "  none — every site inherits the account value.");
  out.push("");
  out.push(shadows.length
    ? `✗ ${shadows.length} shadow(s). Rotating the account value would leave these sites on the old one. Delete each site-level copy, then redeploy that site (env is snapshotted at deploy).`
    : "✓ No shadows. A rotation of an account value reaches every site on its next deploy.");
  return out.join("\n");
};

// ---------------------------------------------------------------------------------------------

type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const netlifyGet = async (fetcher: Fetcher, token: string, path: string): Promise<unknown> => {
  const url = `https://api.netlify.com/api/v1${path}`;
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
  // METHOD, path and status only, exactly as siteGenesis logs them. No body, no query string.
  if (!response.ok) throw new Error(`Netlify GET ${new URL(url).pathname} failed: HTTP ${response.status}`);
  return response.json();
};

export const runAudit = async (fetcher: Fetcher, token: string, teamSlug: string): Promise<string> => {
  const accounts = asArray(await netlifyGet(fetcher, token, "/accounts")).map(asRecord);
  const team = accounts.find((account) => account.slug === teamSlug);
  if (!team) throw new Error(`No Netlify team with slug "${teamSlug}" is visible to this token.`);
  const accountId = String(team.id);

  const accountVars = asArray(await netlifyGet(fetcher, token, `/accounts/${encodeURIComponent(accountId)}/env`)).map(summariseEnvVar);

  const sites: SiteEnv[] = [];
  for (let page = 1; ; page++) {
    const batch = asArray(await netlifyGet(fetcher, token, `/${encodeURIComponent(teamSlug)}/sites?per_page=100&page=${page}`)).map(asRecord);
    if (!batch.length) break;
    for (const site of batch) {
      const vars = asArray(await netlifyGet(fetcher, token, `/accounts/${encodeURIComponent(accountId)}/env?site_id=${encodeURIComponent(String(site.id))}`)).map(summariseEnvVar);
      sites.push({ site: String(site.name ?? site.id), vars });
    }
    if (batch.length < 100) break;
  }
  return renderReport(teamSlug, accountVars, sites);
};

const main = async (): Promise<void> => {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    console.error("✗ NETLIFY_AUTH_TOKEN is not set. This audit reads the account and every site's env NAMES; it cannot run without one.");
    process.exit(2);
  }
  const teamSlug = process.env.NETLIFY_TEAM_SLUG ?? "vreich";
  const report = await runAudit(fetch as unknown as Fetcher, token, teamSlug);
  console.log(report);
  process.exit(report.includes("✗") ? 1 : 0);
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
