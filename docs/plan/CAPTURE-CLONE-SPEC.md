# Capture and Clone Conductors — Design Specification

**Status:** Definitive record · **Last updated:** 2026-08-25  
**Applies to:** T12–T15 (commits ea2f8c3 and earlier)

## Overview

CMS-Agent registers three workflows through a common seam (`workflowRegistry.ts`, §2.23), each a DAG of deterministic and AI-judgment stages composing toward its own product. All three share a single publishing tail when their work reaches production.

| Workflow | Purpose | Entry | Terminal | Product |
|----------|---------|-------|----------|---------|
| `publishing_conductor` | Author long-form DTC articles | content_intake | article_body → shared publish segment → article_report | Article (proposal + live) |
| `capture_conductor` | Crawl and emit third-party site content | capture_intake | capture_emit_live → shared publish segment → capture_report | Draft site map (live or withheld) |
| `clone_conductor` | Author structure and theme for cloned sites | clone_intake | layout_restamp → shared publish segment → clone_report | Site structure + theme (live or withheld) |

The workflows diverge upstream (intake → strategy stages → composition), compose the **ONE shared publish segment** (`publish_payload → publication_controller → publish_executor → release_executor → learning_recorder`, mandatory for every workflow that publishes), and are registered independently via `registerWorkflow()` in:
- `src/agent/workspace/workflowRegistry.ts` — publishing_conductor
- `src/agent/workspace/captureConductorWorkflow.ts` — capture_conductor  
- `src/agent/workspace/cloneConductorWorkflow.ts` — clone_conductor

---

## Publishing Tail — The One Converged Path (T15)

### Design Ruling (T14.5, T15)

**One publish implementation, policy-driven autonomy.**

T14.5 introduced `capture_publish` — a temporary side path that published autonomously. T15 unifies all three workflows on one shared publish segment, receiving a `publishingPolicy` input that specifies:
- `autonomyMode`: `"autonomous"` (publish by default, unless blocked by validation/veto) or `"operator-gated"` (require explicit human approval; absent defaults to `"operator-gated"`)
- `publishEnabled`: boolean (policy-wide gate)
- Explicit operator `withheld` veto via `set_operator_publish_decision`

**The shared publish segment** (`publish_payload → publication_controller → publish_executor → release_executor → learning_recorder`) is mandatory for every workflow that publishes. It publishes an object when **all conditions hold**:
1. The object's own validation passed (machine self-check)
2. Nothing quarantined it (emission, operator veto, or policy)
3. Authority is resolved (by `autonomyMode` policy + any explicit operator decision)

Everything withheld is named with its reason. The terminal report node (capture_report, clone_report, article_report) reports what went live and what was held back. (See ADR-2026-08-25-publish-autonomy for the authoritative policy semantics.)

### Publish Segment Nodes

All three workflows compose these nodes. They replace the earlier capture_publish and clone_publish nodes:

- **`publish_payload`** — boundary adapter; converts workflow-specific output to the run-scoped publish input
- **`publication_controller`** — deterministic gate: requires `decision:"go"` with no blockers
- **`publish_executor`** — deterministic publish: walks objects with machine self-check (object validation passed, not quarantined)
- **`release_executor`** (T15.6) — deterministic release: once per run, idempotent, verified
- **`learning_recorder`** — terminal: records structured observations for improvement

#### Terminal Report Nodes (per workflow)

**capture_report** (capture_conductor)
- **Kind:** reporting (deterministic, read-only)
- **Purpose:** Terminal assembly: rubric verdict, coverage delta, draft ledger, publication ledger (published/withheld), gaps by capability
- **Inputs:** capture_score, gap_adjudicator, capture_emit_live, release_executor
- **Outputs:** capture_run_report.v1 with publication block
- **Tools:** stage.get_output, stage.list_outputs, learning.record_observation
- **Note:** This is where the workflow ENDS. The publication block reports what went live and what was held back.

---

## Capture Conductor — Crawl and Emit (T12+)

### Scope
Read a live site's third-party content, draft a map/emission of what can be cloned, emit it as draft objects on a target site. No publish by default (T12.6–T13.3) until T14.5. Never authors recipes or structure; closed under third-party content routes.

### Node Sequence

1. **capture_intake** (det) — crawl a URL, read live theme and registries, assemble briefing
2. **block_classifier** (AI) — what type is each block?
3. **capture_map_refine** (AI) — refine the vocabulary match (type, structure, assets)
4. **capture_emit_live** (det) — walk the map through creates, patches, asset binds; emit the briefing's own record
5. **capture_score** (det) — measurement: deltas, coverage, gaps by missing capability, editorial/integrity verdicts
6. **gap_adjudicator** (AI) — for each residual gap: can a recipe close it? Carry disposition forward
7. **[shared publish segment]** (det, T15) — compose `publish_payload → publication_controller → publish_executor → release_executor → learning_recorder`; policy-driven autonomy
8. **capture_report** (det) — terminal: verdict, coverage, draft ledger, publication ledger, gaps, evidence feed, human summary

### Engine Files (Vendored)

See `src/agent/capture/provenance.ts` for the authoritative record. All nine files are vendored byte-faithful from platform/packages/core/cli/capture/, with one recorded deviation (screenshot-normalize.mjs, the lazy sharp import).

| File | Purpose | Vendored at |
|------|---------|-------------|
| snapshot-v1.mjs | Briefing envelope and snapshot helpers | T12.9 |
| map.mjs | DOM walk → typed block map (asset fidelity, shape recovery, canonicalization) | T14.3 |
| theme.mjs | Live theme read and validation | T12.9 |
| emit.mjs | Reuse-first emission: map → creates/patches/asset binds, quarantine, reason naming | T14.3 |
| score.mjs | Visual and structural coverage measurement; editorial/integrity verdicts | T12.16 |
| screenshot-normalize.mjs | Image rasterization and side-by-side comparison (lazy sharp import) | T12.16 |
| side-by-side.mjs | Diff visualization helper | T12.16 |
| clone.mjs | Clone intake bounded briefing, recipe validation, theme binding, restamp ops | T13.3 |
| publish.mjs | Autonomous publish stage: object publication, release coordination | T14.5 |

### Why Three Separate Workflows?

**publishing_conductor** is the article workflow — its product is an ARTICLE under DTC content rules, and it composes the publishing tail because articles have approval shape.

**capture_conductor** is read+draft only (T12.6 guarantee). Adding write would destroy the guarantee that makes capture safe against a stranger's site. Recipes are authored separately (clone_conductor).

**clone_conductor** is separate because its product is SITE STRUCTURE (source site's content rules apply, not DTC), and it must be authored independently.

Registering independently (§2.23 seam) lets each inherit the shared publishing tail without refactoring any node except the entry point.

**The copy/structure authority boundary (T15.29, #205; ADR-2026-08-25-structure-studio §2).** The line above — "Recipes are authored separately (clone_conductor)" — is over object TYPE, not over verb: `publishing_conductor` keeps `object_instantiate_template` / `object_instantiate_section_template` (that is CONSUMPTION — a page built from a template, never a mutation of the template) but must never `object_create` / `object_patch` / `site_apply_theme` a recipe type (`theme`, the site singleton, `section_template`, page `template` — `publishableTypeCharter.ts`'s `RECIPE_OBJECT_TYPES`). Enforced at three independent points so this cannot drift the way the publish path once did: a static tool-permission audit over every workflow's canonical/composed node array (`recipeAuthorityConformanceIssues`), a publish-time type allowlist (this file's own §6.3-derived charter, enforced in `objectPublishExecution.buildObjectPublishPlan`), and a runtime write guard in the emission transport (`assertRecipeAuthorshipAllowed`, wired into `publisher.ts`'s DTC publish path). Every future publishing workflow composed through the §2.23 seam inherits all three by construction — the charter table in `publishableTypeCharter.ts` is the one place a new workflow declares what it may author, and that declaration alone drives all three checks.

---

## Clone Conductor — Author Structure and Theme (T13+)

### Scope
Given a capture emission, author recipes (structure diffs) and bound themes, mint and bind them to the target site. First authoring workflow (T13.1). All writes are draft writes through checkout/checkin/patch until clone_publish.

### Node Sequence

1. **clone_intake** (det) — read source emission, live registries, assemble bounded briefing
2. **layout_analyst** (AI) — where does structure diverge? Can a recipe close it?
3. **recipe_designer** (AI) — design recipes from registered types only
4. **recipe_mint** (det) — re-validate; reject unregistered; write to draft storage
5. **theme_reconciler** (AI) — final bounded palette (the last token set)
6. **theme_bind** (det) — write the theme via site_apply_theme (the path that was missing)
7. **fit_adjudicator** (AI) — for each ledger entry the mint/bind stages could not place as-is, chooses the nearest registered stand-in or declines, naming the fidelity cost. (Corrected from "(det)" — Pass 2 Track B1: this node judges, it does not just re-validate; see `CLONE_AI_NODE_IDS` in `cloneConductorNodes.ts`, which lists it as one of the five AI nodes.)
8. **layout_restamp** (det) — re-assemble operations onto what actually minted
9. **[shared publish segment]** (det, T15) — compose `publish_payload → publication_controller → publish_executor → release_executor → learning_recorder`; policy-driven autonomy
10. **clone_report** (det) — terminal: verdict, recipe ledger, theme ledger, restamp ops, human summary

_(T15.34/#210 added a fourth branch after `layout_restamp` and before `clone_report` — `pdf_template_intake` (det), `pdf_template_designer` (AI), `pdf_template_mint` (det), `pdf_template_publish` (det) — not renumbered into the list above to avoid reflowing every reference to steps 9–10; see `cloneConductorNodes.ts` for its current position in the composed array and `CLONE_AI_NODE_IDS` for the authoritative AI-node roster.)

### Governance

**Recipes are data; section types are code** — the one boundary this may never cross.

- **recipe_designer** composes freely inside the registry's vocabulary (read at RUN TIME in clone_intake)
- **recipe_mint** re-validates every design against the registry and rejects anything unregistered
- **theme_bind** is the reason a theme exists: brandTokens is forbidden under set_site_fields; site_apply_theme is the only path and is paired checkout/release/finally so no lock is left on failure
- Tool policy can block site_apply_theme; the stage refuses by name (configuration decision, not routing)

### Why draft writes until clone_publish?

**Reuse-first design** (emit.mjs T12.28+): existing structure is patched in place, not quarantined. A route that already exists goes through checkout → patch → checkin under a paired release. Allows partial incremental updates.

---

## Publishing Policy — Autonomy Mode (T15)

T15 introduces `publishingPolicy` as a per-run input to the ONE shared publish path. This replaces workflow-level topology checks with policy-driven decision logic.

### Policy Input Schema

```typescript
interface PublishingPolicy {
  autonomyMode: "autonomous" | "manual";  // T15 ruling
  publishEnabled: boolean;                 // Gate: policy-wide off switch
  operatorVeto?: OperatorPublishDecision;  // Explicit veto via set_operator_publish_decision
}
```

### Publication Gates (All Checked, Fail-Closed if Any Blocks)

1. **Policy gate** — `publishEnabled: false` → refuse outright
2. **Operator veto** — explicit `set_operator_publish_decision` → refuse by name
3. **Machine verdict** — object's own validation must pass
4. **Quarantine** — emission, veto, or policy must not have quarantined it
5. **Autonomy gate** — `autonomyMode: "manual"` requires explicit approval (approval model: TBD, likely platform approval pattern)

Everything withheld is named with its reason in the terminal report's publication block.

---

## Workflow Registration Seam (§2.23, T13.1+)

**Problem solved:** how does a second workflow reach the shared publishing tail without refactoring every tail node?

**Solution:** registry seam in `workflowRegistry.ts`. Each workflow registers its canonical node array:

```typescript
export type WorkflowDefinition = {
  workflowId: string;
  canonicalNodes: () => WorkspaceNode[];  // Fresh copies per resolution
};

registerWorkflow({ workflowId: "publishing_conductor", canonicalNodes: listWorkspaceNodes });
registerWorkflow({ workflowId: "capture_conductor", canonicalNodes: listCaptureConductorNodes });
registerWorkflow({ workflowId: "clone_conductor", canonicalNodes: listCloneConductorNodes });
```

The executor stamps a workflowId on every run and resolves the run's canonical node array through the registry. An unknown workflowId falls back to publishing_conductor (the only entry before T13.1, so all existing runs behave byte-identically).

A composed workflow can register a `() => composeWorkflowNodes(...)` function instead of a direct list. Store overlays key by NODE id, so an authoring edit to a tail node (prompt, schema, tools, model config) reaches every registered workflow at once — the reason for the seam.

---

## Design Evolution

### T12: Capture Engine Vendored (2026-08-18)

**Commits:** fc1a704, 3ddccdc, 324887f, and T12.6–T12.31 series  
**Record:** src/agent/capture/provenance.ts

Decision: vendor platform's pure capture-stage modules byte-faithfully rather than port/reimplement. Reasons:
1. .mjs in another repo with no published package seam; a port would be a silent fork
2. Vendored bytes are verifiable: provenance.ts records upstream commit + per-file sha256; provenance test fails if vendored file drifts
3. Platform repo remains authoring home; capture changes land there first, then re-vendored here

**Reuse-first emission** (T12.28): existing routes patched in place instead of quarantined.

### T13: Clone Conductor Registered (2026-08-23)

**Commits:** f2562e7, 9259414, 9adba00, 193022b, 1ab6046, 9adba00

**T13.1: clone_conductor — third workflow, first that authors**

Wolf: *"what is the problem with adding templates and objects? Nothing."*

Clone needed a home because:
- Not publishing_conductor (product is site structure, not article; rules differ)
- Not capture_conductor (contract is read+draft only; authoring would destroy the guarantee)
- Solution: separate registration via seam, composes/reuses shared publishing tail, closes the gap capture left open

Deterministic-first law: 8 nodes, exactly 3 AI. Recipes are data; section types are code — the one boundary never crossed. Theme was unreachable (brandTokens forbidden under set_site_fields) until T13.1's theme_bind via site_apply_theme.

**T13.2–T13.5:** Bounded briefing, schema contracts, boundary adapter.

### T14: Capture Publishes By Default (2026-08-25)

**Commit:** ea2f8c3 (T14.5)

Added `capture_publish` between `capture_score` and `capture_report`. Vendors publish.mjs (78e67f0) as ninth engine file.

**What did not change:**
- emit.mjs's forbidden-verb set still bans object_publish and release_to_production
- Emission walks crawled third-party content through creates, patches, asset ingestion; nothing mid-walk reaches production
- trigger_netlify_build and deploy unreachable from every capture path including this one

**What stops it** (not human, by design):
- publishingPolicy.publishEnabled = false
- Operator explicit veto via set_operator_publish_decision
- Dry emission
- Machine verdict: object publishes when **this run's validation passed** and **nothing quarantined it**

Everything withheld is named with reason.

### T15: One Publish Path, Policy-Driven Autonomy (2026-08-25+)

**Ruling:** converge the two publish implementations (T14.5's capture_publish and the original publishing_conductor tail). Make autonomy a policy input to the ONE shared path, deleting the side path (src/agent/capture/engine/publish.mjs is at fail-open; the shared tail is fail-closed behind operator gate).

**Phase 0 (this issue):** document the design, fix stale in-repo statements.

---

## Acceptance Criteria (This Spec)

### ✓ Grep Test
No in-repo assertion that capture/clone cannot publish. Specifically:
- ❌ `src/agent/workspace/captureConductorNodes.ts:33-36` — removed claim "no node here is publish/admin"
- ❌ `src/agent/mcp/workspace/siteDuplicationTools.ts:364` — updated humanGate payload to report the real block (capture_report)
- ❌ `src/agent/workspace/workflowRegistry.ts` header — updated to reflect three workflows, not one

### ✓ Fresh Reader Test
A developer can learn the pipeline's design from this document and `docs/plan/` without reading git log -p.

---

## References

- **Provenance:** `src/agent/capture/provenance.ts` (hash-pinned engine files, per-commit record)
- **Workflows:** `src/agent/workspace/{workflowRegistry,captureConductorWorkflow,cloneConductorWorkflow}.ts`
- **Nodes:** `src/agent/workspace/{nodes,captureConductorNodes,cloneConductorNodes}.ts`
- **Commit history:** ea2f8c3 (T14.5), f2562e7 (T13.1), fc1a704 (T12 capture), c0c326b (early architecture)
- **Design decisions:** Commit bodies, especially T14.5 (ea2f8c3) and T13.1 (f2562e7)

