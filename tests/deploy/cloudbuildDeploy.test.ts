import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the cms-agent-mcp resource pins. Cloud Run logs confirmed an OOM crash loop ("Memory limit
// of 512 MiB exceeded") on the service's default 512Mi/min-instances=0, and console overrides to
// 1Gi/min-instances=1 were reverted by ordinary pipeline deploys twice in one day because nothing in
// the repository pinned them. This fails the build the moment an edit drops either flag, rather than
// shipping the crash loop again.
//
// The pins MOVED (C-12). They used to be inline in cloudbuild.deploy.yaml's deploy step, where this
// file asserted them — while scripts/deploy-mcp.sh, which this file did NOT check, carried
// `--memory 512Mi --min-instances 0`. The guard was real and half-blind: the exact crash loop it
// exists to prevent was one hand deploy away the entire time. Both paths now run
// scripts/deploy-service.sh, so the pins are asserted there, and each caller is asserted to carry no
// `gcloud run deploy` of its own — otherwise a second copy reappears and this guard goes half-blind
// again in precisely the same way.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

const deployService = read("scripts/deploy-service.sh");
const cloudbuild = read("cloudbuild.deploy.yaml");
const deployMcp = read("scripts/deploy-mcp.sh");

// Negative assertions run against COMMAND lines only. These files explain at length what they must
// never do again — "512Mi", "--set-env-vars", "min-instances=0" all appear in the prose that says so
// — and a guard that cannot tell an instruction from a warning about it would forbid the warning.
const code = (source: string) => source.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const deployServiceCode = code(deployService);
const deployMcpCode = code(deployMcp);

const deployStep = (() => {
  const start = cloudbuild.indexOf("id: deploy-and-verify");
  const end = cloudbuild.indexOf("id: sync-executor-planes");
  if (start === -1 || end === -1) throw new Error("cloudbuild.deploy.yaml no longer has the expected deploy-and-verify / sync-executor-planes steps");
  return cloudbuild.slice(start, end);
})();

describe("scripts/deploy-service.sh — cms-agent-mcp resource pins", () => {
  it("pins 1Gi, never back to the 512Mi that crash-looped", () => {
    expect(deployService).toMatch(/MEMORY="1Gi"/);
    expect(deployServiceCode).not.toMatch(/512Mi/);
  });

  it("pins min-instances 1, never back to 0", () => {
    expect(deployService).toMatch(/MIN_INSTANCES="1"/);
    expect(deployService).toMatch(/--min-instances "\$\{MIN_INSTANCES\}"/);
  });

  it("names the runtime service account, so a fresh service never lands on the default compute SA", () => {
    expect(deployService).toMatch(/RUNTIME_SA="\$\{RUNTIME_SA:-cms-agent-run@/);
    expect(deployService).toMatch(/--service-account "\$\{RUNTIME_SA\}"/);
  });

  it("uses MERGE flags only — --set-* deleted the client-connection variables twice", () => {
    expect(deployService).toMatch(/--update-env-vars/);
    expect(deployService).toMatch(/--update-secrets/);
    expect(deployServiceCode).not.toMatch(/--set-env-vars|--set-secrets/);
  });

  it("leaves the publish-enabled flags unnamed, so no deploy can disturb them", () => {
    expect(deployServiceCode).not.toMatch(/DR_LURIE_PUBLISH_ENABLED=|PLATFORM_PUBLISH_ENABLED=/);
  });

  it("carries every client connection a fresh service needs, including the fourth tenant", () => {
    for (const key of [
      "DR_LURIE_MCP_ENDPOINT",
      "PDF_TOOL_MCP_ENDPOINT",
      "PLATFORM_MCP_ENDPOINT",
      "FERNWELL_MCP_ENDPOINT",
      // Live on the service and named by NEITHER artifact before C-12; it survived only because both
      // paths merge, and a fresh service would simply not have had it.
      "ZILBERMAN_MCP_ENDPOINT",
      "TRACKING_SINK_URL"
    ]) {
      expect(deployService).toContain(`${key}=`);
    }
    for (const key of [
      "DR_LURIE_MCP_TOKEN",
      "PDF_TOOL_MCP_TOKEN",
      "PLATFORM_MCP_TOKEN",
      "FERNWELL_MCP_TOKEN",
      "ZILBERMAN_MCP_TOKEN",
      // Was a plaintext env var until revision 00236-pcz; named here so it stays a secret binding.
      "TRACKING_SINK_TOKEN",
      "NETLIFY_API_TOKEN"
    ]) {
      expect(deployService).toMatch(new RegExp(`${key}=[^"]*:latest`));
    }
  });

  it("stamps the build identity RepositoryManager.ts reads (K-O2): commit sha off IMAGE's own tag, deployed-at off the deploy's own clock", () => {
    expect(deployService).toMatch(/SERVICE_GIT_SHA=\$\{IMAGE##\*:\}/);
    expect(deployService).toMatch(/SERVICE_DEPLOYED_AT=\$\(date -u \+%FT%TZ\)/);
  });

  it("builds the origin list with the ^|^ delimiter rather than by hand", () => {
    // The live value was found spliced into nonsense on 2026-09-07 precisely because a comma list of
    // URLs was assembled by hand. Every origin contains "://", so ":" cannot be the delimiter.
    expect(deployService).toContain('ENV_ARG="^|^');
    expect(deployServiceCode).not.toMatch(/\^:\^/);
  });
});

describe("both release paths run the one script", () => {
  it("cloudbuild.deploy.yaml's deploy() calls it and carries no gcloud run deploy of its own", () => {
    expect(deployStep).toContain("bash /workspace/scripts/deploy-service.sh");
    expect(code(deployStep)).not.toMatch(/gcloud run deploy/);
  });

  it("scripts/deploy-mcp.sh calls it and carries no gcloud run deploy of its own", () => {
    expect(deployMcp).toContain("deploy-service.sh");
    expect(deployMcpCode).not.toMatch(/gcloud run deploy/);
  });

  it("neither caller re-states a sizing flag, which is exactly how the two artifacts drifted", () => {
    for (const source of [code(deployStep), deployMcpCode]) {
      expect(source).not.toMatch(/--memory\b/);
      expect(source).not.toMatch(/--min-instances\b/);
      expect(source).not.toMatch(/--cpu\b/);
    }
  });
});
