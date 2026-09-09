import { describe, expect, it } from "vitest";
import { getEditorialVoice } from "../../../src/agent/workspace/voicePrefetch.js";
import { getProjectHooks } from "../../../src/agent/projects/projectHooks.js";
import type { EditorialVoiceBody } from "../../../src/agent/projects/projectHooks.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// G6 — RECORD FIRST, HOOK SECOND.
//
// The fallback used to be reachable ONLY through a project's hook module, so only a tenant with code
// could have one and every genesis-minted tenant resolved to `{source: "unavailable"}` — five
// prefetch nodes and visual_identity_propose running with no voice at all. Moving it onto the record
// is what lets a data-defined tenant carry one; the risk of that move is regressing dr-lurie and
// fernwell, which is what the last test here exists to catch.

const voice = (name: string): EditorialVoiceBody => ({
  name,
  audience: "test readers",
  tone: ["plain"],
  cadence: "short",
  lexicon: { prefer: ["clear"], avoid: ["hype"] },
  claim_policy: "supported only",
  cta_policy: "at most one",
  reader_safety_notes: "none",
  frameworks: [{ framework_id: "f1", label: "F1", when_to_use: "always" }],
  default_framework: "f1"
});

const repositoryWith = (config?: ProjectConnectionConfig): ProjectRepository =>
  ({ get: async () => config } as unknown as ProjectRepository);

const config = (overrides: Partial<ProjectConnectionConfig>): ProjectConnectionConfig =>
  ({
    projectId: "acme",
    name: "acme",
    mcpEndpointEnvVar: "ACME_MCP_ENDPOINT",
    authMode: "bearer_env",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" },
    publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, operatorDefault: "approved", autonomyMode: "supervised" },
    status: "active",
    ...overrides
  }) as unknown as ProjectConnectionConfig;

const run = async (repository: ProjectRepository, projectId = "acme") =>
  getEditorialVoice({ projectId, runId: `run_${Math.random()}` } as never, { projectRepository: repository } as never);

describe("G6 — voicePrefetch resolves the record fallback", () => {
  it("uses the record's editorialVoiceFallback for a tenant with no hook module", async () => {
    const result = await run(repositoryWith(config({ editorialVoiceFallback: voice("acme — provisional") })));
    expect(result.source).toBe("fallback");
    expect(result.voice?.name).toBe("acme — provisional");
    // The warning code is what lets a consumer tell a guess from an authored voice.
    expect(result.warningCode).toBe("voice_object_unconfigured");
  });

  it("still reports unavailable when neither a record nor a hook fallback exists", async () => {
    const result = await run(repositoryWith(config({})));
    expect(result.source).toBe("unavailable");
    expect(result.voice).toBeUndefined();
  });

  it("leaves dr-lurie and fernwell resolving to the seeded voice in their hook modules", async () => {
    // The regression that matters: these two have carried a *_VOICE_FALLBACK constant since long
    // before the record field existed, and their records carry none.
    for (const projectId of ["dr-lurie", "fernwell"] as const) {
      const hookVoice = getProjectHooks(projectId)?.editorialVoiceFallback;
      expect(hookVoice, `${projectId} must still declare a hook fallback`).toBeDefined();
      const result = await run(repositoryWith(config({ projectId })), projectId);
      expect(result.source).toBe("fallback");
      expect(result.voice?.name).toBe(hookVoice!.name);
    }
  });

  it("prefers the record over the hook when a project somehow carries both", async () => {
    // A record is editable without a deploy; a hook constant is not. The editable one wins.
    const result = await run(repositoryWith(config({ projectId: "dr-lurie", editorialVoiceFallback: voice("record wins") })), "dr-lurie");
    expect(result.voice?.name).toBe("record wins");
  });
});
