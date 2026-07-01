import { z, ZodError, type ZodTypeAny } from "zod";
import { articleBodySchema, type WorkspaceStore } from "./store.js";

export type JsonSchema = Record<string, unknown>;
export type WorkspaceTool = {
  name: string;
  description: string;
  zodSchema: ZodTypeAny;
  inputSchema: JsonSchema;
  execute: (input: unknown) => Promise<unknown>;
};

const emptyInput = z.object({}).strict();

const workspaceNodeImport = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string(),
  schema: z.unknown(),
  updatedAt: z.string().datetime()
}).strict();
const stageOutputImport = z.object({
  id: z.string().min(1),
  stage: z.string().min(1),
  value: z.unknown(),
  createdAt: z.string().datetime()
}).strict();
const learningObservationImport = z.object({
  id: z.string().min(1),
  observation: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime()
}).strict();
const publishPayloadSchema = articleBodySchema.extend({
  target: z.enum(["preview", "cms"]),
  dryRun: z.literal(true),
  builtAt: z.string().datetime()
}).strict();
const nodeId = z.object({ id: z.string().min(1) }).strict();
const updatePrompt = z.object({ id: z.string().min(1), prompt: z.string().min(1) }).strict();
const updateSchema = z.object({ id: z.string().min(1), schema: z.unknown() }).strict();
const importWorkspace = z.object({ nodes: z.array(workspaceNodeImport).optional(), stageOutputs: z.array(stageOutputImport).optional(), learningObservations: z.array(learningObservationImport).optional() }).strict();
const saveOutput = z.object({ id: z.string().min(1).optional(), stage: z.string().min(1), value: z.unknown() }).strict();
const listOutputs = z.object({ stage: z.string().min(1).optional() }).strict();
const recordObservation = z.object({ observation: z.string().min(1), metadata: z.record(z.unknown()).optional() }).strict();
const validateArticle = z.object({ article: z.unknown() }).strict();
const publishBuild = z.object({ article: articleBodySchema, target: z.enum(["preview", "cms"]).default("preview") }).strict();
const publishValidate = z.object({ payload: publishPayloadSchema }).strict();

const objectSchema = (properties: JsonSchema = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const emptyJsonSchema = objectSchema();
const nodeIdJsonSchema = objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]);
const updatePromptJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } }, ["id", "prompt"]);
const updateSchemaJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, schema: {} }, ["id", "schema"]);
const workspaceNodeJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, prompt: { type: "string" }, schema: {}, updatedAt: { type: "string", format: "date-time" } }, ["id", "name", "prompt", "schema", "updatedAt"]);
const stageOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {}, createdAt: { type: "string", format: "date-time" } }, ["id", "stage", "value", "createdAt"]);
const learningObservationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, observation: { type: "string", minLength: 1 }, metadata: { type: "object" }, createdAt: { type: "string", format: "date-time" } }, ["id", "observation", "createdAt"]);
const importWorkspaceJsonSchema = objectSchema({ nodes: { type: "array", items: workspaceNodeJsonSchema }, stageOutputs: { type: "array", items: stageOutputJsonSchema }, learningObservations: { type: "array", items: learningObservationJsonSchema } });
const saveOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {} }, ["stage", "value"]);
const listOutputsJsonSchema = objectSchema({ stage: { type: "string", minLength: 1 } });
const recordObservationJsonSchema = objectSchema({ observation: { type: "string", minLength: 1 }, metadata: { type: "object" } }, ["observation"]);
const articleProperties = { title: { type: "string", minLength: 1 }, dek: { type: "string" }, bodyMarkdown: { type: "string", minLength: 1 }, slug: { type: "string", minLength: 1, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, tags: { type: "array", items: { type: "string" } }, author: { type: "string" } };
const articleJsonSchema = objectSchema(articleProperties, ["title", "bodyMarkdown", "slug"]);
const validateArticleJsonSchema = objectSchema({ article: articleJsonSchema }, ["article"]);
const publishBuildJsonSchema = objectSchema({ article: articleJsonSchema, target: { type: "string", enum: ["preview", "cms"], default: "preview" } }, ["article"]);
const publishPayloadJsonSchema = objectSchema({ ...articleProperties, target: { type: "string", enum: ["preview", "cms"] }, dryRun: { const: true }, builtAt: { type: "string", format: "date-time" } }, ["title", "bodyMarkdown", "slug", "target", "dryRun", "builtAt"]);
const publishValidateJsonSchema = objectSchema({ payload: publishPayloadJsonSchema }, ["payload"]);

const ok = (data: unknown) => ({ ok: true, data });

const tool = (definition: WorkspaceTool) => definition;

export function createWorkspaceTools(store: WorkspaceStore): WorkspaceTool[] {
  return [
    tool({ name: "workspace.get_nodes", description: "List workspace nodes.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ nodes: await store.getNodes() }); } }),
    tool({ name: "workspace.get_node", description: "Get one workspace node.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ node: await store.getNode(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "workspace.update_node_prompt", description: "Update a node prompt.", zodSchema: updatePrompt, inputSchema: updatePromptJsonSchema, execute: async (input) => { const data = updatePrompt.parse(input); return ok({ node: await store.updateNodePrompt(data.id, data.prompt) }); } }),
    tool({ name: "workspace.update_node_schema", description: "Update a node schema.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); return ok({ node: await store.updateNodeSchema(data.id, data.schema) }); } }),
    tool({ name: "workspace.export_workspace", description: "Export workspace data.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok(await store.exportWorkspace()); } }),
    tool({ name: "workspace.import_workspace", description: "Import workspace data.", zodSchema: importWorkspace, inputSchema: importWorkspaceJsonSchema, execute: async (input) => ok(await store.importWorkspace(importWorkspace.parse(input))) }),
    tool({ name: "article_body.get_schema", description: "Get article body schema.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ schema: articleJsonSchema }); } }),
    tool({ name: "article_body.validate", description: "Validate article body data.", zodSchema: validateArticle, inputSchema: validateArticleJsonSchema, execute: async (input) => { const article = validateArticle.parse(input).article; const parsed = articleBodySchema.safeParse(article); return ok({ valid: parsed.success, article: parsed.success ? parsed.data : undefined, issues: parsed.success ? [] : parsed.error.issues }); } }),
    tool({ name: "stage.save_output", description: "Save stage output.", zodSchema: saveOutput, inputSchema: saveOutputJsonSchema, execute: async (input) => { const data = saveOutput.parse(input); return ok({ output: await store.saveStageOutput(data.stage, data.value, data.id) }); } }),
    tool({ name: "stage.get_output", description: "Get stage output.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ output: await store.getStageOutput(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "stage.list_outputs", description: "List stage outputs.", zodSchema: listOutputs, inputSchema: listOutputsJsonSchema, execute: async (input) => ok({ outputs: await store.listStageOutputs(listOutputs.parse(input).stage) }) }),
    tool({ name: "learning.record_observation", description: "Record a learning observation.", zodSchema: recordObservation, inputSchema: recordObservationJsonSchema, execute: async (input) => { const data = recordObservation.parse(input); return ok({ observation: await store.recordObservation(data.observation, data.metadata) }); } }),
    tool({ name: "learning.list_observations", description: "List learning observations.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ observations: await store.listObservations() }); } }),
    tool({ name: "publish.build_payload", description: "Build a dry-run publish payload without side effects.", zodSchema: publishBuild, inputSchema: publishBuildJsonSchema, execute: async (input) => { const data = publishBuild.parse(input); return ok({ payload: { ...data.article, target: data.target, dryRun: true, builtAt: new Date().toISOString() } }); } }),
    tool({ name: "publish.validate_payload", description: "Validate a dry-run publish payload.", zodSchema: publishValidate, inputSchema: publishValidateJsonSchema, execute: async (input) => { const parsed = publishValidate.safeParse(input); return ok({ valid: parsed.success, issues: parsed.success ? [] : parsed.error.issues }); } })
  ];
}

export const toolError = (error: unknown) => error instanceof ZodError ? { ok: false, error: { code: "validation_error", issues: error.issues } } : { ok: false, error: { code: "tool_error", message: error instanceof Error ? error.message : "Unknown error" } };
