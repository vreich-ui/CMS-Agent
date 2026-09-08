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
// The script is bash, so grepping it proves nothing about what it does. These run it, against a
// `gcloud` stub on PATH that answers the four shapes the script asks for. Nothing here touches a
// real project.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const DIGEST = "us-central1-docker.pkg.dev/p/r/mcp-service@sha256:1111111111111111111111111111111111111111111111111111111111111111";

const workspace = mkdtempSync(join(tmpdir(), "pin-job-images-"));
const stubDirectory = join(workspace, "bin");
execFileSync("mkdir", ["-p", stubDirectory]);

// Answers only what the script actually asks: the service's latest ready revision, that revision's
// image digest, whether a job exists, and a job's image.
writeFileSync(join(stubDirectory, "gcloud"), `#!/usr/bin/env bash
case "$1 $2 $3" in
  "run services describe") echo "rev-1"; exit 0 ;;
  "run revisions describe")
    for arg in "$@"; do case "$arg" in *imageDigest*) echo "${DIGEST}"; exit 0 ;; esac; done
    exit 0 ;;
  "run jobs describe")
    job="$4"
    case " $STUB_EXISTING_JOBS " in *" $job "*) ;; *) exit 1 ;; esac
    for arg in "$@"; do case "$arg" in *containers*image*) echo "${DIGEST}"; exit 0 ;; esac; done
    exit 0 ;;
esac
exit 0
`);
chmodSync(join(stubDirectory, "gcloud"), 0o755);

const jobsFile = join(workspace, "executor-jobs.txt");
writeFileSync(jobsFile, "# three planes\ncontinuation-tick\ntracking-ingest\nstrategy-learning\n");

const run = (existingJobs: string, mode: "--check" | "pin"): { status: number; output: string } => {
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

describe("scripts/pin-job-images.sh (pin mode)", () => {
  it("still treats an absent plane as a note — a job that does not exist cannot run stale code", () => {
    // Pin mode's question is "does what exists run the served artifact?". Failing a deploy because
    // a plane has not been created yet would block the release that creates it.
    const { status, output } = run("continuation-tick tracking-ingest", "pin");
    expect(output).toContain("note: not present in us-central1");
    expect(status).toBe(0);
  });
});
