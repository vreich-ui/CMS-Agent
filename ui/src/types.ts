import type { JSONSchema7 } from "@rjsf/utils";

export type JsonValue = unknown;

export type WorkspaceNode = {
  id: string;
  name: string;
  prompt: string;
  schema?: JSONSchema7 | JsonValue;
  updatedAt?: string;
};

export type WorkspaceDocument = {
  schemaVersion?: number;
  workspaceVersion?: number;
  updatedAt?: string;
  nodes?: WorkspaceNode[];
  stageOutputs?: unknown[];
  learningObservations?: unknown[];
};

export type ToolEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: unknown;
};

export type ValidationIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
  [key: string]: unknown;
};

export type ArticleValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  articleBody?: unknown;
};
