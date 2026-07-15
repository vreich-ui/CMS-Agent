import { describe, expect, it } from "vitest";
import { getProject } from "../../../src/agent/projects/agentProfiles.js";
import { getAllowedSkills } from "../../../src/agent/skills/registry.js";
import type { ProjectProfile } from "../../../src/agent/runtime/types.js";

describe("skill registry filtering", () => {
  it("returns only project-allowed skills", () => {
    const project: ProjectProfile = { ...getProject("project-a"), allowedSkills: ["draft_content", "publish"] };

    expect(Object.keys(getAllowedSkills(project))).toEqual(["draft_content", "publish"]);
  });

  it("ignores unknown skill names consistently", () => {
    const project = { ...getProject("project-a"), allowedSkills: ["draft_content", "unknown_skill"] } as unknown as ProjectProfile;

    expect(Object.keys(getAllowedSkills(project))).toEqual(["draft_content"]);
  });
});
