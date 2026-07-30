import { describe, expect, it } from "vitest";
import { auditProjectObjectDialects, formatProjectDialectFindings } from "../../../src/agent/projects/projectDialectAudit.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import { platformProjectConfig } from "../../../src/agent/projects/platform/definition.js";
import { pdfToolProjectConfig } from "../../../src/agent/projects/pdfTool/definition.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// G3 (T-2 re-run, run_1785405350649_9u5mjz): platform drifted a full definitionVersion behind
// dr-lurie on the object-dialect parameters with no health surface reporting it. This is the audit
// that closes that gap — see BlobProjectRepository.health()/MemoryProjectRepository.health() for how
// it reaches an operator, and RepositoryManager.getRepositoryHealth() for why the project repository
// is now part of the aggregate at all (it never was before this fix).
describe("auditProjectObjectDialects (G3)", () => {
  it("reports nothing for dr-lurie and platform today — both carry a complete dialect", () => {
    expect(auditProjectObjectDialects([drLurieProjectConfig, platformProjectConfig])).toEqual([]);
  });

  it("does not flag pdf-tool — it has no executePublish hook, so it needs no dialect", () => {
    expect(auditProjectObjectDialects([pdfToolProjectConfig])).toEqual([]);
  });

  it("flags an active, publish-capable project with no objectDialect at all", () => {
    const stale: ProjectConnectionConfig = { ...structuredClone(platformProjectConfig), objectDialect: undefined };
    const findings = auditProjectObjectDialects([stale]);

    expect(findings).toEqual([{ projectId: "platform", missingFields: ["siteObjectId", "taxonomyRegistryObjectId", "objectIdSource", "defaultObjectType"] }]);
  });

  it("flags only the fields actually missing from a partially-configured dialect", () => {
    const partial: ProjectConnectionConfig = {
      ...structuredClone(platformProjectConfig),
      objectDialect: { siteObjectId: "site_platform", taxonomyRegistryObjectId: "tax_platform", objectIdSource: "server_minted" }
    };
    const findings = auditProjectObjectDialects([partial]);

    expect(findings).toEqual([{ projectId: "platform", missingFields: ["defaultObjectType"] }]);
  });

  it("does not flag a disabled project — an inactive config is not an operational problem", () => {
    const disabled: ProjectConnectionConfig = { ...structuredClone(platformProjectConfig), objectDialect: undefined, status: "disabled" };
    expect(auditProjectObjectDialects([disabled])).toEqual([]);
  });

  it("formats findings as human-readable, project-named strings", () => {
    const formatted = formatProjectDialectFindings([{ projectId: "platform", missingFields: ["siteObjectId", "defaultObjectType"] }]);
    expect(formatted).toEqual(["platform: missing objectDialect.siteObjectId, objectDialect.defaultObjectType"]);
  });
});
