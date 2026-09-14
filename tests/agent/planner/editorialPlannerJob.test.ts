/**
 * Track C — the daily job's own decisions, before any tenant is planned for.
 *
 * Who is even considered, who is skipped and why, and the one condition that stops the whole run.
 * The plan itself is pinned elsewhere; what is pinned here is that a misconfigured tenant is named
 * rather than silently dropped, and that a stale image stops everything rather than commissioning.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import { plannerTenantLine, resolvePlannerCandidates, runEditorialPlannerJob } from "../../../src/agent/entrypoints/editorialPlannerJob.js";

const project = (over: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig =>
  ({
    projectId: "dr-lurie",
    name: "Dr Lurie",
    mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT",
    tokenEnvVar: "DR_LURIE_MCP_TOKEN",
    mcpEndpoint: "https://drluriescience.netlify.app/mcp",
    status: "active",
    objectDialect: { requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$" },
    ...over
  }) as unknown as ProjectConnectionConfig;

const ENV = { SERVICE_GIT_SHA: "3ec3395" } as NodeJS.ProcessEnv;

let projectRepository: MemoryProjectRepository;
beforeEach(() => {
  projectRepository = new MemoryProjectRepository();
});

describe("resolvePlannerCandidates", () => {
  it("considers an active, reachable content tenant", () => {
    const { candidates, skipped } = resolvePlannerCandidates([project()], { env: ENV });
    expect(candidates.map((entry) => entry.projectId)).toEqual(["dr-lurie"]);
    expect(skipped).toEqual([]);
  });

  it("never commissions for a paused tenant", () => {
    const { candidates, skipped } = resolvePlannerCandidates([project({ status: "paused" } as never)], { env: ENV });
    expect(candidates).toEqual([]);
    expect(skipped[0]!.reason).toContain("paused tenant");
  });

  it("skips an internal service project — there is no publication behind it", () => {
    const service = project({ projectId: "monetizer", objectDialect: undefined, mcpEndpoint: "https://monetizer.example/mcp" } as never);
    const { candidates, skipped } = resolvePlannerCandidates([service], { env: ENV });
    expect(candidates).toEqual([]);
    expect(skipped[0]!.reason).toContain("nothing marks it as a content tenant");
  });

  it("skips an unreachable tenant, naming the env var that would fix it", () => {
    const { skipped } = resolvePlannerCandidates([project({ mcpEndpoint: undefined } as never)], { env: {} as NodeJS.ProcessEnv });
    expect(skipped[0]!.reason).toContain("DR_LURIE_MCP_ENDPOINT");
  });

  it("sorts by project id so the printed list is stable run to run", () => {
    const { candidates } = resolvePlannerCandidates([project({ projectId: "zeta" }), project({ projectId: "alpha" })], { env: ENV });
    expect(candidates.map((entry) => entry.projectId)).toEqual(["alpha", "zeta"]);
  });

  it("honours --only", () => {
    const { candidates } = resolvePlannerCandidates([project({ projectId: "zeta" }), project({ projectId: "alpha" })], { env: ENV, only: "zeta" });
    expect(candidates.map((entry) => entry.projectId)).toEqual(["zeta"]);
  });
});

describe("the job's own gate", () => {
  it("REFUSES the whole run on a stale image, having considered no tenant at all", async () => {
    await projectRepository.save(project());
    const result = await runEditorialPlannerJob({}, { projectRepository, env: ENV, serviceGitSha: async () => "d478216" });
    expect(result.status).toBe("refused_stale_image");
    expect(result.tenants).toEqual([]);
    expect(result.startedRuns).toEqual([]);
  });

  it("continues when the comparison is unverified — a health probe that failed is not a stale build", async () => {
    await projectRepository.save(project());
    const result = await runEditorialPlannerJob({ dryRun: true }, { projectRepository, env: ENV, serviceGitSha: async () => null });
    expect(result.status).toBe("dry_run");
    expect(result.guard.state).toBe("unverified");
  });

  it("names a tenant whose strategy has no commissioning block rather than dropping it", async () => {
    await projectRepository.save(project());
    const result = await runEditorialPlannerJob({ dryRun: true }, { projectRepository, env: ENV, serviceGitSha: async () => "3ec3395" });
    expect(result.status).toBe("dry_run");
    // No tenant MCP is reachable from a unit test, so the strategy resolves to nothing — which is
    // exactly the shape of a tenant that has not opted in, and it must be REPORTED, not silent.
    expect(result.skipped.some((skip) => skip.projectId === "dr-lurie")).toBe(true);
    expect(result.startedRuns).toEqual([]);
  });
});

describe("plannerTenantLine", () => {
  it("puts the switch first, in a line a human can scan in a log pane", () => {
    expect(plannerTenantLine({ projectId: "dr-lurie", enabled: true, runsPerDay: 2, dailyBudgetUsd: 10 })).toBe(
      "dr-lurie  commissioning=enabled  runsPerDay=2  dailyBudgetUsd=10"
    );
    expect(plannerTenantLine({ projectId: "fernwell", enabled: false, runsPerDay: 1, dailyBudgetUsd: 10 })).toContain("DISABLED");
  });
});
