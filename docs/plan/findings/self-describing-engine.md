# CMS-Agent as a self-describing engine — proposals

**Date:** 2026-07-26 · Companion to the workspace-side alignment doc.

---

## 1. The principle transfers cleanly — and half of it already exists

Platform's rule is *"derive, never hand-author — docs that disagree with enforcing code are a bug."* CMS-Agent's equivalent of "enforcing code" is its **MCP introspection surface**, and it is already complete:

| question | already answerable, live |
|---|---|
| What nodes exist, what does each do? | `workspace.get_nodes` — description, prompt, produces, dependsOn |
| What does a node *actually* run with? | `node.get_effective_prompt` / `_tools` / `_skills` |
| What tools exist, at what risk? | `tool.list` — riskLevel, sideEffect, requiresApproval |
| What skills exist, when to use them? | `skill.list` |
| How is the graph shaped? | `workspace.get_graph`, `constellation.get_structure` |
| What happened, and why? | `changes.list` — full before/after, actor, reason |
| What is broken right now? | `constellation.get_attention` |

So the self-description is **not something to write — it is something to render.** Every "How this works" artifact should be a projection of this surface, stamped with provenance (`workspaceVersion`, `currentRevisionId`, `generatedAt`), so staleness is detectable by machine. Hand-authored engine docs would recreate exactly the drift we spent this session killing (`article_body_validate` was a hand-copied schema).

---

## 2. The key proposal: the engine documents itself *through its own pipeline*

You asked for self-description to become "part of the publishing and system test process." Those aren't two features — they're one mechanism:

**Self-documentation runs ARE system tests.**

The generator emits `content_source.v1` envelopes — *"Document the `draft_writer` node: here is its live config, purpose, inputs, outputs, policies"* — and feeds them through the **normal constellation**: triage → draft → review → article_body → payload → readiness → publish, targeting **client 0 (platform site)**.

Why this is the right mechanism and not just a cute one:

1. **Every docs refresh is a full pipeline exercise with known ground truth.** Unlike a throwaway smoke article, if the article about `artifact_plan` comes out wrong, the error is *meaningful* — either the pipeline broke or the engine changed. Both are things you want to know.
2. **Tier 8 (live publish) gets a permanent, worthwhile target.** No more `zz-smoke-test` articles to remember to unpublish. The live-publish test *produces the README*. Test artifacts become durable value; docs stay current because regenerating them is how you run the tests.
3. **It proves the client-agnostic alignment.** Client 0's contract is the same `object_contract` surface as Dr. Lurié's. If the pipeline can publish engine docs to platform and skincare articles to dr-lurie *with the same nodes*, the "method is fleet law, identity is client data" split is demonstrated, not asserted.
4. **Cost is bounded by design** — `topic_opportunity`'s cost policy already says "choose the smallest workflow that can satisfy the request safely." Engine docs need no web research, no deep review fan-out; the conductor can run the short path.

### Two content sources, different treatment

| source | what it produces | authority | when it runs |
|---|---|---|---|
| **Runtime introspection** (MCP calls) | per-node, per-skill, per-tool docs; graph overview; policy pages | cannot drift — it *is* the engine state | on every docs tier run |
| **Repo analysis** (agent reads platform / CMS-Agent code) | architecture narrative, "why it's built this way," subsystem guides | can drift — must be regenerated on merge | CI, on merge to main (needs the CI that's still item 7 on the fix list) |

Your plan — Claude Code generates the initial platform content — is right for bootstrap, and for the repo-analysis narrative long-term. But the *per-object mechanics* docs should come from introspection from day one, because that's the half that must never lie.

### Concrete object mapping on client 0

- One `content_item` per constellation node — purpose, inputs expected, output artifact, policies (summarized from the prompt), effective tools/skills. Id per the client convention: `req_engine_<node_id>_<yyyymmdd>_<nn>`.
- One per skill and one per tool category; one overview page ("The Constellation") using `tpl_interior`.
- Taxonomy terms: `engine`, `node`, `skill`, `tool`, `policy` — registered in client 0's taxonomy so they resolve.
- Every doc's `editorial.writer_notes` carries `sourceWorkspaceVersion: N` — this is what the drift test reads.

---

## 3. The drift test — new protocol tier

Add **Tier D (docs)** to the protocol, cheap and read-only, CI-able:

1. Recompute the self-description from the live workspace.
2. Fetch client 0's published engine docs; read each `sourceWorkspaceVersion`.
3. Any doc older than the last *content-relevant* workspace change for its subject → **attention item** ("docs stale for `draft_writer`: doc at v61, node changed at v67"), not silent.
4. Refresh is a normal gated publish run — never auto-publish; approval flows as usual.

This also finally gives `constellation.get_attention` (which today returns `[]` on a workspace with real defects) something honest to say — and slots into the attention-resolution work already in the GUI plan.

---

## 4. UI gaps — and your loading question answered

Your assumption — *instructions load with a connection; no client MCP → no nodes, at least in full* — is right in spirit, and worth one refinement:

**Nodes are workspace data. They always render.** What requires a live client connection is the **identity layer**. The inspector should make the three-layer split *visible*:

| layer | source | without client connection |
|---|---|---|
| **Method** — node prompt, dependsOn, output envelope, own tools/skills | workspace store | ✅ fully rendered |
| **Effective** — method + skill instructions, resolved tool grants | resolver (workspace-side) | ✅ fully rendered |
| **Identity** — client contract, voice (future), taxonomy, media rules, publish gates | live `project.call_tool` fetch | ⚠️ degraded: "client contract unreachable (`DR_LURIE_MCP_ENDPOINT`)" — panel greyed, run controls disabled |

Rules for the degraded state:
- Never render a cached contract as if it were live — always show `fetchedAt`, and mark stale explicitly. (A wrong contract shown confidently is worse than a hole.)
- Run/execute controls gate on connection health, since a run without the identity layer would produce exactly the assumed-instead-of-fetched behaviour we just eliminated.
- The project selector in the header carries a connection badge (the data is one `project.test_connection` away), so "why is everything grey" answers itself.

This makes the S4 inspector more than a form — it becomes **the visual proof of the architecture**: you can see, per node, what is fleet law and what arrived from the client, and what's missing when the client is away. The S4 tab spec from the GUI plan (Prompt / Tools / Skills / Overview / Schemas) stands; this adds the layer framing and the degradation behaviour. **Build the read-only inspector first** — your stated pain is *seeing* instructions, and read-only ships without solving the typed-conflict-envelope save path.

---

## 5. Projects cleanup — one caution before deleting

Proposed registry after cleanup:

| projectId | kind | role |
|---|---|---|
| `platform` | **client 0** | canonical engine home; educational content about itself; conformance target |
| `dr-lurie` | client 0001 | first real publication |
| `pdf-tool` | **service** | ⚠️ **do not delete** — it is not a fake client, it is the artifact engine. `artifact_plan` and the whole image pipeline call it via `project.call_tool`. Deleting it re-breaks images. |
| `snoocle` | — | delete (already out of scope) |
| `monetizer` | — | delete |

Two suggestions:
- **Add a `kind: client | service` distinction** to the project record (alongside the `contentSubstrate` and `clientNumber` fields already proposed). pdf-tool being listed as a peer of Dr. Lurié is how it got mistaken for a disposable "project" in the first place.
- **Don't keep monetizer as a fake test client.** When the protocol needs a synthetic client, scaffold a real disposable one with `create-site` — that exercises the actual onboarding path (which is the thing worth testing) instead of a hand-registered imitation.

On the endpoint swap ("platform pushes Dr Lurie as the second connection… or vice versa"): with the registry, this is just which env-var pair points where — both stay separate, explicitly addressed connections either way. Registering `platform` as client 0 converges three earlier threads into one act: it's the **conformance harness target** (run Tiers 0–3 against it after the mcp.ts move), the **self-docs publication**, and the canonical plane's first fully-configured client.

---

## 6. Order of work

1. **S4 inspector, read-only** — closes your stated UI gap; renders the three layers with degradation.
2. **Register `platform` as client 0** after the mcp.ts move lands; run conformance Tiers 0–3 (this *is* their step-5 verification).
3. **Bootstrap client-0 content** — your Claude Code pass for the narrative; introspection-derived node docs generated and pushed through the pipeline as dry-run first, then the first live Tier 8 publish. The engine's first real published work is its own manual.
4. **Tier D drift test** + CI (the CI gap is now blocking two things: repo-analysis docs and everything else on the fix list).
5. **Registry cleanup** — kinds, numbering, delete snoocle/monetizer.
6. Dr. Lurié env vars on Cloud Run remain the standing blocker for everything that touches client 0001.
