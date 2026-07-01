import type { MemoryEnvelope } from "../memory/memoryEnvelope.js";

export type WorkflowId = "content_creation" | "publish_only" | "refresh_existing_content";
export type SkillId = "draft_content" | "editorial_review" | "seo_optimize" | "publish";

export type PublishingTarget = {
  type: "http" | "none";
  endpointEnv?: string;
  tokenEnv?: string;
};

export type McpServerConfig = {
  name: string;
  type: "streamable_http";
  urlEnv: string;
  authorizationEnv?: string;
  allowedTools?: string[];
  blockedTools?: string[];
};

export type ProjectProfile = {
  projectId: string;
  displayName: string;
  defaultWorkflow: WorkflowId;
  brandVoice: string;
  audience: string;
  editorialRules: string[];
  allowedSkills: SkillId[];
  mcpServers: McpServerConfig[];
  memoryNamespace: string;
  publishingTarget: PublishingTarget;
};

export type AgentRequest = {
  projectId: string;
  workflow?: WorkflowId;
  threadId?: string;
  userId?: string;
  dryRun: boolean;
  input: string;
  memory?: MemoryEnvelope;
};

export type AgentRunOutput = {
  title?: string;
  status: string;
  content?: string;
  review?: unknown;
  seo?: unknown;
  publish?: unknown;
  memory: MemoryEnvelope;
};

export type AgentRunResponse = {
  projectId: string;
  workflow: WorkflowId;
  output: AgentRunOutput;
};
