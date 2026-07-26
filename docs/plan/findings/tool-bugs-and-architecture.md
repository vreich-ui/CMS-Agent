# Four answers

**Date:** 2026-07-26 · workspace v67 → **v69**

---

## 1. `publish_executor` — done

Aligned. And the thing that made it safe to do: **the client's contract publishes its own workflow.** `object_contract` returns `workflow.sequence`, `lock_discipline`, `patch_error_codes`, and `publish_policy.pin_rules`. So the checkout → validate → patch → publish → checkin sequence, the 423/409 lock and version discipline, and the M-6 pin rules were all transcribed into the prompt from a source that can simply be read at runtime. Nothing was lost — it's fetched instead of remembered.

Schema consts removed: `contentPath: article_body.v1`, `artifactProtocol: pdf_tool_dr_lurie_blob.v1`, the `publicationAction` enum, the `releaseBuildBehavior` enum. All now contract-declared strings. Node stays `draft` / `activationRequired`.

---

## 2. Repo access — not needed, it's public

`git ls-remote https://github.com/vreich-ui/platform` resolves (`cd2307a7`). I can clone it whenever useful. Worth doing for one specific question in §3 below — whether a brand-voice surface already exists platform-side.

---

## 3. Your architecture — what's true today

> *Local instructions hold general marketing/sales principles. The client contract holds the rest, standards stored as JSONs in blob store.*

### The structural half is TRUE, and as of today it's wired

The client contract is real and authoritative — `object_contract` describes itself as *"derived from the enforcing code (so it cannot drift)"*. And the blob store genuinely holds standards as objects. From a live inventory sweep:

| standard | stored as | count |
|---|---|---|
| Page recipes | `template` objects with `description`, `when_to_use`, `scope: evergreen` | 4 |
| Section recipes | `section_template` objects, same metadata + `blueprint_type` | 6 |
| Palette | `theme` object — *"the production palette, verbatim from the site seed"* | 1 |
| Taxonomy | `taxonomy` objects | 2 |
| Page types / components | code registries via `registry_get` | 2 |

Those recipes carry genuine editorial judgement — `tpl_interior`'s `when_to_use` reads *"the default recipe for any evergreen content page… pick tpl_landing when the page must convert."* That is a standard, living client-side, machine-readable. Exactly the model you described.

After today's changes, the workspace reads all of it at runtime instead of carrying copies.

### The principles half is NOT true — it isn't built anywhere

Your local skills are **one-sentence stubs.** In full, verbatim, that is the entire instruction body of each:

- `seo_review` — *"Recommend SEO improvements without keyword stuffing or publication-specific assumptions."*
- `article_structuring` — *"Transform the brief into a logical article structure with headings, key points, and artifacts."*
- `factual_review` — *"Check assertions, dates, names, and numbers; block when material claims lack support."*

Nine of the twelve look like this. There is **no magnetic marketing skill, no brand story skill, no branding or positioning skill.** Nothing to continuously improve yet, because nothing substantial is there.

### And one thing is backwards

`dr_lurie_dtc_science_editorial` is the only skill with real depth (~1,000 characters of actual direction — voice, tone, DTC framing, what not to overclaim). It is **client-specific and it lives locally.** Under your model that belongs on the client side.

**This is precisely why five nodes still say "Dr. Lurie."** `topic_opportunity`, `research`, `brief_architect`, `draft_writer`, `trust_factual` name the client in an editorial-voice sense — and they cannot stop, because there is nowhere to fetch voice from. The client's object types are page, section, navigation, taxonomy, site, template, section_template, theme, product, content_item, tracking_config. **None of them is brand voice, story, or positioning.**

So you're right that hardcoded client context means local dependency — but the cause isn't sloppiness in the nodes. It's a missing surface on the client side.

### What it takes to close it

**Client side (platform repo):** brand voice, story and positioning need a home the contract can expose. Three plausible shapes — a new governed object type, fields on the existing `site` object, or a blob JSON convention the contract points at. That's a decision for the platform repo, and the first thing I'd look for if I clone it is whether `site_drlurie` already carries voice fields.

**Workspace side:** write the general-principle skills for real — magnetic marketing, brand story, positioning, offer construction. Versioned, improvable, client-neutral. They're the local half of your model and they don't exist yet.

**Then** the five editorial nodes can drop the client name and read voice from the contract like everything else.

---

## 4. `update_node_output_schema` vs `update_node` — I was wrong

I said the first looked legacy. **It isn't. It's the canonical one.** Rechecked against the code:

```ts
export const DEPRECATED_TOOL_ALIASES: Record<string, string> = {
  "workspace.update_node_schema": "workspace.update_node_output_schema"
};
```

`update_node_schema` is the deprecated alias — pointing *to* `update_node_output_schema`. And my invariant theory was wrong too: the tool writes **both** fields (`{ outputSchema: data.schema, schema: data.schema }`), and nothing validates them for equality — `schema` is marked `@deprecated` and migrated one-way on load.

**The real cause: my client stringified the argument.** Its advertised JSON Schema declares `schema: {}` — untyped. The codebase already documents this exact failure mode:

> *"Some MCP clients serialize object-typed arguments as JSON strings (observed live with Claude's connector…)"*

`create_node` defends against it with `coerceNodeInput`. `update_node_output_schema` doesn't — it passes straight to `validateJsonSchema`, which rejects a string with *"JSON Schema must be an object or boolean."* Then the generic `-32603` handler swallows the detail into `error.data`, which my client doesn't surface.

Also: the two tools never accepted the same input. `updateSchema` takes `{id, schema}`, `updateNodeInput` takes `{id, patch}` — both `.strict()`. My "identical input" claim was wrong.

**Fix:** `coerceJsonObjectInput(data.schema)` before validating, and declare `schema: { type: ["object","boolean"] }`. Same bug in `update_node_input_schema`.

### A worse one found while checking

`update_node_tools`, `update_node_skills`, `update_node_dependencies`, `update_node_metadata`, `update_node_model_config` all do:

```ts
updateNode(data.id, { [field]: data.patch[field] }, ...)
```

If the patch omits the target field, `undefined` is written over the existing value. Reproduced live: `update_node_tools {patch:{assignedSkills:[...]}}` returned `ok:true` and **silently wiped `allowedTools` from four entries to empty.** `metadata` and `modelConfig` aren't normalized at all, so they become `undefined` outright.

Silent data loss on a success response. I used the general `update_node` patch throughout today's work, so nothing here was damaged — but that one belongs at the top of the repo fix list, above the GUI work.

---

## Repo fix list (accumulated)

1. **`update_node_*` single-field writers silently wipe omitted fields** — data loss, returns `ok:true`
2. **Skill/node schema compatibility check is broken** — any skill `outputSchema` declaring `additionalProperties`/`properties`/`required` reports incompatible; only bare `{"type":"object"}` passes
3. **`update_node_output_schema` / `_input_schema` don't coerce stringified JSON** despite the codebase documenting that clients do this
4. **`skill_resolve_for_node` and `node_get_effective_tools` disagree** on whether `project.call_tool` is effective for four nodes
5. **Version conflicts return untyped `-32603`** instead of a structured conflict envelope
6. **`article_body_validate` / `article_body_get_schema` describe a shape nothing uses** — retire them
7. **No CI** — 94 tests, zero automation
