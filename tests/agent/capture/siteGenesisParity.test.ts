import { describe, expect, it, vi } from "vitest";
import { runSiteGenesis, type GenesisAction, type GenesisHumanChecklistItem } from "../../../src/agent/capture/siteGenesis.js";
import { GENESIS_TENANT_DEFINITION_VERSION } from "../../../src/agent/projects/genesisTenantProfile.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// GENESIS PARITY (G1 / G4 / G5 / G6) — what a minted tenant is BORN with.
//
// The thread joining these four: before them, a tenant's birth produced a record that could not
// authenticate (its bearer existed only in a console a human had to read), could not be reconciled
// (no migration keyed it), ran voice-less, and left fifteen checklist items for a person. Each test
// below pins one of those, and the dry-run mode keeps every one of them offline.

const SOURCE_URL = "https://an-example-prospect-site.test/";
const SECRET_PROJECT = "cms-agent-503015";

const memoryProjectRepository = (): ProjectRepository => {
  const records = new Map<string, ProjectConnectionConfig>();
  return {
    list: async () => [...records.values()],
    get: async (projectId: string) => records.get(projectId),
    save: async (config: ProjectConnectionConfig) => {
      records.set(config.projectId, config);
      return config;
    },
    delete: async (projectId: string) => records.delete(projectId),
    health: async () => ({ readable: true, writable: true, backend: "memory", version: "memory.v1" })
  } as unknown as ProjectRepository;
};

const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    NETLIFY_API_TOKEN: "netlify-test-token-dry-run-only",
    CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp",
    GENESIS_SECRET_MANAGER_PROJECT: SECRET_PROJECT,
    ...extra
  }) as unknown as NodeJS.ProcessEnv;

const genesis = async (extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = baseEnv(), repository: ProjectRepository = memoryProjectRepository()) => {
  const netlifyFetch = vi.fn(async (url: string) => {
    throw new Error(`dry-run genesis must never call the Netlify API: ${url}`);
  });
  const result = await runSiteGenesis(
    { name: "acme", netlifySiteName: "acme-site", sourceUrl: SOURCE_URL, ...extra } as never,
    { projectRepository: repository, env, netlifyFetch: netlifyFetch as never } as never
  );
  expect(netlifyFetch).not.toHaveBeenCalled();
  return { result, record: (await repository.get("acme"))! };
};

const item = (checklist: GenesisHumanChecklistItem[], id: string) => checklist.find((entry) => entry.id === id);
const step = (ledger: GenesisAction[], name: string) => ledger.find((entry) => entry.step === name);

describe("G5 — a minted tenant is born under the genesis tenant profile", () => {
  it("writes blocked-by-default with the named allowlist, not allow-everything", async () => {
    const { record } = await genesis();
    expect(record.defaultToolPolicy).toBe("blocked");
    expect(record.toolPolicies?.object_create).toBe("allowed");
    expect(record.toolPolicies?.create_capture_job).toBe("allowed");
    expect(record.definitionVersion).toBe(GENESIS_TENANT_DEFINITION_VERSION);
    // Born at the current version, so its very first migration pass is already a no-op.
    expect(record.clientSiteBinding?.netlifySiteName).toBe("acme-site");
  });
});

describe("G6 — a minted tenant is born with a provisional voice, and no pointer to a decided one", () => {
  it("stores a fallback on the RECORD when it was told the niche and audience", async () => {
    const { record } = await genesis({ niche: "Independent film preservation", audience: "archivists and festival programmers" });

    expect(record.editorialVoiceFallback?.audience).toBe("archivists and festival programmers");
    expect(record.editorialVoiceFallback?.default_framework).toBe("plain_explainer");
    // The body has to satisfy the same shape voicePrefetch's isVoiceBody() checks, or it is not
    // usable as a fallback at all.
    expect(Array.isArray(record.editorialVoiceFallback?.tone)).toBe(true);
    expect(record.editorialVoiceFallback?.lexicon.prefer.length).toBeGreaterThan(0);
    // It says what it is. A fallback that reads as an authored house style is the failure mode.
    expect(record.editorialVoiceFallback?.name).toContain("provisional");

    // NO pointer: a decided voice is a written object, and no writer node has run.
    expect(record.objectDialect?.voiceObjectId).toBeUndefined();
  });

  it("writes no voice at all when genesis was told nothing about the tenant", async () => {
    // Boilerplate wearing the tenant's name is worse than an honest absence.
    const { record } = await genesis();
    expect(record.editorialVoiceFallback).toBeUndefined();
  });
});

describe("G1 — tenant bearer custody", () => {
  it("takes custody and records it as executed_unverified, not requires_human", async () => {
    const { result } = await genesis();
    const custody = step(result.ledger, "tenant_mcp_token_custody")!;
    // Dry-run cannot mint (there is no site to install onto), but the step must be PLANNED in full
    // and name the secret it would write — never silently absent.
    expect(custody.kind).toBe("dry_run");
    expect(custody.detail).toContain("acme-mcp-token");
    expect(custody.detail).toContain(SECRET_PROJECT);
  });

  it("refuses to mint when no Secret Manager project is configured, rather than orphaning a token", async () => {
    // Writing a bearer to the site that this deployment cannot store would overwrite the
    // provisioning-generated value with one nobody holds — strictly worse than doing nothing.
    const env = baseEnv();
    delete (env as Record<string, unknown>).GENESIS_SECRET_MANAGER_PROJECT;
    const { result, record } = await genesis({}, env);
    const custody = step(result.ledger, "tenant_mcp_token_custody")!;
    expect(custody.kind).toBe("dry_run");
    expect(record.tokenSecretRef).toBeUndefined();
  });
});

describe("re-running genesis against an established tenant", () => {
  it("never rotates a bearer that is already in custody", async () => {
    // createSite is idempotent: a second run RESOLVES the existing site. Minting again would install
    // a value the live site only picks up on its next deploy — breaking a working tenant on the way
    // to the project_exists refusal that step 4 would have raised anyway.
    const repository = memoryProjectRepository();
    await repository.save({
      projectId: "acme",
      name: "acme",
      mcpEndpointEnvVar: "ACME_MCP_ENDPOINT",
      authMode: "bearer_env",
      tokenSecretRef: "projects/cms-agent-503015/secrets/acme-mcp-token/versions/latest",
      allowedTools: [],
      contentContract: { contentContract: "content_source.v1" },
      publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, operatorDefault: "approved", autonomyMode: "autonomous" },
      status: "active"
    } as unknown as ProjectConnectionConfig);

    const netlifyFetch = vi.fn(async (url: string) => {
      throw new Error(`dry-run genesis must never call the Netlify API: ${url}`);
    });
    await expect(
      runSiteGenesis(
        { name: "acme", netlifySiteName: "acme-site", sourceUrl: SOURCE_URL } as never,
        { projectRepository: repository, env: baseEnv(), netlifyFetch: netlifyFetch as never } as never
      )
    ).rejects.toThrow(/already registered/i);

    // The pre-existing custody is untouched — the refusal must not cost the tenant its bearer.
    expect((await repository.get("acme"))!.tokenSecretRef).toBe("projects/cms-agent-503015/secrets/acme-mcp-token/versions/latest");
  });

  it("supplies ADMIN_EMAILS and the ingest hosts as birth DEFAULTS, never overwriting curated values", async () => {
    // The same idempotent-createSite path: an unconditional write would silently discard co-owners
    // and extra ingest hosts an operator added after birth.
    const { result } = await genesis({ ownerEmail: "owner@example.test" });
    const writes = result.ledger.filter((action) => action.step === "netlify_set_env");
    const defaults = ["ADMIN_EMAILS", "ROLE_EMAILS_ADMIN", "ARTIFACT_URL_INGEST_ALLOWED_HOSTS"];
    for (const key of defaults) {
      const write = writes.find((action) => (action.data as { key?: string }).key === key)!;
      expect(write, `${key} must be written`).toBeDefined();
      expect((write.data as { onlyIfAbsent?: boolean }).onlyIfAbsent, `${key} must be a birth default`).toBe(true);
    }
    // The pdf-tool site id is the exception: it is authoritative, because a stale one points this
    // tenant's artifacts at another tenant's blob stores.
    const siteIdWrite = writes.find((action) => (action.data as { key?: string }).key === "PDF_TOOL_STORAGE_SITE_ID")!;
    expect((siteIdWrite.data as { onlyIfAbsent?: boolean }).onlyIfAbsent).toBeUndefined();
  });
});

describe("G4 — the checklist items that were only human because nobody had derived them", () => {
  it("installs the owner allowlists when given an owner, and says so on the checklist", async () => {
    const { result } = await genesis({ ownerEmail: "owner@example.test" });
    const derived = step(result.ledger, "derived_site_env")!;
    expect(derived.data?.keys).toEqual(expect.arrayContaining(["ADMIN_EMAILS", "ROLE_EMAILS_ADMIN", "ARTIFACT_URL_INGEST_ALLOWED_HOSTS", "PDF_TOOL_STORAGE_SITE_ID"]));

    const admins = item(result.humanChecklist, "set_admin_emails")!;
    expect(admins.title).toContain("Confirm");
    // Installing the allowlist is not the same as Identity being on — the item must not imply it is.
    expect(admins.detail).toContain("Netlify Identity itself still has to be enabled");
  });

  it("never invents an owner address", async () => {
    const { result } = await genesis();
    const derived = step(result.ledger, "derived_site_env")!;
    expect(derived.data?.keys).not.toEqual(expect.arrayContaining(["ADMIN_EMAILS"]));
    expect(item(result.humanChecklist, "set_admin_emails")!.title).toContain("Set ADMIN_EMAILS");
  });

  it("closes the pdf-tool site id half and leaves the token half honestly open", async () => {
    // set_storage_grant ATTACHES a grant; it mints nothing. The token is a Netlify PAT — account
    // authority — so claiming this item is closed would be a lie the operator pays for later.
    const { result } = await genesis();
    const grant = item(result.humanChecklist, "pdf_tool_storage_grant")!;
    expect(grant.envVars).toEqual(["PDF_TOOL_STORAGE_TOKEN"]);
    expect(grant.detail).toContain("PDF_TOOL_STORAGE_SITE_ID");
  });
});

describe("G7 — a minted tenant is born with a DEPLOY binding", () => {
  it("plans the repo attach with base = sites/<slug>, and no package directory", async () => {
    const { result } = await genesis();
    const binding = step(result.ledger, "netlify_deploy_binding")!;
    expect(binding.kind).toBe("dry_run");
    // `base` is the load-bearing field: it is what makes Netlify read sites/acme/netlify.toml.
    expect(binding.data?.base).toBe("sites/acme");
    expect(binding.detail).toContain('package_path ""');
    expect(binding.detail).toContain('cmd ""');
  });

  it("orders the binding BEFORE the build hook", async () => {
    // A build hook on a site with no repo attached is a URL that triggers nothing.
    const { result } = await genesis();
    const steps = result.ledger.map((entry) => entry.step);
    expect(steps.indexOf("netlify_deploy_binding")).toBeLessThan(steps.indexOf("netlify_build_hook"));
  });

  it("leaves the checklist item OPEN in dry-run, where nothing was written and nothing verified", async () => {
    // The failure this guards: a default-mode run (dry_run IS the default) telling an operator the
    // repo is attached and "confirmed by re-reading the site" when no API call was made at all.
    // Same discipline as G1's token custody, which likewise stays open on the dry-run path.
    const { result } = await genesis();
    const item = result.humanChecklist.find((entry) => entry.id === "deploy_repo_binding")!;
    expect(item.title).toContain("attach vreich-ui/platform");
    expect(item.detail).toContain("package directory EMPTY");
    expect(item.detail).not.toContain("Nothing to do");
  });

  it("keeps the CONTENT repo item separate from the deploy binding", async () => {
    // These are two different repos for two different purposes, and conflating them is why the
    // deploy binding had no owner in either column until now.
    const { result } = await genesis();
    expect(result.humanChecklist.find((entry) => entry.id === "github_repo_binding")!.title).toContain("CONTENT repo");
  });
});
