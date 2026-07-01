import { describe, expect, it } from "vitest";
import { getProject, listProjects } from "../src/agent/projects/registry.js";
import { validateRequest } from "../src/agent/runtime/validateRequest.js";
import { normalizeMemoryEnvelope } from "../src/agent/memory/memoryEnvelope.js";
import { getAllowedSkills } from "../src/agent/skills/registry.js";
import { publishContent } from "../src/agent/skills/publish.js";

describe("project registry", () => {
  it("loads project-a", () => {
    expect(listProjects()).toHaveLength(1);
    expect(getProject("project-a").memoryNamespace).toBe("project-a");
  });
});

describe("request validation", () => {
  it("defaults requests to dry-run", () => {
    const request = validateRequest({ projectId: "project-a", input: "Draft a post" });
    expect(request.dryRun).toBe(true);
  });

  it("rejects empty input", () => {
    expect(() => validateRequest({ projectId: "project-a", input: "" })).toThrow();
  });
});

describe("memory envelope validation", () => {
  it("normalizes minimal memory", () => {
    const memory = normalizeMemoryEnvelope({ schemaVersion: "agent.memory.v1" }, { projectId: "project-a" });
    expect(memory.projectId).toBe("project-a");
    expect(memory.facts).toEqual([]);
    expect(memory.updatedAt).toBeTruthy();
  });
});

describe("skill registry filtering", () => {
  it("returns only project-allowed skills", () => {
    const project = { ...getProject("project-a"), allowedSkills: ["draft_content"] };
    expect(Object.keys(getAllowedSkills(project))).toEqual(["draft_content"]);
  });
});

describe("dry-run publishing behavior", () => {
  it("does not call configured publishing endpoint by default", async () => {
    const project = getProject("project-a");
    const result = await publishContent({ title: "T", content: "Body" }, project);
    expect(result).toMatchObject({ dryRun: true, published: false, status: "dry_run" });
  });
});
