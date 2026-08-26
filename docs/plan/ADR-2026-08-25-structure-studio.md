# ADR — The Structure Studio charter

- **Status:** ACCEPTED (2026-08-25)
- **Task:** T15.28 (#204). The T15 series' second and last full-Opus decision.
- **Implemented by:** T15.29 (#205), T15.30 (#206), T15.31 (#207), T15.32 (#208), T15.33 (#209), T15.34 (#210).
- **Depends on:** ADR-2026-08-25-publish-autonomy (T15.4, #184). The studio publishes through the publish segment that ADR defines; nothing here re-opens publish semantics.
- **Verified against:** CMS-Agent `ac194ec`, platform `e9fb790`, pdf-tool `4a96297`.

---

## 1. The directive, and what the codebase already believes

Wolf, 2026-08-25: publishing workflows — the DTC `publishing_conductor` today, more later — focus on **copy** and should never author templates. The clone workflow becomes the fleet's **structure studio**: site structure, clone expertise and template design; serving all tenants with new structures; learning to do it better; kept current with TypeScript and platform standards; publishing finished templates and writing them to client memories; and the workspace for PDF templates.

The code is already leaning this way. `clone_conductor` is described in-repo as "the first workflow that authors." `publish.mjs:47-49` argues that a theme or `section_template` is a recipe and that "publishing a recipe is a deliberate studio act, not a side effect of cloning a page" — and then declines to publish one, because at the time of writing no workflow was chartered to make that act deliberately. `clone_report` already assembles a `capabilityBacklog` keyed by missing section **type**, which is precisely a studio saying "here is what the platform cannot yet express."

This ADR does not invent the studio. It charters the workflow that is already behaving like one, and closes the three gaps that stop it: it has no publish path, no authority boundary against the copy workflows, and no memory of what it has made.

**Naming.** The workflow keeps the id `clone_conductor`. Renaming a registered `workflowId` breaks existing runs and the registry's documented fallback (`workflowRegistry.ts`) for no functional gain. "Structure Studio" is its charter, not its identifier. Node *names* that assert something now false — `clone_report`'s "terminal — human gate" — are corrected by T15.10/T15.29, because those mislead a reader about behaviour rather than merely about branding.

---

## 2. Decision 1 — the authority boundary is over object TYPE, not over verbs

### 2.1 The line

**Structure authorship** is minting or mutating any object whose type is a *recipe* — `section_template`, page template, `theme`, site singleton. These are data the site reads at build time, shared across pages and, in the library's case, across tenants.

> **Only the studio authors structure. Copy workflows consume it and may never mint or mutate it.**

The boundary is over **object type**, not over verb, and getting this backwards would break the copy workflows for no safety gain. `object_instantiate_template` and `object_instantiate_section_template` are **consumption** — they create a *page* from a template without touching the template. `publishing_conductor` must keep them. What it must not have is the ability to `object_create` or `object_patch` an object whose type is a recipe.

| Workflow | Recipes | Pages/articles |
|---|---|---|
| `clone_conductor` (studio) | **author** — create, patch, version, publish | may create as evidence of a structure; not its purpose |
| `publishing_conductor` (copy) | **instantiate and read only** — never create, never patch | author freely |

### 2.2 Enforcement — three points, deliberately redundant

A single enforcement point for an invariant this load-bearing is not enough; the T14.5 fork happened in the gap between two mechanisms that each assumed the other was watching.

1. **Tool-permission audit (T15.29).** A conformance test over the canonical node arrays: no `publishing_conductor` node's `allowedTools` may reach a recipe-authoring call. Static, runs in CI, fails the build.
2. **Publish-time type allowlist.** Already decided in ADR #184 §6.3: `publishing_conductor`'s chartered publishable types exclude `theme`, page template and `section_template`, enforced in `publish_payload` and snapshotted onto the run. A copy workflow that somehow produced a recipe still cannot publish one.
3. **Runtime write guard (T15.29).** The emission transport refuses a governed write of a recipe type from a workflow not chartered for it, with a typed refusal naming the boundary — the same reject-never-coerce posture the engine already takes.

Points 1 and 3 catch authorship; point 2 catches publication. A change that defeats all three is a deliberate act, which is the intent.

### 2.3 What this does *not* restrict

The studio is not the only thing that may *touch* a live site, and copy workflows lose nothing they use today. `publishing_conductor` keeps instantiation, keeps page and article authorship, keeps its own publish path through the shared publish segment. The directive is about who designs structure, not about who is trusted.

---

## 3. Decision 2 — one node graph, two entry adapters

The question the issue poses is "one node graph or two composed variants?" **One graph.** Two variants is a fork, and this series exists because of a fork.

- **Clone-driven entry** (today): input carries a `captureRunId`; the structure brief is *derived* from the capture — layout analysis over a real snapshot.
- **Demand-driven entry** (T15.30): input carries a `structureBrief` directly — a tenant or another workflow asking for a structure that no capture produced.

`clone_intake` becomes the adapter for both: it normalizes either input into the same internal brief artifact, and everything downstream is byte-identically the same graph. Stages that genuinely require a snapshot (`layout_analyst`) are skipped on the demand-driven path through the existing `skipPredicates` machinery rather than through a second node array — skipping is an existing, tested seam and a second array is a new drift surface.

**Consequence for determinism (#200).** The two entries must converge: a demand-driven brief that is byte-identical to a clone-derived brief must produce byte-identical output. The normalization in `clone_intake` is therefore deterministic and total — no clock, no run id, no capture id leaking past it into anything the downstream stages hash or emit.

---

## 4. Decision 3 — the cross-tenant template library, and the `"ask"` floor

### 4.1 The library

A versioned, provenance-pinned library of finished templates, cross-tenant by construction and instantiated per tenant.

Every library entry carries:

- `templateId` — stable across versions;
- `version` — monotonic integer; a published template is **immutable**, and a change is a new version. Consistency over liveness: a tenant instantiated against v3 is not silently moved to v4.
- **provenance** — `sourceUrl`, `captureRunId` (when clone-driven), the vendored capture-engine hashes from `src/agent/capture/provenance.ts`, and the standards-pack version of §6. A template whose provenance cannot be stated is not publishable.
- the recipe body, and the section types it depends on.

Instantiation into a tenant uses the platform's existing `object_instantiate_template` / `object_instantiate_section_template`. No new instantiation mechanism is built — that would be the publish fork wearing a template's clothes.

### 4.2 The `"ask"` floor — resolved, not repealed

`object_instantiate_template` and `object_instantiate_section_template` carry approval floor **`"ask"`** (`platform packages/core/server/lib/mcp-tool-definitions.test.ts:62`, alongside `object_create`, `object_publish`, `object_retire`, `object_review_decide` and every membership write). Under autonomous operation, an `"ask"` floor is a human gate by another name — the exact thing ADR #184 removed from the publish path.

**Ruling.** The floor is **not repealed and not special-cased for the studio.** It is resolved by the *same* mechanism as publish authority, and that reconciliation is platform#615's ("one approval truth on the platform") job:

- The floor consults the calling project's `publishingPolicy.autonomyMode`, exactly as the tail's authority reader does, and is satisfied without a human when the mode is `autonomous`.
- An explicit **withheld** still halts — ADR #184's rule 1 is absolute and reaches here too.
- **Absent or unconfigured policy keeps `"ask"` meaning ask.** Fail-closed is preserved for every project that has not opted in, which is every project that is not deliberately configured for autonomy.
- The floor's *classification* does not change. `object_instantiate_template` stays in the `"ask"` set, exactly as publish nodes stay `riskLevel: "publish"` under ADR #184 §5 — a tool must never lower its declared risk to buy autonomy, because that is how it becomes invisible to every mechanism keyed on the classification.

Two approval systems disagreeing about the same tenant is the fork this series exists to delete. One policy, read in two places, is the fix.

---

## 5. Decision 4 — the client-memory contract

### 5.1 Schema

`src/agent/memory/memoryEnvelope.ts`'s `artifacts[]` entry is `{id, type, uri?, value?}` with `type` enumerated `"brief" | "draft" | "published_url" | "report"`. It gains **`"template"`**, and the template record's shape is declared (carried in `value`, so no existing consumer breaks):

```jsonc
{ "id": "<templateId>@<version>", "type": "template",
  "value": {
    "templateId": "...", "version": 3, "objectType": "section_template",
    "instantiatedObjectId": "...",
    "provenance": { "sourceUrl": "...", "captureRunId": "...",
                    "engineHashes": {}, "standardsPack": "2026.08" } } }
```

### 5.2 Who writes, who reads

- **Writer:** the studio's terminal stage, **deterministically**, never a model turn. A memory record is a ledger of what the run actually did; a model re-deriving it is the "model re-derives a fact the engine already holds" failure the determinism programme exists to remove.
- **Readers:** `client_manager` (the platform admin chat — so a client can be told what structures they have) and the copy workflows (so `publishing_conductor` can discover which templates a tenant owns before asking for one). Read-only for both: §2's boundary means a reader may instantiate, never mutate.
- Written to the per-project `memoryNamespace`, per project, never cross-tenant. The *library* is cross-tenant; a *client's memory* is not, and conflating them would leak one tenant's structures into another's context.

### 5.3 One determinism caveat, stated so it is not discovered later

`normalizeMemoryEnvelope` stamps `updatedAt: new Date().toISOString()` on every write. Memory is a **ledger, not run output**, so it sits outside the determinism boundary — but it therefore must never feed back into anything a run emits or hashes. T15.32 must not let a memory read introduce a wall-clock value into run output, or #200 will fail intermittently, which is the worst way for it to fail.

---

## 6. Decision 5 — the data/code boundary and the standards loop

### 6.1 The boundary holds, unchanged

> **Recipes are data. Section types are code.**

The studio mints recipes freely — that is its charter. A need that cannot be expressed by any existing section type is not a recipe the studio may invent; it is a **platform code change**.

### 6.2 The standards pack

A versioned pack of TS / component / a11y conventions, delivered through the existing skills machinery (`src/agent/skills/` — `skillRegistry`, `skillResolver`, `seededSkills`) and assigned to the studio's authoring nodes. It is **version-pinned onto every run and recorded in the template's provenance** (§4.1), so a template states which standards it was built against and a standards bump does not retroactively change what an existing template claims. This is what "kept current with TypeScript and platform standards" means operationally: the pack is updated, and the studio's next run builds against the new version and records it.

### 6.3 The capability-backlog loop

`clone_report` already produces `capabilityBacklog` — unmet needs grouped by the section **type** that would satisfy them. That artifact becomes the loop's input:

1. the studio records the unmet need with evidence — which structures wanted it, from which sources;
2. it emits a **structured capability request** naming the proposed section type, its fields, and the evidence;
3. a human initiates the platform section-type release;
4. the new type appears in `REGISTERED_SECTION_TYPES`, and the studio's next run can express the structure that was previously impossible.

### 6.4 May the studio draft platform PRs? **No — deliberately.**

The issue asks. The answer is no, and not for lack of capability.

A section type is code that renders on **every tenant's site**. The engine's standing invariant is that the deterministic engine authors governed writes while AI nodes stay advisory — and that invariant is about writes to *content objects*, whose blast radius is one tenant and whose failure mode is a visible, revertible bad page. Platform source has a different blast radius and a different failure mode, and extending an invariant across that gap because the mechanism happens to be available is exactly the reasoning that produced the T14.5 fork.

The studio therefore produces a capability **request** — structured, evidenced, and precise enough that a human's implementation is mechanical. It does not open the PR. If that boundary is later moved, it should be moved by its own ADR with its own argument, not inherited silently from this one.

---

## 7. Decision 6 — PDF templates

The studio is the workspace over pdf-tool's `pdf-template-store` (`create_pdf_template`, `validate_pdf_template`, `publish_pdf_template`, `get_pdf_template_validation`), under the **same design → validate → publish discipline**: deterministic authorship, validation before publication, and every withheld template named with its reason.

**The discipline is shared; the transport is not, and must not be confused.** A `pdf_template` is not a CMS governed object: it lives in pdf-tool's own store, it does not pass through `object_publish`, and it triggers no production release. So:

- PDF template publication does **not** compose the CMS publish segment, and this is not a second publish path — ADR #184's "one publish path" invariant governs *CMS object publication*, and a pdf_template is not one. T15.34 must state this in code comments where a future reader would otherwise see a violation.
- It **does** go through the studio's terminal ledger and client memory (§5) under `type: "template"` with `objectType: "pdf_template"`, so "what has this client got" has one answer, not two.
- `publishingPolicy.autonomyMode` governs it too, via the same policy read — an autonomous tenant does not get a human gate on PDF templates and a gated one does not lose it.

---

## 8. Invariants this ADR binds

1. **Only the studio authors structure.** Copy workflows instantiate and read; they never mint or mutate a recipe. Three enforcement points (§2.2).
2. **One studio graph.** Clone-driven and demand-driven are entry adapters, never separate node arrays.
3. **A published template version is immutable.** Change is a new version; provenance is mandatory and a template that cannot state it is not publishable.
4. **One approval truth.** The platform's `"ask"` floor and the tail's publish authority read the same project policy. Absent policy still means ask. `withheld` always halts.
5. **Recipes are data; section types are code.** The studio never authors platform source, and never opens the PR (§6.4).
6. **Memory is a deterministic ledger** written by the engine, read cross-workflow, scoped per tenant, and never a path for wall-clock values into run output.
7. **PDF templates share the discipline, not the transport** — and that is not a second publish path.

## 9. Consequences accepted

- **The studio becomes a dependency of every other workflow.** A copy workflow that needs a structure it does not have must wait for the studio. That is the directive's intent — one place that gets structure right — and the demand-driven entry (§3) exists precisely so that waiting is a request, not a blockage.
- **The `"ask"` floor changes meaning for autonomous projects**, which is a platform-wide behavioural change beyond the studio. It is scoped by policy, defaults closed, and is platform#615's to land carefully.
- **A capability gap stalls at a human.** By §6.4, deliberately. The cost is latency on genuinely new section types; the alternative is agent-authored code on every tenant's site.

## 10. Rejected alternatives

- **Two composed studio variants, one per entry mode.** Rejected: a fork, and this series exists to delete one.
- **Exempt the studio from the `"ask"` floor.** Rejected: a per-caller exemption is a second approval truth, and the floor would then be invisible for exactly the caller that uses it most.
- **Let copy workflows patch templates "just for their own tenant."** Rejected: a tenant-local mutation of a shared recipe is how a cross-tenant library silently forks per tenant, and it defeats §4.1's immutability with no mechanism to detect it.
- **Let the studio open platform PRs behind a review gate.** Rejected for now, with the reasoning in §6.4 — and explicitly left as a decision a future ADR may revisit on its own merits.
