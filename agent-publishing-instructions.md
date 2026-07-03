# Agent publishing instructions — Dr. Lurie Blog
*Updated after image/publish pipeline overhaul. Supersedes docs/mcp-final-agent-sequence.md and docs/agents/pdf-tool-artifacts.md for all image/publish tasks.*

---

## What agents can now do

- Publish articles with no images, one image, multiple images, or images combined with PDF CTAs
- Reuse existing images from the artifact store (same request, not cross-request)
- Assign one image as the featured/hero image and zero or more images as inline body images
- Self-diagnose image placement problems from publish response warnings
- Verify their own publish output is correct before a live page is served

---

## The non-negotiable rules

### 1. Request ID format — get this right first or nothing else works

Every workflow request requires a `request_id` that matches exactly:

```
req_<flow>_<topic>_<yyyymmdd>_<nn>
```

Examples:
```
req_publish_drlurie_20260702_01
req_repair_skincare_20260702_02
```

Rules:
- Lowercase snake_case only
- Date must match today (`yyyymmdd`)
- Sequence is two digits (`01`–`99`)
- **You must supply this. It is not generated for you.**
- A wrong format is accepted at `create_request` (returns 200) but **breaks every artifact operation** for that request with a hard 400. There is no recovery — start a new request with a correct ID.

### 2. Store only the returned ArtifactReference — never invent values

After any artifact upload, you receive an `ArtifactReference`:

```json
{
  "blobKey": "image/req_publish_drlurie_20260702_01/a3f1...png",
  "sha256": "a3f1...",
  "contentType": "image/png",
  "sizeBytes": 84231,
  "artifactKind": "image",
  "originalFilename": "hero.png"
}
```

- Store the entire object exactly as returned
- Never construct a `blobKey` from parts — if it doesn't come from the server, it is wrong
- Never reuse an artifact reference from a different request as an inline image or featuredImage

### 3. Placement is required for images to appear

An image node **without** `rendering.placement: "inline"` will not appear in the article body. The publish will succeed (201), but the image is silently omitted. You will receive a warning in the response — see Self-check below.

For a featured/hero image: do not set `placement` on the hero node. Pass the `blobKey` as `featuredImage` in the publish payload instead.

---

## Full publish workflow

### Step 1 — Create the request

```
Tool: save_json_blob_create_article_draft
request_id: "req_<flow>_<topic>_<yyyymmdd>_<nn>"   ← required, correct format
input.content.article_body.schema_version: "article_body.v1"
input.content.article_body.nodes: [...]              ← at least one public node
```

### Step 2 — Upload images (for each image)

**Preferred path — direct upload:**
```
1. Tool: create_artifact_upload_intent
   requestId: "<your request_id>"
   artifactKind: "image"
   contentType: "image/png" (or image/jpeg etc.)
   expectedSizeBytes: <exact byte count>
   expectedSha256: <hex sha256>

2. POST raw bytes to /api/artifacts/upload
   Headers: use requiredHeaders from step 1 exactly
   Body: raw binary (not base64, not JSON)

3. Store the returned ArtifactReference exactly
```

**Fallback path — pull from URL** (use when direct POST is not possible):
```
Tool: create_artifact_from_url
requestId: "<your request_id>"
artifactKind: "image"
contentType: "image/png"
sourceUrl: "<public https URL>"
expectedSizeBytes: <exact>
expectedSha256: <hex sha256>
```

**For PDFs** — same flow, `artifactKind: "pdf"`, `contentType: "application/pdf"`.

### Step 3 — Build the article body nodes

**Content node with inline image:**
```json
{
  "id": "n_intro",
  "kind": "content",
  "public": {
    "title": "Section title",
    "body": "Section body text.",
    "media": {
      "type": "image",
      "src": "<blobKey from ArtifactReference>",
      "alt": "Description for screen readers"
    }
  },
  "rendering": {
    "placement": "inline"
  },
  "visibility": "public"
}
```

**Hero image node** (image that becomes the page hero — no placement needed):
```json
{
  "id": "n_hero",
  "kind": "content",
  "public": {
    "title": "Article title",
    "body": "Opening paragraph.",
    "media": {
      "type": "image",
      "src": "<blobKey>",
      "alt": "Hero image description"
    }
  },
  "visibility": "public"
}
```
Pass the same `blobKey` as `featuredImage` in the publish payload (Step 4).

**PDF CTA node:**
```json
{
  "id": "n_cta",
  "kind": "action",
  "public": {
    "ctaText": "Download the guide",
    "ctaLink": "<blobKey of PDF ArtifactReference>"
  },
  "visibility": "public"
}
```

### Step 4 — Patch the workflow with the article body

```
Tool: save_json_blob_patch_canonical_input
request_id: "<your request_id>"
(include article_body nodes with media.src = blobKey values)
```

Artifact references are now validated against the artifact index. If patch rejects an image, the image was not successfully uploaded for this request — do not proceed.

### Step 5 — Publish

```
Tool: save_json_blob_publish_by_time
request_id: "<your request_id>"
lock_token: "<current lock token>"
featuredImage: "<blobKey of hero image>" (omit if no hero image)
artifactReferences: [<ArtifactReference objects for all images and PDFs>]
```

To publish now: omit `published_time` or set it to the current ISO timestamp.
To schedule: set `published_time` to a future ISO timestamp.

---

## Self-check after publish

A successful publish returns `statusCode: 201`. Always inspect the response body before considering the task complete.

### Warnings field

```json
{
  "ok": true,
  "statusCode": 201,
  "warnings": [
    {
      "code": "image_not_rendered",
      "node_id": "n_intro",
      "reason": "Node \"n_intro\" has an image (...) but rendering.placement is absent..."
    }
  ]
}
```

If `warnings` is present and non-empty:
- `image_not_rendered` means an image node has no `rendering.placement: "inline"` and is not the featuredImage — the image will not appear on the published page
- Fix: re-patch the node with `rendering.placement: "inline"` and republish

### Commit check

The response includes `commit` (git SHA) and `path` (article file path). Use these to verify:

1. The article was committed — `commit` must be a hex SHA, not null
2. The article path exists in the repo at that commit
3. If images were included, `media` in the response should list the materialized paths (`~/assets/images/uploads/<slug>/...`)

---

## Test scenarios — what to run and what to check

Run these in order. Each should produce a `201` with a live article at `drluriescience.netlify.app/post/<slug>`.

### T1 — No image (baseline)
- One content node, no media
- Expected: 201, no `warnings`, article renders with no image

### T2 — Single featured image only
- One content node (no `placement`, no `media.src`)
- One image artifact uploaded, passed as `featuredImage` in publish payload
- Expected: 201, no warnings, hero `<img>` visible on live page, raw blobKey absent from HTML

### T3 — Single inline image only (no featured)
- One content node with `public.media.src = blobKey` and `rendering.placement: "inline"`
- No `featuredImage` in publish payload
- Expected: 201, no warnings, image in article body, no hero image, no frontmatter `image:` field

### T4 — Featured image + one inline image (same artifact reused)
- Hero node (no placement) + inline node (placement: inline), both using same `blobKey`
- `featuredImage` = same `blobKey`
- Expected: 201, no warnings, hero image in page header, same image in article body, single materialized file in repo

### T5 — Two distinct inline images, no featured
- Two content nodes, each with different artifact `blobKey`, both `placement: "inline"`
- No `featuredImage`
- Expected: 201, no warnings, both images in article body, two distinct files in `src/assets/images/uploads/<slug>/`, neither raw blobKey in committed Markdown

### T6 — Image + PDF CTA
- One hero image as `featuredImage`
- One PDF artifact, referenced in a CTA node `ctaLink`
- Both artifacts in `artifactReferences` array
- Expected: 201, no warnings, hero image renders, PDF CTA link rewrites to `/pdf/<requestId>/<sha>.pdf`, raw PDF blobKey not present anywhere else in HTML

### T7 — Missing placement (regression check)
- One content node with `public.media.src` set but **no** `rendering.placement`
- Expected: 201 (not a failure), response contains `warnings[0].code === "image_not_rendered"`, live page has no inline image

### T8 — Wrong request ID format (regression check)
- Attempt `create_request` with `request_id: "my-article-123"` (UUID or freeform)
- Expected: 400 with message containing `req_<flow>_<topic>_<yyyymmdd>_<nn>` format hint, no record created

---

## What is still cross-request — do not attempt

- Reusing a `blobKey` from a different `request_id` as an inline image or featuredImage is blocked at canonical promotion. If you need the same image in a new article, upload it again for the new request.
- Cross-request references are intentionally rejected — this is not a bug.

---

## Quick-reference: what breaks silently vs loudly

| Problem | What happens | Signal |
|---|---|---|
| Wrong `request_id` format at create | 200 at create, 400 at every artifact call | 400 with format hint at first artifact op |
| Wrong `request_id` format at artifact | Immediate 400 | `"request_id must match req_..."` |
| Image not uploaded for this request | 422 at `patch_canonical_input` | `"not found in agent_outputs artifact indexes"` |
| Image node has no `placement: "inline"` | 201, image missing from page | `warnings[0].code === "image_not_rendered"` |
| Raw blobKey survives into Markdown | 422 before commit | `"still contains raw image artifact reference(s)"` |
| Cross-request artifact ref | 422 at canonical promotion | `"artifact pointer...not found"` |
| `featuredImage` passed as nested object | Silently coerced to undefined (no hero) | No hero on live page — check `media` in response |

