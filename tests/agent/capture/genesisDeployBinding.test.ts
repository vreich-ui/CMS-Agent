import { describe, expect, it, vi } from "vitest";
import { NetlifyGenesisClient, isAttachedToRepo, type GenesisDeployBinding } from "../../../src/agent/capture/siteGenesis.js";

// G7 ACCEPTANCE (live half). The dry-run tests in siteGenesisParity pin the PLAN; this file pins the
// behaviour that only exists against a real API — and every case here is a way the binding can look
// like it worked when it did not:
//
//   * repo attached, but a PACKAGE directory survived — precisely the kugel-genesis-lab-2 failure:
//     Netlify then reads the REPO-ROOT netlify.toml and builds another tenant's config;
//   * repo attached, but Netlify's framework detection filled in `cmd`, which overrides the per-site
//     netlify.toml's real build command;
//   * repo attached with no GitHub App installation — a site Netlify cannot clone, and which passes
//     every field check that does not look for the installation;
//   * the PATCH returned 200 and changed nothing (this object has prior form for exactly that);
//   * the site was already attached, so a re-mint would have re-pointed a live tenant.
//
// Hence: verify by RE-READING, on all four fields, every time.

const BINDING: GenesisDeployBinding = {
  provider: "github",
  repoPath: "vreich-ui/platform",
  repoBranch: "main",
  installationId: 95173329,
  base: "sites/acme"
};

const BOUND = { repo_path: "vreich-ui/platform", base: "sites/acme", package_path: "", cmd: "", installation_id: 95173329 };

const response = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

/**
 * A Netlify stub whose site record is real state: PATCH mutates it through `accept`, GET reports it.
 * `accept` returning undefined models a write the API takes and ignores.
 */
const netlify = (
  initial: Record<string, unknown>,
  accept: (envelope: string, body: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined,
  { reference = initial }: { reference?: Record<string, unknown> } = {}
) => {
  let settings = { ...initial };
  const patches: { envelope: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if ((init?.method ?? "GET") === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const envelope = "repo" in body ? "repo" : "build_settings";
      const inner = (body[envelope] ?? {}) as Record<string, unknown>;
      patches.push({ envelope, body: inner });
      const next = accept(envelope, inner);
      if (next) settings = { ...settings, ...next };
      return response({});
    }
    // The reference lookup is TWO reads: the list locates it by name, the single-site GET is what
    // the binding is actually read from (the list projection may omit installation_id).
    if (url.includes("/sites?name=")) return response([{ id: "reference-site", name: "zilbermanfilmfoundation" }]);
    if (url.includes("/sites/reference-site")) return response({ id: "reference-site", build_settings: reference });
    return response({ id: "site-1", build_settings: settings });
  });
  return { impl: impl as never, patches, current: () => settings };
};

/** What a successful bind writes: repo attached, base set, package directory and command gone. */
const applied = (body: Record<string, unknown>) => ({
  repo_path: body.repo ?? body.repo_path,
  installation_id: body.installation_id,
  base: body.base,
  package_path: body.package_path,
  cmd: body.cmd
});

const client = (impl: never) => new NetlifyGenesisClient("live", "netlify-token", impl, async () => {});
const requiresHuman = (client_: NetlifyGenesisClient) => client_.actions.find((entry) => entry.step === "netlify_deploy_binding")!;

describe("G7 — bindRepository writes and verifies", () => {
  it("binds an unbound site, carries the App installation, and confirms by re-reading", async () => {
    const api = netlify({}, (_envelope, body) => applied(body));
    const result = await client(api.impl).bindRepository("site-1", BINDING);

    expect(result).toMatchObject({ bound: true });
    expect(api.patches.map((patch) => patch.envelope)).toEqual(["repo"]);
    // Without the installation id the repo is attached but unclonable — every deploy fails while
    // repo/base/package_path all read correctly.
    expect(api.patches[0].body.installation_id).toBe(95173329);
    expect(api.current()).toMatchObject({ repo_path: "vreich-ui/platform", base: "sites/acme", package_path: "", cmd: "" });
  });

  it("falls back to the flat build_settings envelope when the repo envelope does not persist", async () => {
    // The body shape for this object is not pinned by any doc we control, so genesis tries both and
    // lets the re-read decide which one the account actually accepted.
    const api = netlify({}, (envelope, body) => (envelope === "build_settings" ? applied(body) : undefined));
    expect((await client(api.impl).bindRepository("site-1", BINDING)).bound).toBe(true);
    expect(api.patches.map((patch) => patch.envelope)).toEqual(["repo", "build_settings"]);
  });

  it("REFUSES to call a surviving package directory a success", async () => {
    // The kugel-genesis-lab-2 failure exactly: repo attached, base correct — and Netlify still reads
    // the repo-root netlify.toml, so the tenant builds dr-lurie's config. Reporting this as bound
    // would send the operator to a green ledger and a red build.
    const api = netlify({}, (_envelope, body) => ({ ...applied(body), package_path: "sites/acme" }));
    const client_ = client(api.impl);

    expect((await client_.bindRepository("site-1", BINDING)).bound).toBe(false);
    expect(requiresHuman(client_).kind).toBe("requires_human");
    expect(requiresHuman(client_).detail).toContain("package directory EMPTY");
  });

  it("REFUSES to call a build command Netlify filled in itself a success", async () => {
    // Linking a repo triggers framework detection, which can populate cmd — and a non-empty cmd
    // overrides the long build command in sites/<slug>/netlify.toml that the tenant actually needs.
    const api = netlify({}, (_envelope, body) => ({ ...applied(body), cmd: "npm run build" }));
    const client_ = client(api.impl);

    expect((await client_.bindRepository("site-1", BINDING)).bound).toBe(false);
    expect(requiresHuman(client_).kind).toBe("requires_human");
  });

  it("reports requires_human with every API error when neither envelope persists", async () => {
    const api = netlify({});
    const client_ = client(api.impl);
    expect((await client_.bindRepository("site-1", BINDING)).bound).toBe(false);
    expect(api.patches.map((patch) => patch.envelope)).toEqual(["repo", "build_settings"]);
    expect(requiresHuman(client_).kind).toBe("requires_human");
  });
});

describe("G7 — bindRepository never overwrites an existing binding", () => {
  it("leaves a correctly bound site alone and calls it done", async () => {
    const api = netlify(BOUND, (_envelope, body) => applied(body));
    const result = await client(api.impl).bindRepository("site-1", BINDING);

    expect(result).toMatchObject({ bound: true, skipped: "already_bound" });
    expect(api.patches).toEqual([]);
  });

  it("does NOT call an attached-but-wrong site done — the state a failed first attempt leaves", async () => {
    // The self-perpetuating bug this pins: attempt 1 attaches the repo but the base does not stick.
    // The operator's natural recovery is to re-run site.duplicate — and createSite is idempotent, so
    // run 2 resolves the same LIVE site. Keying "already bound" on repo_path alone would flip the
    // checklist to done on a site that still builds the repo-root config.
    const api = netlify({ repo_path: "vreich-ui/platform", base: "" }, (_envelope, body) => applied(body));
    const client_ = client(api.impl);
    const result = await client_.bindRepository("site-1", BINDING);

    expect(result).toMatchObject({ bound: false, skipped: "already_bound" });
    expect(api.patches).toEqual([]); // still no overwrite — a human decides
    expect(requiresHuman(client_).kind).toBe("requires_human");
    expect(requiresHuman(client_).detail).toContain("did not overwrite");
  });

  it("treats a site linked outside the GitHub App flow as attached, and does not re-point it", async () => {
    // repo_url with no repo_path. Reading that as unbound would re-point a live tenant's own repo,
    // overwrite its branch with the REFERENCE site's, and clear a build command it depends on.
    const api = netlify({ repo_url: "https://github.com/tenant/own-repo", repo_branch: "prod", cmd: "npm run build:tenant" }, (_envelope, body) => applied(body));
    const client_ = client(api.impl);

    expect((await client_.bindRepository("site-1", BINDING)).bound).toBe(false);
    expect(api.patches).toEqual([]);
    expect(api.current()).toMatchObject({ repo_url: "https://github.com/tenant/own-repo", cmd: "npm run build:tenant" });
  });

  it("isAttachedToRepo is generous on purpose: any one of four fields counts", () => {
    // Its failure mode must be "declines to configure a site it should have" (a checklist item),
    // never "overwrites a live tenant's binding" (an outage).
    expect(isAttachedToRepo({ repoPath: "a/b" })).toBe(true);
    expect(isAttachedToRepo({ repoUrl: "https://github.com/a/b" })).toBe(true);
    expect(isAttachedToRepo({ installationId: 1 })).toBe(true);
    expect(isAttachedToRepo({ provider: "github" })).toBe(true);
    expect(isAttachedToRepo({ base: "sites/acme" })).toBe(false);
    expect(isAttachedToRepo({})).toBe(false);
  });
});

describe("G7 — readDeployBinding", () => {
  it("copies the repo and GitHub App installation from a site that already builds", async () => {
    const api = netlify({}, undefined, { reference: { provider: "github", repo_path: "vreich-ui/platform", repo_branch: "main", installation_id: 95173329 } });
    expect(await client(api.impl).readDeployBinding("zilbermanfilmfoundation")).toEqual({
      provider: "github",
      repoPath: "vreich-ui/platform",
      repoBranch: "main",
      installationId: 95173329
    });
  });

  it("returns nothing when the reference carries no App installation — both or neither", async () => {
    // A repo attached without the installation that grants access to it is a site Netlify cannot
    // clone, and it passes every other check in this file. Better to ask a human than to mint one.
    const api = netlify({}, undefined, { reference: { provider: "github", repo_path: "vreich-ui/platform", repo_branch: "main" } });
    expect(await client(api.impl).readDeployBinding("zilbermanfilmfoundation")).toBeUndefined();
  });

  it("returns nothing when the reference site is itself unbound, so genesis asks rather than guessing a repo", async () => {
    const api = netlify({}, undefined, { reference: {} });
    expect(await client(api.impl).readDeployBinding("zilbermanfilmfoundation")).toBeUndefined();
  });
});
