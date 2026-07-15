import { describe, expect, it } from "vitest";
import { getProject, listProjects, ProjectNotFoundError } from "../../../src/agent/projects/agentProfiles.js";

describe("project registry", () => {
  it("resolves a known projectId", () => {
    const project = getProject("project-a");

    expect(project.projectId).toBe("project-a");
    expect(project.displayName).toBe("Project A");
    expect(listProjects()).toContain(project);
  });

  it("throws a typed error for an unknown projectId", () => {
    expect(() => getProject("missing-project")).toThrow(ProjectNotFoundError);

    try {
      getProject("missing-project");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectNotFoundError);
      expect((error as ProjectNotFoundError).code).toBe("PROJECT_NOT_FOUND");
    }
  });
});
