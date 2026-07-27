// Coverage for the two-plane drift detector (CHANGE-PLAN R-0). The detector is a CI script, but
// its comparison logic is the part that can be silently wrong — a diff that never reports a
// difference passes forever and protects nothing. These tests pin the comparison semantics, then
// run the real thing end-to-end so plane drift also fails `npm test`, not just the CI drift job.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  checkAliasParity,
  diffSurfaces,
  fingerprintTools,
  isClean,
  readPlaneSurfaces,
  surfaceHash,
  type Manifest,
  type ToolFingerprint
} from "../../../scripts/twoPlaneDrift.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const MANIFEST_PATH = fileURLToPath(new URL("../../../docs/mcp-tool-manifest.json", import.meta.url));

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.MCP_API_TOKEN = "two-plane-drift-detector-token";
  delete process.env.MCP_EXPOSED_TOOL_PREFIXES;
  resetRepositoryManager();
});
afterEach(() => {
  process.env = { ...savedEnv };
  resetRepositoryManager();
});

const tool = (name: string, description = "d", inputSchemaHash = "h"): ToolFingerprint => ({ name, description, inputSchemaHash });

describe("two-plane drift detector — comparison logic", () => {
  it("fingerprints tools by name, description, and schema shape, sorted by name", () => {
    const fingerprints = fingerprintTools([
      { name: "b_tool", description: "second", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
      { name: "a_tool", description: "first", inputSchema: { type: "object" } }
    ]);
    expect(fingerprints.map((entry) => entry.name)).toEqual(["a_tool", "b_tool"]);
    expect(fingerprints[0]).toMatchObject({ name: "a_tool", description: "first" });
    expect(fingerprints[0].inputSchemaHash).toHaveLength(16);
  });

  it("hashes schemas by meaning, not by key insertion order", () => {
    const [first] = fingerprintTools([{ name: "t", inputSchema: { a: 1, b: { c: 2, d: 3 } } }]);
    const [second] = fingerprintTools([{ name: "t", inputSchema: { b: { d: 3, c: 2 }, a: 1 } }]);
    expect(first.inputSchemaHash).toBe(second.inputSchemaHash);
  });

  it("reports an identical surface as clean", () => {
    const surface = [tool("a"), tool("b")];
    expect(isClean(diffSurfaces(surface, [...surface]))).toBe(true);
  });

  it("reports tools present on only one plane", () => {
    const diff = diffSurfaces([tool("shared"), tool("only_first")], [tool("shared"), tool("only_second")]);
    expect(diff.onlyInFirst).toEqual(["only_first"]);
    expect(diff.onlyInSecond).toEqual(["only_second"]);
    expect(isClean(diff)).toBe(false);
  });

  it("reports a description change on a tool that exists on both planes", () => {
    const diff = diffSurfaces([tool("shared", "old")], [tool("shared", "new")]);
    expect(diff.changed).toEqual([{ name: "shared", field: "description", first: "old", second: "new" }]);
    expect(isClean(diff)).toBe(false);
  });

  it("reports an input-schema change on a tool that exists on both planes", () => {
    const diff = diffSurfaces([tool("shared", "d", "hash-a")], [tool("shared", "d", "hash-b")]);
    expect(diff.changed).toEqual([{ name: "shared", field: "inputSchema", first: "hash-a", second: "hash-b" }]);
  });

  it("changes the surface hash when any tool changes", () => {
    expect(surfaceHash([tool("a")])).toBe(surfaceHash([tool("a")]));
    expect(surfaceHash([tool("a")])).not.toBe(surfaceHash([tool("a", "different")]));
  });
});

describe("two-plane drift detector — live planes", () => {
  it("serves a byte-identical tool surface on the netlify and cloud-run planes", async () => {
    const [netlify, cloudRun] = await readPlaneSurfaces();
    expect(netlify.plane).toBe("netlify");
    expect(cloudRun.plane).toBe("cloud-run");
    expect(netlify.tools.length).toBeGreaterThan(0);
    expect(diffSurfaces(netlify.tools, cloudRun.tools)).toEqual({ onlyInFirst: [], onlyInSecond: [], changed: [] });
  });

  it("matches the checked-in tool manifest", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
    const [netlify] = await readPlaneSurfaces();
    const diff = diffSurfaces(manifest.tools, netlify.tools);
    // A failure here means the wire contract moved. If that was intentional:
    //   npm run drift:update && git add docs/mcp-tool-manifest.json
    expect(diff).toEqual({ onlyInFirst: [], onlyInSecond: [], changed: [] });
    expect(manifest.surfaceHash).toBe(buildManifest(netlify.tools).surfaceHash);
    expect(manifest.toolCount).toBe(netlify.tools.length);
  });

  it("resolves every deprecated tool alias on both planes", async () => {
    expect(await checkAliasParity()).toEqual([]);
  });
});
