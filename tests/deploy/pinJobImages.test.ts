import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// scripts/pin-job-images.sh is the only unattended thing that looks at the executor planes — the
// daily `cloud-run-plane.yml` run is `--check` and nothing else. Until 2026-09-08 it inspected only
// jobs that already EXISTED and recorded an absent one as a note, so `strategy-learning` and
// `strategy-review` sat unbuilt from the day their deploy scripts merged (#280) while this check
// went green every morning. K-O3.
//
// It now reconciles the list against the project in BOTH directions. The second direction — a job
// running this image that is not in the list — is the 2026-09-07 incident from the other side, and
// nothing reported it before.
//
// The script is bash, so grepping it proves nothing about what it does. These run it, against a
// `gcloud` stub on PATH that answers the shapes the script asks for. Nothing here touches a real
// project.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const DIGEST = "us-central1-docker.pkg.dev/test-project/cms-agent/mcp-service@sha256:1111111111111111111111111111111111111111111111111111111111111111";

const workspace = mkdtempSync(join(tmpdir(), "pin-job-images-"));
const stubDirectory = join(workspace, "bin");
execFileSync("mkdir", ["-p", stubDirectory]);

// Answers only what the script actually asks: the service's latest ready revision, that revision's
// image digest, which jobs the project has, whether one exists, and its image.
//
// An absent job answers the way gcloud really does — "Cannot find job [x]." on stderr — because the
// script now tells that apart from a permission failure, and a stub that exits 1 in silence would
// let a regression in that distinction pass.
writeFileSync(join(stubDirectory, "gcloud"), `#!/usr/bin/env bash
case "$1 $2 $3" in
  "run services describe") echo "rev-1"; exit 0 ;;
  "run revisions describe")
    for arg in "$@"; do case "$arg" in *imageDigest*) echo "${DIGEST}"; exit 0 ;; esac; done
    exit 0 ;;
  "run jobs list")
    for name in $STUB_PROJECT_JOBS; do echo "$name"; done
    exit 0 ;;
  "run jobs describe")
    job="$4"
    if [ -n "$STUB_DENY_JOB" ] && [ "$job" = "$STUB_DENY_JOB" ]; then
      echo "ERROR: (gcloud.run.jobs.describe) PERMISSION_DENIED: Permission denied on resource project test-project." >&2
      exit 1
    fi
    case " $STUB_EXISTING_JOBS " in
      *" $job "*) ;;
      *) echo "ERROR: (gcloud.run.jobs.describe) Cannot find job [$job]." >&2; exit 1 ;;
    esac
    case " $STUB_OTHER_REPO_JOBS " in
      *" $job "*)
        for arg in "$@"; do case "$arg" in *containers*image*) echo "us-central1-docker.pkg.dev/test-project/other/side-car:v3"; exit 0 ;; esac; done
        exit 0 ;;
    esac
    for arg in "$@"; do case "$arg" in *containers*image*) echo "${DIGEST}"; exit 0 ;; esac; done
    exit 0 ;;
  "run jobs update") echo "update $4" >> "$STUB_UPDATE_LOG"; exit 0 ;;
esac
exit 0
`);
chmodSync(join(stubDirectory, "gcloud"), 0o755);

const jobsFile = join(workspace, "executor-jobs.txt");
writeFileSync(jobsFile, "# three planes\ncontinuation-tick\ntracking-ingest\nstrategy-learning\n");

type Options = { projectJobs?: string; otherRepoJobs?: string; denyJob?: string };

const run = (existingJobs: string, mode: "--check" | "pin", options: Options = {}): { status: number; output: string } => {
  try {
    const output = execFileSync("bash", [repoFile("scripts/pin-job-images.sh"), ...(mode === "--check" ? ["--check"] : [])], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDirectory}:${process.env.PATH ?? ""}`,
        PROJECT: "test-project",
        REGION: "us-central1",
        EXECUTOR_JOBS_FILE: jobsFile,
        STUB_EXISTING_JOBS: existingJobs,
        // The project holds what exists unless a test says otherwise.
        STUB_PROJECT_JOBS: options.projectJobs ?? existingJobs,
        STUB_OTHER_REPO_JOBS: options.otherRepoJobs ?? "",
        STUB_DENY_JOB: options.denyJob ?? "",
        STUB_UPDATE_LOG: join(workspace, "updates.log"),
      },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

afterAll(() => execFileSync("rm", ["-rf", workspace]));

describe("scripts/pin-job-images.sh --check", () => {
  it("passes when every listed plane exists and runs the served artifact", () => {
    const { status, output } = run("continuation-tick tracking-ingest strategy-learning", "--check");
    expect(output).toContain("✓ every executor plane runs the artifact");
    expect(status).toBe(0);
  });

  it("FAILS when a listed plane does not exist, and says how to create it", () => {
    // The direction that would have caught K-O3 on the morning after #280 merged rather than two
    // days later, by hand.
    const { status, output } = run("continuation-tick tracking-ingest", "--check");
    expect(output).toContain("ABSENT   strategy-learning");
    expect(output).toContain("bash scripts/deploy-strategy-learning.sh");
    expect(output).toContain("planes the repository describes that do not exist");
    expect(status).toBe(1);
  });

  it("does not describe an absent plane as skipped, which is what made it invisible", () => {
    const { output } = run("continuation-tick tracking-ingest", "--check");
    expect(output).not.toContain("skipped, not failed");
  });
});

describe("the other direction: a plane the project runs and the list does not name", () => {
  const listed = "continuation-tick tracking-ingest strategy-learning";

  it("FAILS when a job runs this image but is not in the list", () => {
    // Nothing pins it, and before this every deploy walked straight past it — which is exactly how
    // site-credential-reconciler and tracking-ingest went stale on 2026-09-07.
    const { status, output } = run(`${listed} conductor-run`, "--check", { projectJobs: `${listed} conductor-run` });
    expect(output).toContain("UNLISTED conductor-run");
    expect(output).toContain("that are not in executor-jobs.txt");
    expect(status).toBe(1);
  });

  it("FAILS the deploy too, unlike an absent plane", () => {
    // An absent plane cannot run stale code, so pin mode may walk past it. An unlisted one exists,
    // runs this image and is pinned by nothing — shipping past it is the bug itself.
    const { status, output } = run(`${listed} conductor-run`, "pin", { projectJobs: `${listed} conductor-run` });
    expect(output).toContain("UNLISTED conductor-run");
    expect(status).toBe(1);
  });

  it("ignores a job built from a different image, which must never be pinned to mcp-service", () => {
    // Pinning it would point it at an artifact that does not contain its entrypoint.
    const { status, output } = run(`${listed} side-car`, "--check", { projectJobs: `${listed} side-car`, otherRepoJobs: "side-car" });
    expect(output).not.toContain("side-car");
    expect(status).toBe(0);
  });
});

describe("pre-flight", () => {
  it("stops on a permission failure instead of reading it as an absent plane", () => {
    // The two answers arrive the same way — a non-zero describe. Read as 'absent', a lost IAM
    // binding would silently skip a live plane in pin mode and invent a missing one in check mode.
    const { status, output } = run("continuation-tick tracking-ingest strategy-learning", "pin", { denyJob: "tracking-ingest" });
    expect(output).toContain("this is not a 'no such job' answer");
    expect(output).toContain("Nothing has been changed");
    expect(output).not.toContain("ABSENT   tracking-ingest");
    expect(status).toBe(1);
  });
});

describe("scripts/pin-job-images.sh (pin mode)", () => {
  it("still treats an absent plane as a note — a job that does not exist cannot run stale code", () => {
    // Pin mode's question is "does what exists run the served artifact?". Failing a deploy because
    // a plane has not been created yet would block the release that creates it.
    const { status, output } = run("continuation-tick tracking-ingest", "pin");
    expect(output).toContain("note: not present in us-central1");
    expect(status).toBe(0);
  });
});
