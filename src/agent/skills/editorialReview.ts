import { z } from "zod";
import type { ProjectProfile } from "../runtime/types.js";

export const editorialReviewParamsSchema = z.object({ content: z.string().min(1) });

export function editorialReview(params: z.infer<typeof editorialReviewParamsSchema>, project: ProjectProfile) {
  const { content } = editorialReviewParamsSchema.parse(params);
  return {
    passed: project.editorialRules.every((rule) => rule.length > 0) && content.trim().length > 0,
    rulesChecked: project.editorialRules,
    notes: ["Automated scaffold review only; route final copy through human review before publishing."]
  };
}
