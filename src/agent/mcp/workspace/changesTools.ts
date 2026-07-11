import { z } from "zod";
import { metaJson, mutationMeta, objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import type { WorkspaceMutationMeta } from "./store.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ChangeRepository } from "../../repository/interfaces/ChangeRepository.js";
import { workspaceActorKinds, workspaceChangeOperations, workspaceChangeSources } from "../../workspace/changeTypes.js";
import { relationshipDirections, relationshipKinds, type WorkspaceRelationshipsUpdate } from "../../workspace/relationshipTypes.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import { hashValue } from "./store.js";

const listChangesInput = z.object({
  nodeId: z.string().min(1).optional(),
  operation: z.enum(workspaceChangeOperations).optional(),
  actorKind: z.enum(workspaceActorKinds).optional(),
  source: z.enum(workspaceChangeSources).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional()
}).strict();
const listChangesJsonSchema = objectSchema({
  nodeId: { type: "string", minLength: 1 },
  operation: { type: "string", enum: [...workspaceChangeOperations] },
  actorKind: { type: "string", enum: [...workspaceActorKinds] },
  source: { type: "string", enum: [...workspaceChangeSources] },
  from: { type: "string", format: "date-time" },
  to: { type: "string", format: "date-time" },
  limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  cursor: { type: "string", minLength: 1 }
});

const getChangeInput = z.object({ eventId: z.string().min(1) }).strict();
const getChangeJsonSchema = objectSchema({ eventId: { type: "string", minLength: 1 } }, ["eventId"]);

const compareInput = z.object({ fromRevisionId: z.string().min(1), toRevisionId: z.string().min(1) }).strict();
const compareJsonSchema = objectSchema({ fromRevisionId: { type: "string", minLength: 1 }, toRevisionId: { type: "string", minLength: 1 } }, ["fromRevisionId", "toRevisionId"]);

const restoreInput = z.object({ revisionId: z.string().min(1), nodeId: z.string().min(1), ...mutationMeta }).strict();
const restoreJsonSchema = objectSchema({ revisionId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, ...metaJson }, ["revisionId", "nodeId"]);

const relationshipCreateSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(relationshipKinds),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  direction: z.enum(relationshipDirections).optional(),
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  schemaRefs: z.array(z.string().min(1)).optional(),
  artifactRefs: z.array(z.string().min(1)).optional()
}).strict();
const updateRelationshipsInput = z.object({
  create: z.array(relationshipCreateSchema).optional(),
  update: z.array(z.object({ id: z.string().min(1) }).catchall(z.unknown())).optional(),
  delete: z.array(z.string().min(1)).optional(),
  ...mutationMeta
}).strict();
const relationshipJson = { type: "object", additionalProperties: false, required: ["kind", "sourceId", "targetId"], properties: { id: { type: "string" }, kind: { type: "string", enum: [...relationshipKinds] }, sourceId: { type: "string" }, targetId: { type: "string" }, direction: { type: "string", enum: [...relationshipDirections] }, label: { type: "string" }, enabled: { type: "boolean" }, metadata: { type: "object" }, schemaRefs: { type: "array", items: { type: "string" } }, artifactRefs: { type: "array", items: { type: "string" } } } };
const updateRelationshipsJsonSchema = objectSchema({ create: { type: "array", items: relationshipJson }, update: { type: "array", items: { type: "object" } }, delete: { type: "array", items: { type: "string" } }, ...metaJson });

// Node-level diff between two revisions. Values were redacted at write time, so diff output is
// safe to surface directly.
const diffNodes = (fromNodes: WorkspaceNode[], toNodes: WorkspaceNode[]) => {
  const fromById = new Map(fromNodes.map((node) => [node.id, node]));
  const toById = new Map(toNodes.map((node) => [node.id, node]));
  const added = toNodes.filter((node) => !fromById.has(node.id));
  const removed = fromNodes.filter((node) => !toById.has(node.id));
  const changed: Array<{ nodeId: string; changedFields: string[]; before: WorkspaceNode; after: WorkspaceNode }> = [];
  for (const [id, before] of fromById) {
    const after = toById.get(id);
    if (!after || hashValue(before) === hashValue(after)) continue;
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((field) => hashValue((before as Record<string, unknown>)[field] ?? null) !== hashValue((after as Record<string, unknown>)[field] ?? null))
      .sort();
    changed.push({ nodeId: id, changedFields: fields, before, after });
  }
  return { added, removed, changed };
};

export type ChangesToolDeps = {
  workspaceRepository: WorkspaceRepository;
  changeRepository: ChangeRepository;
  meta: <T extends Partial<WorkspaceMutationMeta>>(data: T) => T & WorkspaceMutationMeta;
};

export function createChangesTools({ workspaceRepository, changeRepository, meta }: ChangesToolDeps): WorkspaceTool[] {
  return [
    tool({
      name: "changes.list",
      description: "List immutable workspace change events, newest first, with pagination and filters for a future Changes UI.",
      zodSchema: listChangesInput,
      inputSchema: listChangesJsonSchema,
      execute: async (input) => ok(await changeRepository.listEvents(listChangesInput.parse(input)))
    }),
    tool({
      name: "changes.get",
      description: "Get one immutable workspace change event by id.",
      zodSchema: getChangeInput,
      inputSchema: getChangeJsonSchema,
      execute: async (input) => ok({ event: await changeRepository.getEvent(getChangeInput.parse(input).eventId) ?? null })
    }),
    tool({
      name: "changes.compare",
      description: "Compare two workspace revisions and return a node-level diff plus a relationships diff.",
      zodSchema: compareInput,
      inputSchema: compareJsonSchema,
      execute: async (input) => {
        const data = compareInput.parse(input);
        const [from, to] = await Promise.all([changeRepository.getRevision(data.fromRevisionId), changeRepository.getRevision(data.toRevisionId)]);
        if (!from) throw new Error(`unknown_revision: ${data.fromRevisionId}`);
        if (!to) throw new Error(`unknown_revision: ${data.toRevisionId}`);
        const fromRelationships = new Map(from.relationships.map((relationship) => [relationship.id, relationship]));
        const toRelationships = new Map(to.relationships.map((relationship) => [relationship.id, relationship]));
        return ok({
          diff: {
            fromRevisionId: data.fromRevisionId,
            toRevisionId: data.toRevisionId,
            nodes: diffNodes(from.nodes, to.nodes),
            relationships: {
              added: to.relationships.filter((relationship) => !fromRelationships.has(relationship.id)),
              removed: from.relationships.filter((relationship) => !toRelationships.has(relationship.id)),
              changedIds: [...fromRelationships.keys()].filter((id) => toRelationships.has(id) && hashValue(fromRelationships.get(id)) !== hashValue(toRelationships.get(id)))
            }
          }
        });
      }
    }),
    tool({
      name: "changes.restore",
      description: "Restore one node from a historical revision as a NEW revision. History is append-only and is never rewritten or deleted.",
      zodSchema: restoreInput,
      inputSchema: restoreJsonSchema,
      execute: async (input) => {
        const data = restoreInput.parse(input);
        const revision = await changeRepository.getRevision(data.revisionId);
        if (!revision) throw new Error(`unknown_revision: ${data.revisionId}`);
        const snapshot = revision.nodes.find((node) => node.id === data.nodeId);
        if (!snapshot) throw new Error(`unknown_node_in_revision: ${data.nodeId}`);
        const restoreMeta = meta({ ...data, reason: data.reason ?? `restore ${data.nodeId} from revision ${data.revisionId}` });
        const existing = await workspaceRepository.getNode(data.nodeId);
        const result = existing
          ? await workspaceRepository.updateNode(data.nodeId, { ...snapshot, updatedAt: new Date().toISOString() }, restoreMeta, "node.restored")
          : await workspaceRepository.createNode({ ...snapshot, updatedAt: new Date().toISOString() }, restoreMeta, "node.restored");
        return ok({ node: result.node, workspaceVersion: result.workspaceVersion, revisionId: await workspaceRepository.getCurrentRevisionId(), restoredFromRevisionId: data.revisionId });
      }
    }),
    tool({
      name: "workspace.update_relationships",
      description: "Create, update, or delete typed constellation relationships (data/memory/policy/evaluation/approval). Execution edges are derived from node.dependsOn and cannot be stored.",
      zodSchema: updateRelationshipsInput,
      inputSchema: updateRelationshipsJsonSchema,
      execute: async (input) => {
        const data = updateRelationshipsInput.parse(input);
        return ok(await workspaceRepository.updateRelationships(data as WorkspaceRelationshipsUpdate, meta(data)));
      }
    })
  ];
}
