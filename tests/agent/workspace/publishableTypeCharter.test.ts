import { describe, expect, it } from "vitest";
import {
  RECIPE_AUTHORING_VERBS,
  RECIPE_OBJECT_TYPES,
  RecipeAuthorshipRefusedError,
  assertRecipeAuthorshipAllowed,
  listPublishableTypeCharters,
  mayAuthorRecipes,
  recipeAuthorityConformanceIssues,
  resolvePublishableTypeCharter
} from "../../../src/agent/workspace/publishableTypeCharter.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import { buildObjectPublishPlan } from "../../../src/agent/workspace/objectPublishExecution.js";

// T15.11 (2026-08-25, #190; ADR-2026-08-25-publish-autonomy §6.3) — the per-workflow publishable-type
// charter. These tests assert the CHARTER TABLE itself, independent of how any one workflow's
// publish_payload stage wires it in (objectPublishExecution.test.ts covers the enforcement mechanism).

describe("resolvePublishableTypeCharter — the per-workflow charter table (ADR §6.3)", () => {
  it("publishing_conductor: page/navigation, and NO recipe type — the load-bearing exclusion", () => {
    const charter = resolvePublishableTypeCharter("publishing_conductor");
    expect([...charter.publishableTypes].sort()).toEqual(["navigation", "page"]);
    for (const recipeType of RECIPE_OBJECT_TYPES) {
      expect(charter.publishableTypes).not.toContain(recipeType);
    }
    expect(charter.rationale).toContain("ADR-2026-08-25-structure-studio §2.2");
  });

  it("capture_conductor: widened (T15.11/#190) to page, navigation, theme, site, section_template", () => {
    const charter = resolvePublishableTypeCharter("capture_conductor");
    expect([...charter.publishableTypes].sort()).toEqual(["navigation", "page", "section_template", "site", "theme"]);
  });

  it("clone_conductor: the structure studio's recipe-authoring charter", () => {
    const charter = resolvePublishableTypeCharter("clone_conductor");
    // T15.10 (#189): "template" is the wire objectType for a page template, not "page_template" —
    // see RECIPE_OBJECT_TYPES' own comment.
    expect([...charter.publishableTypes].sort()).toEqual(["section_template", "site", "template", "theme"]);
  });

  it("an unregistered/foreign workflowId fails closed to the NARROWEST (publishing_conductor) charter", () => {
    const charter = resolvePublishableTypeCharter("some_future_workflow_nobody_registered");
    expect([...charter.publishableTypes].sort()).toEqual(["navigation", "page"]);
    expect(charter.workflowId).toBe("some_future_workflow_nobody_registered");
  });

  it("an absent workflowId also fails closed to the narrowest charter", () => {
    const charter = resolvePublishableTypeCharter(undefined);
    expect([...charter.publishableTypes].sort()).toEqual(["navigation", "page"]);
  });

  it("every registered charter is a distinct, non-empty set naming its own workflowId", () => {
    const charters = listPublishableTypeCharters();
    const ids = charters.map((charter) => charter.workflowId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const charter of charters) {
      expect(charter.publishableTypes.length).toBeGreaterThan(0);
      expect(charter.rationale.length).toBeGreaterThan(0);
    }
  });

  it("only clone_conductor and capture_conductor are chartered for any recipe type — publishing_conductor never is", () => {
    for (const charter of listPublishableTypeCharters()) {
      const grantsRecipe = charter.publishableTypes.some((type) => (RECIPE_OBJECT_TYPES as readonly string[]).includes(type));
      if (charter.workflowId === "publishing_conductor") expect(grantsRecipe).toBe(false);
    }
  });
});

// T15.29 (2026-08-25, #205; ADR-2026-08-25-structure-studio §2.2) — enforcement points 1 and 3 of
// the copy/structure authority boundary. Point 2 above (the charter table itself, enforced in
// objectPublishExecution.buildObjectPublishPlan) governs PUBLICATION; these two govern AUTHORSHIP —
// object_create / object_patch / site_apply_theme against a recipe type — which point 2 never
// touched, and which is where a copy workflow minting a recipe would first go wrong.

describe("mayAuthorRecipes — the shared 'may this workflow author a recipe at all' predicate", () => {
  it("clone_conductor (the studio) may; publishing_conductor (copy) may not", () => {
    expect(mayAuthorRecipes("clone_conductor")).toBe(true);
    expect(mayAuthorRecipes("publishing_conductor")).toBe(false);
  });

  it("capture_conductor may (T15.11 widened its charter to include theme/site/section_template)", () => {
    expect(mayAuthorRecipes("capture_conductor")).toBe(true);
  });

  it("an unregistered/absent workflowId fails closed to the narrowest charter — may not author", () => {
    expect(mayAuthorRecipes("some_future_workflow_nobody_registered")).toBe(false);
    expect(mayAuthorRecipes(undefined)).toBe(false);
  });
});

describe("recipeAuthorityConformanceIssues — enforcement point 1, the static tool-permission audit", () => {
  // "Reach" is literal allowedTools string membership, deliberately, the same narrow convention
  // publishingTail.ts's own composeWorkflowNodes / riskLevel conformance test use.
  const withAllowedTools = (allowedTools: string[]): WorkspaceNode => ({
    ...structuredClone(listWorkspaceNodes()[0]),
    id: "synthetic_test_node",
    allowedTools
  });

  it("holds for the CANONICAL publishing_conductor node set (today: zero violations, and that is a floor, not proof)", () => {
    expect(recipeAuthorityConformanceIssues(listWorkspaceNodes(), "publishing_conductor")).toEqual([]);
  });

  it("holds for capture_conductor's and clone_conductor's composed node sets (both are chartered, so this is trivially satisfied)", () => {
    expect(recipeAuthorityConformanceIssues(listCaptureConductorNodes(), "capture_conductor")).toEqual([]);
    expect(recipeAuthorityConformanceIssues(listCloneConductorNodes(), "clone_conductor")).toEqual([]);
  });

  it("actually fires: a copy-workflow node declaring object_create in allowedTools is caught, named", () => {
    const misconfigured = [withAllowedTools(["stage.get_output", "object_create"])];
    const issues = recipeAuthorityConformanceIssues(misconfigured, "publishing_conductor");
    expect(issues).toEqual([expect.stringContaining("synthetic_test_node")]);
    expect(issues[0]).toContain("object_create");
    expect(issues[0]).toContain("publishing_conductor");
  });

  it("fires for object_patch and site_apply_theme too, and reports every reached verb on one node", () => {
    const misconfigured = [withAllowedTools(["object_patch", "site_apply_theme", "stage.get_output"])];
    const issues = recipeAuthorityConformanceIssues(misconfigured, "publishing_conductor");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("object_patch");
    expect(issues[0]).toContain("site_apply_theme");
  });

  it("the SAME misconfigured node is NOT flagged for clone_conductor — the studio may hold these verbs", () => {
    const node = withAllowedTools(["object_create", "object_patch", "site_apply_theme"]);
    expect(recipeAuthorityConformanceIssues([node], "clone_conductor")).toEqual([]);
  });

  // THE TRAP (ADR §2.1's own words: "the single most likely way to get this task wrong"). Consumption
  // — object_instantiate_template / object_instantiate_section_template — is NOT a recipe-authoring
  // verb: it creates a PAGE from a template without mutating the template. publishing_conductor must
  // keep it, and the audit must never flag it.
  it("does NOT flag object_instantiate_template / object_instantiate_section_template on a copy-workflow node — consumption is not authorship", () => {
    expect(RECIPE_AUTHORING_VERBS.has("object_instantiate_template")).toBe(false);
    expect(RECIPE_AUTHORING_VERBS.has("object_instantiate_section_template")).toBe(false);
    const node = withAllowedTools(["object_instantiate_template", "object_instantiate_section_template", "stage.get_output"]);
    expect(recipeAuthorityConformanceIssues([node], "publishing_conductor")).toEqual([]);
  });
});

describe("assertRecipeAuthorshipAllowed — enforcement point 3, the runtime write guard", () => {
  it("refuses publishing_conductor object_create of a recipe type, named with the object and the boundary", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_create", { object_type: "section_template", requested_id: "st_1" }))
      .toThrow(RecipeAuthorshipRefusedError);
    try {
      assertRecipeAuthorshipAllowed("publishing_conductor", "object_create", { object_type: "section_template", requested_id: "st_1" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RecipeAuthorshipRefusedError);
      const refusal = error as RecipeAuthorshipRefusedError;
      expect(refusal.code).toBe("recipe_authorship_refused");
      expect(refusal.workflowId).toBe("publishing_conductor");
      expect(refusal.tool).toBe("object_create");
      expect(refusal.objectType).toBe("section_template");
      expect(refusal.objectId).toBe("st_1");
      expect(refusal.message).toContain("ADR-2026-08-25-structure-studio");
    }
  });

  it("refuses publishing_conductor object_patch of a recipe type when the caller supplies an objectType", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_patch", { objectType: "theme", objectId: "thm_1" }))
      .toThrow(RecipeAuthorshipRefusedError);
  });

  it("refuses site_apply_theme unconditionally from a copy workflow — its target is always the theme", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "site_apply_theme", { objectId: "site_1" }))
      .toThrow(RecipeAuthorshipRefusedError);
  });

  it("reads BOTH the wire (object_type) and clone-engine (objectType) casing", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_create", { object_type: "theme" })).toThrow();
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_create", { objectType: "theme" })).toThrow();
  });

  it("does NOT refuse publishing_conductor authoring its OWN dialect's article/page object type — this is its whole job", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_create", { object_type: "content_item" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_patch", { object_id: "abc" })).not.toThrow();
  });

  // THE TRAP, again, at the runtime-guard layer: instantiation is consumption and must sail through
  // untouched, even though it "creates" a page — the object it creates is a page, never the template.
  it("does NOT refuse object_instantiate_template / object_instantiate_section_template for publishing_conductor — consumption survives", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_instantiate_template", { objectType: "template", templateId: "tpl_1" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_instantiate_section_template", { objectType: "section_template" })).not.toThrow();
  });

  it("is precise PER TYPE, not per workflow: capture_conductor may author theme/site/section_template but NOT page template (objectType \"template\") — T15.11 never widened its charter that far", () => {
    expect(() => assertRecipeAuthorshipAllowed("capture_conductor", "object_create", { object_type: "theme" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("capture_conductor", "object_create", { object_type: "section_template" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("capture_conductor", "object_create", { object_type: "template" })).toThrow(RecipeAuthorshipRefusedError);
  });

  it("clone_conductor (the studio) may create/patch a recipe type — the boundary is per-workflow, not a blanket ban", () => {
    expect(() => assertRecipeAuthorshipAllowed("clone_conductor", "object_create", { objectType: "section_template" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("clone_conductor", "object_patch", { objectType: "theme" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("clone_conductor", "site_apply_theme", { objectId: "site_1" })).not.toThrow();
  });

  it("is a no-op for every verb outside RECIPE_AUTHORING_VERBS, whatever the arguments", () => {
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_publish", { objectType: "section_template" })).not.toThrow();
    expect(() => assertRecipeAuthorshipAllowed("publishing_conductor", "object_instantiate_template", { objectType: "section_template" })).not.toThrow();
  });

  it("fails closed for an unregistered/absent workflowId attempting a recipe write", () => {
    expect(() => assertRecipeAuthorshipAllowed(undefined, "object_create", { object_type: "theme" })).toThrow(RecipeAuthorshipRefusedError);
    expect(() => assertRecipeAuthorshipAllowed("some_future_workflow_nobody_registered", "object_create", { object_type: "theme" })).toThrow(RecipeAuthorshipRefusedError);
  });
});

// ADR-2026-08-25-structure-studio §2.2: "Points 1 and 3 catch authorship; point 2 catches
// publication. A change that defeats all three is a deliberate act, which is the intent." All three
// enforcement points read the SAME per-workflow charter table above (points 1 and 3 directly, via
// mayAuthorRecipes; point 2 via the run's own snapshot of it, per ADR-2026-08-25-publish-autonomy
// §2.5) rather than three implicit, independently-drifting assumptions about who may touch a recipe
// — so there is exactly one lever that moves all three, and it is this file's own heavily-commented,
// ADR-cited PUBLISHING_CONDUCTOR_CHARTER constant, not an accident reachable from unrelated code. This
// suite proves the three points AGREE against that one table, for every charter this file declares —
// so widening it is the only way to widen any of them, and doing so is visibly, auditably deliberate.
describe("three-way consistency (ADR §2.2): the tool-permission audit, the runtime write guard, and the publish-time allowlist agree", () => {
  const syntheticNode = (allowedTools: string[]): WorkspaceNode => ({ ...structuredClone(listWorkspaceNodes()[0]), id: "synthetic_consistency_node", allowedTools });

  const publishPlanForRecipeType = (workflowId: string, objectType: string) =>
    buildObjectPublishPlan({
      report: {
        target: "test-project",
        createdObjects: [{ objectId: "obj_1", objectType }],
        reusedObjects: [],
        validationStates: [{ objectId: "obj_1", phase: "postcreate", valid: true }],
        quarantines: []
      },
      publishableTypes: resolvePublishableTypeCharter(workflowId).publishableTypes,
      workflowId
    });

  for (const charter of listPublishableTypeCharters()) {
    for (const recipeType of RECIPE_OBJECT_TYPES) {
      const grants = charter.publishableTypes.includes(recipeType);
      const label = grants ? "GRANTS" : "REFUSES";

      it(`${charter.workflowId} ${label} recipe type "${recipeType}" — points 2 and 3 agree per type; point 1 agrees at its own (coarser, per-workflow) granularity`, () => {
        // Point 1: the static audit. Coarser than points 2/3 by construction (a node's allowedTools
        // names a TOOL, never an objectType — see recipeAuthorityConformanceIssues's own comment) —
        // it agrees with mayAuthorRecipes (ANY recipe type), not with this specific type's own grant.
        const auditIssues = recipeAuthorityConformanceIssues([syntheticNode(["object_create"])], charter.workflowId);
        expect(auditIssues.length === 0).toBe(mayAuthorRecipes(charter.workflowId));

        // Point 3: the runtime write guard, precise per type.
        const attempt = () => assertRecipeAuthorshipAllowed(charter.workflowId, "object_create", { object_type: recipeType, requested_id: "obj_1" });
        if (grants) expect(attempt).not.toThrow();
        else expect(attempt).toThrow(RecipeAuthorshipRefusedError);

        // Point 2: the publish-time allowlist (objectPublishExecution.ts, unchanged by this task —
        // exercised here only to prove agreement, not to re-test its own logic).
        const plan = publishPlanForRecipeType(charter.workflowId, recipeType);
        expect(plan.publish.some((entry) => entry.objectId === "obj_1")).toBe(grants);
        if (!grants) expect(plan.withheld.find((entry) => entry.objectId === "obj_1")?.reason).toBe("type_not_publishable");
      });
    }
  }
});
