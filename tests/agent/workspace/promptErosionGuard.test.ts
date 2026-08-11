import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../../scripts/seedNodesFromWorkspace.ts", import.meta.url));

const snapshotWith = async (mutate: (nodes: any[]) => void): Promise<string> => {
  const nodes = JSON.parse(JSON.stringify(listWorkspaceNodes()));
  mutate(nodes);
  const dir = await mkdtemp(join(tmpdir(), "seed-guard-"));
  const path = join(dir, "snapshot.json");
  await writeFile(path, JSON.stringify({ nodes }), "utf8");
  return path;
};

// Never --write: these assert the refusal, and a pass must not touch the repo's nodes.ts.
const seed = async (snapshot: string, extra: string[] = []) => {
  try {
    const { stdout } = await run("npx", ["tsx", SCRIPT, "--from", snapshot, ...extra]);
    return { code: 0, out: stdout, err: "" };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: failure.stdout ?? "", err: failure.stderr ?? "" };
  }
};

describe("re-seed prompt erosion guard", () => {
  // The 2026-08-10 incident, reproduced at its real magnitude: article_body 7271 -> 2473 (-66%).
  it("refuses a two-thirds prompt cut and names the node", async () => {
    const snapshot = await snapshotWith((nodes) => {
      const node = nodes.find((candidate: any) => candidate.id === "article_body");
      node.prompt = node.prompt.slice(0, Math.floor(node.prompt.length * 0.34));
    });
    const result = await seed(snapshot);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/article_body: prompt would shrink/);
    expect(result.err).toMatch(/-6[0-9]%/);
    expect(result.err).toMatch(/nodes\.ts was NOT written/);
  }, 60_000);

  it("allows an ordinary tightening pass well inside the ceiling", async () => {
    const snapshot = await snapshotWith((nodes) => {
      const node = nodes.find((candidate: any) => candidate.id === "article_body");
      node.prompt = node.prompt.slice(0, Math.floor(node.prompt.length * 0.9));
    });
    const result = await seed(snapshot);
    expect(result.err).not.toMatch(/prompt would shrink/);
  }, 60_000);

  it("lets an operator confirm a deliberate cut, and says so in the output", async () => {
    const snapshot = await snapshotWith((nodes) => {
      const node = nodes.find((candidate: any) => candidate.id === "article_body");
      node.prompt = node.prompt.slice(0, 200);
    });
    const result = await seed(snapshot, ["--allow-prompt-shrink"]);
    expect(result.err).not.toMatch(/prompt would shrink/);
    expect(result.out).toMatch(/prompt guard\s+DISABLED/);
  }, 60_000);

  it("refuses to drop a canonicalRule", async () => {
    const snapshot = await snapshotWith((nodes) => {
      const node = nodes.find((candidate: any) => (candidate.metadata?.canonicalRules ?? []).length > 0);
      node.metadata.canonicalRules = node.metadata.canonicalRules.slice(1);
    });
    const result = await seed(snapshot);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/would drop 1 canonicalRule/);
  }, 60_000);

  // Gate regression is reported, never blocked: adopting live is the script's purpose. The point is
  // that an eleven-day silent divergence becomes a line in the run output.
  it("reports a status divergence instead of hiding it", async () => {
    const snapshot = await snapshotWith((nodes) => {
      const node = nodes.find((candidate: any) => candidate.id === "publish_executor");
      node.status = node.status === "draft" ? "active" : "draft";
    });
    const result = await seed(snapshot);
    // Direction-agnostic on purpose: the canonical status is itself a thing that changes, and a test
    // that pins it is how the 2026-07-31 go-live stayed invisible in code for eleven days.
    expect(result.out).toMatch(/divergence\s+publish_executor: status (draft -> active|active -> draft)/);
    expect(result.err).not.toMatch(/Refusing to re-seed/); // a divergence is reported, never a refusal
  }, 60_000);
});
