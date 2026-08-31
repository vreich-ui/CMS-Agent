import { describe, expect, it } from "vitest";
import {
  EDITORIAL_SUBJECT_MISSING,
  checkEditorialSubject,
  declaresEditorialSubject,
  readEditorialSubject
} from "../../../src/agent/workspace/editorialSubject.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { startDryRun } from "../../../src/agent/workspace/executor.js";
import { WorkspaceToolError } from "../../../src/agent/workspace/workspaceErrors.js";

// W10 — the subject gate. run_1788207377621_behzkh started on taxonomy alone (a category and three
// tags), ran seventeen nodes, and ended in an empty article the publish gate correctly refused. This
// is the check that would have cost one clarifying question instead.

// The exact envelope that run was started with, as input_triage reported it: taxonomy, nothing else.
const TAXONOMY_ONLY = { category: "skincare", tags: ["sun protection", "guides", "skincare basics"] };

describe("readEditorialSubject — what counts as saying what the piece is about", () => {
  it("accepts a bare string input, the oldest calling convention in this codebase", () => {
    expect(readEditorialSubject("CA3 regression")).toBe("CA3 regression");
    expect(readEditorialSubject("   ")).toBeUndefined();
  });

  it("accepts any of the named subject fields", () => {
    expect(readEditorialSubject({ topic: "The two grams nobody applies" })).toBe("The two grams nobody applies");
    expect(readEditorialSubject({ title: "Barrier repair" })).toBe("Barrier repair");
    expect(readEditorialSubject({ readerQuestion: "Am I getting the SPF on the label?" })).toBe("Am I getting the SPF on the label?");
    expect(readEditorialSubject({ slug: "two-grams" })).toBe("two-grams");
  });

  it("accepts the content itself, which names a subject as surely as a title does", () => {
    expect(readEditorialSubject({ body: { nodes: [{ text: "..." }] } })).toBe("<body>");
    expect(readEditorialSubject({ sourceUrl: "https://example.com/a" })).toBe("<sourceUrl>");
  });

  it("rejects taxonomy alone — it says where a piece would file, not what it would say", () => {
    expect(readEditorialSubject(TAXONOMY_ONLY)).toBeUndefined();
    expect(declaresEditorialSubject(TAXONOMY_ONLY)).toBe(false);
  });

  it("rejects empty shapes that look populated", () => {
    expect(readEditorialSubject({})).toBeUndefined();
    expect(readEditorialSubject({ topic: "", body: {}, tags: [] })).toBeUndefined();
    expect(readEditorialSubject(undefined)).toBeUndefined();
    expect(readEditorialSubject(null)).toBeUndefined();
  });
});

describe("checkEditorialSubject — the gate", () => {
  it("refuses a live run that names no subject, and names the keys it was given", () => {
    const verdict = checkEditorialSubject({ input: TAXONOMY_ONLY, executionMode: "openai" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe(EDITORIAL_SUBJECT_MISSING);
    // The refusal has to be actionable by the agent that tripped it, so it names what was supplied
    // and what would have been accepted.
    expect(verdict.details.suppliedKeys).toEqual(["category", "tags"]);
    expect(verdict.message).toContain("ask for the topic and angle");
    expect(verdict.message).toContain("nothing was spent");
  });

  it("passes any run that says what it is about", () => {
    expect(checkEditorialSubject({ input: { topic: "The two grams nobody applies" }, executionMode: "openai" }).ok).toBe(true);
    expect(checkEditorialSubject({ input: "a bare string topic", executionMode: "openai" }).ok).toBe(true);
    // Taxonomy is fine ALONGSIDE a subject — the gate objects to taxonomy INSTEAD of one.
    expect(checkEditorialSubject({ input: { ...TAXONOMY_ONLY, topic: "SPF application" }, executionMode: "openai" }).ok).toBe(true);
  });

  it("exempts mock runs and late-stage entrypoint runs", () => {
    // Mock runs produce schema-shaped placeholders for CI traversal and cost nothing.
    expect(checkEditorialSubject({ input: TAXONOMY_ONLY, executionMode: "mock" }).ok).toBe(true);
    // A late-stage run seeds article_body with the finished object; the ideation nodes it would name
    // a topic for are seeded as skipped.
    expect(checkEditorialSubject({ input: TAXONOMY_ONLY, executionMode: "openai", entrypoint: "article_body" }).ok).toBe(true);
  });
});

describe("startDryRun — the gate is enforced before the run record exists", () => {
  const store = () => new RepositoryManager().getExecutionRepository();

  it("refuses to create a live run with no subject, so nothing can be spent on it", async () => {
    await expect(startDryRun({ projectId: "project-a", input: TAXONOMY_ONLY }, store())).rejects.toThrow(WorkspaceToolError);
    await expect(startDryRun({ projectId: "project-a", input: TAXONOMY_ONLY }, store())).rejects.toThrow(/does not say what the piece is about/);
  });

  it("leaves no run behind when it refuses", async () => {
    const execution = store();
    await expect(startDryRun({ projectId: "project-a", input: TAXONOMY_ONLY }, execution)).rejects.toThrow();
    expect(await execution.listRuns({ projectId: "project-a" })).toHaveLength(0);
  });

  it("still creates a run that names a subject", async () => {
    const run = await startDryRun({ projectId: "project-a", input: { topic: "The two grams nobody applies" }, executionMode: "mock" }, store());
    expect(run.runId).toMatch(/^run_/);
    expect(run.status).toBe("queued");
  });

  it("still creates a mock run from a bare string, which CI traversal depends on", async () => {
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "CA3 regression" }, store());
    expect(run.status).toBe("queued");
  });
});
