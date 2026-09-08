import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/deploy-continuation-tick.sh configures the ONE plane that touches live tenant content
// every two minutes. Every other deploy script in this repo shapes something that runs once a day
// or once a week, where a mistake is caught before it acts. Here a mistake acts within two minutes,
// on four sites, at full scale.
//
// So the script's safety properties are not a matter of the author's care -- they are asserted:
// it cannot start a run, it cannot write unless an operator asked it to, its two timeout numbers
// cannot drift apart, and it cannot quietly stop declaring half the shape it is supposed to pin.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

/** Comment lines say what the script must never do; only the executable lines can actually do it. */
const codeLines = (body: string) => body.split("\n").filter((line) => !line.trimStart().startsWith("#"));
const codeOf = (body: string) => codeLines(body).join("\n");

const script = read("scripts/deploy-continuation-tick.sh");
const schedule = read("scripts/deploy-continuation-tick-schedule.sh");
const code = codeOf(script);
const scheduleCode = codeOf(schedule);

describe("scripts/deploy-continuation-tick.sh", () => {
  it('declares JOB="${JOB:-continuation-tick}", which is how the executor-jobs audit finds it', () => {
    // tests/deploy/executorJobs.test.ts reads exactly this line to learn which job a script creates.
    expect(script).toMatch(/^JOB="\$\{JOB:-continuation-tick\}"$/m);
  });

  it("has no path that starts a run", () => {
    // Configuring the plane and firing it are different decisions. The schedule fires it; a deploy
    // script that could also fire it would make an env change and an unscheduled fleet-wide run the
    // same keystroke.
    expect(code).not.toMatch(/jobs\s+execute/);
    expect(code).not.toMatch(/scheduler\s+jobs\s+run/);
    expect(scheduleCode).not.toMatch(/jobs\s+execute/);
    expect(scheduleCode).not.toMatch(/scheduler\s+jobs\s+run/);
  });

  it("derives TASK_TIMEOUT_MS from the same variable as --task-timeout", () => {
    // Two hand-typed numbers drift, and the failure is a task killed mid-write with nothing in the
    // log saying why: the job thinks it has budget left, Cloud Run does not.
    expect(code).toContain("TASK_TIMEOUT_MS=$((TASK_TIMEOUT_SECONDS * 1000))");
    expect(code).not.toMatch(/TASK_TIMEOUT_MS=\d/);
    expect(code).toContain('--task-timeout "$TASK_TIMEOUT_SECONDS"');
  });

  it("uses --set-* only where the job is being created", () => {
    // --set-env-vars and --set-secrets REPLACE the whole list. On an existing job that silently
    // drops every variable the script does not name. Only the create branch, where there is nothing
    // to drop, may use them.
    let verb = "(before any gcloud run jobs command)";
    const owners: string[] = [];
    for (const line of codeLines(script)) {
      const match = /gcloud run jobs (\w+)/.exec(line);
      if (match) verb = match[1]!;
      if (line.includes("--set-")) owners.push(verb);
    }
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every((owner) => owner === "create")).toBe(true);
    expect(code).toContain("--update-env-vars");
    expect(code).toContain("--update-secrets");
  });

  it("defaults to checking, and reaches the update only under APPLY=1", () => {
    expect(code).toContain('APPLY="${APPLY:-}"');
    const guard = code.indexOf('if [[ "$APPLY" != "1" ]]');
    const update = code.indexOf("gcloud run jobs update");
    expect(guard).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(guard);
    // The default path ends in a report, not a write.
    expect(code).toContain("Nothing was written.");
  });

  it("declares the whole live shape, not the convenient half of it", () => {
    // The job binds five secrets and four tenant endpoints. A script that declared only OPENAI and
    // the three obvious env vars would pass --update-* harmlessly and then report four false diffs
    // forever -- and would recreate the job wrong if it ever took the create branch.
    for (const name of ["OPENAI_API_KEY", "PLATFORM_MCP_TOKEN", "DR_LURIE_MCP_TOKEN", "FERNWELL_MCP_TOKEN", "ZILBERMAN_MCP_TOKEN"]) {
      expect(code).toMatch(new RegExp(`${name}=\\$\\{?${name}_SECRET`));
    }
    for (const name of ["PLATFORM_MCP_ENDPOINT", "DR_LURIE_MCP_ENDPOINT", "FERNWELL_MCP_ENDPOINT", "ZILBERMAN_MCP_ENDPOINT"]) {
      expect(code).toContain(`${name}=$${name}`);
    }
  });

  it("keeps every credential in the secret list and none in the env list", () => {
    const envBlock = /ENV_PAIRS="([\s\S]*?)"\n/.exec(code)?.[1] ?? "";
    expect(envBlock).not.toBe("");
    for (const line of envBlock.split("\n")) {
      expect(line.split("=")[0] ?? "").not.toMatch(/TOKEN|API_KEY|SECRET|PASSWORD/);
    }
    // Secrets are bound by NAME and VERSION. A value never appears anywhere in this repository.
    const secretBlock = /SECRET_PAIRS="([\s\S]*?)"\n/.exec(code)?.[1] ?? "";
    expect(secretBlock.split("\n").filter(Boolean).every((line) => line.endsWith(":latest"))).toBe(true);
  });
});

describe("scripts/deploy-continuation-tick-schedule.sh", () => {
  it("fires every two minutes as UTC, over the Cloud Run Jobs v1 :run endpoint", () => {
    expect(scheduleCode).toContain('CRON="${CRON:-*/2 * * * *}"');
    expect(scheduleCode).toContain('--time-zone "Etc/UTC"');
    expect(scheduleCode).toContain("/apis/run.googleapis.com/v1/namespaces/");
    expect(scheduleCode).toContain("--oauth-service-account-email");
  });

  it("refuses to schedule a job that does not exist", () => {
    // A schedule pointing at a missing job fails as PERMISSION_DENIED, not NOT_FOUND, and reads as
    // an IAM problem for as long as anyone is willing to believe it.
    expect(scheduleCode).toContain('gcloud run jobs describe "$JOB"');
    expect(scheduleCode).toContain("run scripts/deploy-continuation-tick.sh first");
  });

  it("does not widen IAM, and says so", () => {
    expect(scheduleCode).not.toMatch(/add-iam-policy-binding/);
    expect(scheduleCode).toContain("roles/run.invoker");
  });
});
