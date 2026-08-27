import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { MIN_VISIBLE_CONTENT_CHARS } from "../../../src/agent/projects/readinessContentChecks.js";

// T4 — THE PUBLISH-SMOKE FIXTURE IS CHECKED BY CI, NOT BY A LIVE RUN.
//
// docs/plan/PUBLISH-SMOKE.md seeds this body at article_body and drives the real conductor tools to a
// real publish with zero model calls. The one thing that can silently rot is the fixture: article_body's
// outputSchema or the readiness floor moves, and the next person to run the smoke test discovers it
// halfway through a live run against a tenant site. This test makes that a CI failure instead.

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../fixtures/publish-smoke.client-object.json", import.meta.url)), "utf8"));

// The readiness gate's own notion of reader-visible text is per-node title + body; this mirrors the
// shape it walks rather than re-importing a private helper.
const visibleChars = (body: { nodes?: Array<{ visibility?: string; public?: Record<string, unknown> }> }) =>
  (body.nodes ?? [])
    .filter((node) => node.visibility !== "internal" && node.visibility !== "hidden")
    .flatMap((node) => Object.values(node.public ?? {}))
    .filter((value): value is string => typeof value === "string")
    .join(" ").length;

describe("T4 — the publish-smoke fixture stays valid against the live contracts", () => {
  it("satisfies article_body's own outputSchema — the same authority buildInitialRun holds a seeded entrypoint to", () => {
    const schema = getWorkspaceNode("article_body")?.outputSchema;
    expect(schema, "article_body must exist in the canonical workspace").toBeDefined();
    const result = validateOutput(fixture, schema);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("clears the reader-visible content floor the readiness gate applies", () => {
    expect(visibleChars(fixture.body)).toBeGreaterThanOrEqual(MIN_VISIBLE_CONTENT_CHARS);
  });

  it("is a content_item the client will accept: slug/title/nodes, lowercase-hyphen slug, opaque n_* node ids", () => {
    expect(fixture.body.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(fixture.body.title.length).toBeGreaterThan(0);
    expect(fixture.body.nodes.length).toBeGreaterThan(0);
    for (const node of fixture.body.nodes) {
      expect(node.id).toMatch(/^n_[a-z0-9]+$/);
      expect(["content", "action", "placement", "interactive"]).toContain(node.kind);
    }
    // At least one PUBLIC content node, or the client refuses to publish (article_visible_nodes).
    expect(fixture.body.nodes.some((node: { visibility?: string }) => node.visibility === "public")).toBe(true);
  });

  it("stays recognisable as a test and free of the dependencies a smoke test must not need", () => {
    // zz-test- sorts to the end of any listing and is what teardown looks for.
    expect(fixture.body.slug.startsWith("zz-test-")).toBe(true);
    // No media: the text-only publish path refuses a body carrying image/document media, and a smoke
    // test must not depend on the artifact bridge being healthy. No taxonomy: unknown terms are write
    // blockers, so a term drifting out of a site's registry would fail the test for the wrong reason.
    expect(fixture.body.taxonomy).toBeUndefined();
    expect(JSON.stringify(fixture)).not.toContain('"media"');
    expect(JSON.stringify(fixture)).not.toContain('"images"');
    // No judgement substrate: D7 keeps it workspace-side and the hooks strip it, so a fixture that
    // carried it would be testing the stripping rather than the publish.
    for (const key of ["scores", "claims", "sources", "compliance", "emotional_strategy", "lineage", "schema_version"]) {
      expect(key in fixture.body).toBe(false);
    }
  });
});
