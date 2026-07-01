import { afterEach, describe, expect, it, vi } from "vitest";
import { getProject } from "../../../src/agent/projects/registry.js";
import { publishContent } from "../../../src/agent/skills/publish.js";

describe("publishContent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PROJECT_A_PUBLISH_ENDPOINT;
    delete process.env.PROJECT_A_PUBLISH_TOKEN;
  });

  it("does not mutate external systems when dryRun is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await publishContent({ title: "Title", content: "Body", dryRun: true }, getProject("project-a"));

    expect(result).toMatchObject({ dryRun: true, published: false, status: "dry_run" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires an environment-configured endpoint when dryRun is explicitly false", async () => {
    await expect(publishContent({ title: "Title", content: "Body", dryRun: false }, getProject("project-a"))).rejects.toThrow(
      "Publishing endpoint is not configured"
    );
  });

  it("uses environment-configured publishing target values when dryRun is explicitly false", async () => {
    process.env.PROJECT_A_PUBLISH_ENDPOINT = "https://cms.example.test/publish";
    process.env.PROJECT_A_PUBLISH_TOKEN = "test-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const result = await publishContent({ title: "Title", content: "Body", dryRun: false }, getProject("project-a"));

    expect(result).toMatchObject({ dryRun: false, published: true, status: "published", statusCode: 201 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://cms.example.test/publish",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-token" }),
        body: JSON.stringify({ title: "Title", content: "Body" })
      })
    );
  });
});
