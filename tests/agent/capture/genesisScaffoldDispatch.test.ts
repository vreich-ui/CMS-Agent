import { describe, expect, it, vi } from "vitest";
import {
  GENESIS_SCAFFOLD_GITHUB_TOKEN_ENV,
  advanceGenesisScaffold,
  genesisScaffoldConfig,
  scaffoldArtifactsDocument,
  scaffoldCorrelationId,
  tenantTreeProbePath,
  type GenesisScaffoldConfig
} from "../../../src/agent/capture/genesisScaffoldDispatch.js";

// G2 ACCEPTANCE — handing the scaffold to CI.
//
// The property every test here defends: THE REPOSITORY IS THE GROUND TRUTH, not the job. A mint is
// resumable, so the honest question at every step is "is this tenant's tree in the repo", and the
// job is only how it gets there. Getting that backwards produces the two failures that matter —
// dispatching a second job over a first, and reporting a tenant scaffolded because a job said so.

const CONFIG: GenesisScaffoldConfig = {
  token: "gh-token",
  repository: "vreich-ui/platform",
  workflow: "genesis-scaffold.yaml",
  ref: "main",
  apiBaseUrl: "https://api.github.test"
};

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const notFound = (): Response => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }) as unknown as Response;
const boom = (status: number): Response => ({ ok: false, status, json: async () => ({}), text: async () => "no" }) as unknown as Response;

/** A GitHub stub: `tree` decides the contents probe, `runs` the workflow-run list. */
const github = ({ tree = false, runs = [] as unknown[], artifacts = [] as unknown[], blob = undefined as unknown }) => {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
    if (url.includes("/contents/")) return tree ? ok({ type: "file", path: "x" }) : notFound();
    if (url.includes("/runs?")) return ok({ workflow_runs: runs });
    if (url.includes("/artifacts?")) return ok({ artifacts });
    if (url.includes("/git/blobs/")) return ok({ encoding: "base64", content: Buffer.from(JSON.stringify(blob ?? {})).toString("base64") });
    if (url.includes("/git/blobs")) return ok({ sha: "a".repeat(40) });
    if (url.includes("/dispatches")) return ({ ok: true, status: 204, json: async () => ({}), text: async () => "" }) as unknown as Response;
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { impl: impl as unknown as typeof fetch, calls };
};

const run = (config: GenesisScaffoldConfig, impl: typeof fetch, input = { slug: "acme" }) => advanceGenesisScaffold(config, input, { fetchImpl: impl });

describe("G2 — the repository is the ground truth", () => {
  it("adopts an existing tenant tree without dispatching anything", async () => {
    // The resumed-mint path, and also a tree scaffolded by hand or by an earlier PLATFORM_REPO_ROOT
    // run. All three are the same fact: the tenant's code is in the repo.
    const api = github({ tree: true });
    expect(await run(CONFIG, api.impl)).toEqual({ kind: "present" });
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    expect(api.calls[0].url).toContain(encodeURIComponent("main"));
    expect(api.calls[0].url).toContain("sites/acme/site.config.ts");
  });

  it("dispatches when there is no tree and no run, naming the slug in the run's own name", async () => {
    const api = github({});
    const step = await run(CONFIG, api.impl);
    expect(step.kind).toBe("dispatched");

    const dispatch = api.calls.find((call) => call.url.includes("/dispatches"))!;
    expect(dispatch.body).toMatchObject({ ref: "main", inputs: { slug: "acme", cms_run_id: scaffoldCorrelationId("acme") } });
  });

  it("NEVER dispatches a second job over one already running", async () => {
    // Two jobs for one tenant race on the root lockfile and on refs/heads/main. The first re-run of
    // a resumable mint is the likeliest moment for this to happen, which is why it is checked before
    // any dispatch rather than relied on from the workflow's concurrency group alone.
    const api = github({ runs: [{ id: 7, name: `genesis-scaffold acme ${scaffoldCorrelationId("acme")}`, status: "in_progress", conclusion: null }] });
    const step = await run(CONFIG, api.impl);

    expect(step.kind).toBe("running");
    expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(false);
  });

  it("treats a COMPLETED job whose tree is not yet visible as running, not as a reason to dispatch again", async () => {
    // The window between the commit landing and the contents API reflecting it. Dispatching here
    // would be a second job scaffolding a tenant that already exists.
    const api = github({ runs: [{ id: 9, name: scaffoldCorrelationId("acme"), status: "completed", conclusion: "success" }] });
    const step = await run(CONFIG, api.impl);

    expect(step.kind).toBe("running");
    expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(false);
  });

  it("does not mistake another tenant's run for this one", async () => {
    const api = github({ runs: [{ id: 3, name: scaffoldCorrelationId("acme-labs"), status: "in_progress", conclusion: null }] });
    expect((await run(CONFIG, api.impl)).kind).toBe("dispatched");
  });
});

describe("G2 — a failed job is reported, not retried forever", () => {
  it("carries create-site's machine-readable refusal back verbatim", async () => {
    // Without this a resumed mint re-dispatches against a policy refusal that will never resolve on
    // its own, and the operator sees "scaffold failed" with no named cause.
    const refusal = { error_code: "genesis_artifact_required", missing: ["editorialVoice"], ways_out: ["supply it", "lower the policy"] };
    const api = github({
      runs: [{ id: 11, name: scaffoldCorrelationId("acme"), status: "completed", conclusion: "failure" }],
      artifacts: [{ name: `genesis-scaffold-result-blob-${"b".repeat(40)}` }],
      blob: { status: "failed", refusal }
    });

    const step = await run(CONFIG, api.impl);
    expect(step.kind).toBe("failed");
    if (step.kind !== "failed") throw new Error("unreachable");
    expect(step.refusal).toEqual(refusal);
    expect(step.detail).toContain("genesis_artifact_required");
    expect(step.detail).toContain("Re-running site.duplicate will not fix it");
    expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(false);
  });

  it("still refuses to re-dispatch when the job published no result blob", async () => {
    // The named cause is lost (retention is 14 days), but the decision is not: the job RAN and
    // refused, so re-dispatching would repeat it.
    const api = github({ runs: [{ id: 12, name: scaffoldCorrelationId("acme"), status: "completed", conclusion: "failure" }] });
    const step = await run(CONFIG, api.impl);
    expect(step.kind).toBe("failed");
    expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(false);
  });

  it("RE-DISPATCHES a run that was cancelled or timed out, because nothing was decided", async () => {
    // The wedge this prevents: a queued run cancelled by a concurrency group has conclusion
    // "cancelled" forever. Read as a refusal it means "re-running will not fix it" AND no further
    // dispatch — so that tenant's mint can never complete, and re-running is in fact the only fix.
    for (const conclusion of ["cancelled", "timed_out", "stale", null]) {
      const api = github({ runs: [{ id: 13, name: scaffoldCorrelationId("acme"), status: "completed", conclusion }] });
      const step = await run(CONFIG, api.impl);
      expect(step.kind, `conclusion ${String(conclusion)} must be re-dispatched`).toBe("dispatched");
      expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(true);
    }
  });
});

describe("G2 — a stale success is not evidence", () => {
  const succeeded = (updatedAt: string) => github({ runs: [{ id: 21, name: scaffoldCorrelationId("acme"), status: "completed", conclusion: "success", updated_at: updatedAt }] });

  it("trusts a just-completed run whose tree the contents API has not caught up with", async () => {
    const api = succeeded("2026-09-16T12:00:00Z");
    const step = await advanceGenesisScaffold(CONFIG, { slug: "acme" }, { fetchImpl: api.impl, now: () => new Date("2026-09-16T12:00:30Z") });
    expect(step.kind).toBe("running");
    expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(false);
  });

  it("stops trusting it past the window, so a reverted scaffold or a reused slug can be re-scaffolded", async () => {
    // Unbounded, this state is permanent: a months-old successful run keeps answering "completed,
    // re-run to adopt it" for a tenant tree that is not there and never will be.
    const api = succeeded("2026-09-16T12:00:00Z");
    const step = await advanceGenesisScaffold(CONFIG, { slug: "acme" }, { fetchImpl: api.impl, now: () => new Date("2026-09-16T13:00:00Z") });
    expect(step.kind).toBe("dispatched");
    expect(api.calls.some((call) => call.url.includes("/dispatches"))).toBe(true);
  });
});

describe("G2 — degrading honestly", () => {
  it("surfaces a 404 on the DISPATCH rather than reporting a job that was never started", async () => {
    // POST /dispatches answers 404 when the workflow does not exist on the target ref — the state
    // during any rollout, and while the platform half of this change is unmerged. Treated as an
    // answer it reports "dispatched" on every re-run forever, with no error anywhere.
    const impl = vi.fn(async (url: string) => {
      if (String(url).includes("/contents/")) return notFound();
      if (String(url).includes("/runs?")) return ok({ workflow_runs: [] });
      return notFound();
    }) as unknown as typeof fetch;

    const step = await advanceGenesisScaffold(CONFIG, { slug: "acme" }, { fetchImpl: impl });
    expect(step.kind).toBe("unavailable");
    if (step.kind !== "unavailable") throw new Error("unreachable");
    expect(step.reason).toContain("404");
  });

  it("returns unavailable rather than throwing when GitHub is unreachable", async () => {
    // A mint that already has a Netlify site, a bearer and a registry record must not lose them
    // because one GitHub call failed. The scaffold falls back to the human step it has always been.
    const impl = vi.fn(async () => boom(500)) as unknown as typeof fetch;
    const step = await advanceGenesisScaffold(CONFIG, { slug: "acme" }, { fetchImpl: impl });
    expect(step.kind).toBe("unavailable");
  });

  it("has no config at all without a token, and never borrows the capture preview's", async () => {
    // That token needs only blob write; this one commits to main. Borrowing it would widen a blast
    // radius without anyone deciding to.
    expect(genesisScaffoldConfig({ CAPTURE_PREVIEW_GITHUB_TOKEN: "other" } as NodeJS.ProcessEnv)).toBeUndefined();
    const configured = genesisScaffoldConfig({ [GENESIS_SCAFFOLD_GITHUB_TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv)!;
    expect(configured).toMatchObject({ repository: "vreich-ui/platform", workflow: "genesis-scaffold.yaml", ref: "main" });
  });
});

describe("G2 — the artifacts document", () => {
  it("carries exactly the five genesis bodies, and nothing else from the mint input", async () => {
    // The document reaches a CI job that writes each body to a file. Anything else travelling in it
    // is input this driver never validated arriving on another system's disk.
    const document = scaffoldArtifactsDocument({
      editorialVoice: { name: "v" },
      logo: { svg: "<svg/>" },
      name: "acme",
      sourceUrl: "https://example.test",
      ownerEmail: "owner@example.test"
    })!;
    expect(Object.keys(document).sort()).toEqual(["editorialVoice", "logo"]);
  });

  it("is undefined when the mint supplied no artifacts, so no blob is written at all", async () => {
    expect(scaffoldArtifactsDocument({ name: "acme" })).toBeUndefined();
    const api = github({});
    await run(CONFIG, api.impl);
    expect(api.calls.some((call) => call.url.endsWith("/git/blobs"))).toBe(false);
  });

  it("writes the blob and passes its sha when artifacts were supplied", async () => {
    const api = github({});
    await advanceGenesisScaffold(CONFIG, { slug: "acme", artifacts: { editorialVoice: { name: "v" } } }, { fetchImpl: api.impl });
    const dispatch = api.calls.find((call) => call.url.includes("/dispatches"))!;
    expect((dispatch.body as { inputs: Record<string, unknown> }).inputs.artifacts_blob).toBe("a".repeat(40));
  });
});

describe("G2 — the correlation id cannot match a neighbouring tenant", () => {
  it("terminates the slug, so acme does not match acme-labs", () => {
    // Found by the test above before this was true. A run NAME match is a substring test, and every
    // fleet slug is a prefix of some longer slug somebody may mint later.
    expect(scaffoldCorrelationId("acme-labs").includes(scaffoldCorrelationId("acme"))).toBe(false);
    expect(scaffoldCorrelationId("acme")).toMatch(/#$/);
  });
});
