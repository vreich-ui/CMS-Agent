import { describe, expect, it } from "vitest";
import { describeCapabilities, summarizeCapabilities } from "../../ui/src/capabilities.js";

const toolList = (names: string[]) => ({ tools: names.map((name) => ({ name })) });

const PLATFORM_SCOPED = ["agent_resolve", "agent_converse"];

describe("connection capability report", () => {
  it("returns nothing when tools were never listed", () => {
    expect(summarizeCapabilities(null)).toBeNull();
    expect(summarizeCapabilities({} as never)).toBeNull();
    expect(describeCapabilities(null)).toBe("");
  });

  it("reads a platform-shaped scoped token as scoped, with only the chat surface available", () => {
    const report = summarizeCapabilities(toolList(PLATFORM_SCOPED))!;
    expect(report.scoped).toBe(true);
    expect(report.toolCount).toBe(2);
    const byId = Object.fromEntries(report.areas.map((area) => [area.id, area]));
    expect(byId.conversations.available).toBe(true);
    expect(byId.agents.available).toBe(false);
    expect(byId.workspace.available).toBe(false);
    // Naming what is missing is the point: "Unknown tool" on an unrelated page is unactionable.
    expect(byId.agents.missing).toEqual(["agent_list", "agent_update"]);
  });

  it("requires every tool of an area, not just one", () => {
    const partial = summarizeCapabilities(toolList(["agent_list"]))!;
    expect(partial.areas.find((area) => area.id === "agents")!.available).toBe(false);
    const full = summarizeCapabilities(toolList(["agent_list", "agent_update"]))!;
    expect(full.areas.find((area) => area.id === "agents")!.available).toBe(true);
  });

  it("reads the full catalogue as unscoped rather than a narrow token", () => {
    const everything = summarizeCapabilities(toolList(Array.from({ length: 140 }, (_, index) => `tool_${index}`)))!;
    expect(everything.scoped).toBe(false);
    expect(describeCapabilities(everything)).toMatch(/full workspace access/i);
  });

  it("describes a scoped token in one sentence naming what it covers", () => {
    const report = summarizeCapabilities(toolList(PLATFORM_SCOPED))!;
    expect(describeCapabilities(report)).toBe("Scoped token — 2 tools covering client editor chat.");
  });

  it("says so plainly when a scoped token covers none of the known surfaces", () => {
    const report = summarizeCapabilities(toolList(["usage_record"]))!;
    expect(describeCapabilities(report)).toMatch(/none of the main surfaces/i);
  });

  it("counts a tool list of zero as unscoped-unknown rather than claiming a narrow token", () => {
    const empty = summarizeCapabilities(toolList([]))!;
    expect(empty.toolCount).toBe(0);
    expect(empty.scoped).toBe(false);
  });
});
