import { createHash } from "node:crypto";
import type { NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import type { PublishProducerContext } from "../projects/projectHooks.js";

const PRODUCER_KEYS = ["run_id", "node_id", "prompt_version", "model"] as const;

const sameJson = (left: unknown, right: unknown): boolean => {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};

const boundedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 128 ? value : undefined;

export const promptVersionIdForNode = (node: Pick<WorkspaceNode, "prompt">): string =>
  `prompt_sha256:${createHash("sha256").update(node.prompt, "utf8").digest("hex")}`;

export type NodeExecutionProvenance = {
  promptVersion: string;
  model: string;
  capturedAt: string;
};

export const buildNodeExecutionProvenance = (node: WorkspaceNode, model: unknown, capturedAt: string): NodeExecutionProvenance | undefined => {
  const resolvedModel = boundedString(model);
  if (!resolvedModel) return undefined;
  return { promptVersion: promptVersionIdForNode(node), model: resolvedModel, capturedAt };
};

export const parseProducerContext = (value: unknown): PublishProducerContext | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== PRODUCER_KEYS.length || !Object.keys(record).every((key) => (PRODUCER_KEYS as readonly string[]).includes(key))) return undefined;
  for (const key of PRODUCER_KEYS) if (!boundedString(record[key])) return undefined;
  return record as PublishProducerContext;
};

const producerFromState = (run: WorkflowExecutionRecord, state: NodeExecutionState): PublishProducerContext | undefined =>
  parseProducerContext({
    run_id: run.runId,
    node_id: state.nodeId,
    prompt_version: state.provenance?.promptVersion,
    model: state.provenance?.model
  });

const stateForProducer = (run: WorkflowExecutionRecord, nodeId: string): NodeExecutionState | undefined =>
  run.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.status === "completed");

export const producerContextForPublish = (run: WorkflowExecutionRecord, envelope: unknown, injected?: unknown): PublishProducerContext | undefined => {
  const artifact = run.artifacts.find((candidate) => candidate.type === "client_object.v1" && sameJson(candidate.value, envelope));
  if (!artifact) return undefined;
  const state = stateForProducer(run, artifact.nodeId);
  if (!state) return undefined;

  const persisted = producerFromState(run, state);
  if (persisted) return persisted;

  const fallback = parseProducerContext(injected);
  if (!fallback || fallback.run_id !== run.runId || fallback.node_id !== state.nodeId) return undefined;
  return fallback;
};
