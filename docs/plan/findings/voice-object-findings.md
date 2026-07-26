# Does `site_drlurie` have somewhere voice could live?

**No.** Confirmed two ways — the live contract and the code.

`object_contract("site").body_schema` is `additionalProperties: false` with a closed required set: `name, logo, urls, metadataDefaults, brandTokens, chrome, defaultNavigation, blog`. In code, `packages/core/schema/bodies/site-v1.ts` defines `siteBodySchema` as `z.object({...}).strict()`, and **every nested object is also `.strict()`**. No `metadata`, no `config`, no `settings`, no free-form record. There is no field anywhere in the repo's governed schemas for voice, tone, story, audience, or positioning.

---

## Where editorial identity actually lives today

Nowhere machine-readable. It's scattered across three places, none governed:

1. **Human prose** — `docs/agents/publishing-policy.md` §5.3 carries the functional-block rule, the strategy enum and the framework list.
2. **Rendered page copy** — the brand story exists only as About-page HTML: `sec_about_intro.json`, `sec_about_science.json`, `sec_about_thinking.json`.
3. **One sentence of data** — `site.metadataDefaults.description`:

> *"A calm Dr. Lurié Skincare publishing space for people who arrived late, need help now, and mistrust the skin-care market."*

That single SEO meta description is the entire positioning statement in structured form. It's a good sentence. It's doing far too much work.

Repo-wide counts: `brand story` 0, `messaging` 0, `pillars` 0, `manifesto` 0, `style guide` 0. Every one of the 13 `voice` hits is either page copy or an LLM prompt saying *"Preserve the voice, tone, and structure of the surrounding content"* — i.e. voice exists only as "don't change whatever's already there."

---

## The structural argument for making it an object

The repo's own governing principle, from `docs/agents/publishing-instructions.md`:

> *"tool descriptions in `netlify/functions/mcp.ts` are the machine-readable version of the same contract — if they ever disagree, one of them is a bug."*

`docs/agents/` ships 11 files an agent is expected to read. All eleven are **mechanics** — ids, upload transport, node grammar, lock discipline. Every one is derived from enforcing code.

**Voice is the only input an agent needs before writing that has no code to derive from.** That's the gap, stated in the platform's own terms.

---

## `theme` is the exact precedent

`packages/core/schema/bodies/theme-v1.ts`:

```ts
export const themeBodySchema = z
  .object({
    ...trackingAttributeShape,
    name: z.string().min(1),
    // Self-description (W8.3b): schema-optional, required to publish.
    ...recipeMetadataShape,
    tokens: brandTokensSchema,
  })
  .strict();
```

Theme is brand **visual** standards as governed data — draftable, validatable, publishable, revertible, restrictable to a maker agent, with a totality validator (`theme_token_keys`) that blocks publishing an incomplete preset.

**Voice is theme's missing sibling.** Theme is how the publication looks. Voice is how it sounds. Same governance shape, same `name + self-description + payload` skeleton, same `recipeMetadataShape` for the reuse-first index.

One design difference: theme is **applied by copy** (`site_apply_theme`) because CSS must be static. Voice is read by agents at draft time, so **resolve-by-reference** is the better fit — an agent reads it live rather than the site holding a snapshot.

---

## This maps exactly onto your engine/publication split

The split already exists and is further along than I expected. `packages/core/` is engine law; `sites/<client>/` is data and bindings. Core never imports site config — there's a provider-injection seam (`setActiveApprovalPolicyProvider`, `setSiteIdentityConfigProvider`) wired site-side. **A second publication already exists** at `sites/platform/`, and `node packages/core/cli/create-site.mjs --name acme` scaffolds a new one.

So voice splits cleanly along the seam you're already working:

| layer | what | where |
|---|---|---|
| **Engine law** | the voice object *type* — schema, patch ops, constraints, publish policy | `packages/core/` |
| **Publication material** | this publication's voice *record* | `sites/<client>/data/site/voices/vox_<client>_default.json` |
| **Craft** | general marketing/brand-story method, client-neutral | CMS-Agent workspace skills |

Today `create-site.mjs` scaffolds a palette (`themes-seed-data.mjs`) but no voice. Its own comment at line 540 notes *"A brand-new client has no editorial…"*. Voice would sit beside `thm_<client>_default.json` as seed data.

---

## Two things already half-designed for this

**1. `publication_context` is voice leaking into articles.**
`contentItemPublicationContextSchema` = `{ publication_name?, domain?, topic_scope? }` — per-article, optional, never rendered. It's the closest thing to "publication identity as data" in the repo, and it's **stamped on every article instead of resolved from the site.** A voice object is the obvious upstream source; `publication_context` becomes a resolved projection rather than a copy.

**2. `editorial.framework` has zero readers.**
`content_item.editorial = { writer_notes?, framework? }`. `framework` is a free string consumed by **no** code — no validator, no renderer, no index. Only `publishing-policy.md` enforces it, and only as *"warns, never blocks"*.

But the code already anticipates the fix — `content-item-v1.ts:156` notes frameworks *"become `strategy_drlurie` term ids if/when Wolf approves OQ-W7-3's registry."* **You've already scoped this.** Voice is the layer directly above it: the voice object declares which frameworks this publication permits; `editorial.framework` becomes a term id in that governed vocabulary.

---

## Proposed shape

Modeled on `theme`, id prefix `vox_`, one patch op `set_voice_fields`:

```ts
export const voiceBodySchema = z.object({
  ...trackingAttributeShape,
  name: z.string().min(1),
  ...recipeMetadataShape,                    // description, whenToUse, scope

  publication: z.object({                    // feeds content_item.publication_context
    name: z.string().min(1),
    domain: z.string().optional(),
    topicScope: z.string().optional(),
  }).strict(),

  audience: z.object({
    primary: z.string().min(1),
    knowsAlready: z.array(z.string()).optional(),
    painPoints: z.array(z.string()).optional(),
    decisionContext: z.string().optional(),
  }).strict(),

  positioning: z.object({
    promise: z.string().min(1),              // today buried in metadataDefaults.description
    differentiators: z.array(z.string()).optional(),
    notFor: z.array(z.string()).optional(),
  }).strict(),

  voice: z.object({
    register: z.array(z.enum([...])),        // calm | warm | authoritative | clinical | playful …
    person: z.enum(['first','second','third']),
    doList: z.array(z.string()),
    avoidList: z.array(z.string()),
    vocabulary: z.object({
      prefer: z.array(z.string()),
      avoid: z.array(z.string()),
    }).strict().optional(),
  }).strict(),

  story: z.object({
    origin: z.string().optional(),           // rich_text.v1
    beliefs: z.array(z.string()).optional(),
    proofPoints: z.array(z.string()).optional(),
  }).strict().optional(),

  standards: z.object({
    claimPolicy: z.string().min(1),          // e.g. no medical outcome claims
    evidenceDepth: z.enum(['light','moderate','deep']).optional(),
    disclosureRules: z.array(z.string()).optional(),
  }).strict(),

  frameworks: z.array(z.string()).optional(), // the OQ-W7-3 registry slot
}).strict();
```

Nearly all of this content already exists in the repo — as About-page copy, as `publishing-policy.md` prose, as the one meta description. It's a migration into governed form, not authoring from scratch.

### Registration change-set

Derived from how `theme` and `tracking_config` are wired. Most is mechanical and test-gated — `object-contract.ts` states *"DERIVE, NEVER HAND-AUTHOR… the coverage test fails until the derivation picks it up."*

`object-record-v1.ts` (type enum) · `schema/bodies/voice-v1.ts` (new) · `lib/object-ids.ts` + `object-ids-mint.ts` (`vox_`) · `object-patch-ops.ts` (`set_voice_fields`) · `approval-policy.ts` · `creation-policy.ts` · `object-validate.ts` (schema + totality criteria) · `object-verbs.ts` · `materialize.ts` + `materializers/voice.ts` · `registry/object-contract.ts` · `admin/display-name.ts` · `cli/migrate-site.mjs` · `cli/create-site.mjs` seed.

---

## What it unlocks on the CMS-Agent side

The five nodes still naming Dr. Lurié (`topic_opportunity`, `research`, `brief_architect`, `draft_writer`, `trust_factual`) can stop, because `contract_intelligence` would fetch voice the same way it fetches structure. The `dr_lurie_dtc_science_editorial` skill — the one substantial skill, currently client-specific and living locally, which is backwards — gets replaced by a client-neutral craft skill plus a per-publication voice record.

That completes the model: **craft is local and improves across all clients; identity is the client's and travels with the publication.**
