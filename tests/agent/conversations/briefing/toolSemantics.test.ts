import { describe, expect, it } from "vitest";
import { classifyTool, condenseToolDescription, renderToolSemantics } from "../../../../src/agent/conversations/briefing/toolSemantics.js";
import type { ConversationTool } from "../../../../src/agent/conversations/conversationContract.js";

const tool = (name: string, description = "A tool."): ConversationTool => ({
  name,
  description,
  input_schema: {}
});

describe("toolSemantics — classification precedence and size discipline", () => {
  // deploy_status contains "publish"-adjacent nothing, but does contain a name that could be misread
  // as a status/monitoring tool crossed with publishing; the module header calls this out explicitly
  // as the ordering-dependent case: diagnostics must win because it is tested first.
  it("classifies deploy_status as diagnostics, never publish", () => {
    expect(classifyTool("deploy_status")).toBe("diagnostics");
  });

  // publish_pdf_template is about a template, which the artifact rule would also match — but publish
  // is tested first, so a tool that both publishes AND touches an artifact reads as a publish action.
  it("classifies publish_pdf_template as publish, never artifact", () => {
    expect(classifyTool("publish_pdf_template")).toBe("publish");
  });

  it("classifies object_patch as write", () => {
    expect(classifyTool("object_patch")).toBe("write");
  });

  it("classifies object_get as read", () => {
    expect(classifyTool("object_get")).toBe("read");
  });

  // A 16,000-character description (legal on the wire per conversationContract's own bound) must never
  // reach the briefing whole — the module's entire value is staying small.
  it("condenses a 16,000-character description to at most ~110 characters", () => {
    const huge = "x".repeat(16_000);
    const condensed = condenseToolDescription(huge);
    expect(condensed.length).toBeLessThanOrEqual(110);
    expect(condensed.endsWith("…")).toBe(true);
  });

  // A description with a real sentence break still yields just its first sentence, not the full 110
  // characters, when that sentence is short.
  it("condenses to the first sentence when one exists inside the budget", () => {
    expect(condenseToolDescription("Reads the object. Never writes anything.")).toBe("Reads the object.");
  });

  // Empty groups cost nothing: printing "Everything else: (none)" on every turn of every conversation
  // would spend tokens to teach the model nothing it can act on.
  it("omits a purpose group entirely when no tool on this turn's wire falls into it", () => {
    const rendered = renderToolSemantics([tool("object_get", "Reads an object.")]);
    expect(rendered).toContain("Read (free — never ask permission to look)");
    expect(rendered).not.toContain("Publish and release");
    expect(rendered).not.toContain("Make images, PDFs and templates");
    expect(rendered).not.toContain("Change a governed object");
    expect(rendered).not.toContain("Check whether something worked");
    expect(rendered).not.toContain("Everything else on this turn's wire");
  });

  // An empty tool list is a real, nameable state (no tools reached this turn), not an empty document.
  it("renders the 'no tools reached this turn' line for an empty tool list", () => {
    expect(renderToolSemantics([])).toBe("No tools reached this turn. Say so plainly rather than describing work you cannot do.");
  });

  // Multiple purposes present at once still separate cleanly, each under its own heading.
  it("groups a mixed tool list under each purpose's own heading", () => {
    const rendered = renderToolSemantics([
      tool("object_get", "Reads an object."),
      tool("object_patch", "Patches an object."),
      tool("object_publish", "Publishes an object."),
      tool("deploy_status", "Checks deploy status.")
    ]);
    expect(rendered).toContain("Read (free — never ask permission to look)");
    expect(rendered).toContain("Change a governed object");
    expect(rendered).toContain("Publish and release");
    expect(rendered).toContain("Check whether something worked");
  });
});
