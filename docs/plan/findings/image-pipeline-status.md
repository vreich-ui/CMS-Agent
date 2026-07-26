# Image pipeline — status after fix

**Date:** 2026-07-26 · **Plane:** Cloud Run + GCS (canonical) · Scope: pdf-tool + Dr. Lurie connection only. No nodes were added or edited.

---

## Root cause

pdf-tool was **not migrated — it was re-registered from scratch on GCloud** using the read-only onboarding recipe in `project.get_registration_contract`. Its `contentContract: content_source.v1` and `defaultToolPolicy: blocked` were the contract's *defaults*, and onboarding step 5 says "allow-list the safe read-only tool names" — which is exactly the 8 it had. Nobody returned to grant the write tools.

The authoritative required set was already in your workspace: `article_body`'s output schema has a `requiredPdfToolCapabilities` enum naming exactly 11 pdf-tool tools. Five were missing.

---

## Changed (2 config writes, both on `project.update`, both in the change ledger)

| field | before | after |
|---|---|---|
| `allowedTools` | 8 | **14** |
| `contentContract` | `content_source.v1` | `article_body.v1` |
| `defaultToolPolicy` | `blocked` | **`blocked` (kept)** |

Restored: `create_agent_artifact_job`, `search_images`, `update_image_search_candidate`, `import_image_from_url`, `import_images_from_url`.
Added: `verify_agent_artifact` (approved separately — see below).

**`defaultToolPolicy` deliberately left as `blocked`.** Netlify had `allowed`. Deny-by-default is the safer setting and every required tool is now explicitly allow-listed, so this is the one place I did not restore Netlify's value. Reverting it would grant every future pdf-tool tool automatically.

**Why `verify_agent_artifact` was needed.** `publish_payload`'s prompt states: *"Pattern-valid blobKeys alone are not proof."* It requires evidence that each reference was materialized by pdf-tool for the current request. `verify_agent_artifact` is the only tool that produces that evidence, and it was allow-listed on **neither** plane — an original gap, not a migration regression.

---

## Verified live, end to end

Ran the real protocol using the direct MCP connections:

| step | result |
|---|---|
| Dr. Lurie issues storage grant | ✅ `netlify-pat`, 6 stores, limits `maxImageBytes 153600` / `webp` / `warn`, ~1h TTL |
| pdf-tool reads Dr. Lurie blob with grant | ✅ image model policy (`fal-ai/flux-2/klein/9b`) + search policy (5 providers, license rules) |
| pdf-tool **writes** to Dr. Lurie blob | ✅ 54,586 B, under the 150 KB limit |
| ArtifactReference returned | ✅ all 5 required fields; blobKey matches `^image/req_[a-z0-9_]+/[a-f0-9]{32,128}\.(png\|jpg\|jpeg\|webp)$` |
| `verify_agent_artifact` | ✅ `verified: true` — safety, blobKeyBinding, persisted, bytesHash all pass; returned a signed `materializationProof` |
| Dr. Lurie artifact index sees it | ✅ `list_artifacts_for_request` returns it with license metadata intact |

**The agent → pdf-tool → client-blob → reference loop works.** The plumbing is sound.

---

## Still blocking — 3 items

### 1. Cloud Run environment variables · you must do this

Both projects report `endpointConfigured: false, tokenConfigured: false` on GCloud. Four variables are unset:

```
DR_LURIE_MCP_ENDPOINT     DR_LURIE_MCP_TOKEN
PDF_TOOL_MCP_ENDPOINT     PDF_TOOL_MCP_TOKEN
```

Values live in the Netlify site config and, per the registration contract, *"are configured in the deployment and never pass through MCP"* — so I cannot read or set them. Copy them from Netlify → Cloud Run, redeploy, then confirm:

```
project.get("dr-lurie")        → connection.endpointConfigured/tokenConfigured = true
project.get("pdf-tool")        → same
project.test_connection("dr-lurie")
project.test_connection("pdf-tool")
project.list_tools("pdf-tool") → should list all 14 allow-listed names
```

Until this is done, CMS-Agent on GCloud cannot reach either service — the config fix above is necessary but not sufficient.

### 2. `article_body` schema mismatch · blocks every image-bearing article

This is independent of the migration and **not fixable by config**. Two schemas disagree, and no image node can satisfy both:

| | `article_body_validate` (workspace tool) | `article_body` node `outputSchema` |
|---|---|---|
| `rendering` key | **rejects** — `unrecognized_keys: ["rendering"]` | **requires** `rendering.placement` when `public.media` present (conditional `allOf`) |
| `media.artifactReference` | `string` | `object` with 5 required fields |
| `public.images[]` | not supported | supported |
| `private` / `chat` | not supported | supported |

Proven both directions:
- media node **without** `rendering` → `article_body_validate` says `valid: true`; the node's own schema would reject it.
- media node **with** `rendering.placement: "inline"` → `article_body_validate` says `valid: false`.

Your Dr. Lurie knowledge rules describe exactly this failure mode: *"A node missing inline placement can disappear from the published body even if it appears in admin preview."* So an agent can validate an article, get a green light, and ship an article whose image silently vanishes on publish.

The workspace-level validator is running a reduced/stale copy of the schema. It needs to be regenerated from the `article_body` node's `outputSchema` — a backend change in the tool definition, not a node edit.

### 3. requestId format mismatch · creates unreachable artifacts

pdf-tool accepts `^req_[a-z0-9_]+$`. Dr. Lurie enforces `req_<flow>_<topic>_<yyyymmdd>_<nn>` and rejects anything else:

> `request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn> using lowercase snake_case.`

My first import used `req_cms_agent_image_smoke_20260726` — pdf-tool **accepted it and wrote the bytes**, but Dr. Lurie's index cannot list, reconcile, or delete that requestId. The artifact is orphaned in the blob store.

Every artifact schema in your workspace uses the permissive pattern, so an agent will hit this. Tighten the workspace-side pattern to the strict form, or have pdf-tool validate against the client's convention.

---

## Cleanup you need to run

`soft_delete_artifact` is admin-only and returned **"Authentication is required."** for my session, so I could not remove the two test artifacts. Both are the same 54 KB public-domain NASA image tagged `disposable`:

```
sha256  5b62bc51015e2eaee1978518b2c7e60ec67271608c6d6a8ce2a7bdc396af476f

image/req_smoke_imagepipeline_20260726_01/<sha>.jpg      ← listable, deletable
image/req_cms_agent_image_smoke_20260726/<sha>.jpg       ← orphaned, see item 3
```

Run `soft_delete_artifact` on the first with an admin credential. The second may need `reconcile_artifact_indexes` or direct blob access, since its requestId fails Dr. Lurie's validation.

---

## Order of work

1. Set the 4 Cloud Run env vars → verify with `project.test_connection` on both.
2. Regenerate `article_body_validate` from the node's `outputSchema` (item 2) — otherwise images pass validation and disappear at publish.
3. Tighten the workspace requestId pattern to the strict client form (item 3).
4. Delete the 2 test artifacts.
5. Re-run the live loop through CMS-Agent's `project.call_tool` rather than direct MCP — that is the one hop still unproven, and it is approval-gated (`project.call_tool` is `write` + `requiresApproval`, and resolves as `approval_required` on `artifact_plan`).
