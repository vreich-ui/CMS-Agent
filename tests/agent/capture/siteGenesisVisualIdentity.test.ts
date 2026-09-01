import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARTICLE_PDF_TEMPLATE_ID,
  PUBLISH_ARTICLE_TEMPLATE_SCRIPT,
  genesisHouseBrief,
  houseVisualStandardId,
  readDerivedHouseStandardFromScaffold,
  runSiteGenesis,
  type GenesisAction,
  type GenesisHumanChecklistItem
} from "../../../src/agent/capture/siteGenesis.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// C3 (BRIEF §3.5 / §3.2 / R2 / R7) — VISUAL IDENTITY AT BIRTH.
//
// A site used to be born with no written imagery standard and no published PDF template, which made
// two things silently true of every run it would ever do: its images were rendered against whatever
// a palette derivation produced, and EVERY PDF slot was a `no_pdf_template` blocker, because
// artifact_plan chooses templateId only from the site's PUBLISHED templates and never authors one.
//
// Both closing steps are writes against the NEW tenant's own MCP, which the deployment running
// genesis cannot reach at birth: `<SLUG>_MCP_TOKEN` is itself a human secret-custody item, and so is
// the tenant's pdf-tool grant. So the contract these tests pin is the one R-C5 states for every other
// step past account authority — PLANNED IN FULL AND AUDITED, never silently skipped — plus the
// shrink-to-confirmation path for a caller that CAN reach the tenant.
const SOURCE_URL = "https://an-example-prospect-site.test/";

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

const baseEnv = (): NodeJS.ProcessEnv =>
  ({ NETLIFY_API_TOKEN: "netlify-test-token-dry-run-only", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" }) as unknown as NodeJS.ProcessEnv;

const genesis = async (extra: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) => {
  const netlifyFetch = vi.fn(async (url: string) => {
    throw new Error(`dry-run genesis must never call the Netlify API: ${url}`);
  });
  const result = await runSiteGenesis(
    { name: "acme", netlifySiteName: "acme-site", sourceUrl: SOURCE_URL, ...extra } as never,
    { projectRepository: memoryProjectRepository(), env: baseEnv(), netlifyFetch: netlifyFetch as never, ...deps } as never
  );
  expect(netlifyFetch).not.toHaveBeenCalled();
  return result;
};

const item = (checklist: GenesisHumanChecklistItem[], id: string) => checklist.find((entry) => entry.id === id)!;
const step = (ledger: GenesisAction[], name: string) => ledger.find((entry) => entry.step === name)!;

describe("C3 — a new site is born with a house standard and a default PDF template on the checklist", () => {
  it("puts the house-standard and default-template steps on the checklist, named and executable", async () => {
    const result = await genesis({ niche: "Independent film preservation", audience: "archivists and festival programmers" });

    const house = item(result.humanChecklist, "visual_identity_house_standard");
    expect(house).toBeDefined();
    // R2: the singleton id, mirroring voice_<site>. Named on the item so nobody has to derive it.
    expect(house.title).toContain("visual identity workflow in mode 'house'");
    expect(house.detail).toContain("vis_acme");
    // The brief is the tenant's own niche and audience, carried verbatim — never invented.
    expect(house.detail).toContain("Independent film preservation, written for archivists and festival programmers.");
    // The floor platform's create-site mints (P6) is BUILT ON, not duplicated or overwritten.
    expect(house.detail).toMatch(/derived/i);
    expect(house.detail).toMatch(/tokens/i);
    // Writing a look and putting it live stay separate acts (R6).
    expect(house.detail).toContain("site_apply_brand_imagery");
    expect(house.verify).toContain("vis_acme");

    const template = item(result.humanChecklist, "pdf_default_template");
    expect(template).toBeDefined();
    expect(template.title).toContain(DEFAULT_ARTICLE_PDF_TEMPLATE_ID);
    // R7's template, published the way pdf-tool's own script publishes it, then NAMED in site.pdf.
    expect(template.detail).toContain(PUBLISH_ARTICLE_TEMPLATE_SCRIPT);
    expect(template.detail).toContain("create_pdf_template");
    expect(template.detail).toContain("publish_pdf_template");
    expect(template.detail).toContain('{"pdf": {"defaultTemplateId": "article_brochure_v1"}}');
    // The consequence of not doing it, stated rather than left to be discovered on a live run.
    expect(template.detail).toContain("no_pdf_template");
    expect(template.source).toContain(PUBLISH_ARTICLE_TEMPLATE_SCRIPT);
  });

  it("audits both steps in the ledger as requires_human — a capability this deployment lacks is never a silent skip", async () => {
    const result = await genesis({ niche: "Independent film preservation", audience: "archivists" });

    expect(step(result.ledger, "publish_default_pdf_template").kind).toBe("requires_human");
    expect(step(result.ledger, "write_house_visual_standard").kind).toBe("requires_human");
    expect(step(result.ledger, "write_house_visual_standard").detail).toContain("ACME_MCP_TOKEN");
    expect(result.visualIdentity).toMatchObject({
      houseStandardId: "vis_acme",
      defaultTemplateId: DEFAULT_ARTICLE_PDF_TEMPLATE_ID,
      templatePublished: false,
      houseStandardWritten: false
    });
  });

  it("asks for a niche/audience rather than inventing a house look for a publication nobody described", async () => {
    const result = await genesis();

    expect(result.visualIdentity.brief).toBeUndefined();
    expect(step(result.ledger, "write_house_visual_standard").detail).toContain("invents neither");
    // The floor still applies, so the site is never WITHOUT a standard — only without a decided one.
    expect(item(result.humanChecklist, "visual_identity_house_standard").detail).toContain("never invents one");
  });

  it("performs both steps and shrinks the checklist items when the caller can reach the tenant", async () => {
    const result = await genesis(
      { niche: "Independent film preservation", audience: "archivists" },
      {
        publishArticlePdfTemplate: async ({ templateId }: { templateId: string }) => ({ published: true, detail: `Published ${templateId} and named it in the site's pdf block.` }),
        runVisualIdentityHouse: async ({ visualStandardId }: { visualStandardId: string }) => ({ visualStandardId, status: "draft", detail: `Ran visual_identity mode:'house' and filed ${visualStandardId}.` })
      }
    );

    expect(step(result.ledger, "publish_default_pdf_template").kind).toBe("executed");
    expect(step(result.ledger, "write_house_visual_standard").kind).toBe("executed");
    // The write is a DRAFT. Genesis never applies a look to a live site by side effect.
    expect(step(result.ledger, "write_house_visual_standard").detail).toContain("DRAFT");
    expect(step(result.ledger, "write_house_visual_standard").detail).toContain("site_apply_brand_imagery");
    expect(result.visualIdentity).toMatchObject({ templatePublished: true, houseStandardWritten: true });
    expect(item(result.humanChecklist, "visual_identity_house_standard").title).toContain("Review the WRITTEN house imagery standard");
    expect(item(result.humanChecklist, "pdf_default_template").title).toContain("genesis published it");
  });

  it("keeps a failed visual-identity write from failing the birth", async () => {
    const result = await genesis(
      { niche: "Film", audience: "archivists" },
      { runVisualIdentityHouse: async () => { throw new Error("tenant unreachable"); } }
    );

    expect(step(result.ledger, "write_house_visual_standard").kind).toBe("requires_human");
    expect(step(result.ledger, "write_house_visual_standard").detail).toContain("tenant unreachable");
    expect(step(result.ledger, "write_house_visual_standard").detail).toContain("a failed write never removes a standard");
    expect(result.projectId).toBe("acme");
  });

  it("derives the house id and the brief, and reads platform's derived floor without asserting one", () => {
    expect(houseVisualStandardId("dr-lurie")).toBe("vis_drlurie");
    expect(genesisHouseBrief({ niche: "Film", audience: "archivists" })).toBe("Film, written for archivists.");
    expect(genesisHouseBrief({ niche: "Film" })).toBe("Film.");
    expect(genesisHouseBrief({})).toBeUndefined();
    // P6 may report the floor under any of a few names; a scaffold that predates it reports none, and
    // absence is recorded as absence rather than becoming a claim that the floor exists.
    expect(readDerivedHouseStandardFromScaffold({ visualStandardId: "vis_acme" })).toBe(true);
    expect(readDerivedHouseStandardFromScaffold({ brandTokens: { colors: {} } })).toBe(true);
    expect(readDerivedHouseStandardFromScaffold({ ids: {} })).toBe(false);
    expect(readDerivedHouseStandardFromScaffold(undefined)).toBe(false);
  });
});
