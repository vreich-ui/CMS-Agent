import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { citedTools, coreObjects, engineObject, engineObjects } from "../../ui/src/objectModel.js";

// The object descriptions make concrete, checkable claims about the engine — chiefly which MCP tools
// operate on each object. A confidently wrong sentence in front of an operator is worse than no
// sentence, and prose rots silently, so the checkable claims are checked here.
//
// docs/mcp-tool-manifest.json is the checked-in wire surface (locked by npm run test:drift), which
// makes it the right authority: if a tool is renamed or removed, the object description citing it
// fails CI in the same commit.

const manifest = JSON.parse(readFileSync(join(process.cwd(), "docs/mcp-tool-manifest.json"), "utf8")) as {
  tools: Array<{ name: string }>;
  aliases: Record<string, string>;
};

const servedTools = new Set(manifest.tools.map((tool) => tool.name));

describe("engine object model — correspondence with the tool manifest", () => {
  it("cites only tools the engine actually serves", () => {
    const unknown = citedTools().filter((tool) => !servedTools.has(tool));
    expect(unknown, `these tool names are not in docs/mcp-tool-manifest.json: ${unknown.join(", ")}`).toEqual([]);
  });

  it("cites tools in the underscore wire form, which is what a reader will see", () => {
    // Internally tools are dotted (`workspace.get_nodes`); the wire serves underscores because the
    // Messages API rejects dots. The docs should match what an operator or an agent actually sends.
    for (const tool of citedTools()) {
      expect(tool, `${tool} should be the wire form`).not.toContain(".");
    }
  });

  it("does not cite a deprecated alias in place of its canonical tool", () => {
    const deprecated = new Set(Object.keys(manifest.aliases).map((alias) => alias.replace(/\./g, "_")));
    const cited = citedTools().filter((tool) => deprecated.has(tool));
    expect(cited, `deprecated aliases cited: ${cited.join(", ")}`).toEqual([]);
  });
});

describe("engine object model — content", () => {
  it("describes every object with all of its required prose", () => {
    for (const object of engineObjects) {
      expect(object.id, "id slug").toMatch(/^[a-z][a-z0-9_]*$/);
      for (const field of ["name", "typeName", "summary", "purpose", "identity", "lifecycle", "relations", "whereSeen"] as const) {
        expect(object[field].length, `${object.id}.${field} present`).toBeGreaterThan(0);
      }
      // Each of these is a real explanation, not a placeholder. A summary that is three words means
      // someone stubbed the entry and moved on.
      expect(object.summary.split(/\s+/).length, `${object.id}.summary substance`).toBeGreaterThan(8);
      expect(object.purpose.split(/\s+/).length, `${object.id}.purpose substance`).toBeGreaterThan(10);
      expect(object.tools.length, `${object.id}.tools`).toBeGreaterThan(0);
    }
  });

  it("gives every object a unique id and name", () => {
    expect(new Set(engineObjects.map((object) => object.id)).size).toBe(engineObjects.length);
    expect(new Set(engineObjects.map((object) => object.name)).size).toBe(engineObjects.length);
  });

  it("covers the objects an operator meets in the interface", () => {
    // If a core object is dropped, a UI surface loses its description silently.
    const ids = coreObjects().map((object) => object.id).sort();
    expect(ids).toEqual([
      "artifact",
      "change_event",
      "learning_observation",
      "node",
      "project",
      "relationship",
      "run",
      "skill",
      "stage_output",
      "tool",
      "workspace"
    ]);
  });

  it("records the traps that actually cost people time", () => {
    // Each of these was a real, expensive misunderstanding. They are the highest-value sentences in
    // the file, so their presence is asserted rather than trusted.
    expect(engineObject("workspace")?.caution).toMatch(/THREE version concepts/);
    expect(engineObject("node")?.caution).toMatch(/CEILING/);
    expect(engineObject("skill")?.caution).toMatch(/APPENDS/);
    expect(engineObject("project")?.caution).toMatch(/toolPolicies/);
    expect(engineObject("run")?.caution).toMatch(/blocked.+failed|failed.+blocked/);
    expect(engineObject("artifact")?.caution).toMatch(/ArtifactReference` is NOT an engine type/);
  });

  it("names the improvement objects rather than omitting them", () => {
    // Silence would imply the object model stops at the publishing pipeline.
    const improvement = engineObjects.filter((object) => object.tier === "improvement");
    expect(improvement).toHaveLength(1);
    expect(improvement[0].whereSeen).toMatch(/[Nn]ot yet surfaced/);
  });

  it("is honest that a described object has no UI surface yet", () => {
    // whereSeen must never claim a screen that does not exist. The improvement tier says so out loud;
    // every core object must point at something real.
    for (const object of coreObjects()) {
      expect(object.whereSeen, `${object.id}.whereSeen`).not.toMatch(/not yet|coming|planned/i);
    }
  });
});
