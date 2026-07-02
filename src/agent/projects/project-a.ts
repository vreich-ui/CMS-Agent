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
  // TODO: Resolve project MCP servers from authenticated project selection and passthrough credentials.
  mcpServers: [],
  memoryNamespace: "project-a",
  publishingTarget: {
    type: "project_mcp"
  }
};
