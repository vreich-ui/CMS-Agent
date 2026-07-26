# Client-contract alignment — what changed

**Date:** 2026-07-26 · **Plane:** Cloud Run + GCS (canonical) · **Workspace version:** 56 → 67
**Principle applied:** the client's live contract is the only source of truth, fetched at runtime, for **any** client the workflow meets — not just Dr. Lurie.

---

## The shift

**Before:** the workspace carried its own copy of what an article looks like, baked into node schemas and prompts. Copies drift. One had already drifted so far that a valid article and a publishable article were mutually exclusive.

**After:** nodes carry no content schema of their own. `contract_intelligence` fetches the client's contract at runtime and passes it forward as data. Everything downstream builds to that, and validates through **the client's own validator**. A workspace verdict is explicitly not evidence.

The practical test: point this workflow at a new client tomorrow and nothing needs re-coding — the contract fetch adapts.

---

## Changed

### Retired
- **Baked content schemas.** `article_body`'s hardcoded shape is gone. Its output is now an envelope — `clientProjectId`, `clientObjectType`, `contractSource` provenance, and `body`, which is the client's own object shape, opaque to the workspace.
- **`article_body_validate` as an authority.** Node metadata now states: *"Workspace-local article schemas are advisory and must never be used to validate."* The compiled tool still exists — it can't be removed over MCP — but nothing is allowed to trust it.
- **Hardcoded client conventions.** `pdf_tool_dr_lurie_blob.v1`, `/img/`, `/pdf/`, `content_item`, and the `^req_[a-z0-9_]+$` pattern are no longer fixed in schemas. All now read from the contract.

### Fixed
- **`contract_intelligence` could not do its job.** `riskLevel: read` while `project.call_tool` is `write` → `risk_level_exceeds_authorization`. The node whose entire purpose is fetching contracts was structurally unable to. Now `write`. **This was the keystone** — nothing downstream could work without it.
- **The orphaned-artifact bug.** `artifact_plan` now derives the request id from the client's convention and must confirm it before anything is written. The old permissive pattern let pdf-tool write under an id the client's index rejects — that's how the test artifact became unreachable.
- **`trust_factual`** — `research` restored to `requiredInputs` (migration regression).
- **Six skills** rewritten to stop declaring output shapes (see below).
- **`dr_lurie_contract_intelligence`** generalized to client-agnostic contract discipline. SkillId kept so all six assignments stayed intact.

### Nodes touched (6)
`contract_intelligence`, `article_body`, `artifact_plan`, `publish_payload`, `publication_controller`, `trust_factual`

---

## A real bug found mid-work

The verification sweep showed **10 of 13 skill-bearing nodes carrying blocker-severity conflicts** — including skills I hadn't touched. That ruled out my change as the cause.

I set one skill's `outputSchema` to `{"type":"object","additionalProperties":true}` — maximally permissive — and it *still* reported incompatible. Meanwhile the one conflict-free skill in the workspace had a bare `{"type":"object"}`.

**The resolver's compatibility check is broken.** Any skill `outputSchema` that declares `additionalProperties`, `properties`, or `required` is reported incompatible regardless of actual compatibility. Only a bare `{"type":"object"}` passes.

Setting all six skills to bare `{"type":"object"}` cleared it — and is semantically right anyway: a behavioural skill shouldn't dictate the node's output shape. But **the underlying resolver defect is still there** and will bite the next person who writes a properly-specified skill. It belongs in the repo fix list.

---

## Verification

| check | result |
|---|---|
| Graph validity | ✅ valid, 0 issues, 21 nodes / 27 edges |
| Storage | ✅ gcs, healthy, 9/9 stores read+write |
| `risk_level_exceeds_authorization` | ✅ none remaining |
| Skill conflicts | ✅ 11/13 clean (was 3/13) |
| `dependsOn` == `requiredInputs` | ✅ 20/21, entry node correctly excepted |
| `schema` == `outputSchema` | ✅ 21/21 |
| Attention items | ✅ none |

---

## Two things I deliberately left

**1. `publish_executor` still names Dr. Lurie (5 places).** It's `status: draft` with `activationRequired: true`, so it isn't running — and its prompt is the most detailed in the workspace, carrying the content_item materialization rule that the GCloud migration gained (*"the body is strict and carries NO schema_version — root the article fields"*). Rewriting it blind risks losing rules I'd have to reconstruct. It should be aligned deliberately before it's ever activated.

**2. `publication_controller` and `publish_executor` show a `tool_policy` warning** — the skill requests `project.call_tool`, those two nodes don't grant it. **That's the publish gate working as designed**: the decision gate and the executor should not be able to reach the client while gated. Cosmetic warning, correct behaviour.

Also left as correct: **five nodes still say "Dr. Lurie" in an editorial-voice sense** (`topic_opportunity`, `research`, `brief_architect`, `draft_writer`, `trust_factual`) — brand voice, trust standards, tone. That's legitimately client-specific *content* direction and belongs in the client's editorial skill, not in contract logic. Generalizing it would make the writing worse, not more portable.

---

## Two tool bugs for the repo list

1. **`workspace_update_node_output_schema` is unusable.** It fails with `-32603` on every call; `workspace_update_node` with both `schema` and `outputSchema` in the patch succeeds with identical input. It almost certainly violates the server-side invariant that the two must stay equal. I used the general patch throughout.
2. **The two resolvers disagree.** `skill_resolve_for_node` reports `effectiveTools: ["project.call_tool"]` for four nodes where `node_get_effective_tools` reports the same tool `allowed: false`. Only one can be right, and a GUI reading either would show a different answer.

Plus the skill-compatibility defect above, and the untyped version-conflict envelope from the earlier audit.

---

## Still blocking live publish

Unchanged, and not fixable from here: **the four Cloud Run env vars.** `DR_LURIE_MCP_ENDPOINT/TOKEN` and `PDF_TOOL_MCP_ENDPOINT/TOKEN` are unset, so `project.call_tool` reaches nothing.

Everything above is now correct *and inert* until those are set. The alignment makes the workflow contract-driven; the env vars make it connected.
