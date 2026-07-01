import { z } from "zod";

export const seoParamsSchema = z.object({ content: z.string().min(1), keyword: z.string().optional() });

export function seoOptimize(params: z.infer<typeof seoParamsSchema>) {
  const { content, keyword } = seoParamsSchema.parse(params);
  return {
    keyword: keyword ?? null,
    metaTitle: content.split("\n")[0]?.replace(/^#\s*/, "").slice(0, 60) ?? "Untitled",
    recommendations: ["Use descriptive headings.", "Add internal links where relevant.", "Include a concise meta description."]
  };
}
