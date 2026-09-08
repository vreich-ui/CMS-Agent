import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/deploy-continuation-tick.sh embeds a small JavaScript program, LIVE_READER, inside a
// single-quoted shell string. It is the part of the script that decides what "the live shape" IS,
// and being a string it is not type-checked, not linted, and not covered by any grep-the-source
// test. If it read `maxRetries` from the wrong nesting level, or `execution-environment` from the
// wrong annotations block, the check would report a permanent false diff on a job that is correct —
// and the operator's instruction is to reconcile the SCRIPT when that happens, so the reader being
// wrong looks exactly like the job being wrong.
//
// So it is extracted from the script and RUN, against a trimmed copy of the real
// `gcloud run jobs describe --format=json` output for continuation-tick (captured 2026-09-08;
// secret references are names and versions, which is all the describe output carries).
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const liveReader = (): string => {
  const script = readFileSync(repoFile("scripts/deploy-continuation-tick.sh"), "utf8");
  const match = /LIVE_READER='([\s\S]*?)'\n/.exec(script);
  if (!match) throw new Error("LIVE_READER is no longer a single-quoted shell string in deploy-continuation-tick.sh");
  return match[1]!;
};

const readLive = (describeJson: string): Map<string, string> => {
  const output = execFileSync(process.execPath, ["-e", liveReader()], { input: describeJson, encoding: "utf8" });
  return new Map(output.split("\n").filter(Boolean).map((line) => {
    const [key, ...rest] = line.split("\t");
    return [key!, rest.join("\t")];
  }));
};

const fixture = readFileSync(repoFile("tests/deploy/fixtures/continuation-tick.describe.json"), "utf8");

describe("the live-shape reader inside deploy-continuation-tick.sh", () => {
  const fields = readLive(fixture);

  it("reads the scalars from the nesting level Cloud Run actually puts them at", () => {
    expect(fields.get("serviceAccount")).toBe("cms-agent-run@cms-agent-503015.iam.gserviceaccount.com");
    expect(fields.get("cpu")).toBe("1000m");
    expect(fields.get("memory")).toBe("1Gi");
    expect(fields.get("taskTimeoutSeconds")).toBe("600");
    expect(fields.get("taskCount")).toBe("1");
    expect(fields.get("command")).toBe("node");
    expect(fields.get("args")).toBe("--import,tsx,src/agent/entrypoints/runContinuationTickMain.ts");
  });

  it("reads maxRetries 0 as a value, not as an absence", () => {
    // The one field whose correct value is falsy. A reader that skipped it would report
    // "maxRetries (absent)" on every run of a job that has exactly the declared value.
    expect(fields.get("maxRetries")).toBe("0");
  });

  it("finds execution-environment on the execution template's annotations, where gcloud writes it", () => {
    expect(fields.get("executionEnvironment")).toBe("gen2");
  });

  it("separates secret references from literal env, and carries no value for either kind of secret", () => {
    expect(fields.get("secret.OPENAI_API_KEY")).toBe("openai-api-key:latest");
    expect(fields.get("secret.ZILBERMAN_MCP_TOKEN")).toBe("zilberman-mcp-token:latest");
    expect(fields.get("env.OPENAI_API_KEY")).toBeUndefined();
    expect(fields.get("env.TASK_TIMEOUT_MS")).toBe("600000");
    expect(fields.get("env.WORKSPACE_STORE")).toBe("gcs");
  });

  it("emits every field the script declares, so a real check has something to compare", () => {
    const declared = ["serviceAccount", "cpu", "memory", "taskTimeoutSeconds", "maxRetries", "taskCount", "executionEnvironment", "command", "args", "image"];
    for (const key of declared) expect(fields.has(key)).toBe(true);
    expect([...fields.keys()].filter((key) => key.startsWith("secret."))).toHaveLength(5);
    expect([...fields.keys()].filter((key) => key.startsWith("env."))).toHaveLength(8);
  });
});
