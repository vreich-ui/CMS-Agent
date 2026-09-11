// In-memory SiteContextSource fixture (A4). NOT a live adapter — see siteContext.ts's own header
// for which real tenant reads a later task binds this port to. This file exists purely so tests in
// this directory (and, later, A6-A9's own tests) can exercise siteContext.ts/candidates.ts/
// changeSet.ts/scopedApproval.ts against realistic, self-contained data without a network call.
//
// NOT matched by vitest's `tests/**/*.test.ts` include glob (vitest.config.ts) — this file is a
// helper module, never collected as a suite on its own.
import type { SiteContextObject, SiteContextSource, SiteObjectFieldContract, SiteRegistries } from "../../../../src/agent/operations/siteContext.js";

export type FixtureTenantData = {
  tenantId: string;
  revisionId: string | null;
  objectsByType: Record<string, SiteContextObject[]>;
  contractsByType: Record<string, SiteObjectFieldContract>;
  registries: SiteRegistries;
};

export type InMemorySiteContextSourceCallCounts = {
  listObjects: number;
  getObjectContract: number;
  getRegistries: number;
  getRevisionId: number;
};

// Returns both the port implementation and a call-count record, so a test can assert a cache hit
// skipped the underlying reads (siteContext.test.ts) without needing a mocking library.
export function createInMemorySiteContextSource(data: FixtureTenantData): { source: SiteContextSource; callCounts: InMemorySiteContextSourceCallCounts } {
  const callCounts: InMemorySiteContextSourceCallCounts = { listObjects: 0, getObjectContract: 0, getRegistries: 0, getRevisionId: 0 };
  const source: SiteContextSource = {
    async listObjects({ tenantId, objectType }) {
      callCounts.listObjects += 1;
      return tenantId === data.tenantId ? (data.objectsByType[objectType] ?? []) : [];
    },
    async getObjectContract({ tenantId, objectType }) {
      callCounts.getObjectContract += 1;
      return tenantId === data.tenantId ? (data.contractsByType[objectType] ?? null) : null;
    },
    async getRegistries({ tenantId }) {
      callCounts.getRegistries += 1;
      return tenantId === data.tenantId ? data.registries : { visualStandards: [], pdfTemplates: [], imagePolicyContexts: [] };
    },
    async getRevisionId({ tenantId }) {
      callCounts.getRevisionId += 1;
      return tenantId === data.tenantId ? data.revisionId : null;
    }
  };
  return { source, callCounts };
}

// A house visual_standard object contract — realistic enough to exercise required-field and
// pattern-constraint validation without pretending to be byte-identical to a live tenant's schema.
export const VISUAL_STANDARD_CONTRACT: SiteObjectFieldContract = {
  objectType: "visual_standard",
  required: ["primaryColor", "secondaryColor", "fontFamily", "logoAssetId"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["primaryColor", "secondaryColor", "fontFamily", "logoAssetId"],
    properties: {
      primaryColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      secondaryColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      fontFamily: { type: "string", minLength: 1 },
      logoAssetId: { type: "string", minLength: 1 },
      whenToUse: { type: "string" }
    }
  }
};

// A LoRA-style image model config object contract.
export const LORA_MODEL_CONFIG_CONTRACT: SiteObjectFieldContract = {
  objectType: "image_model_config",
  required: ["baseModel", "loraWeightsAssetId", "triggerWord", "trainingSteps"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["baseModel", "loraWeightsAssetId", "triggerWord", "trainingSteps"],
    properties: {
      baseModel: { type: "string", minLength: 1 },
      loraWeightsAssetId: { type: "string", minLength: 1 },
      triggerWord: { type: "string", minLength: 1 },
      trainingSteps: { type: "integer", minimum: 1 },
      loraWeight: { type: "number", minimum: 0, maximum: 2 }
    }
  }
};

// The live shape the coordinator's contract names verbatim: version 4, content_revision 2,
// published_time null — saved four times over, applied not once.
export const VIS_ZILBERMAN_OBJECT: SiteContextObject = {
  objectId: "vis_zilberman",
  objectType: "visual_standard",
  status: "saved",
  version: 4,
  contentRevision: 2,
  publishedTime: null,
  updatedAt: "2026-08-30T12:00:00.000Z",
  fields: {
    primaryColor: "#101820",
    secondaryColor: "#c9a227",
    fontFamily: "Cormorant Garamond",
    logoAssetId: "asset_zilberman_logo_v2",
    whenToUse: "House standard for the Zilberman Film Foundation site."
  }
};

export const DEFAULT_REGISTRIES: SiteRegistries = {
  visualStandards: [{ id: "vis_zilberman", kind: "house", label: "Zilberman house standard" }],
  pdfTemplates: [{ templateId: "tmpl_brochure_v1", kind: "brochure", label: "Brochure", isDefault: true }],
  imagePolicyContexts: ["article_header", "article_body", "category_page"]
};

export function buildZilbermanFixtureData(overrides: Partial<FixtureTenantData> = {}): FixtureTenantData {
  return {
    tenantId: "zilberman-ff",
    revisionId: "rev_2026_09_11_01",
    objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT] },
    contractsByType: { visual_standard: VISUAL_STANDARD_CONTRACT, image_model_config: LORA_MODEL_CONFIG_CONTRACT },
    registries: DEFAULT_REGISTRIES,
    ...overrides
  };
}
