import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { GENESIS_DEFAULT_OBJECT_TYPE, GENESIS_REQUEST_ID_PATTERN } from "../../../src/agent/capture/siteGenesis.js";
import { genesisParityDivergences } from "../../../src/agent/projects/genesisParity.js";

// G1 ACCEPTANCE — MINT-ONLY GENESIS.
//
// `site.duplicate({newSite})` with NO `sourceUrl` must: mint the tenant, create NO run at all, and
// answer with the three facts a mint produces. The "no run" half is the load-bearing one — a mint
// that quietly started a capture_conductor run would still be charged for it, would still be picked
// up by the continuation tick, and would still be a chaining candidate for clone_conductor. So this
// asserts the EXECUTION REPOSITORY is empty afterwards, not merely that the result omits a runId.
//
// G2/G5 ride along here rather than in their own file because they are facts about the same single
// call: the record a mint produces must be at fleet parity the moment it exists.

const MINT_SITE_ENDPOINT = "https://genesis-lab-3.example/mcp";

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const mcpCall = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const parsed = JSON.parse(response.body);
  return { rpcError: parsed.error, structured: parsed.result?.structuredContent, content: parsed.result?.content };
};

const STUB_CLI = `
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const marker = fileURLToPath(new URL("../../../invocations.ndjson", import.meta.url));
appendFileSync(marker, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
console.log(JSON.stringify({
  contract: "create_site_result.v1", ok: true, mode: "scaffold", slug: "genesis-lab-3", dir: "sites/genesis-lab-3",
  ids: { siteId: "site_genesis_lab_3", taxonomyId: "tax_genesis_lab_3", themeId: "thm_genesis_lab_3_default" },
  plannedFiles: 80, scaffolded: true, alreadyScaffolded: false, netlify: null
}));
`;

describe("site.duplicate — mint only (newSite with no sourceUrl)", () => {
  let platformRoot: string;

  beforeEach(async () => {
    resetRepositoryManager();
    platformRoot = await mkdtemp(path.join(tmpdir(), "g1-platform-"));
    await mkdir(path.join(platformRoot, "packages/core/cli"), { recursive: true });
    await writeFile(path.join(platformRoot, "packages/core/cli/create-site.mjs"), STUB_CLI);
    process.env.MCP_API_TOKEN = "test-token";
    process.env.NETLIFY_API_TOKEN = "netlify-test-token-dry-run-only";
    process.env.PLATFORM_REPO_ROOT = platformRoot;
    process.env.GENESIS_LAB_3_MCP_ENDPOINT = MINT_SITE_ENDPOINT;
    delete process.env.SITE_GENESIS_NETLIFY_MODE; // dry_run
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      throw new Error(`a mint-only genesis must make no network call at all in dry-run mode: ${url}`);
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.MCP_API_TOKEN;
    delete process.env.NETLIFY_API_TOKEN;
    delete process.env.PLATFORM_REPO_ROOT;
    delete process.env.GENESIS_LAB_3_MCP_ENDPOINT;
    await rm(platformRoot, { recursive: true, force: true });
    resetRepositoryManager();
  });

  const mint = async (newSite: Record<string, unknown> = {}) =>
    mcpCall("site_duplicate", {
      newSite: {
        name: "genesis-lab-3",
        niche: "senior and aging pets",
        audience: "owners of aging dogs noticing mobility and comfort changes",
        ownerEmail: "vreich@kugelbrands.com",
        ...newSite
      }
    });

  it("mints the tenant and starts NO run", async () => {
    const { rpcError, structured } = await mint();
    expect(rpcError).toBeUndefined();
    const data = structured.data as { mode: string; projectId: string; mcpEndpoint: string; humanChecklist: unknown[]; runId?: string };

    expect(data.mode).toBe("mint_only");
    expect(data.projectId).toBe("genesis-lab-3");
    expect(data.mcpEndpoint).toMatch(/^https:\/\//);
    expect(Array.isArray(data.humanChecklist)).toBe(true);
    // A caller that reads runId off this and polls would poll forever, so the field must be ABSENT
    // rather than null.
    expect("runId" in data).toBe(false);
    expect("statusTool" in data).toBe(false);

    // THE ASSERTION THAT MATTERS: no run exists anywhere. Not "the result hid one".
    const runs = await repositoryManager.getExecutionRepository().listRuns({});
    expect(runs.length ?? (runs as unknown as unknown[]).length).toBe(0);
  });

  it("refuses an empty call and refuses targetProjectId without a source", async () => {
    const empty = await mcpCall("site_duplicate", {});
    expect(empty.rpcError ?? empty.content).toBeDefined();
    expect(JSON.stringify(empty)).toContain("exactly one of");

    const noSource = await mcpCall("site_duplicate", { targetProjectId: "dr-lurie" });
    expect(JSON.stringify(noSource)).toContain("sourceUrl");
  });

  it("seeds a DENY-ALL capture policy, because no source was ever named", async () => {
    await mint();
    const record = (await repositoryManager.getProjectRepository().get("genesis-lab-3"))!;
    // Fail-closed: a tenant minted with no source cannot be crawled into until an operator names an
    // origin. Inventing one (its own origin, a wildcard) would hand a newborn tenant an authority
    // nobody asked for.
    expect(record.capturePolicy?.allowedCrawlOrigins).toEqual([]);
  });

  it("writes the full object dialect at the ids the platform scaffold mints (G2)", async () => {
    await mint();
    const record = (await repositoryManager.getProjectRepository().get("genesis-lab-3"))!;
    expect(record.objectDialect).toEqual({
      siteObjectId: "site_genesis_lab_3",
      taxonomyRegistryObjectId: "tax_genesis_lab_3",
      objectIdSource: "server_minted",
      requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
      defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE,
      voiceObjectId: "voice_genesis_lab_3",
      strategyObjectId: "strat_genesis_lab_3"
    });
    // The exact blockage from the proof run: site-scoped artifact verbs need this one field.
    expect(record.objectDialect?.siteObjectId).toBeTruthy();
  });

  it("is born autonomous and at fleet parity (G5)", async () => {
    await mint();
    const record = (await repositoryManager.getProjectRepository().get("genesis-lab-3"))!;
    expect(record.publishingPolicy.autonomyMode).toBe("autonomous");
    expect(record.publishingPolicy.publishEnabled).toBe(true);
    // The sink partition genesis chose, recorded on the record AND written to the site as
    // TRACKING_PROJECT_ID — the same value on both sides, which is what makes it consistent. It is
    // deliberately NOT `conventionalTenantSlug` ("genesislab3"): that derivation is the FALLBACK for
    // a tenant carrying no recorded partition, and a recorded one always outranks it.
    expect(record.tracking?.projectId).toBe("genesis-lab-3");

    const divergences = genesisParityDivergences(record, {
      requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
      defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE
    });
    expect(divergences.map((divergence) => `${divergence.field}: ${divergence.expected} != ${divergence.actual}`)).toEqual([]);
  });

  it("hands the derived voice to the scaffold so the seeded object is not an empty skeleton (G4)", async () => {
    await mint();
    const { readFile } = await import("node:fs/promises");
    const invocations = (await readFile(path.join(platformRoot, "invocations.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[] });
    const argv = invocations[0]!.argv;
    const flagIndex = argv.indexOf("--editorial-voice");
    expect(flagIndex, "genesis must seed the scaffold's editorial_voice baseline from the niche/audience it was given").toBeGreaterThan(-1);
    const body = JSON.parse(argv[flagIndex + 1]!) as { audience: string; name: string };
    expect(body.audience).toBe("owners of aging dogs noticing mobility and comfort changes");
    expect(body.name).toContain("provisional");
  });

  it("does not override a caller-supplied editorial voice", async () => {
    await mint({ editorialVoice: { name: "House voice, decided" } });
    const { readFile } = await import("node:fs/promises");
    const argv = (JSON.parse((await readFile(path.join(platformRoot, "invocations.ndjson"), "utf8")).trim().split("\n")[0]!) as { argv: string[] }).argv;
    const body = JSON.parse(argv[argv.indexOf("--editorial-voice") + 1]!) as { name: string };
    expect(body.name).toBe("House voice, decided");
  });

  it("installs the tenant's own object-store credentials (G3)", async () => {
    const { structured } = await mint();
    const ledger = (structured.data as { genesis: { ledger: Array<{ step: string; kind: string; data?: Record<string, unknown> }> } }).genesis.ledger;
    const installed = ledger.find((entry) => entry.step === "tenant_object_store_env");
    expect(installed, "genesis must provision the tenant's own object-store variables").toBeDefined();
    expect(installed!.data?.installed).toEqual(["PUBLISH_SECRET", "ARTIFACT_UPLOAD_TOKEN_SECRET", "TRACKING_SALT", "NETLIFY_SITE_ID"]);
    // onlyIfAbsent: the delegated create-site --provision-only path keeps owning the values wherever
    // it ran, and a second genesis run never rotates a live tenant's secrets.
    expect(installed!.data?.onlyIfAbsent).toBe(true);
    // Nothing that could name a value ever reaches the ledger.
    expect(JSON.stringify(installed)).not.toMatch(/[0-9a-f]{32}/);
  });
});
