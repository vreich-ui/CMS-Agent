import type { ProjectProfile } from "../runtime/types.js";

export const projectA: ProjectProfile = {
  projectId: "project-a",
  displayName: "Project A",
  defaultWorkflow: "content_creation",
  brandVoice: "Clear, practical, expert, non-hype.",
  audience: "Business owners and content operators.",
  editorialRules: [
    "Prefer concise sections.",
    "Use concrete examples.",
    "Avoid unsupported claims.",
    "Return publish-ready Markdown unless another format is requested."
  ],
  allowedSkills: ["draft_content", "editorial_review", "seo_optimize", "publish"],
  mcpServers: [
    {
      name: "content_repo",
      type: "streamable_http",
      urlEnv: "MCP_CONTENT_REPO_URL",
      authorizationEnv: "MCP_CONTENT_REPO_TOKEN",
      allowedTools: ["search_documents", "get_document"]
    }
  ],
  memoryNamespace: "project-a",
  publishingTarget: {
    type: "http",
    endpointEnv: "PROJECT_A_PUBLISH_ENDPOINT",
    tokenEnv: "PROJECT_A_PUBLISH_TOKEN"
  }
};
