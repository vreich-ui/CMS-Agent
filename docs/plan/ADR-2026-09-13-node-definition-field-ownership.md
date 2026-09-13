# ADR 0001 — Node-definition field ownership across the two planes

- **Project:** cms-agent
- **Status:** Proposed — needs Wolf's decision on §7.1
- **Date:** 2026-09-13
- **Supersedes/relates:** `docs/KNOWN_ISSUES.md` C-19, K-A9, K-A13, K-A14; `docs/plan/ADR-2026-08-25-publish-autonomy.md` (publish semantics, not reopened here)

---

## 1. Context

### 1.1 The mechanism

A `publishing_conductor` node exists in two planes and each is authoritative for different fields of the same row.

`resolveConductorNodes` (`src/agent/workspace/executor.ts:397-422`) maps over the canonical array the workflow registry returns, then `overlayStoreNode` (`executor.ts:352-369`) merges the live store row on top. The store is the default source (`executor.ts:344` — `WORKSPACE_NODES_SOURCE` is `store` unless explicitly set to `static`; `KNOWN_ISSUES` C-4 records that the docs said otherwise).

**Store wins** (`executor.ts:354-368`): `name`, `description`, `prompt`, `schema`, `inputSchema`, `outputSchema`, `allowedTools`, `assignedSkills`, `modelConfig`, `executionConfig`, `metadata`, `updatedAt`.

**Canonical wins**, by not being overridden at all (`executor.ts:353` `...canonical`): `id`, `kind`, `dependsOn`, `requiredInputs`, `produces`, `riskLevel`, `position`, `status`.

Two corrections to the prevailing description of this seam, both load-bearing:

- **`metadata` is MERGED, not replaced** — `executor.ts:364-367`: `{ ...(canonical.metadata ?? {}), ...(stored.metadata ?? {}) }`, store keys winning per key. `scripts/reseedStoreFromCanonical.ts:13` still asserts "allowedTools and metadata are replaced WHOLESALE, not merged". That header comment is **stale**. `KNOWN_ISSUES` K-A9 has it right. `allowedTools` *is* replaced wholesale (`executor.ts:360`). The K-A9 hazard survives the correction — a canonical→store *write* of metadata still deletes store-only keys, because after the write there is nothing left in `stored.metadata` for the merge to preserve.
- **`kind` and `requiredInputs` are canonical-owned too**, and neither appears in `reseedStoreFromCanonical.ts:85`'s `TOPOLOGY_FIELDS`. They are protected only incidentally, by not being in `STORE_OWNED_FIELDS` (`:89`) either.

### 1.2 The measured state (reproduced offline, 2026-09-13)

Both scripts were re-run in this investigation against a live `workspace_export_workspace` payload (51 nodes, `workspaceVersion` 1182, `updatedAt` 2026-09-13T13:58:21.883Z) saved to `cms-agent-store-export.json`. `nodes:check --from <file>` reproduced Appendix A's 14 problems **verbatim**. `store:check` has no `--from`; its pure planner `planReseed` (`reseedStoreFromCanonical.ts:249`) was driven directly from the same snapshot and reproduced Appendix A's 4 up-to-date / 4 drift / 2 refusal lines **verbatim**.

Both planes are stale, in opposite directions, on disjoint field sets:

| Direction | What is stale | Evidence |
|---|---|---|
| canonical → store (`store:check`) | **canonical is stale on content**: `brief_architect.prompt` 9910→3939 (−60%, refused), `artifact_plan.prompt` 9369→5206 (−44%, refused), `brief_architect.outputSchema` −1828, `artifact_plan.outputSchema`/`.schema` −1587 each | C-19; reproduced |
| store → canonical (`nodes:check`) | **the store is stale on topology**: it holds the pre-W8 graph — `artifact_plan` `dependsOn [article_body]`, `produces [artifact_plan.v1]`, `riskLevel write`, plus `article_body`, `publish_payload`, `learning_recorder` edges and the whole tail order | reproduced; `publishingTail.ts:102-115` |

**Live runs are correct.** They get canonical's W8 topology (pinned) and the store's 2026-09 content (overlaid). The deadlock is in the tooling.

### 1.3 Why it got here

- `nodes:check` and `store:check` are in **neither** workflow. `.github/workflows/ci.yml` gates `typecheck`, tests, `test:drift`, `test:glossary`, `test:objects`, `test:scope`, and the ui suite. Nothing watches this seam.
- The one credential-free gate that could have watched it, `nodes:check:offline` (`package.json:17`), is **permanently red and has never been in CI** — see §1.4 (N2). So "the gate is down" was itself undetectable, one level up. This is precisely the failure `seedNodesFromWorkspace.ts:112-122` describes happening to the *live* gate; it has a twin.
- The store is written legitimately and often: the admin chat, `optimizer.promote` (`improvement/optimizer.ts:283,285`), `playbook.apply_delta`, `scripts/dtcPublishingNodeCorrections.ts`, `scripts/applyNodeOps.ts:520`, and hand-fixes during live incidents.
- The MCP surface will write canonical-owned fields with no guard: `workspace.update_node` takes an arbitrary `patch` (`src/agent/mcp/workspace/tools.ts:924`), and `workspace.update_node_dependencies` writes `dependsOn` outright (`tools.ts:928`). Neither reaches a run — `overlayStoreNode` discards them — so every such write is a **write-only lie** that later blocks a re-seed.

### 1.4 Three findings this investigation added, not in Appendix A

Appendix A's `nodes:check` run dies inside `refuseUnsafe` and never reaches the later guards. Clearing the tail exposes more:

- **N1 — `magnetic_marketing` is in the live skill registry and not in code.** `skill_list` returns 14 skills; `seededSkillDefinitions` has 13 (`seededSkills.ts:22` plus `standardsPackSkillDefinition`). The store assigns `magnetic_marketing` to **four** nodes — `brief_architect`, `draft_writer`, `narrative_movement`, `angle_strategy`. `skillIntegrityProblems` (`seedNodesFromWorkspace.ts:219-228`) refuses on all four. This is armed **today** for the next tenant genesis: a fresh workspace seeds skills from `seededSkillDefinitions` (`skillRegistry.ts:33`), so those four nodes raise blocker-severity "assigned skill not found" attention items on a brand-new site. It is the same shape as the incident that header documents, recurring.
- **N2 — `seededSkills.ts` cannot round-trip through its own generator.** The file ends with the identifier `standardsPackSkillDefinition` (`seededSkills.ts` last line, deliberate — its header at `:15-19` explains why), but `renderSkills` (`seedNodesFromWorkspace.ts:422-442`) emits pure JSON with a fixed header and no import. `npm run nodes:check:offline` therefore exits 1 with `seededSkills.ts DRIFTED` **on a clean checkout**, and `nodes:update` would silently delete that import and inline the pin. The nodes renderer already solved exactly this problem for shared schema properties (`seedNodesFromWorkspace.ts:390-412`); the skills renderer never got the same treatment.
- **N3 — `article_body.metadata.canonicalRules` is a genuine two-way divergence, not "store behind".** Both planes carry five rules. Four match. The fifth differs: canonical has *"Media comes from artifact_plan's already-verified media_slots only…"*; the store has *"Do not regenerate the article from a brief, outline, or summary when the actual drafted text is available…"*. Both are real operating rules. The correct reconciliation is the **union (6)**, written to the store first — not `--allow-prompt-shrink`, which would delete the media rule that the entire W8 `artifact_plan`/`artifact_materializer` split exists to enforce.

Two smaller ones: `reseedStoreFromCanonical.ts:13`'s wholesale-metadata claim is stale (§1.1); and `seedNodesFromWorkspace.ts:480` mislabels `--from-canonical` runs as reading skills "from the live workspace store" when they read `seededSkillDefinitions`.

### 1.5 What actually blocks the re-seed, measured

Three experiments against the live snapshot, each isolating one cause:

| Source fed to `nodes:check --from` | Problems |
|---|---|
| the live export, unmodified | **14** (Appendix A, reproduced) |
| minus `brand_imagery_writer` / `visual_standard_materializer` | **12** |
| …and with canonical-owned fields taken from canonical | **1** (the N3 canonicalRule) |
| …and with `canonicalRules` unioned and `--skills` supplying `magnetic_marketing` | **0** — `graph valid`, `nodes added none`, **`edges changed none`**, real content drift ready to write |

`edges changed none` on the final run is the proof that matters: the reconciliation this ADR proposes writes **content only**. No edge, no risk level, no gate moves.

---

## 2. Decision — field ownership per plane

Each field has exactly one owner. The owner is the plane a run actually reads it from; the other plane's copy is either generated from it or refused at the write.

| Field | Owning plane | How it changes | How divergence is detected |
|---|---|---|---|
| `prompt` | **store** | `workspace.update_node_prompt`, `optimizer.promote`, `playbook.apply_delta`, admin chat — live, no deploy | `nodes:check` (live, scheduled). Erosion guarded by `MAX_PROMPT_SHRINK` 0.4 (`seedNodesFromWorkspace.ts:83`) |
| `inputSchema` | **store** | `workspace.update_node_input_schema` | `nodes:check` |
| `outputSchema` | **store** | `workspace.update_node_output_schema` (writes `schema` in lockstep, `tools.ts:927`) | `nodes:check`; OpenAI root-keyword lint warns at write (`tools.ts:927`) and at check (`seedNodesFromWorkspace.ts:450-454`) |
| `schema` (@deprecated alias, `nodeTypes.ts:15-16`) | **store**, derived | never written alone — only by `update_node_output_schema` | `nodes:check`; must equal `outputSchema` |
| `name`, `description` | **store** | `workspace.update_node` | `nodes:check` |
| `allowedTools` | **store**, *constrained* | `workspace.update_node_tools` only | `nodes:check` + the publish/admin `project.call_tool` refusal (`seedNodesFromWorkspace.ts:360-368`). **Never** widened by a re-seed in either direction |
| `assignedSkills` | **store** | `skill.assign` / `skill.unassign` (`tools.ts:898-899`) | `nodes:check` + `skillIntegrityProblems` (`:219`) — N1 is this check firing correctly |
| `modelConfig` | **store** | `workspace.update_node_model_config` (deep-merges, `tools.ts:932`), `optimizer.promote` | `nodes:check` |
| `executionConfig` | **store** | `workspace.update_node` | `nodes:check` |
| `metadata` — general keys | **store**, merged over canonical (`executor.ts:364-367`) | `workspace.update_node_metadata`; canonical supplies defaults the store may omit | `nodes:check`; `canonicalRules` drop guard (`seedNodesFromWorkspace.ts:301-306`) |
| `metadata.*Deterministic` (tail routes) | **UNRESOLVED — see §7.1** | today: store only, unguarded (K-A9) | nothing today |
| `metadata.skipWhen` / prefetch flags | **code seed is the floor** (`nodeGatingSeed.ts:1-26`), store row wins where present (K-A14 residual) | code: deploy. store: `workspace.update_node_metadata` | none today; `nodes:check` would surface a store row that shadows the seed |
| `id`, `kind` | **canonical** | `nodes.ts` + redeploy | store copy ignored at dispatch; re-seed pins from canonical (§3) |
| `dependsOn`, `requiredInputs`, `produces`, `riskLevel` | **canonical**, and for tail nodes **`publishingTail.ts`** | `publishingTail.ts` + `nodes.ts` in the same commit + redeploy (`publishingTail.ts:149-169` refuses otherwise) | `publishingTail.test.ts` (CI, blocking); `refuseUnsafe`'s tail check (`seedNodesFromWorkspace.ts:378`); risk-ladder guard (`:344-347`) |
| `position`, `status` | **canonical** | `nodes.ts` + redeploy | gate-regression NOTE (`seedNodesFromWorkspace.ts:310-317`), reported never blocked |
| skill definitions (`seededSkills.ts`) | **store** (`SkillRepository`) | `skill_create` / `skill_update` | `nodes:check --skills`; blocked today by N2 |

**The rule in one line:** the store owns *how a node runs*; code owns *what the graph is*. A field's copy in the non-owning plane is a generated artifact or a refused write — never an independent source.

---

## 3. Decision — the three structural changes this implies

1. **`nodes.ts` and `seededSkills.ts` are generated snapshots of the store's content fields.** They are already labelled that way (`seedNodesFromWorkspace.ts:24-28`, `seededSkills.ts` header); this ADR makes it true by putting the generator in CI and fixing the two things that stop it round-tripping (N2, and the visual-identity scoping gap).
2. **The re-seeder takes canonical-owned fields from canonical, not from the store, by default.** Those fields can never reach a run from the store (`executor.ts:353`), so copying them into `nodes.ts` was always meaningless — and it is the sole reason 11 of the 14 refusals exist. Opting out (`--adopt-store-topology`) stays available, because a deliberate topology change through the store is a sanctioned act (`seedNodesFromWorkspace.ts:21-23`); in that mode the tail conformance check fires exactly as designed and demands `publishingTail.ts` change in the same commit.
3. **The store's canonical-owned fields become unwritable through the normal MCP surface** for any node a registered workflow already defines, with the refusal text `reseedStoreFromCanonical.ts:275` already uses. They are *kept in the rows* — `assertGraphValid` (`store.ts:347-355`) runs `validateWorkspaceGraph` on every mutation and requires every canonical id present, so rows cannot simply drop them.

---

## 4. Alternatives, priced

### Option A — Store-authoritative for content; `nodes.ts` a generated snapshot gated in CI  ← **recommended**

**What it is.** Exactly §2 and §3. `nodes:check` red on divergence; `nodes:update` the only way content fields change in git; `reseedStoreFromCanonical`'s `RESEED_ALLOWLIST` shrinks to the handful of genuine code-first pushes and eventually to zero.

**What it costs.**
- One CI job with a credential. The `GCP_SERVICE_ACCOUNT_KEY` secret already exists (`cloud-run-plane.yml:21-26`, used at `:80` and `:88-90` via `google-github-actions/auth@v2`) — **confirmed**. It needs **one** new IAM grant: `roles/storage.objectViewer` on `gs://cms-agent-503015-cms-agent-state`. Read-only; the job never writes.
- Fork PRs get no secrets, and the store moves independently of any diff, so this job **cannot** be a per-PR required check without being unattributable and therefore disabled. It runs scheduled + manual (§5E in the plan). Cost: ~3 min of `ubuntu-latest` per day, zero per PR.
- Fixing N2 first (a ~15-line identifier substitution in `renderSkills`, mirroring `seedNodesFromWorkspace.ts:390-412`). Without it the whole scheme is red on a clean checkout.
- A committed `nodes.ts` will routinely lag the store by hours. That is honest and visible instead of silent and unbounded, but it does mean "green CI" no longer implies "code equals live".

**What it gives up.** The fiction that `nodes.ts` is authored. It becomes a lockfile. Anyone who wants to change a prompt must do it in the workspace, not in the editor — which is already true at runtime and merely stops being surprising.

**Invariant 3 (live iteration) is fully preserved**: a prompt fix still lands with no PR and no deploy. The `nodes:update` commit is bookkeeping that follows, not a gate that precedes.

### Option B — Code-authoritative; the store holds no content fields

**What it is.** Delete the content half of `overlayStoreNode`. Every prompt, schema, tool grant and model config comes from `nodes.ts`. The store keeps only run state.

**What it costs — honestly.**
- **It kills the optimizer.** `optimizer.promote` writes `updateNodePrompt` / `updateNode({modelConfig})` (`optimizer.ts:283,285`). With no store override, a promotion changes nothing until someone opens a PR and redeploys. The trial→analyze→propose→promote loop becomes trial→analyze→propose→**file a ticket**. `optimizer_auto_promote` becomes a no-op with a misleading name.
- **It kills `playbook.apply_delta`** and the admin chat's authoring surface for the same reason.
- **It puts a Cloud Run redeploy on the critical path of every live editorial fix.** The 2026-09-01 `article_body.prompt` hand-fix that unblocked `run_1788208708424_a4xtn2` (`reseedStoreFromCanonical.ts:108-111`) becomes a PR, a review, a build and a deploy — during an incident.
- It does not even remove the drift: `nodes.ts` would still diverge from what *ran* on any revision older than `main`.

**What it gives up.** The product's own improvement loop, which is a feature and not an accident. This option is not merely more expensive — it deletes a shipped capability to solve a tooling problem. **Reject.**

### Option C — Keep the split, add the watch (nothing else changes)

**What it is.** Put `nodes:check` and `store:check` in CI. Change no script, no ownership.

**What it costs.** Almost nothing to build.

**Does it stop recurrence?** **No — and it cannot run at all today.** Both scripts refuse against the current live store; adding them to CI adds two permanently-red checks, which get disabled within a week (§5E's own warning). Even after a one-off reconciliation it only shortens the interval: the store's canonical-owned fields stay writable (`tools.ts:924,928`), so the next `workspace.update_node_dependencies` call re-breaks `nodes:check` with a write that can never reach a run. The watch fires on a lie. That is the "fix the instance, not the mechanism" outcome invariant 5 forbids.

It is a *component* of Option A (Option A includes the watch), not an alternative to it.

---

## 5. Recommendation

**Option A.** The store already wins at dispatch for every content field; the codebase is built end-to-end for this (`seedNodesFromWorkspace.ts`'s entire header argues for it, the guards exist, the renderer is byte-stable for nodes). Option A writes down what is already true, then stops the two things that make it unworkable: the generator copying fields it can never own, and nothing watching the seam.

Sequenced so the unblock lands alone: fix scoping + canonical-field pinning + the `renderSkills` round-trip → reconcile once → then add the watch. Full task breakdown in `docs/plan/two-plane-reconciliation-plan.md`.

---

## 6. The §4 invariants, checked against the recommendation

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | Topology and risk stay pinned in code; a store edit must never rewire an edge, reorder the tail, or downgrade a publish-risk gate | **Strengthened.** `overlayStoreNode` is untouched, so dispatch is unchanged. Pinning canonical-owned fields at re-seed removes the one path by which a store topology edit could reach `nodes.ts`; §3.3 additionally stops such a write being accepted. `--adopt-store-topology` keeps the deliberate path, and in that mode `publishingTailConformanceIssues` (`:378`) still refuses unless `publishingTail.ts` changes in the same commit | `executor.ts:352-369`; `publishingTail.ts:149-169`; `seedNodesFromWorkspace.ts:344-347,360-368,378,385` |
| 2 | The publish charter is never widened | **Held — explicitly out of scope.** No change to `publisher.ts`, `publishDecision.ts`, `publishingTail.ts`. The measured reconciliation writes `edges changed none` and touches no publish-risk node's `allowedTools`. §7.1 is flagged as a separate decision *because* it is adjacent to this | §1.5 experiment 4; plan §"Non-goals" |
| 3 | Live content iteration survives — prompt/schema fixes without a deploy, and the optimizer/playbook loop | **Held in full.** Option A makes the store *more* clearly the owner of those fields. No prompt change is routed through a PR to take effect. Option B was rejected on exactly this ground and the cost is priced in §4 | `executor.ts:354-363`; `optimizer.ts:283-285` |
| 4 | Warn-never-block platform-wide; quality gates warn, only real gates block | **Held, with the line drawn explicitly.** Blocking: `nodes:check:offline` (self-consistency of a generated file — a real gate, no credential, attributable to the diff) and the existing `publishingTail.test.ts`. Warning: live store↔canonical content lag (scheduled job, not a required check) — it is real information about a system that is running correctly, and making it block a merge would make it unattributable and get it disabled | `ci.yml` `drift` job; plan §5E |
| 5 | Fix the mechanism, not the instance | **Held.** The one-off reconciliation is one task of several; the ownership rule, the generator fix, the write-surface refusal and the watch are the mechanism. Option C — reconcile and watch only — is rejected by name in §4 for failing this | §3; §4 Option C |

---

## 7. Open decisions requiring Wolf's approval

### 7.1 `metadata.*Deterministic` ownership (K-A9) — NOT decided here
Six tail routes are store-only booleans today, and the live store carries `publish_executor.publishExecutorDeterministic = "execute"` (confirmed in the 2026-09-13 export) while canonical sets neither that flag nor `publicationControllerDeterministic` (`reseedStoreFromCanonical.ts:132-138`). Pinning them in code is the right answer *and* it changes publish-path behaviour, which this ADR's own non-goals forbid. It is recorded as its own decision, unmade.

---

## 8. Consequences

**Positive.** The re-seeder runs again. `nodes.ts` becomes a lockfile with a meaning. The store's stale topology stops being able to block anything, be written by accident, or be mistaken for something that takes effect. N1 and N2 — both live, both silent, both armed for a tenant genesis — get caught by the gate that exists to catch them.

**Negative.** `nodes.ts` diffs get noisier (generated content churn on prompt promotions). A daily CI job now needs a cloud credential, widening the blast radius of `GCP_SERVICE_ACCOUNT_KEY` by one read-only bucket grant. A red scheduled check that nobody actions is still possible — mitigated by the runbook, not eliminated.

**Neutral but worth stating.** `RESEED_ALLOWLIST` does not disappear on day one. Code→store remains the right direction for a genuine code-first change (the W8 entries are exactly that). What changes is that it stops being the *only* direction that works.
