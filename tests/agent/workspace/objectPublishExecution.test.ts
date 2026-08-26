import { describe, expect, it } from "vitest";
import {
  OBJECT_PUBLISHABLE_TYPES,
  OBJECT_PUBLISH_FORBIDDEN_VERBS,
  OBJECT_PUBLISH_VERBS,
  ObjectPublishError,
  buildObjectPublishPlan,
  executeObjectPublish,
  type ObjectPublishPlan
} from "../../../src/agent/workspace/objectPublishExecution.js";
import type { CallToolFn } from "../../../src/agent/workspace/publisher.js";

// T15.6 (ADR-2026-08-25-publish-autonomy §3, §9) — the canonical TS port of publish.mjs's object-scoped
// self-check. Every behaviour publish.mjs's own header called out as load-bearing is asserted here:
//   - publish only what THAT OBJECT's own validation passed;
//   - never publish a quarantined object, even one that also validated "true" somewhere;
//   - name every withheld object with its reason;
//   - one object's failure never withholds the rest;
//   - leases released in `finally`, even when object_publish throws;
//   - release_to_production / trigger_netlify_build / deploy are never reachable from this module.

const report = (overrides: Record<string, unknown> = {}) => ({
  target: "dr-lurie",
  createdObjects: [
    { objectId: "obj_page_1", objectType: "page" },
    { objectId: "obj_nav_1", objectType: "navigation" },
    { objectId: "obj_theme_1", objectType: "theme" }
  ],
  reusedObjects: [],
  validationStates: [
    { objectId: "obj_page_1", phase: "postcreate", valid: true },
    { objectId: "obj_nav_1", phase: "postcreate", valid: true },
    { objectId: "obj_theme_1", phase: "postcreate", valid: true }
  ],
  quarantines: [],
  ...overrides
});

describe("buildObjectPublishPlan — the object-scoped self-check, pure", () => {
  it("publishes only objects whose OWN validation passed and are a publishable type", () => {
    const plan = buildObjectPublishPlan({ report: report() });
    expect(plan.publish.map((entry) => entry.objectId)).toEqual(["obj_page_1", "obj_nav_1"]);
    expect(plan.release).toBe(true);
  });

  it("names a failed-validation object as withheld with its reason and detail", () => {
    const plan = buildObjectPublishPlan({
      report: report({ validationStates: [{ objectId: "obj_page_1", phase: "postcreate", valid: false, reason: "missing_slug" }, { objectId: "obj_nav_1", phase: "postcreate", valid: true }] })
    });
    expect(plan.publish.map((entry) => entry.objectId)).toEqual(["obj_nav_1"]);
    expect(plan.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "obj_page_1", reason: "validation_failed", detail: "missing_slug" })
    ]));
  });

  it("NEVER publishes an object this run quarantined, even though its own validation says valid:true", () => {
    const plan = buildObjectPublishPlan({ report: report({ quarantines: [{ objectId: "obj_page_1", reason: "asset_missing" }] }) });
    expect(plan.publish.map((entry) => entry.objectId)).not.toContain("obj_page_1");
    expect(plan.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "obj_page_1", reason: "quarantined_by_emission" })
    ]));
  });

  it("names a quarantined object that was NEVER validated at all — the silently-dropped-object case", () => {
    const plan = buildObjectPublishPlan({
      report: report({
        validationStates: [{ objectId: "obj_nav_1", phase: "postcreate", valid: true }],
        quarantines: [{ objectId: "obj_page_1", reason: "write_incomplete" }]
      })
    });
    expect(plan.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "obj_page_1", reason: "quarantined_by_emission", detail: "write_incomplete" })
    ]));
  });

  it("withholds a theme/section_template — not a publishable type from this loop", () => {
    const plan = buildObjectPublishPlan({ report: report() });
    expect(plan.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "obj_theme_1", objectType: "theme", reason: "type_not_publishable" })
    ]));
    expect(OBJECT_PUBLISHABLE_TYPES.has("theme")).toBe(false);
    expect([...OBJECT_PUBLISHABLE_TYPES]).toEqual(["page", "navigation"]);
  });

  // T15.11 (#190, ADR-2026-08-25-publish-autonomy §6.3) — the allowlist is now POLICY-DRIVEN per
  // caller (the run's own publishingPolicySnapshot.publishableTypes), not one constant every workflow
  // shares. These cases exercise the parameter directly: buildObjectPublishPlan never resolves a
  // charter itself, so passing the widened/narrowed set IS the enforcement point.
  describe("T15.11 (#190) — policy-driven publishableTypes per calling workflow", () => {
    it("capture_conductor's widened charter publishes theme alongside page/navigation", () => {
      const plan = buildObjectPublishPlan({
        report: report(),
        publishableTypes: ["page", "navigation", "theme", "site", "section_template"],
        workflowId: "capture_conductor"
      });
      expect(plan.publish.map((entry) => entry.objectId).sort()).toEqual(["obj_nav_1", "obj_page_1", "obj_theme_1"]);
      expect(plan.withheld).toEqual([]);
      expect(plan.release).toBe(true);
    });

    it("capture_conductor's charter also admits the site singleton and section_template", () => {
      const plan = buildObjectPublishPlan({
        report: report({
          createdObjects: [
            { objectId: "obj_site_1", objectType: "site" },
            { objectId: "obj_tmpl_1", objectType: "section_template" }
          ],
          reusedObjects: [],
          validationStates: [
            { objectId: "obj_site_1", phase: "postpatch", valid: true },
            { objectId: "obj_tmpl_1", phase: "postcreate", valid: true }
          ],
          quarantines: []
        }),
        publishableTypes: ["page", "navigation", "theme", "site", "section_template"],
        workflowId: "capture_conductor"
      });
      expect(plan.publish.map((entry) => entry.objectId).sort()).toEqual(["obj_site_1", "obj_tmpl_1"]);
      expect(plan.withheld).toEqual([]);
    });

    it("publishing_conductor's charter REFUSES a theme with a typed, named refusal stating the boundary", () => {
      const plan = buildObjectPublishPlan({
        report: report(),
        publishableTypes: ["page", "navigation"],
        workflowId: "publishing_conductor"
      });
      expect(plan.publish.map((entry) => entry.objectId)).toEqual(["obj_page_1", "obj_nav_1"]);
      // The refused object is NAMED (objectId + objectType), never silently dropped, and its reason
      // names the boundary that refused it — the reject-never-coerce posture, not a coercion or a
      // quiet omission from `publish`.
      expect(plan.withheld).toEqual(expect.arrayContaining([
        expect.objectContaining({
          objectId: "obj_theme_1",
          objectType: "theme",
          reason: "type_not_publishable",
          detail: expect.stringContaining("publishing_conductor is not chartered to publish object type \"theme\"")
        })
      ]));
      const themeWithheld = plan.withheld.find((entry) => entry.objectId === "obj_theme_1");
      expect(themeWithheld?.detail).toContain("ADR-2026-08-25-publish-autonomy §6.3");
    });

    it("publishing_conductor's charter REFUSES a section_template by the same mechanism", () => {
      const plan = buildObjectPublishPlan({
        report: report({
          createdObjects: [{ objectId: "obj_tmpl_1", objectType: "section_template" }],
          reusedObjects: [],
          validationStates: [{ objectId: "obj_tmpl_1", phase: "postcreate", valid: true }],
          quarantines: []
        }),
        publishableTypes: ["page", "navigation"],
        workflowId: "publishing_conductor"
      });
      expect(plan.publish).toEqual([]);
      expect(plan.withheld).toEqual([
        expect.objectContaining({ objectId: "obj_tmpl_1", objectType: "section_template", reason: "type_not_publishable" })
      ]);
    });

    it("omitting publishableTypes falls back to the legacy OBJECT_PUBLISHABLE_TYPES default unchanged", () => {
      const withParam = buildObjectPublishPlan({ report: report(), publishableTypes: undefined });
      const withoutParam = buildObjectPublishPlan({ report: report() });
      expect(withParam).toEqual(withoutParam);
      expect(withoutParam.publish.map((entry) => entry.objectId)).toEqual(["obj_page_1", "obj_nav_1"]);
    });
  });

  it("names object_type_unknown when the object never appears in created/reused at all", () => {
    const plan = buildObjectPublishPlan({
      report: report({ validationStates: [{ objectId: "obj_ghost", phase: "postcreate", valid: true }] })
    });
    expect(plan.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "obj_ghost", objectType: null, reason: "object_type_unknown" })
    ]));
  });

  it("release is false when nothing is publishable", () => {
    const plan = buildObjectPublishPlan({ report: report({ validationStates: [] }) });
    expect(plan.publish).toEqual([]);
    expect(plan.release).toBe(false);
  });

  it("never names trigger_netlify_build, deploy, or release_to_production as reachable", () => {
    const plan = buildObjectPublishPlan({ report: report() });
    expect(plan.forbiddenVerbs).toEqual(["deploy", "release_to_production", "trigger_netlify_build"]);
    expect(OBJECT_PUBLISH_VERBS.has("release_to_production")).toBe(false);
    expect(OBJECT_PUBLISH_FORBIDDEN_VERBS.has("release_to_production")).toBe(true);
  });

  it("refuses without a report or a target, never inventing either", () => {
    expect(() => buildObjectPublishPlan({ report: undefined as never })).toThrow(ObjectPublishError);
    expect(() => buildObjectPublishPlan({ report: {} })).toThrow(/target project/);
  });
});

// -----------------------------------------------------------------------------------------------------
// executeObjectPublish — the per-object loop over an injected transport.

type StubResponse = { object_checkout?: unknown; object_publish?: unknown; object_checkin?: unknown };

const stubTransport = (overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const callTool: CallToolFn = (async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const override = overrides[tool];
    if (override) {
      const outcome = override(args);
      if (outcome instanceof Error) throw outcome;
      return { ok: true, projectId: "dr-lurie", tool, result: outcome };
    }
    if (tool === "object_checkout") return { ok: true, projectId: "dr-lurie", tool, result: { lockToken: `lock_${args.object_id}` } };
    if (tool === "object_publish") return { ok: true, projectId: "dr-lurie", tool, result: { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "abc123" } } };
    if (tool === "object_checkin") return { ok: true, projectId: "dr-lurie", tool, result: {} };
    throw new Error(`unexpected tool ${tool}`);
  }) as unknown as CallToolFn;
  return { callTool, calls };
};

const planWith = (publish: ObjectPublishPlan["publish"]): ObjectPublishPlan => ({
  schemaVersion: "object_publish_plan.v1",
  target: "dr-lurie",
  publish,
  withheld: [],
  release: publish.length > 0,
  forbiddenVerbs: ["deploy", "release_to_production", "trigger_netlify_build"]
});

describe("executeObjectPublish — the per-object loop, non-throwing", () => {
  it("publishes every candidate through checkout -> publish -> checkin, in order", async () => {
    const { callTool, calls } = stubTransport();
    const plan = planWith([{ objectId: "obj_page_1", objectType: "page", phase: "postcreate" }, { objectId: "obj_nav_1", objectType: "navigation", phase: "postcreate" }]);

    const result = await executeObjectPublish({ plan, callTool });

    expect(result.published.map((entry) => entry.objectId)).toEqual(["obj_page_1", "obj_nav_1"]);
    expect(result.failed).toEqual([]);
    expect(calls.map((call) => call.tool)).toEqual(["object_checkout", "object_publish", "object_checkin", "object_checkout", "object_publish", "object_checkin"]);
    // release_to_production is never called by this loop — that is release_executor's job alone.
    expect(calls.some((call) => call.tool === "release_to_production")).toBe(false);
  });

  it("one object's failure does NOT withhold the rest — the loop keeps going", async () => {
    const { callTool, calls } = stubTransport({
      object_publish: (args) => (args.object_id === "obj_page_1" ? new Error("publish refused: schema mismatch") : { published: true, published_time: null, receipt: {} })
    });
    const plan = planWith([
      { objectId: "obj_page_1", objectType: "page", phase: "postcreate" },
      { objectId: "obj_nav_1", objectType: "navigation", phase: "postcreate" }
    ]);

    const result = await executeObjectPublish({ plan, callTool });

    expect(result.failed).toEqual([{ objectId: "obj_page_1", objectType: "page", reason: "publish_failed", detail: expect.stringContaining("schema mismatch") }]);
    expect(result.published.map((entry) => entry.objectId)).toEqual(["obj_nav_1"]);
    // Both objects were attempted — the second was not skipped because the first failed.
    expect(calls.filter((call) => call.tool === "object_checkout")).toHaveLength(2);
  });

  it("releases the lease in a `finally` even when object_publish throws", async () => {
    const { callTool, calls } = stubTransport({ object_publish: () => new Error("boom") });
    const plan = planWith([{ objectId: "obj_page_1", objectType: "page", phase: "postcreate" }]);

    const result = await executeObjectPublish({ plan, callTool });

    expect(result.failed[0]).toMatchObject({ objectId: "obj_page_1", reason: "publish_failed" });
    const checkin = calls.find((call) => call.tool === "object_checkin");
    expect(checkin).toBeDefined();
    expect(checkin!.args.lock_token).toBe("lock_obj_page_1");
  });

  it("never throws past its own loop, even when checkout itself throws", async () => {
    const { callTool } = stubTransport({ object_checkout: () => new Error("network error") });
    const plan = planWith([{ objectId: "obj_page_1", objectType: "page", phase: "postcreate" }]);

    await expect(executeObjectPublish({ plan, callTool })).resolves.toMatchObject({
      failed: [{ objectId: "obj_page_1", objectType: "page", reason: "publish_failed", detail: expect.stringContaining("network error") }],
      published: []
    });
  });

  it("records a failed checkin rather than swallowing it, without failing the publish that already succeeded", async () => {
    const { callTool, calls } = stubTransport({ object_checkin: () => new Error("lock service unavailable") });
    const plan = planWith([{ objectId: "obj_page_1", objectType: "page", phase: "postcreate" }]);

    const result = await executeObjectPublish({ plan, callTool });

    expect(result.published.map((entry) => entry.objectId)).toEqual(["obj_page_1"]);
    const checkinTrace = result.trace.find((entry) => entry.verb === "object_checkin");
    expect(checkinTrace).toEqual({ verb: "object_checkin", objectType: "page", objectId: "obj_page_1", failed: true });
    expect(calls.filter((call) => call.tool === "object_checkin")).toHaveLength(1);
  });

  it("withholds pass through verbatim, unrelated to what got published", async () => {
    const { callTool } = stubTransport();
    const plan: ObjectPublishPlan = { ...planWith([{ objectId: "obj_nav_1", objectType: "navigation", phase: "postcreate" }]), withheld: [{ objectId: "obj_theme_1", objectType: "theme", phase: "postcreate", reason: "type_not_publishable" }] };

    const result = await executeObjectPublish({ plan, callTool });
    expect(result.withheld).toEqual([{ objectId: "obj_theme_1", objectType: "theme", phase: "postcreate", reason: "type_not_publishable" }]);
  });
});
