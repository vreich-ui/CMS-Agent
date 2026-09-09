# W4.3 — Does every tenant allow what its routes actually call?

**Date:** 2026-09-09 · **Source:** live CMS-Agent registry (`project.list`) against `routeRegistry.ts`
after W3.2.0 · **Status:** one finding fixed on the operator's decision the same day (see
"Resolved" below); the rest reported only. Changing a tenant's tool policy is an operator decision.

## What was checked, and why it is checkable now

W3.1 declared, per route and per stage, the tenant verbs the engine calls
(`routeRegistry.requiredTools`). W3.2.0 attributed the four that were still marked unverified. That
makes one question answerable for the first time: **for each tenant, is every verb its routes will
speak actually permitted by that tenant's own tool policy?**

Permission resolves exactly as `effectiveToolPermission` does — an explicit `toolPolicies` entry
first, then membership of `allowedTools`, then `defaultToolPolicy`. A verb that resolves to
`needs_approval` is **held, not forwarded**: `ProjectMcpAdapter.callTool` returns `ok:false` before any
transport. On an engine route that is a stage failure, not a prompt for a human — nothing on the
deterministic path knows how to wait for an approval.

24 distinct verbs across 11 route stages were checked against four tenants.

## Summary

| Tenant | Required verb-instances | Not allowed | Verdict |
|---|---|---|---|
| dr-lurie | 40 | 0 | Every route verb permitted — but see the note below; this is not the reassurance it looks like |
| zilberman | 40 | 7 | Three real gaps, one of them internally inconsistent |
| platform | 40 | 2 | Two admin verbs held at `needs_approval`; both break a route that has no way to wait |
| fernwell | 40 | 30 | Dead tenant (operator, 2026-09-09). Not a divergence and not a backlog item |

## dr-lurie — 0 divergences, and the reason is worth naming

`defaultToolPolicy: "allowed"`. Every verb not explicitly listed resolves to allowed, including
`object_publish`, `release_to_production` and `site_apply_brand_imagery`. So this tenant's own policy
is not a constraint on the engine at all: what stands between a node and a publish on dr-lurie is
CMS-Agent's own rules — the publish gates, the operator decision, and (as of W3.2) the choke point's
`FORBIDDEN_PROJECT_VERBS`.

That is a coherent position for a tenant CMS-Agent fully operates. It is worth stating explicitly
because "dr-lurie: all green" reads as defence-in-depth and is not.

## zilberman — 3 gaps

| Route stage | Verb | Risk | Permission |
|---|---|---|---|
| `clone_stage:pdf_mint` | `create_pdf_template` | write | **blocked** |
| `clone_stage:pdf_mint` | `validate_pdf_template` | write | **blocked** |
| `clone_stage:pdf_mint` | `get_pdf_template_validation` | read | **blocked** |
| `artifact_materializer` | `get_agent_artifact_by_slot` | read | **blocked** |
| `artifact_materializer` | `create_agent_artifact_job` | write | **blocked** |
| `artifact_materializer` | `get_agent_artifact_job_status` | read | **blocked** |
| `visual_standard_materializer` | `site_apply_brand_imagery` | admin | **blocked** |

Three findings, in order of how much they look like mistakes:

1. **`pdf_publish` is allowed while `pdf_mint` is blocked.** zilberman's policy explicitly permits
   `publish_pdf_template` and explicitly omits the three verbs that create the template being
   published. A clone run reaching the pdf branch fails at mint and never gets to the publish it is
   allowed to perform. **RESOLVED — see below.**
2. **`artifact_materializer` cannot run on zilberman at all.** All three of its verbs are blocked. If
   any workflow dispatches that node for this tenant, every slot fails.
3. **`site_apply_brand_imagery` is blocked**, so `visual_standard_materializer` cannot complete on
   zilberman. Given the verb restyles an entire site, this one may well be deliberate — but the node
   is dispatched without knowing that, so it fails rather than skipping.

## platform — 2 held verbs

| Route stage | Verb | Risk | Permission |
|---|---|---|---|
| `clone_stage:theme_bind` | `site_apply_theme` | admin | **needs_approval** |
| `visual_standard_materializer` | `site_apply_brand_imagery` | admin | **needs_approval** |

Both are the two site-wide admin verbs, and both are almost certainly a deliberate policy — an
operator chose "hold these" rather than "block these". The problem is what `needs_approval` means on
this path: the adapter refuses the call before transport, and a deterministic route has no approval
loop to enter. So the intended behaviour ("a human confirms before the whole site is restyled") lands
as a stage failure with no route to the confirmation.

This is the one finding in this report that is a **design gap rather than a configuration gap**: the
tenant's approval model and the engine's deterministic routes do not meet. Options, none taken here:
mark these routes as requiring an operator decision before dispatch (the publish-risk gate already has
that shape); teach the choke point to surface a held call as a named, resumable outcome; or accept
that these two nodes are operator-run only on platform.

## fernwell — dead

`status: "disabled"`, `defaultToolPolicy: "blocked"`, an allowlist of seven read verbs, and 30 of 40
required verb-instances blocked. The operator confirmed on 2026-09-09 that **fernwell is dead** — not
paused, not pending. Its rows are recorded here only so a future reader of this table does not
mistake them for a fleet-wide problem; there is nothing to fix and nothing to re-check.

Its record is still registered and disabled rather than deleted, which is the right resting state: a
disabled record keeps the id from being reused and keeps its history readable, and deleting it would
be an irreversible operator action nobody has asked for.

## Scope, stated so it is not mistaken for completeness

- **The DTC publish dialect is not in this table.** `publisher.ts` drives a tenant's own
  `executePublish` hook, whose verbs are per-tenant and are not declared in any route manifest, so
  there is nothing to check them against. That is the remaining unmanifested route family (see
  `nodeCapabilityAudit.ts`'s header).
- Permissions were read from the registry, not probed against each live server. A tenant whose server
  refuses a verb its registry record permits would not appear here.
- Numbers are verb-*instances* per route stage; a verb used by three stages is counted three times,
  which is why 24 distinct verbs give 40 rows.

## Resolved: the pdf-template gap, and where it actually came from

The operator confirmed the oversight, and the question "was this part of genesis?" turned out to be
the important one. **It was — with the causation running backwards from the obvious guess.**

`genesisTenantProfile.ts` says how its verb list was built: the UNION of (1) zilberman's LIVE
`toolPolicies` and (2) the verbs the capture/clone emission stages speak. (2) was a strict subset of
(1), so **the profile IS zilberman's hand-tuned map**. That was recorded at the time as the
reassuring outcome. It was the defect: one tenant's gaps were copied into the birth certificate of
every tenant minted afterwards. `genesis-lab-2` carries the identical hole, which is the proof.

The containment check that existed was real and insufficient — it covered emission, one route family
out of five, so nothing ever compared the profile against the pdf-template branch or against
`artifact_materializer`.

Two fixes, one per layer:

- **Live data (operator, `project.update`, 2026-09-09):** zilberman gains `create_pdf_template`,
  `validate_pdf_template`, `get_pdf_template_validation` — 35 entries, the other 32 byte-identical.
  Note for anyone repeating this: `toolPolicies` **replaces** the whole map rather than merging, so a
  three-key patch would have wiped the other 32 and, under `defaultToolPolicy: "blocked"`, disabled
  the tenant outright.
- **Code (`genesisTenantProfile.ts`, definition version 1 → 2):** the profile gains those three plus
  `get_agent_artifact_by_slot` / `create_agent_artifact_job` / `get_agent_artifact_job_status`,
  without which a minted tenant reports every PDF and image slot blocked — the same
  "minted tenant cannot do its job" class, one node over. The containment test now walks the ROUTE
  MANIFESTS instead of a hand-kept emission list: a verb a route declares must be either granted or
  named in `GENESIS_WITHHELD_ROUTE_VERBS`, so a gap and a decision can no longer look alike.
  `site_apply_brand_imagery` is the one entry on that withheld list.

The code fix reaches tenants the migration recognises — records carrying a `clientSiteBinding`.
zilberman and genesis-lab-2 carry none, so they are hand-tuned records: zilberman was fixed directly
above, and **genesis-lab-2 still has both gaps**.

## Remaining, in priority order

1. **genesis-lab-2** has the same two gaps zilberman had (pdf mint trio, artifact-job trio). It is a
   lab tenant, so this is only urgent if something is expected to run there.
2. **platform's two `needs_approval` verbs** are a design decision, not a configuration one — a
   deterministic route has no approval loop to enter, so the intended confirmation lands as a stage
   failure. Its own task.
3. ~~fernwell~~ — dead, closed.
