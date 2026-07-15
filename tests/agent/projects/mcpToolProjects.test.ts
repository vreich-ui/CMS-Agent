import { describe, expect, it } from "vitest";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { PDF_TOOL_SAFE_READ_ONLY_TOOLS, pdfToolProjectConfig } from "../../../src/agent/projects/pdfTool/definition.js";
import { SNOOCLE_SAFE_READ_ONLY_TOOLS, snoocleProjectConfig } from "../../../src/agent/projects/snoocle/definition.js";
import { MONETIZER_SAFE_READ_ONLY_TOOLS, monetizerProjectConfig } from "../../../src/agent/projects/monetizer/definition.js";
import { toProjectSummary } from "../../../src/agent/projects/projectRegistry.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

const cases = [
  { config: pdfToolProjectConfig, projectId: "pdf-tool", name: "PDF Tool", endpointEnvVar: "PDF_TOOL_MCP_ENDPOINT", tokenEnvVar: "PDF_TOOL_MCP_TOKEN", tools: PDF_TOOL_SAFE_READ_ONLY_TOOLS },
  { config: snoocleProjectConfig, projectId: "snoocle", name: "Snoocle", endpointEnvVar: "SNOOCLE_MCP_ENDPOINT", tokenEnvVar: "SNOOCLE_MCP_TOKEN", tools: SNOOCLE_SAFE_READ_ONLY_TOOLS },
  { config: monetizerProjectConfig, projectId: "monetizer", name: "Monetizer", endpointEnvVar: "MONETIZER_MCP_ENDPOINT", tokenEnvVar: "MONETIZER_MCP_TOKEN", tools: MONETIZER_SAFE_READ_ONLY_TOOLS }
] as const;

// Tools that must never be allow-listed by default — any mutating / publishing / registration verb.
const MUTATING_PREFIXES = ["create", "update", "delete", "publish", "import", "set", "save", "register", "ingest", "pause", "run", "trigger", "acquire", "normalize", "trim", "convert", "reconcile", "analyze_and_store"];

describe("MCP tool project defaults (pdf-tool, snoocle, monetizer)", () => {
  it("seeds all three MCP tool projects by default alongside dr-lurie", async () => {
    const repository = new MemoryProjectRepository();
    const ids = (await repository.list()).map((project) => project.projectId);

    expect(ids).toEqual(expect.arrayContaining(["dr-lurie", "pdf-tool", "snoocle", "monetizer"]));
  });

  for (const testCase of cases) {
    describe(testCase.projectId, () => {
      it("allow-lists exactly the exported safe read-only tools", () => {
        expect(testCase.config.allowedTools).toEqual([...testCase.tools]);
      });

      it("allow-lists only read-only tools (no mutating/publishing verbs)", () => {
        for (const tool of testCase.config.allowedTools) {
          expect(MUTATING_PREFIXES.some((prefix) => tool.startsWith(prefix))).toBe(false);
        }
      });

      it("keeps publishing disabled and uses bearer_env auth", () => {
        expect(testCase.config.authMode).toBe("bearer_env");
        expect(testCase.config.tokenEnvVar).toBe(testCase.tokenEnvVar);
        expect(testCase.config.publishingPolicy).toMatchObject({ publishEnabled: false, requiresExplicitPublish: true });
      });

      it("exposes only safe metadata — env var names and configured booleans, never the endpoint value or token", () => {
        const env = { [testCase.endpointEnvVar]: "https://secret.example/mcp", [testCase.tokenEnvVar]: "super-secret-token" } as unknown as NodeJS.ProcessEnv;
        const summary = toProjectSummary(testCase.config, env);
        const serialized = JSON.stringify(summary);

        expect(serialized).not.toContain("super-secret-token");
        expect(serialized).not.toContain("https://secret.example/mcp");
        expect(summary.connection).toEqual({
          endpointConfigured: true,
          tokenConfigured: true,
          mcpEndpointEnvVar: testCase.endpointEnvVar,
          tokenEnvVar: testCase.tokenEnvVar
        });
      });

      it("is seeded through the repository with a stable definition version", async () => {
        const repository = new MemoryProjectRepository();
        const seeded = (await repository.get(testCase.projectId)) as ProjectConnectionConfig;

        expect(seeded.name).toBe(testCase.name);
        expect(seeded.mcpEndpointEnvVar).toBe(testCase.endpointEnvVar);
        expect(seeded.definitionVersion).toBe(testCase.config.definitionVersion);
      });
    });
  }
});
