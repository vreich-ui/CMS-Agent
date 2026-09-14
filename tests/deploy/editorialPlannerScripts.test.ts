/**
 * Track C — the deploy contract for the one plane that spends money.
 *
 * Script content, asserted the way `cloudbuildDeploy.test.ts` asserts it: these files are executed
 * by hand against production, so the properties that keep them safe (the dry-run first, the image
 * sha the guard compares, continuation-tick left alone) have to be pinned somewhere a reviewer
 * reads rather than trusted to survive the next edit.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * The script's EXECUTABLE lines — comments and `say` lines stripped. Both files talk ABOUT the
 * commands an operator should run next, so a naive grep for "jobs execute" finds the instruction
 * rather than an invocation, and the assertion that matters ("this script never runs the job") would
 * fail on its own documentation.
 */
const commands = (script: string) =>
  script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("say "))
    .join("\n");

describe("scripts/deploy-editorial-planner.sh", () => {
  const script = read("scripts/deploy-editorial-planner.sh");

  it("runs the planner entrypoint as a Cloud Run job", () => {
    expect(script).toContain("src/agent/entrypoints/editorialPlannerJobMain.ts");
    expect(script).toContain("--max-retries 0");
  });

  it("REQUIRES the service URL, without which the stale-image guard cannot compare anything", () => {
    expect(script).toContain('"${CMS_AGENT_SERVICE_URL:?');
  });

  it("stamps SERVICE_GIT_SHA from the image tag, the same source deploy-service.sh uses", () => {
    expect(script).toContain('GIT_SHA="${IMAGE##*:}"');
    expect(script).toContain("SERVICE_GIT_SHA=$GIT_SHA");
  });

  it("refuses an untagged image, because the guard would have nothing to compare", () => {
    expect(script).toMatch(/IMAGE must carry a tag/);
  });

  it("never executes the job it configures, and tells the operator to dry-run first", () => {
    expect(commands(script)).not.toMatch(/jobs execute/);
    expect(script).toContain("DRY RUN FIRST");
  });

  it("declares no tenant opt-in of its own", () => {
    expect(script).not.toContain("COMMISSIONING_ENABLED");
    expect(script).toContain("A tenant opts in by setting");
  });
});

describe("scripts/deploy-editorial-planner-schedule.sh", () => {
  const script = read("scripts/deploy-editorial-planner-schedule.sh");

  it("fires daily at 06:00 UTC — after the jobs producing the evidence it plans against", () => {
    expect(script).toContain('CRON="${CRON:-0 6 * * *}"');
    expect(script).toContain('--time-zone "Etc/UTC"');
  });

  it("refuses to schedule a job that does not exist yet", () => {
    expect(script).toContain("run scripts/deploy-editorial-planner.sh first");
  });

  it("names both stop levers — the schedule, and one tenant's own strategy", () => {
    expect(script).toContain("scheduler jobs pause");
    expect(script).toContain("commissioning.enabled false");
  });
});

describe("scripts/jobs-repin.sh", () => {
  const script = read("scripts/jobs-repin.sh");
  const pin = read("scripts/pin-job-images.sh");

  it("excludes continuation-tick by default, and says why", () => {
    expect(script).toContain('DEFAULT_EXCLUDE="continuation-tick"');
    expect(script).toContain("--all");
  });

  it("delegates to the ONE pin implementation rather than calling gcloud itself", () => {
    expect(script).toContain('"$ROOT/scripts/pin-job-images.sh"');
    expect(commands(script)).not.toMatch(/gcloud /);
  });

  it("passes the FULL job list through, so the both-directions reconciliation still runs", () => {
    expect(script).toContain('EXECUTOR_JOBS_FILE="$SOURCE_LIST"');
    expect(script).toContain('PIN_ONLY="$SELECTED"');
  });

  it("executes nothing", () => {
    expect(commands(script)).not.toMatch(/jobs execute/);
    expect(script).toContain("No job was executed");
  });

  it("is honoured by pin-job-images.sh as a selection, never as a shorter list", () => {
    expect(pin).toContain('if [ -n "${PIN_ONLY:-}" ]');
    expect(pin).toContain("SKIPPED  $JOB");
  });
});

describe("deploy/executor-jobs.txt", () => {
  it("lists editorial-planner, so a release repins it", () => {
    const list = read("deploy/executor-jobs.txt");
    const names = list
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(names).toContain("editorial-planner");
  });
});
