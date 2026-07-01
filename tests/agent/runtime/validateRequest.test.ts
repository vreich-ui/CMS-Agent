import { describe, expect, it } from "vitest";
import { validateRequest } from "../../../src/agent/runtime/validateRequest.js";

describe("validateRequest", () => {
  it("parses valid requests", () => {
    expect(validateRequest({ projectId: "project-a", input: "Write a post", dryRun: false })).toMatchObject({
      projectId: "project-a",
      input: "Write a post",
      dryRun: false
    });
  });

  it("fails when projectId is missing", () => {
    expect(() => validateRequest({ input: "Write a post" })).toThrow();
  });

  it("fails when input is missing", () => {
    expect(() => validateRequest({ projectId: "project-a" })).toThrow();
  });

  it("defaults dryRun to true", () => {
    expect(validateRequest({ projectId: "project-a", input: "Write a post" }).dryRun).toBe(true);
  });
});
