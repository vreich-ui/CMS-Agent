import type { RJSFSchema } from "@rjsf/utils";

export type JsonValue = unknown;

export type McpConfig = {
  endpoint: string;
  token?: string;
  authToken?: string;
  requiresToken?: boolean;
};

export type WorkspaceNode = {
  id: string;
  name: string;
  prompt: string;
  schema?: RJSFSchema | JsonValue;
  updatedAt?: string;
};

export type WorkspaceExport = {
  schemaVersion?: number;
  workspaceVersion?: number;
  updatedAt?: string;
  nodes?: WorkspaceNode[];
  stageOutputs?: unknown[];
  learningObservations?: unknown[];
};

export type WorkspaceDocument = WorkspaceExport;
export type ArticleBodySchema = RJSFSchema;

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

export type ConnectionStatusTone = "idle" | "success" | "error";

export type ConnectionStatus = {
  tone: ConnectionStatusTone;
  serverName?: string;
  protocolVersion?: string;
  error?: string;
};

export type InitializeResult = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
};
