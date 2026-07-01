import type { ProjectProfile, SkillId } from "../runtime/types.js";
import { draftContent } from "./contentDraft.js";
import { editorialReview } from "./editorialReview.js";
import { seoOptimize } from "./seo.js";
import { publishContent } from "./publish.js";

export const skillRegistry = {
  draft_content: draftContent,
  editorial_review: editorialReview,
  seo_optimize: seoOptimize,
  publish: publishContent
};

export function getAllowedSkills(project: ProjectProfile): Partial<typeof skillRegistry> {
  return Object.fromEntries(
    (Object.entries(skillRegistry) as Array<[SkillId, (typeof skillRegistry)[SkillId]]>)
      .filter(([id]) => project.allowedSkills.includes(id))
  ) as Partial<typeof skillRegistry>;
}
