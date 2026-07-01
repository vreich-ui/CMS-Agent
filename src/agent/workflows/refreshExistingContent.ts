export const refreshExistingContentWorkflow = {
  id: "refresh_existing_content" as const,
  description: "Refresh existing content with editorial and SEO checks before publishing review.",
  steps: ["draft_content", "editorial_review", "seo_optimize"]
};
