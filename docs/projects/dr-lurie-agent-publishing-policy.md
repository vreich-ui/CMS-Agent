# Dr. Lurie agent publishing policy

**Status: proposed — 2026-07-22. Derived from code and docs in `vreich-ui/Dr-Lurie-Blog` (at PR #463) and `vreich-ui/CMS-Agent`. Every rule cites the enforcing code or the authoritative doc. Where this policy disagrees with an older doc in either repo, this policy names that doc stale and wins.**

This is the policy an agent needs *beyond* the MCP tool contract: which pipeline to use, where its JSON goes, what shape the content must have, what the gates are, what costs money, and which mechanisms are stale and must never be used.

Authoritative upstream sources, in order:
1. Enforcing code in Dr-Lurie-Blog (`src/schema/bodies/content-item-v1.ts`, `netlify/lib/object-*.ts`, `netlify/lib/publish-gate.ts`, `netlify/lib/production-release.ts`, `netlify/lib/artifact-trust.ts`).
2. `Dr-Lurie-Blog/docs/agents/cms-agent-contract-alignment.md` (2026-07-19, user-ratified) and `docs/agents/cms-agent-enablement-runbook.md`.
3. `Dr-Lurie-Blog/docs/cms-architecture/08-articles-plan.md`.
4. Older agent docs (`publishing-instructions.md`, `mcp-final-agent-sequence.md`, `mcp-article-body-v1.md`) remain authoritative **only** for artifact-safety semantics and the error/status taxonomy — their tool sequences are legacy (§9).

---

## 1. The mental model (read this first)

1. **Two grammars.** The agent *authors* `article_body.v1` (CMS-Agent's minimal sibling grammar). The client *stores* `content_item.v1` objects. They are related but not identical; a mapping step stands between them (§4.6). Never send `article_body.v1` fields (e.g. `schema_version`) into a `content_item` write.
2. **Blocks, not blobs.** An article is never one body of text. It is a sequence of **functional blocks** — nodes with a `private.strategy` role (hook, agitation, proof, resolution, …) forming a persuasion/education arc. One giant text node is a policy violation even when it validates (§4.3).
3. **Publish ≠ Release.** `object_publish` commits JSON with `[skip netlify]` — it is free and invisible to readers. `release_to_production` triggers the one paid Netlify build that ships *everything* accumulated. Batch publishes; release once (§6).
4. **Artifacts are made by PDF-Tool, referenced by public path.** Agents never mint storage keys and never ship raw blob keys into renderable fields. Renderable `src` is always `/img/{id}/{sha}.ext` or `/pdf/{id}/{sha}.pdf` (§5).
5. **The request id is the spine.** `req_<flow>_<topic>_<yyyymmdd>_<nn>` is the workflow id, the artifact-trust scope, the content_item object id, and the committed filename. Get it right before doing anything else (§8).

## 2. System map — who owns what

| Concern | Owner | Enforcing location |
|---|---|---|
| Authoring workflow (ideation → draft → review → article body) | CMS-Agent workspace (Publishing Conductor nodes) | `CMS-Agent/src/agent/workspace/nodes.ts` |
| Authored grammar `article_body.v1` | CMS-Agent | `CMS-Agent/src/agent/mcp/workspace/store.ts` |
| Governed object store, `content_item.v1`, validation, review, publish, release | Dr-Lurie-Blog MCP (`Dr_Lurie_MCP_Server`, `netlify/functions/mcp.ts`) | `Dr-Lurie-Blog/netlify/lib/object-verbs.ts`, `object-validate.ts`, `object-publish.ts` |
| Artifact bytes (images/PDFs) | PDF-Tool via Dr-Lurie storage grant | `get_pdf_tool_storage_grant`; `Dr-Lurie-Blog/netlify/lib/artifact-trust.ts` |
| Serving images/PDFs to readers | Dr-Lurie-Blog Netlify redirects `/img/*`, `/pdf/*` → blob-backed functions | `Dr-Lurie-Blog/netlify.toml`, `netlify/functions/get-public-image.ts`, `get-public-pdf.ts` |
| Production deploys (the paid step) | Dr-Lurie-Blog `release_to_production` (agent) and `admin-release.ts` (human button) — same code path | `Dr-Lurie-Blog/netlify/lib/production-release.ts` |

The CMS-Agent workspace MCP is **not** the publishing backend and must not impersonate it (`CMS-Agent/docs/projects/dr-lurie-integration-notes.md`). It prepares content and drives the Dr-Lurie MCP verbs through `project.call_tool`.

## 3. The one current pipeline (object path)

Everything below is the **only** sanctioned publish path. The `save_json_blob_*` pipeline is frozen legacy (§9).

```
0. Pick request id            req_<flow>_<topic>_<yyyymmdd>_<nn>   (§8; never auto-generated)
1. Produce media FIRST        grant → PDF-Tool job → verify        (§5; fail-closed: media failure ⇒ no publish attempt)
2. object_create              content_item, object_id = request id (403 creation_restricted if policy blocks; §7.1)
3. object_checkout            take the lock (423/409 discipline; object_refresh_lock on long runs)
4. object_patch               node upserts, taxonomy, seo, hero — media as PUBLIC paths only
5. object_validate            dry-run the exact candidate patch; fix every blocker before continuing
6. object_publish             dark commit: '[skip netlify]', production.live:false — NO deploy
7. (repeat 2–6 per article)   batch as many articles as the run intends
8. release_to_production      ONCE for the whole batch — the only paid step
9. deploy_status {commit}     poll 10–15 s up to ~5 min until deployStatus:"ready" AND productionConfirmed:true
10. verify_article_images     with {url, expectedImages:['/img/…'], commit}; PDFs: fetch /pdf/… expect 200 %PDF-
11. object_checkin            release the lock
```

Enforcement anchors: dark-commit marker `NETLIFY_SKIP_MARKER = '[skip netlify]'` (`object-publish.ts:81`); single build trigger (`production-release.ts:119,158`); batch-release discipline stated in the tool contract itself (`mcp.ts:1108–1137`) and `cms-agent-contract-alignment.md:117`.

Expected non-errors an agent must not "fix":
- First `release_to_production` returning `build_not_confirmed_live` — the in-call wait is capped (~6 s); poll `deploy_status` instead of re-releasing.
- `verify_article_images` returning `inconclusive` before the deploy is live — deploy-aware by design; only `deployReady:true` verdicts are definitive.
- `build_ready_not_published` / `productionConfirmed:false` — Netlify Auto-Publishing is locked; a **human** unlocks or publishes the deploy. Stop and report; do not re-trigger builds.

## 4. Where and what to add to the client's JSON

### 4.1 Where it lands

A published `content_item` materializes to **`src/data/site/articles/{request_id}.json`** in Dr-Lurie-Blog (`netlify/lib/materializers/content-item.ts:18`). Agents never write this file — it is the server-side export of `object_publish`. The reader URL comes back in the publish response (`production.article_path`, `object-publish.ts:369`); use that plus `verify_after_release` — never hand-construct reader URLs (legacy `/post/<slug>` is dead, §9).

### 4.2 Body envelope (`content_item.v1` — `src/schema/bodies/content-item-v1.ts:233`)

All objects are zod `.strict()` — **unknown fields are rejected at every level**, and there is **no `schema_version` field** in the body.

| Field | Required | Rule |
|---|---|---|
| `slug` | ✔ | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`; collision with a committed post is a validation blocker |
| `title` | ✔ | non-empty |
| `nodes` | ✔ | array of nodes (§4.3); ≥1 reader-visible node required to publish |
| `deck`, `description` | – | short standfirst / summary |
| `image` | – | hero `{src, alt}` — `src` must be `/img/…`; **a PDF can never be the hero** |
| `taxonomy` | – | `{category, tags[]}` — every term must resolve **active** in the `tax_drlurie` registry (§7.4) |
| `seo` | – | `{meta_title, meta_description, canonical_url}` |
| `editorial` | – | `{framework, writer_notes}` — framework names the arc (e.g. PAS); deviation **warns, never blocks** |
| `sources`, `claims`, `compliance`, `scores[]`, `lineage`, `emotional_strategy`, `publication_context` | – | judge/audit substrate; carried verbatim, never rendered |

### 4.3 Nodes — the functional-block rule (POLICY, stricter than schema)

Node anatomy (`content-item-v1.ts:99`): `id`, `kind ∈ {content, action, placement, interactive}`, `public` (required), `private`, `commercial`, `chat`, `rendering`, `visibility ∈ {public, internal, hidden}`.

**Policy requirements on top of the schema:**

1. **Decompose.** An article body is authored as multiple nodes, one functional block each. A single node carrying the whole article text is non-compliant even though the schema allows it.
2. **Every content node declares its function** in `private.strategy` — closed enum (`article-content-v1.ts:66`):
   `hook · agitation · context · explanation · proof · example · comparison · myth · step · recommendation · resolution · summary`
   and `private.intent` — `educate · persuade · reassure · convert · navigate`.
   Offers/CTAs are **not** a strategy value: express them as `kind:"action"` nodes (`ctaText`/`ctaLink`) with `intent:"convert"`, optionally with the `commercial` field.
3. **Arc, then blocks.** Pick the framework first (PAS `hook → agitation → resolution → recommendation`, AIDA, Before-After-Bridge, or a house arc — `08-articles-plan.md:243–245`), record it in `editorial.framework`, then write one node per beat. Live reference shape: `req_agent_niacinamide_barrier_after40_20260719_01.json` — seven nodes, `hook → context → explanation → proof → myth → step → summary`, each with `public.title` + rich `public.body`.
4. **`private` never renders.** Enforced twice: the renderer emits only `public` fields (`render-nodes.ts:280`) and the reader-safety check blocks the words `private, strategy, agentNotes, sourcePromptId, inputTemplateId` from the reader projection (`object-validate.ts:594`; `assert-reader-safe.ts:5`). Never copy strategy labels into visible text.
5. **Node ids are opaque.** `/^n_[a-z0-9]+$/i` **minus** the forbidden words `hook, agitation, cta, advert, offer` (`content-item-v1.ts:48–58`). Author **lowercase only** (`n_open`, `n_evidence`); the role lives in `private.strategy`, never in the id. (Note the regex's `/i` flag technically admits uppercase — treat lowercase as mandatory anyway; see §10.1.)

### 4.4 Rich text per block

`public.body` is `string | rich_text.v1` (`content-item-v1.ts:81`). **Prefer `rich_text.v1` for every content block**; use plain strings only for genuinely flat copy (they render escaped: blank line → paragraph, single `\n` → `<br/>`).

`rich_text.v1` (Contentful-shaped: `nodeType`/`content`/`value`/`marks`/`data` — `src/lib/richtext/rich-text-v1.ts`):
- **Blocks:** `paragraph`, `heading-2`, `heading-3`, `unordered-list`, `ordered-list`, `list-item`, `blockquote`.
- **Marks:** `bold`, `italic` — nothing else.
- **Inline:** `hyperlink` only; `data.uri` non-empty, no whitespace; **https-only survives render** (`SAFE_HREF_RE = /^https?:\/\//` in both `object-validate.ts:262` and `node-renderer.ts:56`; sanitizer tag set `p,br,strong,em,a,ul,ol,li,h2,h3`).
- **Embeds (`embedded-entry`/`embedded-asset`) are schema-legal but validation- and render-blocked** — do not author them. Inline images go through node `media`/`images[]`, not rich-text embeds (`cms-agent-contract-alignment.md:40`).

### 4.5 Media on a node

`public.media` = `{type ∈ image|video|audio|embed|document, src, alt, caption, title, contentType}`; multi-image via `public.images[]`. `src` rules in §5. Hero is body-level `image {src, alt}` — **not** a `featuredImage` publish argument (that is legacy, §9).

### 4.6 Mapping from the authored grammar (`article_body.v1` → `content_item`)

When CMS-Agent materializes its authored body into an `object_create`/`object_patch`:
- **Drop** `schema_version` (content_item has none; strict schema rejects it).
- **Root** `slug`, `title`, `deck`, `description`, `taxonomy`, `seo`, `image`, `editorial` at the body — they are not node fields.
- **Preserve** node ids (`n_*` lowercase), `kind`, `visibility`, `public.*`, and carry strategy annotations into `private.strategy`/`private.intent` (T9.22: "strategy annotations preserved into `private.*`").
- **Convert** every artifact reference to its public path before the write (§5.3).
- **Validate** with `object_validate` (candidate_patch dry-run) before `object_publish` — same checks, full report (`cms-agent-contract-alignment.md:75–76`).

## 5. Media and artifact policy

### 5.1 Production (fail-closed, grant-brokered)

1. `get_pdf_tool_storage_grant` once per session; pass the **entire grant** as the `storage` argument of every PDF-Tool call. **Never persist the grant or its token** into workflow JSON, drafts, article content, or artifact metadata. Expired grant → fetch fresh, retry **once** (`docs/agents/pdf-tool-storage-grant.md`).
2. Generate via PDF-Tool `create_agent_artifact_job` → poll `get_agent_artifact_job_status`. Request `requirements.image.outputFormat:'webp'` and `requirements.maxBytes` within budget (may lower the cap, never raise it).
3. Image formats: **JPEG/PNG/WebP only** (server-decoded by sharp; GIF/AVIF/SVG rejected — `image-validation.ts:19`). Budget: `maxImageBytes` 153,600 (~150 KB), `preferredImageFormat` webp, over-budget currently **warns** (`src/config/media-policy.ts`) — treat the warning as a defect to fix, not noise.
4. PDF jobs require a **published** PDF template — preflight `list_pdf_templates`, else `create_pdf_template` → `publish_pdf_template`.
5. Verify materialization (PDF-Tool `verify_agent_artifact` and/or `list_artifacts_for_request`) **before** any object write. Media failure ⇒ stop; do not publish a degraded article.

### 5.2 Trust scope

Artifact references are trusted **per request id** only (`artifact-trust.ts:78`): uploaded for THIS request or already in `agent_outputs[*].output.artifactReferences`. Cross-request reuse is rejected by design; soft-deleted refs are untrusted until restored. Never synthesize a blobKey, repo path, or URL — store what the server returned, exactly.

### 5.3 The reference-form rule (the flip that broke builds)

- Raw blobKey ("Major Key"): `image/{req}/{sha256}.ext`, `pdf/{req}/{sha256}.pdf` (`MAJOR_KEY_ARTIFACT_REF_RE`, `artifact-trust.ts:5`). Belongs **only** in `*AssetRef` / `artifact_ref` carrier fields (`RAW_REF_CARRIER_KEY_RE`, `object-validate.ts:784`).
- Public renderable path: `/img/{req}/{sha}.ext`, `/pdf/{req}/{sha}.pdf` (`PUBLIC_ARTIFACT_PATH_RE`; served via `netlify.toml` redirects — a URL rewrite over the blob store, no committed asset needed).
- **A raw blobKey in any renderable field is a write-blocker** (`checkRenderableImageRefs`, `object-validate.ts:786`) — it 404s in the browser and can fail the whole Astro build. Convert with `publicPathForArtifactRef` semantics (`artifact-trust.ts:17`): prefix rewrite `image/… → /img/…`, `pdf/… → /pdf/…`.
- Also blocked in `media.src`: `data:` URIs and legacy repo paths (`src/assets/…`). Remote `https://` and bare site paths **warn** — avoid them; article media should be materialized artifacts.
- **A PDF can never be the hero** — write-blocked (`forbidPdf` on hero, `object-validate.ts:1843`); PDF belongs in `media {type:'document', src:'/pdf/…'}` or an action node's `ctaLink` with the exact artifact-derived path.

## 6. Release and build-cost policy

**The paid event is the Netlify production build. Everything before it is free.**

1. `object_publish` **never** deploys — every export commit carries `[skip netlify]` (`object-publish.ts:81`). Publish as many articles as the batch needs.
2. `release_to_production` is the **only** sanctioned build trigger for agents; it POSTs the build hook **once** and returns receipts (`released:true` only when the *published* production deploy matches the target commit — `production-release.ts:119–214`). One release ships **all** accumulated dark commits.
3. `trigger_netlify_build` is **not** for agents on this path (deliberately excluded from the enablement allowlist — it queues a build with no production confirmation). The human "Release to Production" admin button drives the same `releaseToProduction` code path, so batching discipline is identical for humans and agents.
4. Release cadence is a **client-side/human decision**. Default posture: agents accumulate dark publishes and either (a) call `release_to_production` once at the end of an approved batch run, or (b) leave release to the human button. A run must never emit more than one release; "publish 5, release 5×" is a policy violation with direct cost.
5. Scheduling/unpublish do **not** exist on this path: `published_time` future → `scheduling_not_supported`; `null` → `unpublish_not_supported` (`object-publish.ts:174–188`). A released article stays live until edited — **publish only go-live-acceptable content.** Timed drops are orchestrated upstream (CMS-Agent schedules the *batch*), not via the object verbs.
6. Rollback honesty: the build hook always builds branch HEAD. Content rollback = inverse patches → republish → re-release. Deploy rollback = human publishes an earlier deploy in Netlify UI. `release_to_production {commit:<old>}` can only *verify* an old commit, never rebuild it.

## 7. Gates — who may do what

Four independent gates stand between an agent and a live page. **Granting one never implies another** (this is the "three separate approvals" runbook, plus verification as a fourth duty):

### 7.1 Access: tool allowlist (CMS-Agent project config)
The `dr-lurie` project connection currently exposes a **read-only + artifact** allowlist (`CMS-Agent/src/agent/projects/drLurie/definition.ts`) — **no object verbs, no release, no deploy_status**. Enabling the object path means a human expands the allowlist per `cms-agent-enablement-runbook.md`, which also names the **deliberate exclusions**: all `save_json_blob_*`, `trigger_netlify_build`, `save_artifact`, `create_artifact_upload_intent`, `create_artifact_from_url`, `object_review_decide`, `wipe_blob_stores` (stays needs-approval).

### 7.2 Policy: publish enablement (CMS-Agent side)
`publishingPolicy.publishEnabled` is server-enforced `false` and not patchable; the operator override is the env flag `DR_LURIE_PUBLISH_ENABLED=true` in the deployment (`CMS-Agent/src/agent/workspace/publisher.ts:56–62`). Even then, every `workflow_publish_run` needs `approved:true` **and** `live:true` **and** a GO from the readiness hook (verified media refs, taxonomy, pinned approval, hard constraints — `publishReadiness.ts`). The flag alone publishes nothing.

### 7.3 Object-store gates (Dr-Lurie side)
- **Creation policy** (`src/config/creation-policy.ts`): master `open`; `content_item` is agent-creatable; `tracking_config` restricted. Denial = 403 `creation_restricted`. `agent_name` is self-declared attribution over the shared publish key — a coordination seam, **not** a security boundary (per-agent credentials are an open item, §10.5).
- **Approval policy** (`src/config/approval-policy.ts`): master `all-autonomous`; `product` requires approval; `content_item` is Tier-1 autonomous **today**. If the human flips it to require-approval, the M-6 pin applies: approval pins `content_revision` + `publish_action` (`'immediate'` | ISO | `null`) and optionally `request_id` / `artifact_set` (exact set match) / `release_build` (`'defer'|'release'`). Any mismatch is a 403 with a specific denial code (`publish-gate.ts:84–96`: `approval_stale`, `publish_action_mismatch`, `publish_artifact_set_mismatch`, …). Further patches after approval make it stale by design.

### 7.4 Content gates (validation blockers)
Strict schema; taxonomy terms must resolve **active** in `tax_drlurie` (slug or `term_id`, `merged_into` aliases followed; unknown terms block — `object-validate.ts:394–418`); slug collisions block; raw blobKeys in renderable fields block; reader-safety leak check blocks; ≥1 reader-visible node to publish; media budget per policy.

## 8. Naming and identity

| Thing | Rule | Source |
|---|---|---|
| Request/object id | `req_<flow>_<topic>_<yyyymmdd>_<nn>`, lowercase snake, date = today, `nn` 01–99, **caller-supplied, never generated** | `src/lib/agents-naming.ts`; `content-item-v1.ts:27–31` |
| Node id | `n_` + lowercase alnum, opaque, no `hook/agitation/cta/advert/offer` | `content-item-v1.ts:48–58` |
| Slug | kebab-case `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | `content-item-v1.ts:238` |
| blobKey | `{image|pdf}/{requestId}/{sha256}.{ext}` — server-minted only | `artifacts.ts:434` |
| Public media path | `/img/{req}/{sha}.{ext}`, `/pdf/{req}/{sha}.pdf` | `artifact-trust.ts:8–23` |
| PDF template id | `tpl_<project>_<purpose>_<variant>_v<version>` | `naming-convention.md` |
| Artifact slot | role-named (`img_hero`, `pdf_guide`), never storage-named | `naming-convention.md` |

A malformed request id is accepted at create but hard-400s every later artifact operation with no recovery — start over with a correct id.

## 9. Stale mechanisms — never use (the pre-object-model register)

The blog's post collection was wiped (83 markdown posts deleted; `src/data/post/` holds one dry-run leftover) and the 5-agent pipeline's markdown terminus is a dead end (`T9.22-repoint-ai-publisher.md`). The following are **frozen or inverted**; an agent (or a doc it reads) using them is operating pre-v1:

| Stale mechanism | Status | Replacement |
|---|---|---|
| `save_json_blob_*` tool family (create/checkout/patch/publish_by_time/checkin, `{agent}_update_output`…) | Frozen legacy; zero new writes; **do not allowlist** | `object_create/checkout/patch/validate/publish/checkin` |
| `publish-article.ts` markdown commits to `src/data/post/{slug}.md`; reader URLs `/post/<slug>` | Collection wiped; dead end | content_item JSON export `src/data/site/articles/{req_id}.json`; URL from publish response `article_path` |
| `article_body.v1` `schema_version` label sent to the client | content_item body has **no** `schema_version`; strict schema rejects it | drop at mapping (§4.6) |
| Raw blobKey in `media.src` (old rule: "src MUST be the raw pointer") | **Inverted** — now a write-blocker in renderable fields | public `/img/…`, `/pdf/…` paths (§5.3) |
| `featuredImage` publish argument + frontmatter `image:` | Legacy publish payload | body-level `image {src, alt}` |
| `rendering.placement:"inline"` as the render gate (silent `image_not_rendered` drop) | Legacy markdown renderer semantics | object renderer renders `public` media directly; placement is optional metadata |
| `published_time` future scheduling / `null` unpublish | `scheduling_not_supported` / `unpublish_not_supported` on the object path | immediate publish only; batch timing upstream; unpublish does not exist |
| `trigger_netlify_build` as the agent's release verb | Excluded from allowlist; no production receipts | `release_to_production`, once per batch |
| `save_artifact`, `create_artifact_upload_intent`, `create_artifact_from_url` | Legacy transports (grant-only posture; CMS-Agent's executable policy already blocks them at call time) | PDF-Tool grant flow (§5.1) |
| Standalone `mcp/save-json-blob-mcp` mirror (auto-generates `req_<uuid>` ids!) | Legacy mirror of a frozen pipeline; its auto-ids violate the id contract | main MCP object verbs |

**Stale items inside CMS-Agent itself** (flagged for cleanup; this policy supersedes them):
- `agent-publishing-instructions.md` (repo root, 2026-07-03): documents the frozen `save_json_blob_*`/markdown pipeline as current, including raw-blobKey `media.src` and `featuredImage`. Superseded by this policy.
- `src/agent/workspace/publisher.ts` tool sequence (`save_json_blob_create_article_draft → checkout → publish_by_time → checkin`): drives the frozen pipeline. The gate logic around it (§7.2) is current; the tool sequence needs repointing at the object verbs before enablement.
- `src/agent/projects/drLurie/knowledge.ts` artifact rules: "Do not rewrite ArtifactReference blobKey values into reader-facing public URLs" and "top-level `output.artifactReferences[]`" are legacy-path rules — on the object path the public path **is** the renderable reference (§5.3). The "future CMS object model" framing is stale: the object model is live.
- `docs/projects/dr-lurie-integration-notes.md`: same "future architecture" framing; media/verification cautions remain valid.
- `DR_LURIE_ALLOWED_TOOLS` (`drLurie/definition.ts`) allowlists `save_artifact`/`create_artifact_upload_intent`/`create_artifact_from_url`, which `executablePolicy.ts` then blocks at call time — net-blocked but self-contradictory; align the allowlist with the enablement runbook's exclusions.
- `articleBodySchema` (`store.ts`): plain-string-only `public.body` (no `rich_text.v1`), and its rendered-src pattern accepts **both** raw `image/…` and `/img/…` forms — the mapping layer must convert explicitly (§4.6), and the authored grammar should gain rich-text support to stop flattening block content.

## 10. Known divergences and open items (for the human)

1. **Node-id case sensitivity.** Blog code: `/^n_[a-z0-9]+$/i` — the `/i` admits `n_Intro`. CMS-Agent standalone schemas: `^n_[A-Za-z0-9]+$`. Effective acceptance is the same today; the *convention* everywhere (docs + all live articles) is lowercase. Recommendation: standardize authored ids to lowercase (this policy, §4.3.5) and, if strictness is wanted, drop the `/i` in the blog schema and tighten CMS-Agent to `^n_[a-z0-9]+$` in the same change. Note CMS-Agent also lacks the forbidden-word check the blog enforces.
2. **`blocks_write` is not a tool** — it is a constraint-severity value in the object contract (`src/lib/registry/object-contract.ts:216`). Task briefs citing "blocks_write enforcement" mean write-time validation blockers generally.
3. **Node kinds:** code enforces 4 (`content/action/placement/interactive`); `article-content-structure.md` still lists 5 (`reference` is deferred). Code wins.
4. **Pinning docs divergence:** `03-mapping-and-agent-contract.md` describes the M-6 pin as `{content_revision, publish_action}`; the enablement runbook adds `{request_id, artifact_set, release_build}`. The code implements all of them together (`publish-gate.ts:116–290`); follow the runbook's fuller pin for content_item.
5. **`agent_name` is self-declared** over the shared publish key — attribution, not authentication, until per-agent credentials land (OQ-3).
6. **Hero materialization tension:** `08-articles-plan.md` describes materializing artifact bytes into `src/assets/**/uploads/{slug}/`, while the ratified contract serves media from blobs via `/img/*`. The serving redirects are live; treat committed-asset materialization as an export detail owned by the blog repo — agents only ever reference `/img/…` paths either way.
7. **CMS-Agent enablement sequencing:** repoint `publisher.ts` to the object verbs *before* expanding the allowlist (§7.1) or flipping `DR_LURIE_PUBLISH_ENABLED` (§7.2) — otherwise the first enabled publish drives the frozen pipeline. Track as the follow-up to the T9.22 repoint on the blog side.

## 11. Result classification (report honestly, always)

Adopted verbatim from the ratified taxonomy (`publishing-instructions.md`, still authoritative for statuses):
- **PUBLISHED** — 2xx, no warnings, and conclusive live verification (`verified:true`, `deployReady:true`).
- **PUBLISHED_WITH_DEFECTS** — 2xx but warnings (e.g. media budget) or verification found missing media.
- **PUBLISHED_VERIFICATION_INCONCLUSIVE** — 2xx but the deploy never confirmed ready / verify stayed `inconclusive`.
- **PUBLISH_FAILED** — non-2xx; nothing committed.

Never report PUBLISHED without conclusive verification, and never call `release_to_production` a success without `productionConfirmed:true`.
