import { describe, expect, it } from "vitest";
import { createSiteDuplicationTools } from "../../../src/agent/mcp/workspace/siteDuplicationTools.js";

// The gap this pins: `niche`, `audience` and `ownerEmail` are all declared on SiteGenesisInput and
// all were unreachable through site.duplicate — the ONLY surface that runs genesis. A field a caller
// cannot supply is a field the feature does not have, so `genesisHouseBrief` silently never had a
// brief (the house visual standard asked a human for one on every birth) and the G6 editorial-voice
// fallback could never be written at all.
//
// This asserts the WIRE schema, deliberately. Unit tests that call runSiteGenesis directly pass these
// inputs happily and prove nothing about whether any caller can actually send them — which is exactly
// how the gap survived a full green suite.
const duplicateTool = () => {
  const tools = createSiteDuplicationTools({} as never);
  const tool = tools.find((entry) => entry.name === "site.duplicate");
  expect(tool, "site.duplicate must be registered").toBeDefined();
  return tool!;
};

const newSite = () => {
  const schema = duplicateTool().inputSchema as unknown as {
    properties: { newSite: { properties: Record<string, { format?: string }>; required: string[] } };
  };
  return schema.properties.newSite;
};

describe("site.duplicate exposes every genesis input", () => {
  it("accepts niche, audience and ownerEmail on newSite", () => {
    const props = newSite().properties;
    for (const field of ["name", "netlifySiteName", "mcpEndpoint", "niche", "audience", "ownerEmail"]) {
      expect(props[field], `newSite.${field} must be reachable through the wire schema`).toBeDefined();
    }
  });

  it("keeps name the only required field, so nothing here is breaking", () => {
    expect(newSite().required).toEqual(["name"]);
  });

  it("validates ownerEmail as an email rather than accepting any string", () => {
    expect(newSite().properties.ownerEmail?.format).toBe("email");
  });

  it("rejects an unknown newSite field, so the zod and JSON schemas cannot drift apart", () => {
    const tool = duplicateTool();
    const parsed = tool.zodSchema.safeParse({
      sourceUrl: "https://example.test/",
      newSite: { name: "acme", niche: "n", audience: "a", ownerEmail: "o@example.test", surprise: 1 }
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a well-formed call carrying all three", () => {
    const parsed = duplicateTool().zodSchema.safeParse({
      sourceUrl: "https://example.test/",
      newSite: {
        name: "acme",
        niche: "independent film preservation",
        audience: "archivists and festival programmers",
        ownerEmail: "owner@example.test"
      }
    });
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
  });
});
