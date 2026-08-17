import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { listWorkspaceNodes, sortWorkspaceNodes } from "../../workspace/nodes.js";
import { workspaceNodeStatuses, workspaceRiskLevels, type WorkspaceEvent, type WorkspaceNode, type WorkspaceVersionSnapshot } from "../../workspace/nodeTypes.js";
import { validateWorkspaceGraph } from "../../workspace/nodes.js";
import { relationshipDirections, relationshipKinds, type WorkspaceRelationship, type WorkspaceRelationshipsUpdate } from "../../workspace/relationshipTypes.js";
import { WorkspaceVersionConflictError } from "../../workspace/workspaceErrors.js";
import { type WorkspaceActor, type WorkspaceChangeCorrelation, type WorkspaceChangeOperation, type WorkspaceChangeSink, type WorkspaceChangeSource, type WorkspaceChangeTarget, type WorkspaceRevision } from "../../workspace/changeTypes.js";
import { redactSensitiveKeys } from "../../observability/redaction.js";
import { conversationalAgentStatuses, pendingCanonicalPromptUpgrades, seededConversationalAgents, type ConversationalAgentDefinition } from "../../conversations/agentDefinitions.js";
import type { ReducedContract } from "../../workspace/contractReduction.js";

// Replace a node in place when it already exists, otherwise append it. This preserves the existing
// array order so editing a node's prompt/schema never moves it (e.g. to the end of the workflow).
export const upsertWorkspaceNode = (nodes: WorkspaceNode[], node: WorkspaceNode): WorkspaceNode[] =>
  nodes.some((existing) => existing.id === node.id)
    ? nodes.map((existing) => existing.id === node.id ? node : existing)
    : [...nodes, node];

export type StageOutput = { id: string; stage: string; value?: unknown; createdAt: string };
// F4 (T-2, run_1785352838155_l544ye): runId/nodeId are optional so existing observations (recorded
// before this field existed) still parse — but every new one is stamped, so it can finally be joined
// back to the run/node that produced it. Previously only {id, observation, metadata, createdAt}.
// 2.8 (handoff 2026-08-10): lifecycle fields for soft-deletion. `status` is optional and defaults to
// "active" wherever it is read (never persisted as a required field) so every observation recorded
// before this existed still parses. Nothing is ever hard-deleted — archive is the only removal path,
// so a bad archive can always be reasoned about from the record itself (archivedAt/archivedReason).
export const learningObservationStatuses = ["active", "archived"] as const;
export type LearningObservationStatus = typeof learningObservationStatuses[number];
export type LearningObservation = { id: string; observation: string; metadata?: Record<string, unknown>; runId?: string; nodeId?: string; createdAt: string; status?: LearningObservationStatus; archivedAt?: string; archivedReason?: string };
// §2.20: cross-run cache of already-reduced client contracts, keyed by (projectId, objectType,
// fingerprint) so a run whose client contract has not changed since a prior run's fetch can reuse the
// reduction instead of recomputing it (contractPrefetch.ts). `key` is the joined lookup key, stored
// alongside its parts so a lookup is a plain find() and no caller needs to reconstruct the join
// format. Capped at REDUCED_CONTRACT_CACHE_CAP entries (oldest evicted first) — a footprint bound on
// an optimization, not state anything depends on for correctness: a full or cold cache degrades to
// exactly today's behavior (always recompute).
export type ReducedContractCacheEntry = { key: string; projectId: string; objectType: string; fingerprint: string; reduced: ReducedContract; createdAt: string };
const REDUCED_CONTRACT_CACHE_CAP = 20;
const reducedContractCacheKey = (projectId: string, objectType: string, fingerprint: string): string => `${projectId}:${objectType}:${fingerprint}`;
export type WorkspaceMutationMeta = {
  expectedWorkspaceVersion?: number;
  // Optimistic concurrency against the change-history revision chain; stale values throw
  // `revision_conflict: expected <base>, current <current>`.
  baseRevisionId?: string;
  // Legacy string actors map to { kind: "agent", label }; structured actors carry kind/id/label.
  actor?: string | WorkspaceActor;
  source?: WorkspaceChangeSource;
  summary?: string;
  reason?: string;
  correlation?: WorkspaceChangeCorrelation;
};

export const normalizeActor = (actor?: string | WorkspaceActor): WorkspaceActor =>
  actor === undefined ? { kind: "system" } : typeof actor === "string" ? { kind: "agent", label: actor } : actor;
export const actorLabel = (meta?: WorkspaceMutationMeta): string | undefined =>
  meta?.actor === undefined ? undefined : typeof meta.actor === "string" ? meta.actor : meta.actor.label ?? meta.actor.id ?? meta.actor.kind;
export type WorkspaceGraphUpdate = { create?: WorkspaceNode[]; update?: Array<Partial<WorkspaceNode> & { id: string }>; delete?: string[]; dependencies?: Record<string, string[]>; orderedNodeIds?: string[]; positions?: Record<string, { x: number; y: number }>; allowCanonicalNodeRemoval?: boolean; adminApproved?: boolean };
export type WorkspaceDocument = { schemaVersion: 1; workspaceVersion: number; updatedAt: string; nodes: WorkspaceNode[]; conversationalAgents: ConversationalAgentDefinition[]; stageOutputs: StageOutput[]; learningObservations: LearningObservation[]; versions: WorkspaceVersionSnapshot[]; events: WorkspaceEvent[]; relationships: WorkspaceRelationship[]; currentRevisionId?: string; reducedContractCache: ReducedContractCacheEntry[] };
export interface WorkspaceStore {
  getWorkspaceVersion(): Promise<number>;
  getCurrentRevisionId(): Promise<string | undefined>;
  attachChangeSink?(sink: WorkspaceChangeSink): void;
  listRelationships(): Promise<WorkspaceRelationship[]>;
  updateRelationships(update: WorkspaceRelationshipsUpdate, meta: WorkspaceMutationMeta): Promise<{ relationships: WorkspaceRelationship[]; workspaceVersion: number; revisionId?: string }>;
  getNodes(): Promise<WorkspaceNode[]>;
  getNode(id: string): Promise<WorkspaceNode | undefined>;
  ensureConversationalAgentSeeds(meta?: WorkspaceMutationMeta): Promise<ConversationalAgentDefinition[]>;
  listConversationalAgents(): Promise<ConversationalAgentDefinition[]>;
  getConversationalAgent(id: string): Promise<ConversationalAgentDefinition | undefined>;
  updateConversationalAgent(id: string, patch: Partial<Omit<ConversationalAgentDefinition, "id" | "role" | "rev" | "updatedAt">>, meta: WorkspaceMutationMeta): Promise<{ agent: ConversationalAgentDefinition; workspaceVersion: number }>;
  // Return the node together with the workspaceVersion the mutation produced. The caller reports and
  // enforces THAT version, never a second racy read that could reflect a later, unrelated mutation.
  updateNodePrompt(id: string, prompt: string, meta?: WorkspaceMutationMeta): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  updateNodeSchema(id: string, schema: unknown, meta?: WorkspaceMutationMeta): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  createNode(node: WorkspaceNode, meta: WorkspaceMutationMeta, eventType?: string): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  deleteNode(id: string, meta: WorkspaceMutationMeta): Promise<{ deleted: true; workspaceVersion: number }>;
  cloneNode(id: string, newId: string, meta: WorkspaceMutationMeta): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  updateNode(id: string, patch: Partial<WorkspaceNode>, meta: WorkspaceMutationMeta, eventType?: string): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  updateGraph(update: WorkspaceGraphUpdate, meta: WorkspaceMutationMeta, eventType?: string): Promise<{ nodes: WorkspaceNode[]; workspaceVersion: number }>;
  getEvents(): Promise<WorkspaceEvent[]>;
  getVersions(): Promise<WorkspaceVersionSnapshot[]>;
  exportWorkspace(): Promise<WorkspaceDocument>;
  importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }): Promise<{ imported: true; workspaceVersion: number; counts: { nodes: number; stageOutputs: number; learningObservations: number } }>;
  saveStageOutput(stage: string, value: unknown, id?: string): Promise<StageOutput>;
  getStageOutput(id: string): Promise<StageOutput | undefined>;
  listStageOutputs(stage?: string): Promise<StageOutput[]>;
  recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }): Promise<LearningObservation>;
  // 2.8: includeArchived defaults to false — archived (soft-deleted) observations are excluded from
  // every existing caller (curation, migration) automatically unless a caller explicitly opts in, so
  // this one option closes the read side for every consumer at once rather than needing each of them
  // updated to filter status themselves.
  listObservations(options?: { includeArchived?: boolean }): Promise<LearningObservation[]>;
  archiveObservation(id: string, reason?: string): Promise<LearningObservation>;
  // In-process predicate for callers that already hold the repository directly (e.g. a one-off
  // script) — never exposed over MCP as-is, since a function cannot cross that boundary. The MCP
  // bulk tool (learning.archive_observations) wraps this with a serializable filter (a text prefix).
  archiveObservationsByPredicate(predicate: (observation: LearningObservation) => boolean, reason?: string): Promise<{ archived: number; ids: string[] }>;
  getReducedContractCacheEntry(projectId: string, objectType: string, fingerprint: string): Promise<ReducedContractCacheEntry | undefined>;
  putReducedContractCacheEntry(entry: { projectId: string; objectType: string; fingerprint: string; reduced: ReducedContract }): Promise<ReducedContractCacheEntry>;
}

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
// R-22 — this used to overwrite article_body's own schema AND outputSchema with articleBodyJsonSchema, the
// workspace-local {schema_version, nodes} monolith, on every fresh workspace. It is the third of the three
// article_body schemas and the one that was installed by default, which is why a fresh workspace disagreed
// with both the canonical node definition and the live workspace at the single most important node on the
// publish path. It is also the mechanism behind F-1/T6.3: the node reported completed while its persisted
// output failed all six required fields of the schema it was SUPPOSED to have, because the schema it
// actually had was this one.
//
// The node's own schema now stands. The alignment wave's rule is the reason — "workspace-local article
// schemas are advisory and must never be used to validate" — and a seed-time override is the strongest
// possible form of treating one as authoritative. R-6 and R-23's delete half then removed the
// {schema_version, nodes} monolith (both its Zod and JSON Schema forms) from this module entirely, along
// with the article_body.* wire tools that served it; the article_body node's own outputSchema — and,
// beyond it, the client's fetched contract — is the only remaining definition of "what a body is".
const defaultWorkspaceNodes = (): WorkspaceNode[] => listWorkspaceNodes();
export const createDefaultWorkspaceDocument = (): WorkspaceDocument => {
  const createdAt = now();
  return { schemaVersion: 1, workspaceVersion: 0, updatedAt: createdAt, nodes: defaultWorkspaceNodes(), conversationalAgents: seededConversationalAgents(createdAt), stageOutputs: [], learningObservations: [], versions: [], events: [], relationships: [], reducedContractCache: [] };
};

const workspaceNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1).default("workspace"),
  description: z.string().default(""),
  prompt: z.string(),
  schema: z.unknown().optional(),
  inputSchema: z.unknown().default({ type: "object" }),
  outputSchema: z.unknown().default({ type: "object" }),
  allowedTools: z.array(z.string()).default([]),
  assignedSkills: z.array(z.string()).default([]),
  requiredInputs: z.array(z.string()).default([]),
  produces: z.array(z.string()).default([]),
  riskLevel: z.enum(workspaceRiskLevels).default("read"),
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(workspaceNodeStatuses).default("draft"),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  modelConfig: z.record(z.string(), z.unknown()).optional(),
  executionConfig: z.record(z.string(), z.unknown()).optional()
}).passthrough().transform((node) => ({ ...node, outputSchema: node.outputSchema ?? node.schema ?? { type: "object" } }));
const conversationalAgentSchema: z.ZodType<ConversationalAgentDefinition> = z.object({
  id: z.string().regex(/^agt_[a-z0-9_]+$/),
  role: z.literal("client_manager"),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(24_000),
  modelConfig: z.object({ provider: z.string().min(1), model: z.string().min(1), timeoutMs: z.number().int().positive().max(120_000), maxOutputTokens: z.number().int().positive().max(32_000) }).strict(),
  skills: z.array(z.string().min(1).max(128)).max(64),
  status: z.enum(conversationalAgentStatuses),
  rev: z.number().int().positive(),
  updatedAt: z.string().datetime()
}).strict();
const stageOutputSchema: z.ZodType<StageOutput> = z.object({ id: z.string().min(1), stage: z.string().min(1), value: z.unknown().optional(), createdAt: z.string().datetime() }).strict();
const learningObservationSchema: z.ZodType<LearningObservation> = z.object({ id: z.string().min(1), observation: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional(), runId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(), createdAt: z.string().datetime(), status: z.enum(learningObservationStatuses).optional(), archivedAt: z.string().datetime().optional(), archivedReason: z.string().min(1).optional() }).strict();
// `reduced` stays loose (z.record) rather than a full ReducedContract shape — same posture as
// StageOutput.value above: this is a cache of an already-validated, internally-produced shape, not an
// external input this schema needs to police field-by-field.
const reducedContractCacheEntrySchema = z.object({ key: z.string().min(1), projectId: z.string().min(1), objectType: z.string().min(1), fingerprint: z.string().min(1), reduced: z.record(z.string(), z.unknown()), createdAt: z.string().datetime() }).strict() as unknown as z.ZodType<ReducedContractCacheEntry>;
const workspaceEventSchema: z.ZodType<WorkspaceEvent> = z.object({ id: z.string(), type: z.string(), nodeId: z.string().optional(), actor: z.string().optional(), summary: z.string().optional(), workspaceVersion: z.number().int().nonnegative(), beforeHash: z.string().optional(), afterHash: z.string().optional(), createdAt: z.string().datetime() }).strict();
const workspaceVersionSnapshotSchema: z.ZodType<WorkspaceVersionSnapshot> = z.object({ workspaceVersion: z.number().int().nonnegative(), createdAt: z.string().datetime(), summary: z.string().optional(), nodes: z.array(workspaceNodeSchema as z.ZodType<WorkspaceNode>) }).strict();
const workspaceRelationshipSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(relationshipKinds),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  direction: z.enum(relationshipDirections).default("forward"),
  label: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
  schemaRefs: z.array(z.string().min(1)).optional(),
  artifactRefs: z.array(z.string().min(1)).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict() as z.ZodType<WorkspaceRelationship>;
// relationships and currentRevisionId default/omit so documents persisted before change-history
// existed keep parsing (migration/default logic, same pattern as versions/events).
export const workspaceDocumentSchema = z.object({ schemaVersion: z.literal(1), workspaceVersion: z.number().int().nonnegative(), updatedAt: z.string().datetime(), nodes: z.array(workspaceNodeSchema), conversationalAgents: z.array(conversationalAgentSchema).default([]), stageOutputs: z.array(stageOutputSchema), learningObservations: z.array(learningObservationSchema), versions: z.array(workspaceVersionSnapshotSchema).default([]), events: z.array(workspaceEventSchema).default([]), relationships: z.array(workspaceRelationshipSchema).default([]), currentRevisionId: z.string().min(1).optional(), reducedContractCache: z.array(reducedContractCacheEntrySchema).default([]) }).strict();


export const hashValue = (value: unknown) => JSON.stringify(value).split("").reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0).toString(16);
const canonicalIds = () => new Set(listWorkspaceNodes().map((node) => node.id));
export const validateJsonSchema = (schema: unknown): string[] => {
  if (typeof schema === "boolean") return [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["JSON Schema must be an object or boolean."];
  const type = (schema as { type?: unknown }).type;
  const validTypes = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
  if (type !== undefined) {
    const values = Array.isArray(type) ? type : [type];
    for (const value of values) if (typeof value !== "string" || !validTypes.has(value)) return [`Invalid JSON Schema type: ${String(value)}`];
  }
  return [];
};
// Guarantee every collection/scalar field is present so a minimally-specified node (e.g. one an
// agent creates via workspace.create_node with just id/name/prompt) is valid and — critically —
// safe to iterate everywhere downstream. Missing dependsOn previously threw
// "node.dependsOn is not iterable" from graph/revision code even though the node had been persisted.
const normalizeNode = (node: WorkspaceNode): WorkspaceNode => ({
  ...node,
  kind: node.kind ?? "workspace",
  description: node.description ?? "",
  riskLevel: node.riskLevel ?? "read",
  status: node.status ?? "draft",
  position: node.position ?? { x: 0, y: 0 },
  allowedTools: node.allowedTools ?? [],
  assignedSkills: node.assignedSkills ?? [],
  requiredInputs: node.requiredInputs ?? [],
  produces: node.produces ?? [],
  dependsOn: node.dependsOn ?? [],
  inputSchema: node.inputSchema ?? { type: "object" },
  outputSchema: node.outputSchema ?? node.schema ?? { type: "object" },
  updatedAt: node.updatedAt ?? now()
});

// Coerce a node argument to a plain object before it is spread into the store. MCP clients may send
// a nested object parameter as a JSON string (the `node` field is schema-typed `{}`); left as a
// string it would be spread into indexed characters and persisted as a node with no id/name/prompt.
// A string is JSON-parsed; anything that is not a plain object is rejected outright.
export const coerceNodeInput = (node: unknown): WorkspaceNode => {
  let value: unknown = node;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new Error("invalid_node: node string is not valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_node: expected a node object");
  return value as WorkspaceNode;
};

// R-3 — the same client-stringification defense as coerceNodeInput, for the two schema writers.
//
// update_node_input_schema / update_node_output_schema declared `schema: {}` and passed the argument
// straight to validateJsonSchema, so a client that serialized the schema as a JSON string got
// "JSON Schema must be an object or boolean" and had to fall back to workspace.update_node — which
// is why the S4 inspector's Schemas tab shipped read-only. Parse the string back first.
//
// A JSON Schema is legally an object OR a boolean (`true`/`false` are the permit-all / permit-nothing
// schemas), so both shapes survive the round trip, including a stringified bare boolean. Anything
// else is refused rather than written: an array or a number here means the caller sent the wrong
// thing, and silently persisting it would corrupt the node exactly as the stringified `node` arg
// once did.
export const coerceSchemaInput = (schema: unknown): unknown => {
  let value: unknown = schema;
  if (typeof value === "string") {
    try { value = JSON.parse(value.trim()); } catch { throw new Error("invalid_schema: schema string is not valid JSON"); }
  }
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_schema: expected a JSON Schema object or boolean");
  return value;
};

// Universal write-side guard: a node is only persistable if it satisfies the node schema (id, name,
// and prompt present, etc.). Enforced in mutate() so no mutation path can ever write a node that a
// later strict read would choke on. Returns the parsed/normalized node.
const assertPersistableNode = (node: WorkspaceNode): WorkspaceNode => {
  const parsed = workspaceNodeSchema.safeParse(node);
  if (!parsed.success) throw new Error(`invalid_node: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
  return parsed.data as WorkspaceNode;
};

// Tolerant document parse used on read: a single unusable node record must never brick the entire
// workspace. Node records that fail schema validation are dropped (their count reported) and the
// rest of the document is parsed normally. Callers persist the healed document so the store repairs
// itself. A structurally-broken document (not even an object with a nodes array) still throws.
export const parseWorkspaceDocumentTolerant = (raw: unknown): { document: WorkspaceDocument; droppedNodes: number } => {
  if (raw && typeof raw === "object" && Array.isArray((raw as { nodes?: unknown }).nodes)) {
    const rawNodes = (raw as { nodes: unknown[] }).nodes;
    const validNodes = rawNodes.filter((node) => workspaceNodeSchema.safeParse(node).success);
    const document = workspaceDocumentSchema.parse({ ...(raw as object), nodes: validNodes }) as WorkspaceDocument;
    return { document, droppedNodes: rawNodes.length - validNodes.length };
  }
  return { document: workspaceDocumentSchema.parse(raw) as WorkspaceDocument, droppedNodes: 0 };
};
// R-4: a conflict is a typed, recoverable outcome, not an anonymous crash. The current version and
// revision travel with it so a caller can reload to exactly this state and re-apply.
const assertWorkspaceVersion = (document: WorkspaceDocument, meta?: WorkspaceMutationMeta) => {
  if (meta?.expectedWorkspaceVersion !== undefined && document.workspaceVersion !== meta.expectedWorkspaceVersion) {
    throw new WorkspaceVersionConflictError({
      conflict: "workspace_version",
      expectedVersion: meta.expectedWorkspaceVersion,
      currentVersion: document.workspaceVersion,
      currentRevisionId: document.currentRevisionId
    });
  }
};
const assertBaseRevision = (document: WorkspaceDocument, meta?: WorkspaceMutationMeta) => {
  if (meta?.baseRevisionId !== undefined && document.currentRevisionId !== meta.baseRevisionId) {
    throw new WorkspaceVersionConflictError({
      conflict: "revision",
      expectedRevisionId: meta.baseRevisionId,
      currentRevisionId: document.currentRevisionId,
      currentVersion: document.workspaceVersion
    });
  }
};
const operationForEventType = (eventType: string): WorkspaceChangeOperation => {
  if (eventType === "node.created") return "create";
  if (eventType === "node.cloned") return "clone";
  if (eventType === "node.deleted") return "delete";
  if (eventType === "node.restored") return "restore";
  if (eventType === "graph.reordered") return "reorder";
  if (eventType === "workspace.imported") return "import";
  if (eventType === "stage.output_saved" || eventType === "learning.observation_recorded") return "record";
  return "update";
};
const targetForEventType = (eventType: string, nodeId?: string, agentId?: string): WorkspaceChangeTarget => {
  if (agentId) return { type: "agent", id: agentId };
  if (nodeId) return { type: "node", id: nodeId };
  if (eventType.startsWith("graph.")) return { type: "graph" };
  if (eventType === "workspace.relationships_updated") return { type: "relationship" };
  return { type: "workspace" };
};
const changedNodeIds = (before: WorkspaceNode[], after: WorkspaceNode[]) => {
  const ids = new Set<string>();
  const beforeById = new Map(before.map((node) => [node.id, node]));
  for (const node of after) { const prev = beforeById.get(node.id); if (!prev || hashValue(prev) !== hashValue(node)) ids.add(node.id); }
  const afterIds = new Set(after.map((node) => node.id));
  for (const node of before) if (!afterIds.has(node.id)) ids.add(node.id);
  return ids;
};
const assertGraphValid = (nodes: WorkspaceNode[], allowCanonicalNodeRemoval = false, adminApproved = false) => {
  for (const node of nodes) {
    const inputIssues = validateJsonSchema(node.inputSchema);
    const outputIssues = validateJsonSchema(node.outputSchema);
    if (inputIssues.length || outputIssues.length) throw new Error([...inputIssues.map((issue) => `${node.id} inputSchema: ${issue}`), ...outputIssues.map((issue) => `${node.id} outputSchema: ${issue}`)].join("; "));
  }
  if (!allowCanonicalNodeRemoval || !adminApproved) for (const id of canonicalIds()) if (!nodes.some((node) => node.id === id)) throw new Error(`Missing required canonical node: ${id}`);
  const validation = validateWorkspaceGraph(nodes);
  if (!validation.valid) throw new Error(validation.issues.join("; "));
};

// Bounded reconciliation for eventual-consistency reads (see mutate). Under Netlify Blobs' eventual
// fallback a fresh serverless instance can read a workspace version older than one already committed
// elsewhere; these short, backed-off reloads let the read catch up before a version check fires.
const STALE_READ_RETRIES = 4;
const STALE_READ_BACKOFF_MS = 75;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WorkspaceStateStore implements WorkspaceStore {
  protected document: WorkspaceDocument;
  protected changeSink?: WorkspaceChangeSink;
  constructor(document: WorkspaceDocument = createDefaultWorkspaceDocument()) { this.document = document; }
  attachChangeSink(sink: WorkspaceChangeSink) { this.changeSink = sink; }
  // Process-local count of node records dropped by tolerant self-healing loads (see
  // parseWorkspaceDocumentTolerant). Surfaced through repository health so a silent heal is
  // observable instead of invisible; resets with the process/request lifecycle.
  protected healedDroppedNodes = 0;
  getHealedDroppedNodes(): number { return this.healedDroppedNodes; }

  protected async load() { return this.document; }
  protected async save(document: WorkspaceDocument) { this.document = document; }
  protected async mutate(update: (document: WorkspaceDocument) => void, meta?: WorkspaceMutationMeta, eventType = "workspace.updated", nodeId?: string, agentId?: string) {
    let document = await this.load();
    // Eventual-consistency reconciliation: if the caller expects a NEWER version than we just read,
    // our read is lagging a version already committed elsewhere (a fresh instance under Blobs'
    // eventual fallback). Reload — strong-first — a few times so the version a prior mutation returned
    // can be enforced instead of falsely conflicting. No-op on single-instance stores, where the read
    // is always current, and when no expectedWorkspaceVersion is supplied.
    for (let attempt = 0; meta?.expectedWorkspaceVersion !== undefined && document.workspaceVersion < meta.expectedWorkspaceVersion && attempt < STALE_READ_RETRIES; attempt++) {
      await delay(STALE_READ_BACKOFF_MS * (attempt + 1));
      document = await this.load();
    }
    assertWorkspaceVersion(document, meta);
    assertBaseRevision(document, meta);
    const beforeNodes = structuredClone(document.nodes);
    const beforeConversationalAgents = structuredClone(document.conversationalAgents ?? []);
    const beforeRelationships = structuredClone(document.relationships ?? []);
    update(document);
    // Normalize, then validate every node before anything is saved: save() does not re-validate, so
    // this is the single backstop that guarantees no mutation persists a node a strict read rejects.
    document.nodes = document.nodes.map(normalizeNode).map(assertPersistableNode);
    document.conversationalAgents = document.conversationalAgents.map((agent) => conversationalAgentSchema.parse(agent));
    if (new Set(document.conversationalAgents.map((agent) => agent.id)).size !== document.conversationalAgents.length) throw new Error("Duplicate conversational agent id.");
    assertGraphValid(document.nodes);
    document.workspaceVersion += 1;
    document.updatedAt = now();
    // Revisions are minted only when structural state changed; record-style mutations (stage
    // outputs, observations) still produce change events but no snapshot.
    const structuralChange = hashValue({ nodes: document.nodes, conversationalAgents: document.conversationalAgents ?? [], relationships: document.relationships ?? [] }) !== hashValue({ nodes: beforeNodes, conversationalAgents: beforeConversationalAgents, relationships: beforeRelationships });
    const parentRevisionId = document.currentRevisionId;
    const actor = normalizeActor(meta?.actor);
    const source = meta?.source ?? "system";
    const reason = meta?.reason ?? meta?.summary;
    let revision: WorkspaceRevision | undefined;
    if (structuralChange) {
      revision = { revisionId: makeId("rev"), parentRevisionId, workspaceVersion: document.workspaceVersion, createdAt: document.updatedAt, actor, source, reason, nodes: redactSensitiveKeys(structuredClone(document.nodes)), conversationalAgents: redactSensitiveKeys(structuredClone(document.conversationalAgents ?? [])), relationships: redactSensitiveKeys(structuredClone(document.relationships ?? [])) };
      document.currentRevisionId = revision.revisionId;
    }
    // Legacy in-document events keep appending for back-compat readers; the full-node versions[]
    // snapshots are replaced by revision records (getVersions() merges both).
    document.events = [...(document.events ?? []), { id: makeId("event"), type: eventType, nodeId, actor: actorLabel(meta), summary: meta?.summary, workspaceVersion: document.workspaceVersion, beforeHash: hashValue(beforeNodes), afterHash: hashValue(document.nodes), createdAt: document.updatedAt }];
    await this.save(document);
    if (this.changeSink) {
      // Document is saved first: a crash here loses one history record but never fabricates
      // history for a mutation that did not persist.
      const relationshipsChanged = hashValue(beforeRelationships) !== hashValue(document.relationships ?? []);
      const ids = changedNodeIds(beforeNodes, document.nodes);
      const targetNode = nodeId ? document.nodes.find((node) => node.id === nodeId) ?? beforeNodes.find((node) => node.id === nodeId) : undefined;
      const before = nodeId
        ? beforeNodes.find((node) => node.id === nodeId)
        : agentId
          ? beforeConversationalAgents.find((agent) => agent.id === agentId)
        : structuralChange
          ? { nodes: beforeNodes.filter((node) => ids.has(node.id)), ...(relationshipsChanged ? { relationships: beforeRelationships } : {}) }
          : undefined;
      const after = nodeId
        ? document.nodes.find((node) => node.id === nodeId)
        : agentId
          ? document.conversationalAgents.find((agent) => agent.id === agentId)
        : structuralChange
          ? { nodes: document.nodes.filter((node) => ids.has(node.id)), ...(relationshipsChanged ? { relationships: document.relationships ?? [] } : {}) }
          : undefined;
      await this.changeSink.record({
        revision,
        event: {
          eventId: makeId("evt"),
          type: eventType,
          operation: operationForEventType(eventType),
          target: targetForEventType(eventType, nodeId, agentId),
          actor,
          source,
          reason,
          baseRevisionId: meta?.baseRevisionId,
          parentRevisionId,
          resultingRevisionId: document.currentRevisionId,
          workspaceVersion: document.workspaceVersion,
          riskLevel: targetNode?.riskLevel,
          before: redactSensitiveKeys(before),
          after: redactSensitiveKeys(after),
          correlation: meta?.correlation,
          createdAt: document.updatedAt
        }
      });
    }
    return document.workspaceVersion;
  }
  async getWorkspaceVersion() { return (await this.load()).workspaceVersion; }
  async getCurrentRevisionId() { return (await this.load()).currentRevisionId; }
  async getNodes() { return sortWorkspaceNodes([...(await this.load()).nodes]); }
  async getNode(id: string) { return (await this.load()).nodes.find((node) => node.id === id); }
  async ensureConversationalAgentSeeds(meta: WorkspaceMutationMeta = { actor: { kind: "system" }, source: "system", reason: "Seed canonical conversational agents" }) {
    const current = await this.load();
    const missing = seededConversationalAgents(current.updatedAt).filter((seed) => !current.conversationalAgents.some((agent) => agent.id === seed.id));
    // CA6: a workspace seeded before a canonical prompt changed keeps the old text, because seeding
    // is additive. Upgrade only prompts that still match a superseded canonical text exactly — an
    // operator-edited prompt classifies as "diverged" and is never overwritten here.
    const upgrades = pendingCanonicalPromptUpgrades(current.conversationalAgents);
    if (missing.length === 0 && upgrades.length === 0) return structuredClone(current.conversationalAgents);
    await this.mutate((document) => {
      document.conversationalAgents = [...document.conversationalAgents, ...seededConversationalAgents(document.updatedAt).filter((seed) => !document.conversationalAgents.some((agent) => agent.id === seed.id))];
      const upgradeById = new Map(pendingCanonicalPromptUpgrades(document.conversationalAgents).map((upgrade) => [upgrade.id, upgrade.prompt]));
      document.conversationalAgents = document.conversationalAgents.map((agent) => {
        const prompt = upgradeById.get(agent.id);
        return prompt === undefined ? agent : { ...agent, prompt, rev: agent.rev + 1, updatedAt: document.updatedAt };
      });
    }, meta, "agent.seeded", undefined, missing[0]?.id ?? upgrades[0]?.id);
    return structuredClone((await this.load()).conversationalAgents);
  }
  async listConversationalAgents() { return structuredClone((await this.load()).conversationalAgents); }
  async getConversationalAgent(id: string) { return structuredClone((await this.load()).conversationalAgents.find((agent) => agent.id === id)); }
  async updateConversationalAgent(id: string, patch: Partial<Omit<ConversationalAgentDefinition, "id" | "role" | "rev" | "updatedAt">>, meta: WorkspaceMutationMeta) {
    let agent: ConversationalAgentDefinition | undefined;
    const workspaceVersion = await this.mutate((document) => {
      const existing = document.conversationalAgents.find((candidate) => candidate.id === id);
      if (!existing) throw new Error(`Unknown conversational agent: ${id}`);
      agent = { ...existing, ...patch, id: existing.id, role: existing.role, rev: existing.rev + 1, updatedAt: now() };
      document.conversationalAgents = document.conversationalAgents.map((candidate) => candidate.id === id ? agent! : candidate);
    }, meta, "agent.updated", undefined, id);
    return { agent: agent!, workspaceVersion };
  }
  async getEvents() { return [...((await this.load()).events ?? [])]; }
  async getVersions() {
    const document = await this.load();
    const legacy = [...(document.versions ?? [])];
    const revisions = this.changeSink ? await this.changeSink.listRevisions() : [];
    const mapped: WorkspaceVersionSnapshot[] = revisions.map((revision) => ({ workspaceVersion: revision.workspaceVersion, createdAt: revision.createdAt, summary: revision.reason, nodes: revision.nodes }));
    return [...legacy, ...mapped].sort((a, b) => a.workspaceVersion - b.workspaceVersion);
  }
  async listRelationships() { return structuredClone((await this.load()).relationships ?? []); }
  async updateRelationships(update: WorkspaceRelationshipsUpdate, meta: WorkspaceMutationMeta) {
    let relationships: WorkspaceRelationship[] = [];
    const workspaceVersion = await this.mutate((document) => {
      const nodeIds = new Set(document.nodes.map((node) => node.id));
      let current = [...(document.relationships ?? [])];
      for (const id of update.delete ?? []) {
        if (!current.some((relationship) => relationship.id === id)) throw new Error(`unknown_relationship: ${id}`);
        current = current.filter((relationship) => relationship.id !== id);
      }
      for (const create of update.create ?? []) {
        if (create.kind === "execution") throw new Error("execution_relationships_are_derived: execution edges come from node.dependsOn");
        const id = create.id ?? makeId("rel");
        if (current.some((relationship) => relationship.id === id)) throw new Error(`duplicate_relationship_id: ${id}`);
        for (const endpoint of [create.sourceId, create.targetId]) if (!nodeIds.has(endpoint)) throw new Error(`unknown_relationship_endpoint: ${endpoint}`);
        current.push({ ...create, id, direction: create.direction ?? "forward", enabled: create.enabled ?? true, createdAt: now(), updatedAt: now() });
      }
      for (const patch of update.update ?? []) {
        const existing = current.find((relationship) => relationship.id === patch.id);
        if (!existing) throw new Error(`unknown_relationship: ${patch.id}`);
        if (patch.kind === "execution") throw new Error("execution_relationships_are_derived: execution edges come from node.dependsOn");
        const next: WorkspaceRelationship = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: now() };
        for (const endpoint of [next.sourceId, next.targetId]) if (!nodeIds.has(endpoint)) throw new Error(`unknown_relationship_endpoint: ${endpoint}`);
        current = current.map((relationship) => relationship.id === existing.id ? next : relationship);
      }
      document.relationships = current;
      relationships = current;
    }, meta, "workspace.relationships_updated");
    return { relationships: structuredClone(relationships), workspaceVersion, revisionId: (await this.load()).currentRevisionId };
  }
  async updateNodePrompt(id: string, prompt: string, meta?: WorkspaceMutationMeta) {
    let updated: WorkspaceNode | undefined;
    const workspaceVersion = await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, prompt, updatedAt: now() };
      document.nodes = upsertWorkspaceNode(document.nodes, updated);
    }, meta, "node.prompt_updated", id);
    return { node: updated!, workspaceVersion };
  }
  async updateNodeSchema(id: string, schema: unknown, meta?: WorkspaceMutationMeta) {
    let updated: WorkspaceNode | undefined;
    const workspaceVersion = await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      // outputSchema is canonical. The deprecated `schema` alias is no longer written here — a record that
      // carried both could drift (schema stale, outputSchema current) and readers that still preferred
      // `schema` saw the old contract. normalizeNode/workspaceNodeSchema keep reading `schema` as the
      // fallback for OLD records; dropping it on write is what stops the two from ever disagreeing.
      const { schema: _legacySchemaAlias, ...rest } = existing;
      void _legacySchemaAlias;
      updated = { ...rest, outputSchema: schema, updatedAt: now() };
      document.nodes = upsertWorkspaceNode(document.nodes, updated);
    }, meta, "node.output_schema_updated", id);
    return { node: updated!, workspaceVersion };
  }
  async createNode(node: WorkspaceNode, meta: WorkspaceMutationMeta, eventType = "node.created") { let workspaceVersion = 0; const normalized = normalizeNode(coerceNodeInput(node)); workspaceVersion = await this.mutate((document) => { if (document.nodes.some((existing) => existing.id === normalized.id)) throw new Error(`Duplicate node id: ${normalized.id}`); document.nodes = [...document.nodes, normalized]; }, meta, eventType, normalized.id); return { node: normalized, workspaceVersion }; }
  async deleteNode(id: string, meta: WorkspaceMutationMeta) { let workspaceVersion = 0; workspaceVersion = await this.mutate((document) => { if (document.nodes.some((node) => node.dependsOn.includes(id))) throw new Error(`Cannot delete referenced node: ${id}`); document.nodes = document.nodes.filter((node) => node.id !== id); }, meta, "node.deleted", id); return { deleted: true as const, workspaceVersion }; }
  async cloneNode(id: string, newId: string, meta: WorkspaceMutationMeta) { const existing = await this.getNode(id); if (!existing) throw new Error(`Unknown node: ${id}`); const node = normalizeNode({ ...structuredClone(existing), id: newId, name: `${existing.name} Copy`, dependsOn: [...existing.dependsOn], updatedAt: now() }); let workspaceVersion = 0; workspaceVersion = await this.mutate((document) => { if (document.nodes.some((existingNode) => existingNode.id === newId)) throw new Error(`Duplicate node id: ${newId}`); document.nodes = [...document.nodes, node]; }, meta, "node.cloned", newId); return { node, workspaceVersion }; }
  async updateNode(id: string, patch: Partial<WorkspaceNode>, meta: WorkspaceMutationMeta, eventType = "node.updated") { let node: WorkspaceNode | undefined; const workspaceVersion = await this.mutate((document) => { const existing = document.nodes.find((candidate) => candidate.id === id); if (!existing) throw new Error(`Unknown node: ${id}`); node = normalizeNode({ ...existing, ...patch, id, updatedAt: now() }); document.nodes = upsertWorkspaceNode(document.nodes, node); }, meta, eventType, id); return { node: node!, workspaceVersion }; }
  async updateGraph(update: WorkspaceGraphUpdate, meta: WorkspaceMutationMeta, eventType = "graph.updated") { let nodes: WorkspaceNode[] = []; const workspaceVersion = await this.mutate((document) => { nodes = [...document.nodes]; (update.delete ?? []).forEach((id) => { if (nodes.some((node) => node.dependsOn.includes(id)) && !(update.delete ?? []).includes(id)) throw new Error(`Cannot delete referenced node: ${id}`); nodes = nodes.filter((node) => node.id !== id); }); (update.create ?? []).forEach((rawNode) => { const node = coerceNodeInput(rawNode); if (nodes.some((existing) => existing.id === node.id)) throw new Error(`Duplicate node id: ${node.id}`); nodes.push(normalizeNode(node)); }); (update.update ?? []).forEach((patch) => { const existing = nodes.find((node) => node.id === patch.id); if (!existing) throw new Error(`Unknown node: ${patch.id}`); nodes = upsertWorkspaceNode(nodes, normalizeNode({ ...existing, ...patch, updatedAt: now() })); }); Object.entries(update.dependencies ?? {}).forEach(([id, dependsOn]) => { const existing = nodes.find((node) => node.id === id); if (!existing) throw new Error(`Unknown node: ${id}`); nodes = upsertWorkspaceNode(nodes, normalizeNode({ ...existing, dependsOn, updatedAt: now() })); }); Object.entries(update.positions ?? {}).forEach(([id, position]) => { const existing = nodes.find((node) => node.id === id); if (!existing) throw new Error(`Unknown node: ${id}`); nodes = upsertWorkspaceNode(nodes, normalizeNode({ ...existing, position, updatedAt: now() })); }); if (update.orderedNodeIds) { const ordered = update.orderedNodeIds.map((id) => nodes.find((node) => node.id === id)); if (ordered.some((node) => !node) || ordered.length !== nodes.length) throw new Error("orderedNodeIds must contain every node exactly once."); nodes = (ordered as WorkspaceNode[]).map((node, index) => normalizeNode({ ...node, position: node.position ? { ...node.position, y: index * 100 } : { x: 0, y: index * 100 }, updatedAt: now() })); } assertGraphValid(nodes, update.allowCanonicalNodeRemoval, update.adminApproved); document.nodes = nodes; }, meta, eventType); return { nodes: sortWorkspaceNodes(nodes), workspaceVersion }; }
  async exportWorkspace() { return structuredClone(await this.load()); }
  async importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }) {
    let workspaceVersion = 0;
    workspaceVersion = await this.mutate((document) => {
      workspace.nodes?.forEach((node) => { document.nodes = upsertWorkspaceNode(document.nodes, node); });
      workspace.stageOutputs?.forEach((output) => { document.stageOutputs = [...document.stageOutputs.filter((existing) => existing.id !== output.id), output]; });
      workspace.learningObservations?.forEach((observation) => { document.learningObservations = [...document.learningObservations.filter((existing) => existing.id !== observation.id), observation]; });
    }, undefined, "workspace.imported");
    return { imported: true as const, workspaceVersion, counts: { nodes: workspace.nodes?.length ?? 0, stageOutputs: workspace.stageOutputs?.length ?? 0, learningObservations: workspace.learningObservations?.length ?? 0 } };
  }
  async saveStageOutput(stage: string, value: unknown, id = makeId("stage")) {
    const output = { id, stage, value, createdAt: now() };
    await this.mutate((document) => { document.stageOutputs = [...document.stageOutputs.filter((existing) => existing.id !== id), output]; }, undefined, "stage.output_saved");
    return output;
  }
  async getStageOutput(id: string) { return (await this.load()).stageOutputs.find((output) => output.id === id); }
  async listStageOutputs(stage?: string) { return (await this.load()).stageOutputs.filter((output) => !stage || output.stage === stage); }
  async recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }) {
    // 2.7 (handoff 2026-08-10): playbook.migrate_observations (improvementTools.ts) reads
    // observation.metadata?.nodeId, but this method only ever wrote nodeId at the TOP level
    // (provenance, below) — so every one of 34 stored observations failed that lookup and curation
    // silently produced nothing. Prefer writing both: mirror the context-stamped provenance into
    // metadata as well as top-level, so either access path finds it. The mirrored value always comes
    // from `provenance` (never from caller-supplied metadata), so this cannot be used to forge
    // attribution to a different run/node than actually recorded it.
    const metadataWithProvenance = provenance?.runId || provenance?.nodeId
      ? { ...(metadata ?? {}), ...(provenance?.nodeId ? { nodeId: provenance.nodeId } : {}), ...(provenance?.runId ? { runId: provenance.runId } : {}) }
      : metadata;
    const record: LearningObservation = { id: makeId("learning"), observation, metadata: metadataWithProvenance, ...(provenance?.runId ? { runId: provenance.runId } : {}), ...(provenance?.nodeId ? { nodeId: provenance.nodeId } : {}), createdAt: now() };
    await this.mutate((document) => { document.learningObservations = [...document.learningObservations, record]; }, undefined, "learning.observation_recorded");
    return record;
  }
  // 2.8: default excludes archived (soft-deleted) records — an observation's status is undefined
  // ("active" is never actually persisted for the common case) until something archives it, so
  // "status !== 'archived'" is the correct default-active check without needing a default value
  // migration for every existing record.
  async listObservations(options?: { includeArchived?: boolean }) {
    const observations = (await this.load()).learningObservations;
    return options?.includeArchived ? [...observations] : observations.filter((observation) => observation.status !== "archived");
  }
  async archiveObservation(id: string, reason?: string): Promise<LearningObservation> {
    let archived: LearningObservation | undefined;
    await this.mutate((document) => {
      const existing = document.learningObservations.find((observation) => observation.id === id);
      if (!existing) throw new Error(`Unknown learning observation: ${id}`);
      archived = { ...existing, status: "archived", archivedAt: now(), ...(reason ? { archivedReason: reason } : {}) };
      document.learningObservations = document.learningObservations.map((observation) => observation.id === id ? archived! : observation);
    }, undefined, "learning.observation_archived");
    return archived!;
  }
  async archiveObservationsByPredicate(predicate: (observation: LearningObservation) => boolean, reason?: string): Promise<{ archived: number; ids: string[] }> {
    const ids: string[] = [];
    await this.mutate((document) => {
      document.learningObservations = document.learningObservations.map((observation) => {
        if (observation.status === "archived" || !predicate(observation)) return observation;
        ids.push(observation.id);
        return { ...observation, status: "archived" as const, archivedAt: now(), ...(reason ? { archivedReason: reason } : {}) };
      });
    }, undefined, "learning.observations_archived");
    return { archived: ids.length, ids };
  }
  async getReducedContractCacheEntry(projectId: string, objectType: string, fingerprint: string) {
    const key = reducedContractCacheKey(projectId, objectType, fingerprint);
    return (await this.load()).reducedContractCache?.find((entry) => entry.key === key);
  }
  async putReducedContractCacheEntry(entry: { projectId: string; objectType: string; fingerprint: string; reduced: ReducedContract }) {
    const key = reducedContractCacheKey(entry.projectId, entry.objectType, entry.fingerprint);
    const record: ReducedContractCacheEntry = { key, projectId: entry.projectId, objectType: entry.objectType, fingerprint: entry.fingerprint, reduced: entry.reduced, createdAt: now() };
    await this.mutate((document) => {
      // Replace-on-write (same fingerprint overwrites, never duplicates), then cap by dropping the
      // oldest entries — insertion order, not access order: simple, bounded, and correct enough for a
      // footprint cap on an optimization (a full cache degrades to "always recompute", never to a
      // wrong answer).
      const withoutExisting = (document.reducedContractCache ?? []).filter((existing) => existing.key !== key);
      const next = [...withoutExisting, record];
      document.reducedContractCache = next.length > REDUCED_CONTRACT_CACHE_CAP ? next.slice(next.length - REDUCED_CONTRACT_CACHE_CAP) : next;
    }, undefined, "contract.reduced_cache_stored");
    return record;
  }
}

export class InMemoryWorkspaceStore extends WorkspaceStateStore {}

export class JsonWorkspaceStore extends WorkspaceStateStore {
  private loaded = false;
  constructor(private readonly filePath: string) { super(createDefaultWorkspaceDocument()); }
  protected override async load() {
    if (this.loaded) return this.document;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      const { document, droppedNodes } = parseWorkspaceDocumentTolerant(parsed);
      this.document = document;
      // Persist the healed document so a dropped-node repair is permanent.
      if (droppedNodes > 0) {
        this.healedDroppedNodes += droppedNodes;
        await this.save(this.document);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.document = createDefaultWorkspaceDocument();
        await this.save(this.document);
      } else {
        throw error;
      }
    }
    this.loaded = true;
    return this.document;
  }
  protected override async save(document: WorkspaceDocument) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
    this.document = document;
    this.loaded = true;
  }
}
