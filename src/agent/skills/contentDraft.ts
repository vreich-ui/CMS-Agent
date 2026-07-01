import { z } from "zod";
import type { ProjectProfile } from "../runtime/types.js";

export const draftContentParamsSchema = z.object({ input: z.string().min(1) });

export function draftContent(params: z.infer<typeof draftContentParamsSchema>, project: ProjectProfile) {
  const { input } = draftContentParamsSchema.parse(params);
  return {
    title: input.length > 72 ? `${input.slice(0, 69)}...` : input,
    content: `# ${input}\n\nAudience: ${project.audience}\n\n${project.brandVoice}\n\n## Draft\n\nCreate useful, specific content for this request: ${input}`,
    status: "draft_ready" as const
  };
}
