import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the cms-agent-mcp resource pins on the `cms-agent-mcp-deploy` trigger's gcloud run deploy
// step. Cloud Run logs confirmed an OOM crash loop ("Memory limit of 512 MiB exceeded") on the
// service's default 512Mi/min-instances=0, and console overrides to 1Gi/min-instances=1 were reverted
// by ordinary pipeline deploys twice in one day because nothing in the repository pinned them. This
// fails the build the moment an edit drops either flag, rather than shipping the crash loop again.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const deployStep = (() => {
  const config = readFileSync(repoFile("cloudbuild.deploy.yaml"), "utf8");
  const start = config.indexOf("id: deploy-and-verify");
  const end = config.indexOf("id: sync-executor-planes");
  if (start === -1 || end === -1) throw new Error("cloudbuild.deploy.yaml no longer has the expected deploy-and-verify / sync-executor-planes steps");
  return config.slice(start, end);
})();

describe("cloudbuild.deploy.yaml — cms-agent-mcp resource pins", () => {
  it("pins --memory=1Gi on the gcloud run deploy step", () => {
    expect(deployStep).toMatch(/--memory=1Gi\b/);
    expect(deployStep).not.toMatch(/--memory=512Mi\b/);
  });

  it("pins --min-instances=1 on the gcloud run deploy step, never back to 0", () => {
    expect(deployStep).toMatch(/--min-instances=1\b/);
    expect(deployStep).not.toMatch(/--min-instances=0\b/);
  });
});
