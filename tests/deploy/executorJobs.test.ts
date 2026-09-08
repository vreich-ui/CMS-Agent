import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// deploy/executor-jobs.txt is the ONE list of Cloud Run jobs built from the mcp-service image, read
// by scripts/pin-job-images.sh and run by both release paths (C-10).
//
// The list going stale is not hypothetical — it is the incident. It used to live in a cloudbuild
// substitution only the trigger could see (`_EXECUTOR_JOBS: continuation-tick`), and the two jobs
// added later were never put in it, so the sync step passed green on every push while two of three
// live planes were never even considered. Both were found stale by hand on 2026-09-07:
// site-credential-reconciler had been re-narrowing all four tenants to an older allowlist and
// exiting 0, and tracking-ingest had been dropping the projectId stamp on everything it wrote.
//
// Moving the list into a file fixed WHERE it lives. Nothing yet checked that it stays TRUE. That is
// what this does: a job you can deploy but never pin is the same defect in a new spot.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

/** The list as pin-job-images.sh parses it: #-comments and blank lines out, names may share a line. */
const listedJobs = (): string[] =>
  read("deploy/executor-jobs.txt")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/\s+/));

/** Every deploy script that CREATES a Cloud Run job, and the job name it defaults to. */
const jobCreatingScripts = (): Array<{ file: string; job: string }> => {
  const dir = repoFile("scripts");
  return readdirSync(dir)
    .filter((name) => /^deploy-.*\.sh$/.test(name))
    .map((name) => ({ name, body: readFileSync(`${dir}/${name}`, "utf8") }))
    .filter(({ body }) => body.includes("gcloud run jobs create"))
    .map(({ name, body }) => {
      const match = /^JOB="\$\{JOB:-([a-z0-9-]+)\}"/m.exec(body);
      if (!match) throw new Error(`${name} creates a Cloud Run job but declares no JOB="\${JOB:-<name>}" default`);
      return { file: name, job: match[1]! };
    });
};

describe("deploy/executor-jobs.txt", () => {
  it("parses to a clean list with no duplicates", () => {
    const jobs = listedJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(new Set(jobs).size).toBe(jobs.length);
    for (const job of jobs) expect(job).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  // The direction that would have caught C-10. A job gains a deploy artifact the moment someone
  // wants to run it; being pinned is the step that gets forgotten, because nothing breaks when it is.
  it("lists every job any deploy script can create", () => {
    const listed = new Set(listedJobs());
    const missing = jobCreatingScripts().filter(({ job }) => !listed.has(job));
    expect(
      missing.map(({ file, job }) => `${file} creates "${job}", which is not in deploy/executor-jobs.txt`)
    ).toEqual([]);
  });

  it("still lists the three planes the 2026-09-07 audit found live", () => {
    const listed = new Set(listedJobs());
    for (const job of ["continuation-tick", "site-credential-reconciler", "tracking-ingest"]) {
      expect(listed.has(job)).toBe(true);
    }
  });

  // The reverse direction, now that it is true. Until 2026-09-08 `continuation-tick` -- the plane
  // with the largest blast radius, dispatching live content nodes every two minutes -- sat in this
  // list with NO deploy script. It was configured entirely by hand, so nothing in the repository
  // recorded its image, sizing, env or schedule, and the only way to know what it was was to ask
  // the live project. That was the outstanding half of S-14. Asserting the reverse is what stops it
  // recurring: a job may not be listed here without an artifact that says what it is.
  it("has a deploy script for every job in the list", () => {
    const scripted = new Set(jobCreatingScripts().map(({ job }) => job));
    const unscripted = listedJobs().filter((job) => !scripted.has(job));
    expect(
      unscripted.map((job) => `${job} is in deploy/executor-jobs.txt with no deploy script in scripts/`)
    ).toEqual([]);
  });

  it("has a schedule script for every job in the list", () => {
    // Cloud Scheduler fires every one of these planes, and the cadence is as much a part of a plane
    // as its env is. A schedule that exists only in the console is a plane nobody can reproduce.
    const dir = readdirSync(repoFile("scripts"));
    const missing = listedJobs().filter((job) => !dir.includes(`deploy-${job}-schedule.sh`));
    expect(missing.map((job) => `${job} has no deploy-${job}-schedule.sh`)).toEqual([]);
  });
});

describe("the W21 learning loop is deployable end to end", () => {
  // tracking-ingest COLLECTS, strategy-learning LEARNS from what it collected, strategy-review puts
  // what held up in front of a human. Shipping one without the others is what left the loop
  // half-built: the collector ran from 2026-09-06 with no consumer for two days.
  it("has a job script and a schedule script for all three W21 jobs", () => {
    const dir = readdirSync(repoFile("scripts"));
    for (const job of ["tracking-ingest", "strategy-learning", "strategy-review"]) {
      expect(dir).toContain(`deploy-${job}.sh`);
      expect(dir).toContain(`deploy-${job}-schedule.sh`);
    }
  });

  it("never pins a window on any of them", () => {
    // Each job defaults to its own trailing window. A fixed --from/--to would re-read one frozen
    // period forever — harmless for a pure reader, but strategy-learning WRITES observations (a
    // frozen day would inflate the consecutive-window streak that gates promotion) and
    // strategy-review opens a thread a human reads (a frozen week would be a weekly duplicate).
    for (const job of ["tracking-ingest", "strategy-learning", "strategy-review"]) {
      const body = read(`scripts/deploy-${job}.sh`);
      const code = body.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
      expect(code).not.toMatch(/TRACKING_INGEST_(FROM|TO)=/);
      expect(code).not.toMatch(/STRATEGY_(LEARNING|REVIEW)_(FROM|TO)=/);
    }
  });

  it("binds the sink token from Secret Manager and never as an env literal", () => {
    for (const job of ["tracking-ingest", "strategy-learning", "strategy-review"]) {
      const body = read(`scripts/deploy-${job}.sh`);
      expect(body).toContain("TRACKING_SINK_TOKEN=$TRACKING_SINK_TOKEN_SECRET:latest");
      const code = body.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
      // The token may only ever appear as a secret binding, never inside the --set/--update-env-vars list.
      expect(code).not.toMatch(/ENV_VARS=.*TRACKING_SINK_TOKEN=/);
    }
  });

  it("leaves the autopatch flag alone in the review job", () => {
    // Autonomous patching of the governed strategy object is an operator policy decision. Setting it
    // in a deploy script would be that decision made silently, in the wrong place.
    const body = read("scripts/deploy-strategy-review.sh");
    const code = body.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/STRATEGY_REVIEW_AUTOPATCH=/);
  });
});
