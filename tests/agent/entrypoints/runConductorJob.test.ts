import { afterEach, describe, expect, it } from "vitest";
import { exitCodeFor, parseCliOptions, runConductorJob } from "../../../src/agent/entrypoints/runConductorJob.js";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("runConductorJob (Cloud Run job entrypoint)", () => {
  it("drives a full mock run to the publish-risk block without approval", async () => {
    const lines: string[] = [];
    const result = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "Draft this", log: (line) => lines.push(line) });

    expect(result.outcome).toBe("blocked");
    expect(result.run.status).toBe("blocked");
    expect(result.run.nodes.find((node) => node.nodeId === "publication_controller")?.status).toBe("blocked");
    expect(result.run.nodes.find((node) => node.nodeId === "learning_recorder")?.status).toBe("queued");
    expect(result.run.approvalsRequired.length).toBeGreaterThan(0);
    expect(result.run.nodes.filter((node) => node.status === "completed").length).toBeGreaterThanOrEqual(14);
    expect(exitCodeFor(result.outcome)).toBe(0);
    expect(lines.some((line) => line.includes("Approvals required"))).toBe(true);
  });

  it("completes the whole graph when approved", async () => {
    const result = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "Draft this", approved: true });

    expect(result.outcome).toBe("completed");
    expect(result.run.nodes.every((node) => node.status === "completed")).toBe(true);
    // One step per node plus the finalizing advance that flips the run to completed.
    expect(result.steps).toBe(result.run.nodes.length + 1);
    expect(exitCodeFor(result.outcome)).toBe(0);
  });

  it("resumes a blocked run to completion when approval is supplied", async () => {
    const first = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "Draft this" });
    expect(first.outcome).toBe("blocked");

    const resumed = await runConductorJob({ projectId: "dr-lurie", resumeRunId: first.run.runId, approved: true });
    expect(resumed.run.runId).toBe(first.run.runId);
    expect(resumed.outcome).toBe("completed");
    expect(resumed.run.nodes.every((node) => node.status === "completed")).toBe(true);
  });

  it("leaves a blocked run untouched when resumed without approval", async () => {
    const first = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "Draft this" });
    const resumed = await runConductorJob({ projectId: "dr-lurie", resumeRunId: first.run.runId });

    expect(resumed.outcome).toBe("blocked");
    expect(resumed.steps).toBe(0);
  });

  it("refuses openai mode without OPENAI_API_KEY before creating a run", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(runConductorJob({ projectId: "dr-lurie", executionMode: "openai" })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("refuses the blobs backend without explicit off-Netlify credentials", async () => {
    process.env.WORKSPACE_STORE = "blobs";
    delete process.env.NETLIFY_BLOBS_SITE_ID;
    delete process.env.NETLIFY_BLOBS_TOKEN;
    await expect(runConductorJob({ projectId: "dr-lurie" })).rejects.toThrow(/NETLIFY_BLOBS_SITE_ID/);
  });

  it("stops between nodes when the abort signal fires, leaving the run resumable", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", signal: controller.signal });

    expect(result.outcome).toBe("stopped");
    expect(result.steps).toBe(0);
    expect(result.run.status).toBe("queued");
    expect(exitCodeFor(result.outcome)).toBe(0);
  });
});

describe("parseCliOptions", () => {
  it("applies defaults (dr-lurie project, mock mode, no approval)", async () => {
    const options = await parseCliOptions([], {});
    expect(options).toMatchObject({ projectId: "dr-lurie", executionMode: "mock", approved: undefined, resumeRunId: undefined });
  });

  it("lets flags override environment values", async () => {
    const options = await parseCliOptions(
      ["--project", "other", "--mode", "mock", "--input", "{\"topic\":\"cli\"}", "--max-steps", "7", "--approved"],
      { PROJECT_ID: "env-project", EXECUTION_MODE: "openai", RUN_INPUT_JSON: "{\"topic\":\"env\"}", MAX_STEPS: "3" }
    );
    expect(options.projectId).toBe("other");
    expect(options.executionMode).toBe("mock");
    expect(options.input).toEqual({ topic: "cli" });
    expect(options.maxSteps).toBe(7);
    expect(options.approved).toBe(true);
  });

  it("reads environment configuration when no flags are given", async () => {
    const options = await parseCliOptions([], { PROJECT_ID: "env-project", EXECUTION_MODE: "openai", RUN_APPROVED: "true", RESUME_RUN_ID: "run_x" });
    expect(options).toMatchObject({ projectId: "env-project", executionMode: "openai", approved: true, resumeRunId: "run_x" });
  });

  it("rejects unknown modes and malformed JSON input", async () => {
    await expect(parseCliOptions(["--mode", "turbo"], {})).rejects.toThrow(/Unsupported --mode/);
    await expect(parseCliOptions(["--input", "{nope"], {})).rejects.toThrow(/valid JSON/);
    await expect(parseCliOptions(["--max-steps", "0"], {})).rejects.toThrow(/positive integer/);
  });
});
