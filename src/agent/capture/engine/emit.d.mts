// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export class EmissionError extends Error {}

export type EmissionCreateOperation = {
  kind: string;
  objectType: string;
  requestedId: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  reason: string;
  /** Present on page operations (T12.14): binds the body to its mapper page. */
  pageRef?: string;
};

/**
 * T12.14 — one pending asset section carried from the mapper to the binder. It
 * holds manifest identities and alt text only: NO source URL, by construction.
 */
export type EmissionAssetPlan = {
  pageRef: string;
  candidateId: string;
  sectionId: string;
  sectionType: string;
  target: "items" | "images" | "logos" | "portrait";
  entries: Array<{ manifestRef: string; alt: string | null }>;
};

export type EmissionPlan = {
  schemaVersion: "capture-emission-plan.v1";
  task: string;
  target: string;
  source: { mappingGeneratedAt: string; targetUrl: string | null };
  pageRefs: string[];
  repeatThreshold: number;
  copy: { source: string; extractedTextPresent: boolean; dryRunDisposition: string };
  preflight: Array<Record<string, unknown>>;
  creates: EmissionCreateOperation[];
  media: Array<Record<string, unknown>>;
  assetPlans: EmissionAssetPlan[];
  gaps: Array<Record<string, unknown>>;
  forbiddenVerbs: string[];
};

export type EmissionTransport = { call(verb: string, args: Record<string, unknown>): Promise<unknown> };

export type EmissionReport = EmissionPlan & {
  dryRun: boolean;
  siteId?: string;
  copyPolicy?: Record<string, unknown>;
  createdObjects: Array<{ objectType: string; objectId: string; draftVerified: boolean; published_time?: null }>;
  reusedObjects?: Array<Record<string, unknown>>;
  createdArtifacts?: Array<Record<string, unknown>>;
  validationStates: Array<{ phase: string; requestedId?: string; objectId?: string; valid: boolean; reason: string | null }>;
  quarantines: Array<Record<string, unknown>>;
  /** T12.14: asset fields actually bound to materialized first-party artifacts. */
  assetBindings: Array<{ sectionId: string; sectionType: string; target: string; manifestRefs: string[]; artifactRefs: string[]; pageRef?: string; objectType?: string; status: "bound" }>;
  /** T12.14: planned asset sections that could NOT bind — dropped, never hotlinked. */
  assetGaps: Array<{ gapId: string; blockRef: string; sectionId: string; pageRef?: string; why: string; nearestType: string; missingCapability: string; unresolved?: Array<{ manifestRef: string; reason: string }> }>;
  mediaPolicy?: { mediaRetention: string; materialized: number; declined: number };
  gapReportRefs?: unknown;
  trace?: Array<Record<string, unknown>>;
  plan?: EmissionPlan;
};

export function capturePolicyFromProject(result: unknown, target: string): Record<string, unknown>;
export function captureRequestId(plan: EmissionPlan, pageRef: string): string;
export function buildEmissionPlan(input: { target: string; mapping: unknown; theme: unknown; repeatThreshold?: number }): EmissionPlan;
export function bindBodyAssets(
  body: Record<string, unknown>,
  plans: EmissionAssetPlan[],
  resolveArtifactRef: (manifestRef: string) => string | null | undefined
): { body: Record<string, unknown>; bound: Array<Record<string, unknown>>; gaps: Array<Record<string, unknown>> };
/** Throws EmissionError unless every asset field is a first-party artifact value. */
export function assertAssetFieldsFirstParty(value: unknown, path?: string): void;
export function buildDryRunReport(plan: EmissionPlan): { dryRun: true; plan: EmissionPlan; createdObjects: never[]; validationStates: never[]; quarantines: never[]; copyPolicy: EmissionPlan["copy"] };
export function createMcpTransport(options?: { endpoint?: string; fetchImpl?: typeof fetch; token?: string }): EmissionTransport;
export function createAssetProbe(options?: { fetchImpl?: typeof fetch; maxBytes?: number }): (sourceUrl: string) => Promise<Record<string, unknown>>;
/** T12.16 — the bare MIME type: parameters stripped, lower-cased; '' when absent. */
export function normalizeContentType(contentType: unknown): string;
/** T12.16 — the blobKey extension for a contentType (e.g. '.jpg'), or null when none is known. */
export function artifactExtensionForContentType(contentType: unknown): string | null;
/**
 * T12.16 — the artifact kind derived from the BYTES' contentType; the mapper's
 * `kind` is only a hint about where the asset was found. null quarantines.
 */
export function artifactKindForContentType(contentType: unknown, kindHint?: string): "image" | "pdf" | "doc" | null;
/** T12.16 — the deterministic `<sha256><ext>` ingest filename, or null if unsafe. */
export function artifactFilename(sha256: string, extension?: string | null): string | null;
export function executeEmission(input: {
  plan: EmissionPlan;
  transport: EmissionTransport;
  projectPolicyResolver: (target: string) => Promise<unknown> | unknown;
  modelAdapter?: { regenerateBody(input: { body: Record<string, unknown>; objectType: string; target: string; source: unknown }): Promise<Record<string, unknown>> } | null;
  assetProbe?: ((sourceUrl: string) => Promise<Record<string, unknown>>) | null;
  mapping?: unknown;
}): Promise<EmissionReport>;
