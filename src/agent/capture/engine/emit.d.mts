// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export class EmissionError extends Error {}

export type EmissionCreateOperation = {
  kind: string;
  objectType: string;
  requestedId: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  reason: string;
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
  gapReportRefs?: unknown;
  trace?: Array<Record<string, unknown>>;
  plan?: EmissionPlan;
};

export function capturePolicyFromProject(result: unknown, target: string): Record<string, unknown>;
export function captureRequestId(plan: EmissionPlan, pageRef: string): string;
export function buildEmissionPlan(input: { target: string; mapping: unknown; theme: unknown; repeatThreshold?: number }): EmissionPlan;
export function buildDryRunReport(plan: EmissionPlan): { dryRun: true; plan: EmissionPlan; createdObjects: never[]; validationStates: never[]; quarantines: never[]; copyPolicy: EmissionPlan["copy"] };
export function createMcpTransport(options?: { endpoint?: string; fetchImpl?: typeof fetch; token?: string }): EmissionTransport;
export function createAssetProbe(options?: { fetchImpl?: typeof fetch; maxBytes?: number }): (sourceUrl: string) => Promise<Record<string, unknown>>;
export function executeEmission(input: {
  plan: EmissionPlan;
  transport: EmissionTransport;
  projectPolicyResolver: (target: string) => Promise<unknown> | unknown;
  modelAdapter?: { regenerateBody(input: { body: Record<string, unknown>; objectType: string; target: string; source: unknown }): Promise<Record<string, unknown>> } | null;
  assetProbe?: ((sourceUrl: string) => Promise<Record<string, unknown>>) | null;
  mapping?: unknown;
}): Promise<EmissionReport>;
