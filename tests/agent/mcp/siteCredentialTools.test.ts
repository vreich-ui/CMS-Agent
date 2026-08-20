import { beforeEach, describe, expect, it } from "vitest";
// The metadata token is cached module-side by secretManager's shared planeAccessToken, so a token
// minted by one test would otherwise satisfy the next and skip the handshake entirely.
import { __resetSecretCachesForTesting } from "../../../src/agent/projects/secretManager.js";
import { defaultProjectConfigs } from "../../../src/agent/projects/defaultMigration.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import {
  createSiteCredentialTools,
  DEFAULT_SITE_CREDENTIAL_RECONCILER_JOB,
  SITE_CREDENTIAL_RECONCILER_APPLY_ARGS,
  SITE_CREDENTIAL_RECONCILER_GCP_PROJECT_ENV,
  SITE_CREDENTIAL_RECONCILER_JOB_ENV,
  SITE_CREDENTIAL_RECONCILER_REGION_ENV,
  type CloudRunFetch,
  type CloudRunFetchResponse
} from "../../../src/agent/mcp/workspace/siteCredentialTools.js";

const SECRET_ACCESS_TOKEN = "ya29.SUPER-SECRET-ACCESS-TOKEN-value";

const projectRepository = (projects: Array<Record<string, unknown>>): ProjectRepository => {
  const records = projects as unknown as Awaited<ReturnType<ProjectRepository["list"]>>;
  return {
    list: async () => records,
    get: async (projectId: string) => records.find((project) => project.projectId === projectId),
    save: async (value) => value,
    delete: async () => false,
    health: async () => ({ readable: true, writable: true, backend: "memory", version: "memory.v1" })
  } as ProjectRepository;
};

const eligibleProject = () => {
  const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
  return { ...platform, authMode: "bearer_env" as const, clientSiteBinding: { netlifySiteName: "kugel-platform", netlifySiteId: "site_platform" } };
};

const jsonResponse = (status: number, body: unknown): CloudRunFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const REGION = "us-central1";
const PROJECT = "kugel-cms-agent";

const baseEnv = () => ({
  [SITE_CREDENTIAL_RECONCILER_GCP_PROJECT_ENV]: PROJECT,
  [SITE_CREDENTIAL_RECONCILER_REGION_ENV]: REGION
});

const EXECUTION_NAME = `projects/${PROJECT}/locations/${REGION}/jobs/${DEFAULT_SITE_CREDENTIAL_RECONCILER_JOB}/executions/site-credential-reconciler-abcde`;

// A fetch double that routes on URL, mirroring the metadata-token then Cloud-Run-REST call sequence
// every apply/status call makes. Kept as a factory so individual tests can override one leg.
const cloudRunFetch = (overrides: { run?: CloudRunFetch; status?: CloudRunFetch; tokenStatus?: number } = {}): CloudRunFetch =>
  (async (url, init) => {
    if (url.includes("/computeMetadata/v1/instance/service-account/default/token")) {
      if (overrides.tokenStatus && overrides.tokenStatus !== 200) return jsonResponse(overrides.tokenStatus, { error: "denied" });
      return jsonResponse(200, { access_token: SECRET_ACCESS_TOKEN, expires_in: 3600 });
    }
    if (url.endsWith(":run")) {
      if (overrides.run) return overrides.run(url, init);
      return jsonResponse(200, { name: `${url.split(":run")[0]}/operations/op-1`, metadata: { name: EXECUTION_NAME } });
    }
    if (overrides.status) return overrides.status(url, init);
    return jsonResponse(200, {});
  }) as CloudRunFetch;

beforeEach(() => __resetSecretCachesForTesting());

describe("site_credentials_plan", () => {
  it("reports a dry-run plan with staleCount from the reconciler's own results, without any network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("site_credentials_plan must never call fetch");
    }) as CloudRunFetch;
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([eligibleProject()]), env: baseEnv(), fetchImpl });
    const plan = tools.find((tool) => tool.name === "site_credentials_plan")!;
    const result = (await plan.execute({})) as { ok: true; data: { mode: string; results: unknown[]; staleCount: number } };
    expect(result.ok).toBe(true);
    expect(result.data.mode).toBe("dry_run");
    expect(result.data.results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "planned" }]);
    expect(result.data.staleCount).toBe(1);
  });

  it("reports staleCount 0 when there are no eligible tenants", async () => {
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv() });
    const plan = tools.find((tool) => tool.name === "site_credentials_plan")!;
    const result = (await plan.execute({})) as { ok: true; data: { results: unknown[]; staleCount: number } };
    expect(result.data.results).toEqual([]);
    expect(result.data.staleCount).toBe(0);
  });
});

describe("site_credentials_apply", () => {
  it("fires the Cloud Run Job and returns immediately with the execution name and job resource name", async () => {
    const fetchImpl = cloudRunFetch();
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    const result = (await apply.execute({})) as { ok: true; data: { executionName: string; jobName: string } };
    expect(result.ok).toBe(true);
    expect(result.data.executionName).toBe(EXECUTION_NAME);
    expect(result.data.jobName).toBe(`projects/${PROJECT}/locations/${REGION}/jobs/${DEFAULT_SITE_CREDENTIAL_RECONCILER_JOB}`);
  });

  it("uses the JOB env override instead of the default job name when set", async () => {
    let capturedRunUrl = "";
    const fetchImpl = cloudRunFetch({
      run: async (url) => {
        capturedRunUrl = url;
        return jsonResponse(200, { metadata: { name: EXECUTION_NAME } });
      }
    });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: { ...baseEnv(), [SITE_CREDENTIAL_RECONCILER_JOB_ENV]: "custom-reconciler-job" }, fetchImpl });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    await apply.execute({});
    expect(capturedRunUrl).toContain("/jobs/custom-reconciler-job:run");
  });

  it("sends the COMPLETE, correctly-ordered args override — Cloud Run replaces rather than merges the configured args", async () => {
    let capturedBody: unknown;
    const fetchImpl = cloudRunFetch({
      run: async (_url, init) => {
        capturedBody = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
        return jsonResponse(200, { metadata: { name: EXECUTION_NAME } });
      }
    });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    await apply.execute({});
    expect(capturedBody).toEqual({ overrides: { containerOverrides: [{ args: SITE_CREDENTIAL_RECONCILER_APPLY_ARGS }] } });
    // Pin the exact argv: dropping the entrypoint (leaving only "--apply") makes the job exec
    // `node` with no script — it exits 0 having rotated nothing, and nothing else catches that.
    expect(SITE_CREDENTIAL_RECONCILER_APPLY_ARGS).toEqual(["--import", "tsx", "src/agent/entrypoints/reconcileSiteCredentialsMain.ts", "--apply"]);
  });

  it("turns a 403 from Cloud Run into guidance naming the run.jobs.run IAM permission", async () => {
    const fetchImpl = cloudRunFetch({ run: async () => jsonResponse(403, { error: { code: 403, message: "Permission denied" } }) });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    await expect(apply.execute({})).rejects.toMatchObject({ code: "cloud_run_run_forbidden", message: expect.stringContaining("run.jobs.run") });
  });

  it("refuses with a catalogued code when the GCP project env var is missing", async () => {
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: { [SITE_CREDENTIAL_RECONCILER_REGION_ENV]: REGION } });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    await expect(apply.execute({})).rejects.toMatchObject({ code: "site_credential_reconciler_project_missing" });
  });

  it("refuses with a catalogued code when the region env var is missing", async () => {
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: { [SITE_CREDENTIAL_RECONCILER_GCP_PROJECT_ENV]: PROJECT } });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    await expect(apply.execute({})).rejects.toMatchObject({ code: "site_credential_reconciler_region_missing" });
  });

  it("never returns or throws the GCP access token", async () => {
    const fetchImpl = cloudRunFetch({ run: async () => jsonResponse(403, { error: { code: 403, message: "Permission denied" } }) });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const apply = tools.find((tool) => tool.name === "site_credentials_apply")!;
    try {
      await apply.execute({});
      throw new Error("expected a refusal");
    } catch (error) {
      expect(JSON.stringify(error instanceof Error ? { message: error.message } : error)).not.toContain(SECRET_ACCESS_TOKEN);
    }
    const okFetch = cloudRunFetch();
    const okTools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl: okFetch });
    const okResult = await okTools.find((tool) => tool.name === "site_credentials_apply")!.execute({});
    expect(JSON.stringify(okResult)).not.toContain(SECRET_ACCESS_TOKEN);
  });
});

describe("site_credentials_execution_status", () => {
  it("reports succeeded state with timestamps and counts", async () => {
    const fetchImpl = cloudRunFetch({
      status: async () => jsonResponse(200, {
        startTime: "2026-08-20T06:00:00Z",
        completionTime: "2026-08-20T06:03:12Z",
        succeededCount: 4,
        failedCount: 0,
        conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED" }]
      })
    });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const status = tools.find((tool) => tool.name === "site_credentials_execution_status")!;
    const result = (await status.execute({ executionName: EXECUTION_NAME })) as { ok: true; data: Record<string, unknown> };
    expect(result.data).toEqual({ state: "succeeded", startedAt: "2026-08-20T06:00:00Z", completedAt: "2026-08-20T06:03:12Z", succeededCount: 4, failedCount: 0 });
  });

  it("reports running state for an execution still in flight (no Completed condition, no completionTime)", async () => {
    const fetchImpl = cloudRunFetch({ status: async () => jsonResponse(200, { startTime: "2026-08-20T06:00:00Z" }) });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const status = tools.find((tool) => tool.name === "site_credentials_execution_status")!;
    const result = (await status.execute({ executionName: EXECUTION_NAME })) as { ok: true; data: Record<string, unknown> };
    expect(result.data.state).toBe("running");
  });

  it("refuses a malformed executionName without calling fetch at all", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not call fetch for an invalid executionName");
    }) as CloudRunFetch;
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const status = tools.find((tool) => tool.name === "site_credentials_execution_status")!;
    await expect(status.execute({ executionName: "not-a-resource-name" })).rejects.toMatchObject({ code: "execution_name_invalid" });
  });

  it("never returns the GCP access token", async () => {
    const fetchImpl = cloudRunFetch({ status: async () => jsonResponse(200, { startTime: "2026-08-20T06:00:00Z" }) });
    const tools = createSiteCredentialTools({ projectRepository: projectRepository([]), env: baseEnv(), fetchImpl });
    const status = tools.find((tool) => tool.name === "site_credentials_execution_status")!;
    const result = await status.execute({ executionName: EXECUTION_NAME });
    expect(JSON.stringify(result)).not.toContain(SECRET_ACCESS_TOKEN);
  });
});
