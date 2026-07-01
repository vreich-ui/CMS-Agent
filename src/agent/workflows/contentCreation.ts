export const contentCreationWorkflow = {
  id: "content_creation" as const,
  description: "Draft content, run editorial review, prepare SEO recommendations, and optionally prepare a dry-run publish payload.",
  steps: ["draft_content", "editorial_review", "seo_optimize", "publish"]
};
