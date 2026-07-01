export const publishOnlyWorkflow = {
  id: "publish_only" as const,
  description: "Publish provided content through the configured publishing adapter.",
  steps: ["publish"]
};
