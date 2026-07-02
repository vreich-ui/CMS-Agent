import { afterEach, describe, expect, it, vi } from "vitest";
import { getProject } from "../../../src/agent/projects/registry.js";
import { publishContent } from "../../../src/agent/skills/publish.js";

describe("publishContent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not mutate external systems when dryRun is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await publishContent({ title: "Title", content: "Body", dryRun: true }, getProject("project-a"));

    expect(result).toMatchObject({ dryRun: true, published: false, status: "dry_run" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not mutate external systems when dryRun is explicitly false until project MCP publishing is implemented", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await publishContent({ title: "Title", content: "Body", dryRun: false }, getProject("project-a"));

    expect(result).toMatchObject({ dryRun: false, published: false, status: "project_mcp_publish_not_implemented" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
