import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReducedContract } from "../../../src/agent/workspace/contractPrefetch.js";
import { getSitePrefetch } from "../../../src/agent/workspace/sitePrefetch.js";
import { RunScopedCache } from "../../../src/agent/workspace/conductor.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { visualStandardIdFor } from "../../../src/agent/workspace/visualStandardIds.js";

const ENDPOINT = "https://dr-lurie.example/mcp";

// F1 (T-2, run_1785352838155_l544ye): contract_intelligence used to fetch this via a tool call inside
// its own agent loop, re-sending the raw contract on every subsequent turn. getReducedContract is the
// deterministic replacement — a plain function call the conductor makes once, before the node runs.
describe("getReducedContract (F1 deterministic contract prefetch)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  const remoteMethods: string[] = [];

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteMethods.length = 0;
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      remoteMethods.push(request.method);
      const result = request.method === "tools/call"
        ? { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write", description: "slug rules" }] } } }
        : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("fetches, reduces, and resolves the object type from the project's configured default", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getReducedContract({ runId: "run-prefetch-1", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reduced.clientObjectType).toBe("content_item");
      expect(result.reduced.idConventions).toEqual([expect.objectContaining({ id: "article_slug" })]);
      expect(result.reduced.contractSource.tool).toBe("object_contract");
    }
    expect(remoteMethods).toEqual(["tools/call"]);
  });

  it("caches the reduction per run — a second call for the same run/project never refetches", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getReducedContract({ runId: "run-prefetch-2", projectId: "dr-lurie" }, { projectRepository, cache });
    await getReducedContract({ runId: "run-prefetch-2", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteFetch).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache across different runs", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getReducedContract({ runId: "run-prefetch-3a", projectId: "dr-lurie" }, { projectRepository, cache });
    await getReducedContract({ runId: "run-prefetch-3b", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it("reports a clear error for an unknown project instead of throwing", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getReducedContract({ runId: "run-prefetch-4", projectId: "does-not-exist" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does-not-exist");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  // T-2 re-run (run_1785405350649_9u5mjz): platform had no objectDialect.defaultObjectType
  // configured, so an earlier version of this function silently guessed a hardcoded "content_item"
  // literal — which happened to be right for platform, but there was no way to tell "guessed right"
  // from "guessed wrong" from outside the function, and the guess masked the real defect (platform's
  // missing dialect) for a full live run's worth of cost. It must now fail loudly and by name.
  it("fails loudly and by name when a project has no configured default object type", async () => {
    const projectRepository = new MemoryProjectRepository();
    const drLurie = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...drLurie!, projectId: "no-dialect-project", objectDialect: undefined });

    const result = await getReducedContract({ runId: "run-prefetch-7", projectId: "no-dialect-project" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("prefetch_object_type_unresolved");
      expect(result.error).toContain("no-dialect-project");
    }
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("honors an explicit requestedObjectType over the project's configured default", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getReducedContract({ runId: "run-prefetch-5", projectId: "dr-lurie", requestedObjectType: "page" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reduced.clientObjectType).toBe("page");
  });

  // T3 (autonomous-publish): the run-scoped cache used to memoize a FAILED prefetch as eagerly as a
  // successful one, so one transient client failure was replayed for every remaining node in the run
  // — the failure mode behind the doomed runs, where a single 401 at contract_intelligence became a
  // whole run's worth of empty-but-schema-valid artifacts. Only success is cacheable now.
  it("does not cache a failed fetch — a later call in the same run reaches the client again and succeeds", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    let attempt = 0;
    remoteFetch.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 401, text: async () => "unauthorized", json: async () => ({}) } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: { structuredContent: { contract: { object_type: "content_item", body_schema: { type: "object", required: ["slug"] }, constraints: [] } } } })
      } as unknown as Response;
    });

    const first = await getReducedContract({ runId: "run-prefetch-t3", projectId: "dr-lurie" }, { projectRepository, cache });
    expect(first.ok).toBe(false);

    const second = await getReducedContract({ runId: "run-prefetch-t3", projectId: "dr-lurie" }, { projectRepository, cache });
    expect(second.ok).toBe(true);
    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it("still caches a successful fetch after an earlier failure in the same run", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    let attempt = 0;
    remoteFetch.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 503, text: async () => "unavailable", json: async () => ({}) } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: { structuredContent: { contract: { object_type: "content_item", body_schema: { type: "object", required: ["slug"] }, constraints: [] } } } })
      } as unknown as Response;
    });

    await getReducedContract({ runId: "run-prefetch-t3b", projectId: "dr-lurie" }, { projectRepository, cache });
    await getReducedContract({ runId: "run-prefetch-t3b", projectId: "dr-lurie" }, { projectRepository, cache });
    await getReducedContract({ runId: "run-prefetch-t3b", projectId: "dr-lurie" }, { projectRepository, cache });

    // one failure + one success; the third call is served from cache
    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it("still honors the project's own executable policy block before any transport", async () => {
    // save_json_blob_* names are blocked by dr-lurie's executable policy; object_contract itself is
    // not, so this exercises the same policy hook a real block would use without depending on one.
    const projectRepository = new MemoryProjectRepository();
    const project = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...project!, toolPolicies: { ...project!.toolPolicies, object_contract: "blocked" } });
    const result = await getReducedContract({ runId: "run-prefetch-6", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    // toolPolicies "blocked" is enforced inside callTool itself (after the executable-policy hook
    // above finds nothing to block), so this still surfaces as a clean ok:false, not a thrown error.
    expect(result.ok).toBe(false);
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});

// C1 (BRIEF §3.7): getSitePrefetch fetches the site-level facts a run needs to write on-brand imagery
// and PDFs — the house visual standard + assignable templates, the site's PDF templates, and the
// image-model policy's usage contexts — via four independent reads, each of which degrades on its
// own with a NAMED warningCode rather than failing the whole prefetch.
describe("getSitePrefetch (C1 site/visual-standard/PDF-template/image-policy prefetch)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  const remoteCalls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];

  // Realistic per-tool responses for the happy path — object_contract('site') carries the
  // brand_imagery_override_policy constraint (BRIEF §3.7's read path), object_get('site') carries the
  // applied brandImagery + pdf block + a visualStandardId reference, object_list('visual_standard')
  // returns the house singleton plus one assignable template, list_pdf_templates returns one
  // published template cross-referenced against site.pdf.defaultTemplateId, and
  // get_image_model_policy carries a byUsageContext map.
  const HAPPY_PATH_RESPONSES: Record<string, unknown> = {
    object_contract: { contract: { object_type: "site", constraints: [{ id: "brand_imagery_override_policy", value: "lock" }] } },
    object_get: {
      object: {
        brandImagery: { version: 1, medium: "photo", styleSentence: "Warm, clinical, evidence-led.", palette: ["#123456"], negative: [], aspectRatios: {}, seedBase: 1 },
        pdf: { defaultTemplateId: "tmpl_article", byKind: { article: "tmpl_article" } },
        visualStandardId: "vis_drlurie",
        // FIX-D (BRIEF §3.5): a real site object carries these two, and the writer's palette rule is
        // only half enforceable without them — so the HAPPY path here carries them too.
        brandTokens: { colors: { primary: "#2E5C42" }, fonts: { sans: "'Inter Variable'" } },
        // REVIEW: platform's own strict shape (`{ text, imageAssetRef? }`,
        // packages/core/schema/bodies/site-v1.ts), not the invented `{url, alt}` this fixture used
        // to carry — the extractor read neither key, so the logo half never resolved on a real site.
        logo: { text: "Dr Lurie", imageAssetRef: "https://cdn.example/mark.svg" }
      }
    },
    object_list: {
      items: [
        { object_id: "vis_drlurie", body: { kind: "house", label: "House standard", whenToUse: "The site's default look." } },
        { object_id: "vis_drlurie_ad", body: { kind: "template", label: "Ad campaign", whenToUse: "Paid ad creative only." } }
      ]
    },
    list_pdf_templates: { templates: [{ templateId: "tmpl_article", kind: "article", label: "Article Brochure", renderDataSchema: { type: "object" } }] },
    get_image_model_policy: { byUsageContext: { article_body: { model: "flux-2" }, hero_image: { model: "flux-2" } } }
  };

  const mockHappyPath = () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      remoteCalls.push({ name: request.params?.name, arguments: request.params?.arguments });
      const structuredContent = request.method === "tools/call" ? HAPPY_PATH_RESPONSES[request.params?.name ?? ""] : undefined;
      const result = structuredContent !== undefined ? { structuredContent } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
  };

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteCalls.length = 0;
    remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);
    mockHappyPath();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("resolves all three fields on a happy path", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-1", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.visualStandard).toEqual({
      houseId: "vis_drlurie",
      houseStatus: "present",
      derivedHouseId: "vis_drlurie",
      templates: [{ id: "vis_drlurie_ad", label: "Ad campaign", whenToUse: "Paid ad creative only." }],
      overridePolicy: "lock"
    });
    expect(result.pdfTemplates).toEqual([{ templateId: "tmpl_article", kind: "article", label: "Article Brochure", renderDataSchema: { type: "object" }, isDefault: true }]);
    expect(result.imagePolicyContexts).toEqual(["article_body", "hero_image"]);
    // FIX-D: the site's own brand facts, off the same object_get read 2 already made — no sixth call.
    expect(result.brandPalette).toEqual({ colors: { primary: "#2E5C42" }, fonts: { sans: "'Inter Variable'" } });
    expect(result.logo).toEqual({ url: "https://cdn.example/mark.svg", alt: "Dr Lurie" });
    expect(result.warnings).toEqual([]);
    expect(remoteCalls.map((call) => call.name).sort()).toEqual(["get_image_model_policy", "list_pdf_templates", "object_contract", "object_get", "object_list"]);
  });

  // REVIEW: the logo half of FIX-D, pinned against the shapes a REAL site object can take.
  it("reads the logo from platform's own `{ text, imageAssetRef }` shape, and reports absence for a wordmark-only site", async () => {
    const projectRepository = new MemoryProjectRepository();
    const originalObjectGet = HAPPY_PATH_RESPONSES.object_get;

    // A site whose logo is a wordmark only: platform's `imageAssetRef` is optional, so there is no
    // mark to look at. Absent + named, never a fabricated url.
    HAPPY_PATH_RESPONSES.object_get = { object: { logo: { text: "Dr Lurie" } } };
    const wordmarkOnly = await getSitePrefetch({ runId: "run-logo-1", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });
    expect(wordmarkOnly.logo).toBeUndefined();
    expect(wordmarkOnly.warnings.map((warning) => warning.code)).toContain("site_logo_absent");

    // A tolerated alias shape (a differently-shaped substrate) still resolves.
    HAPPY_PATH_RESPONSES.object_get = { object: { logo: { url: "https://cdn.example/alias.svg", alt: "Alias" } } };
    const alias = await getSitePrefetch({ runId: "run-logo-2", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });
    expect(alias.logo).toEqual({ url: "https://cdn.example/alias.svg", alt: "Alias" });

    HAPPY_PATH_RESPONSES.object_get = originalObjectGet;
  });

  it("caches per run — a second call for the same run/project never refetches", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getSitePrefetch({ runId: "run-site-cache", projectId: "dr-lurie" }, { projectRepository, cache });
    await getSitePrefetch({ runId: "run-site-cache", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteCalls).toHaveLength(5);
  });

  it("is a clean no-op (not a degradation) for an unknown project", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-2", projectId: "does-not-exist" }, { projectRepository, cache: new RunScopedCache() });

    expect(result).toEqual({ warnings: [{ code: "site_project_unresolved", message: expect.stringContaining("does-not-exist") }] });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("is a clean no-op for a project with no configured objectDialect.siteObjectId", async () => {
    const projectRepository = new MemoryProjectRepository();
    const drLurie = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...drLurie!, projectId: "no-site-project", objectDialect: { ...drLurie!.objectDialect!, siteObjectId: "" } });

    const result = await getSitePrefetch({ runId: "run-site-3", projectId: "no-site-project" }, { projectRepository, cache: new RunScopedCache() });

    expect(result).toEqual({ warnings: [{ code: "site_object_unconfigured", message: expect.stringContaining("no-site-project") }] });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  // Acceptance: "a missing template list ⇒ warning not failure" — exercised both ways: the
  // visual_standard object_list failing (templates default to [], houseId still resolves from the
  // site object) and list_pdf_templates failing (pdfTemplates stays absent).
  it("degrades to a warning, not a failure, when the visual_standard list is unreachable", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method === "tools/call" && request.params?.name === "object_list") {
        return { ok: false, status: 503, text: async () => "unavailable", json: async () => ({}) } as unknown as Response;
      }
      const structuredContent = request.method === "tools/call" ? HAPPY_PATH_RESPONSES[request.params?.name ?? ""] : undefined;
      const result = structuredContent !== undefined ? { structuredContent } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });

    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-4", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    // houseId still resolves — it came from the site object, not the list — so only the templates
    // array and the warning reflect the degradation.
    // houseStatus is "present" because the SITE OBJECT named the standard; the failed list is why
    // templates is empty, and it never turns a known-present standard into an unknown one.
    expect(result.visualStandard).toEqual({ houseId: "vis_drlurie", houseStatus: "present", derivedHouseId: "vis_drlurie", templates: [], overridePolicy: "lock" });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "visual_standard_list_unreachable" }));
    // Not a failure: the other two independent reads still resolved normally.
    expect(result.pdfTemplates).toBeDefined();
    expect(result.imagePolicyContexts).toBeDefined();
  });

  // FIX (chat-recovery) — THE ACCEPTANCE CASE. A site whose house standard has never been written is
  // the ordinary state of every tenant the backfill has not reached, and it must reach a node as a
  // POSITIVE "none", not as an undefined houseId that reads like a lookup waiting to be performed.
  // The live incident: a fresh chat listed a tenant's visual standards (correctly empty), then
  // assembled `vis_` + the SITE OBJECT id and called object_get("vis_site_drlurie") — an id the
  // convention can never mint — and the editor got a red "Object record not found".
  const respondWithoutHouseStandard = (overrides: { listFails?: boolean } = {}) => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const name = request.params?.name ?? "";
      remoteCalls.push({ name: request.params?.name, arguments: request.params?.arguments });
      if (overrides.listFails && name === "object_list") {
        return { ok: false, status: 503, text: async () => "unavailable", json: async () => ({}) } as unknown as Response;
      }
      let structuredContent = request.method === "tools/call" ? HAPPY_PATH_RESPONSES[name] : undefined;
      if (name === "object_get") {
        // A real un-backfilled site object: brand tokens and logo, and NO visual standard reference.
        structuredContent = { object: { pdf: { defaultTemplateId: "tmpl_article" }, brandTokens: { colors: { primary: "#2E5C42" } }, logo: { text: "Mark", imageAssetRef: "https://cdn.example/mark.svg" } } };
      }
      if (name === "object_list") structuredContent = { items: [] };
      const result = structuredContent !== undefined ? { structuredContent } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
  };

  it("states 'none' positively for a site with no house standard yet, and derives the id one would take", async () => {
    respondWithoutHouseStandard();
    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-none", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    // "This site has no house standard" is SAID, not inferred from a hole. houseId stays absent
    // because there is no object to name; houseStatus is what a consuming prompt reads.
    expect(result.visualStandard?.houseStatus).toBe("none");
    expect(result.visualStandard?.houseId).toBeUndefined();
    // The id a house standard for this site WOULD take, derived by the one rule the materializer
    // writes with — so no node ever assembles one, and none of them is `vis_site_drlurie`.
    expect(result.visualStandard?.derivedHouseId).toBe("vis_drlurie");
    expect(result.visualStandard?.derivedHouseId).toBe(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "house" }));
    expect(result.visualStandard?.derivedHouseId).not.toBe("vis_site_drlurie");
    // Absence is a NAMED degradation (the executor stamps site_prefetch_degraded:<code> on the run),
    // never a failure: the other reads resolved and the prefetch returned normally.
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "visual_standard_house_absent" }));
    expect(result.pdfTemplates).toBeDefined();
    expect(result.imagePolicyContexts).toBeDefined();
  });

  it("distinguishes 'unknown' from 'none' when the visual_standard list never answered", async () => {
    respondWithoutHouseStandard({ listFails: true });
    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-unknown", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    // The list is the only read that can PROVE a site has no house standard. It did not answer, and
    // the site object named none, so nothing here is evidence either way — and saying "none" would
    // invite an offer to write a standard that may already exist.
    expect(result.visualStandard?.houseStatus).toBe("unknown");
    expect(result.visualStandard?.houseId).toBeUndefined();
    // The derived id travels in every state; it is never evidence that the object exists.
    expect(result.visualStandard?.derivedHouseId).toBe("vis_drlurie");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "visual_standard_list_unreachable" }));
    expect(result.warnings.map((warning) => warning.code)).not.toContain("visual_standard_house_absent");
  });

  it("states 'present' — with the real id, not the derived one — for a site that has a house standard", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-present", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.visualStandard?.houseStatus).toBe("present");
    expect(result.visualStandard?.houseId).toBe("vis_drlurie");
    expect(result.warnings.map((warning) => warning.code)).not.toContain("visual_standard_house_absent");
  });

  it("degrades to a warning, not a failure, when list_pdf_templates is unreachable", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method === "tools/call" && request.params?.name === "list_pdf_templates") {
        return { ok: false, status: 503, text: async () => "unavailable", json: async () => ({}) } as unknown as Response;
      }
      const structuredContent = request.method === "tools/call" ? HAPPY_PATH_RESPONSES[request.params?.name ?? ""] : undefined;
      const result = structuredContent !== undefined ? { structuredContent } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });

    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-5", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.pdfTemplates).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "pdf_templates_unreachable" }));
    // Not a failure: visualStandard and imagePolicyContexts still resolved normally.
    expect(result.visualStandard).toBeDefined();
    expect(result.imagePolicyContexts).toBeDefined();
  });

  // Acceptance: "a blocked policy call ⇒ warning".
  it("degrades to a warning, not a failure, when get_image_model_policy is blocked by project policy", async () => {
    const projectRepository = new MemoryProjectRepository();
    const project = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...project!, toolPolicies: { ...project!.toolPolicies, get_image_model_policy: "blocked" } });

    const result = await getSitePrefetch({ runId: "run-site-6", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.imagePolicyContexts).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "image_policy_unreachable" }));
    // Not a failure: the other independent reads still resolved normally.
    expect(result.visualStandard).toBeDefined();
    expect(result.pdfTemplates).toBeDefined();
    expect(remoteCalls.some((call) => call.name === "get_image_model_policy")).toBe(false);
  });

  // Acceptance: "absent override constraint ⇒ 'allow' + warning".
  it("defaults overridePolicy to 'allow' and warns when the constraint is absent from the site contract", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const responses: Record<string, unknown> = { ...HAPPY_PATH_RESPONSES, object_contract: { contract: { object_type: "site", constraints: [] } } };
      const structuredContent = request.method === "tools/call" ? responses[request.params?.name ?? ""] : undefined;
      const result = structuredContent !== undefined ? { structuredContent } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });

    const projectRepository = new MemoryProjectRepository();
    const result = await getSitePrefetch({ runId: "run-site-7", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.visualStandard?.overridePolicy).toBe("allow");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "override_policy_absent" }));
  });
});
