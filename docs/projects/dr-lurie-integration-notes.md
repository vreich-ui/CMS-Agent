# Dr. Lurie integration notes

These notes summarize CMS-Agent policy for future Dr. Lurie integration. They are based on the canonical Dr. Lurie diagnostics docs under `docs/diagnostics/` and end-state CMS architecture docs under `docs/cms-architecture/` in `vreich-ui/Dr-Lurie-Blog`.

## Authority boundaries

- The CMS-Agent workspace MCP is **not** the Dr. Lurie publishing backend.
- The Dr. Lurie MCP/repository remains canonical for Dr. Lurie workflow records, artifact trust, media materialization, publish receipts, verification, and generated exports.
- CMS-Agent must not change the workspace MCP contract to impersonate Dr. Lurie publishing. It may prepare adapter payloads and validations only until a real Dr. Lurie MCP integration is explicitly added.

## Artifact and image constraints

- CMS-Agent must preserve Dr. Lurie `artifactReferences` when building adapter payloads.
- Raw image artifact references, including image `blobKey` values, must not be treated as public reader-facing URLs.
- Images are reader-visible only after the Dr. Lurie backend materializes them into committed/public assets or another explicit image serving route.
- PDF/document refs are different: Dr. Lurie may route PDF artifacts through `/pdf/*` as a blob-backed fallback. Do not infer the same behavior for images; images do not currently have a corresponding public `/image/*` fallback.
- Reader-visible inline image nodes in `article_body.v1` must specify `rendering.placement`, normally `inline`, so admin preview and live rendering semantics stay aligned.
- Hero/featured images and inline images use separate rendering paths. A hero candidate must not be assumed to appear in the article body unless the inline node is also valid for body rendering.
- Publish verification must be deploy-aware. Immediate image verification can observe a pre-deploy page and should not be conflated with a true rendering failure.

## Canonical content shape

- `article_body.v1` is the canonical Dr. Lurie article body shape.
- Markdown is adapter/export output only. CMS-Agent should not make Markdown the source of truth for Dr. Lurie article editing.
- `content_source.v1` is the working source envelope for intake and workflow context; project adapters may map it to Dr. Lurie records but must preserve Dr. Lurie validation and review constraints.

## Future CMS architecture constraints

The Dr. Lurie CMS architecture docs describe a future object model, not current publishing code. CMS-Agent should align future integration planning with these concepts:

- `ObjectRecord` generalizes the article workflow envelope for typed CMS objects.
- `site-objects` is the future blob-backed storage area for non-article CMS objects.
- Object types include `site`, `page`, `template`, `section`, `navigation`, `taxonomy`, and `content_item`.
- Pages are built from Sections; Sections are validated and rendered through a Component Registry.
- Articles remain `content_item` objects that keep `content_source.v1` and `article_body.v1`; article nodes are a sibling grammar to Section objects, not a Section replacement.
- Review and publish gates are envelope-level mechanics. Future publishing must validate, materialize derived exports, and record publish receipts through Dr. Lurie-owned paths.

## CMS-Agent policy until live integration

- Do not add publishing side effects for Dr. Lurie.
- Do not call Dr. Lurie MCP from the default workspace flow.
- Do not replace Dr. Lurie artifact trust or materialization logic with CMS-Agent-local assumptions.
- Record artifact/rendering validation failures as learning observations so future prompts and adapters can be improved deliberately.
