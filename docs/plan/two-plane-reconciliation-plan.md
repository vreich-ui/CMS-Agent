# Two-plane reconciliation — implementation plan (cms-agent)

Companion to `docs/plan/ADR-2026-09-13-node-definition-field-ownership.md`. That ADR decides ownership; this plan lands it.

- **Date:** 2026-09-13
- **Part 1 (§A)** is the immediate unblock. It is landable and shippable **on its own** and depends on nothing in Part 2.
- **Part 2 (§B)** is the durable fix.
- Every task states goal, files, acceptance test (a command and its expected output), land order, and the model + reasoning effort a runner chat should use.
- **Never Fable.** Anything touching `executor.ts`, the seed scripts, or CI is **Opus, high**. Mechanical edits are Sonnet.
- `main` is protected — land through a PR (CLAUDE.md). Cloud sessions cannot push; deliver via the `patch-delivery` skill.

**Verification status of every claim below:** reproduced in this investigation against a live `workspace_export_workspace` snapshot (51 nodes, `workspaceVersion` 1182, `updatedAt` 2026-09-13T13:58:21.883Z). `nodes:check --from` reproduced Appendix A's 14 problems verbatim; `store:check`'s planner reproduced its 4/4/2 verbatim. Deviations from Appendix A's exact invocation are listed in §D.

---

## Part 1 — Immediate unblock (§5A)

### T1 — Scope visual_identity's two nodes out of the publishing re-seed

**Goal.** `brand_imagery_writer` and `visual_standard_materializer` are not publishing_conductor nodes and must not be fed to the publishing re-seeder. This is a one-line omission, not an orphan problem — see §5D verdict below.

**Files.** `scripts/seedNodesFromWorkspace.ts` (import + `OTHER_WORKFLOW_NODE_IDS`, `:130`); `tests/agent/workspace/seedNodesScoping.test.ts`.

**Exact change.**
```ts
// scripts/seedNodesFromWorkspace.ts — add to the imports beside captureConductorNodes/cloneConductorNodes
import { visualIdentityNodes } from "../src/agent/workspace/visualIdentityNodes.js";

// :130 — was [...captureConductorNodes, ...cloneConductorNodes]
const OTHER_WORKFLOW_NODE_IDS = new Set(
  [...captureConductorNodes, ...cloneConductorNodes, ...visualIdentityNodes].map((node) => node.id)
);
```
`scopeToPublishingConductor`'s collision guard (`:138-145`) and the by-exclusion design need no change: `visualIdentityNodes` composes no publishing tail at all (`visualIdentityNodes.ts:30-34`; `workspaceStoreNodes.ts:60-67`), so it collides with nothing. Update the `say()` label at `:472` from "capture/clone node(s)" to "non-publishing node(s)", and mirror the union in `seedNodesScoping.test.ts`'s `storeShapedUnion()` (`:25-26`) so the test keeps matching how `workspaceStoreNodes.ts` actually builds the document.

**Acceptance test.**
```
npx tsx scripts/seedNodesFromWorkspace.ts --from <live-export.json>
```
Expected: the `scoped` line names **26** excluded nodes including `brand_imagery_writer, visual_standard_materializer`, and the refusal count drops **14 → 12** — the two `missing schema` problems are gone. (Measured.)
```
npm test -- seedNodesScoping
```
Expected: green.

**Land order.** 1. **Model:** Opus, high (touches a seed script).

---

### T2 — Pin canonical-owned fields from canonical during a re-seed

**Goal.** Stop the generator copying fields that can never reach a run from the store. This is the answer to §5A. It removes 11 of the 14 refusals without weakening a single guard.

**Why not the shapes the brief floated.** A "content-only re-seed mode" is the right *idea*, but implementing it as a flag that **scopes `refuseUnsafe`'s tail checks to the fields being written** is the wrong shape: it would leave the generator emitting the store's stale topology into `nodes.ts` with the tail check switched off — a silently forked tail, which is exactly what `publishingTail.ts:16-19` exists to prevent. Fix it at the source-normalisation step instead, and let every guard keep running, unmodified, over the result. **If a flag is wrong, this is what is right:** normalise the source, do not narrow the guard.

**Files.** `scripts/seedNodesFromWorkspace.ts`; `src/agent/workspace/executor.ts` (export one constant only, no behaviour change); new `tests/agent/workspace/seedNodesCanonicalPinning.test.ts`.

**Exact change.**
1. In `executor.ts`, beside `overlayStoreNode` (`:352-369`), export the complement of the fields it overrides, so the two can never disagree:
```ts
// The fields overlayStoreNode does NOT let a store row override — i.e. the fields a run always takes
// from canonical. Exported so scripts/seedNodesFromWorkspace.ts pins exactly these and no others.
export const CANONICAL_OWNED_FIELDS = ["id", "kind", "dependsOn", "requiredInputs", "produces", "riskLevel", "position", "status"] as const;
```
Note this is a **superset** of `reseedStoreFromCanonical.ts:85`'s `TOPOLOGY_FIELDS`, which omits `kind` and `requiredInputs`. Widen `TOPOLOGY_FIELDS` to import from this constant in the same PR so there is one list.

2. In `seedNodesFromWorkspace.ts`, add a normalisation step between `scopeToPublishingConductor` (`:471`) and `topologicallyOrdered` (`:474`):
```ts
const ADOPT_TOPOLOGY_FLAG = "--adopt-store-topology";

// overlayStoreNode (executor.ts:352-369) pins CANONICAL_OWNED_FIELDS to the canonical definition on
// every dispatch, so a store row's copy of them can NEVER reach a run. Copying them into nodes.ts is
// therefore not a re-seed, it is transcribing a value the runtime already ignores — and it is the sole
// reason 11 of the 14 refusals measured 2026-09-13 existed. Pin them from canonical for any node
// canonical already defines; a node the store adds keeps its own (there is nothing to pin from).
// --adopt-store-topology restores the old behaviour for a DELIBERATE topology change, where the tail
// conformance check at refuseUnsafe() then demands publishingTail.ts move in the same commit.
export const pinCanonicalOwnedFields = (source: WorkspaceNode[]): { pinned: WorkspaceNode[]; changed: string[] } => { /* … */ };
```
Report every pin on stdout (`pinned  artifact_plan.dependsOn [article_body] -> [brief_architect, contract_intelligence, draft_writer] (store copy is never dispatched)`) so an operator sees exactly what was discarded and why. Do **not** silence it.

3. Leave `refuseUnsafe` (`:322-388`) **completely unchanged**. The tail check, the risk ladder, the `project.call_tool` guard, `validateWorkspaceGraph` and the recipe-authority check all still run, over the normalised array. They pass because the array is now correct, not because they were narrowed.

**Acceptance test.**
```
npx tsx scripts/seedNodesFromWorkspace.ts --from <live-export.json>
```
Expected: refusal count **12 → 1**; the only remaining problem is `article_body: would drop 1 canonicalRule(s): "Media comes from artifact_plan's already-verified media_slots only…"`. (Measured.)
```
npx tsx scripts/seedNodesFromWorkspace.ts --from <live-export.json> --adopt-store-topology
```
Expected: back to 12 problems, all `tail:`-prefixed. Proves the guard was not weakened, only bypassed by explicit request.
```
npm run nodes:check:offline
```
Expected: `nodes.ts up to date`, `edges changed none` — pinning is a no-op when source and canonical agree.

**Land order.** 2 (after T1). **Model:** Opus, high.

---

### T3 — Make `seededSkills.ts` round-trip through its own generator

**Goal.** `npm run nodes:check:offline` exits 1 on a clean checkout today with `seededSkills.ts DRIFTED`, and `nodes:update` would delete a deliberate import. This must be fixed before any gate in Part 2 can be green, and before the one-off re-seed writes the file.

**Evidence.** `seededSkills.ts` ends with the identifier `standardsPackSkillDefinition` (its header at `:15-19` explains why it is a pin, not a copy). `renderSkills` (`seedNodesFromWorkspace.ts:422-442`) emits pure JSON with a fixed header and no import, so byte-equality is unreachable. Confirmed: `npm run nodes:check:offline` → `seededSkills.ts DRIFTED`, exit 1, no local changes.

**Files.** `scripts/seedNodesFromWorkspace.ts` (`renderSkills`); `tests/agent/workspace/` (new round-trip test).

**Exact change.** Mirror the mechanism that already exists 20 lines above for schemas — `SHARED_SCHEMA_PROPERTIES` / `substituteSharedProperties` / `restoreSharedIdentifiers` (`:390-412`). In `renderSkills`, emit the `import { standardsPackSkillDefinition } from "./standardsPack.js";` line in the generated header, and substitute the bare identifier for any skill that deep-equals `standardsPackSkillDefinition` instead of inlining its JSON. Same reasoning, same shape, same reason: an identifier the generator must preserve or the file stops being the single source of truth its header claims.

While in the file, fix the label bug at `:480`: with `--from-canonical` and no `--skills`, the run uses `seededSkillDefinitions` but prints "from the live workspace store". Correct to name the compiled set.

**Acceptance test.**
```
npm run nodes:check:offline
```
Expected: `nodes.ts up to date` **and** `seededSkills.ts up to date`, exit **0**. This is the first time this command has passed.
```
git diff --exit-code src/agent/skills/seededSkills.ts
```
after `npm run nodes:update -- --from-canonical --write` — expected: no diff, in particular the `import { standardsPackSkillDefinition }` line survives.

**Land order.** 3. **Model:** Opus, high (seed script).

---

### T4 — Correct the two stale comments the next reader will act on

**Goal.** `reseedStoreFromCanonical.ts:13` states that `metadata` is "replaced WHOLESALE, not merged". `executor.ts:364-367` merges it, store keys winning per key. `KNOWN_ISSUES` K-A9 already describes it correctly. A reader who trusts the script header will mis-reason about K-A9 and about what a metadata write costs.

**Files.** `scripts/reseedStoreFromCanonical.ts` (header only, `:12-14`). No logic.

**Exact change.** Amend to: `allowedTools is replaced WHOLESALE; metadata is MERGED per key with the store winning (executor.ts:364-367).` Keep the following sentence about a stale store row silently winning — it remains true for any key the store row declares. Add one line noting that the K-A9 hazard survives the correction: a canonical→store *write* still deletes store-only keys, because after the write there is nothing left for the merge to preserve. That is why `publish_executor.metadata` stays off `RESEED_ALLOWLIST`.

**Acceptance test.** `npm run typecheck` green; `git diff` touches comments only (`git diff -U0 -- scripts/reseedStoreFromCanonical.ts | grep -c '^[+-][^+-]' ` — every changed line begins with ` *`).

**Land order.** 4, or fold into T2's PR. **Model:** Sonnet, medium.

---

## Part 2 — Durable fix (§5B/C/D/E)

### T5 — Refuse canonical-owned field writes at the MCP surface (§5C)

**Goal.** Make "the store's topology is stale" a permanent non-event. Today `workspace.update_node` accepts an arbitrary `patch` (`src/agent/mcp/workspace/tools.ts:924`) and `workspace.update_node_dependencies` writes `dependsOn` outright (`:928`). Neither reaches a run — `overlayStoreNode` discards them. Every such write is a write-only lie that later blocks a re-seed. That is how the store came to hold the pre-W8 graph.

**§5C decision — keep, ignore, or drop?** **Keep the fields in the rows; ignore them in the re-seeder (T2); refuse new writes to them here.** Dropping them from the rows is not available: `assertGraphValid` (`src/agent/mcp/workspace/store.ts:347-355`) runs `validateWorkspaceGraph` on **every** mutation and requires every canonical id present, so a row without `dependsOn`/`produces` fails the next unrelated write. Keeping-and-reconciling alone is Option C from the ADR and only shortens the interval.

**Files.** `src/agent/mcp/workspace/tools.ts` (`:924`, `:928`); `src/agent/mcp/workspace/store.ts` if the guard is better placed in `updateNode` (`:574`); tests.

**Exact change.** For any node id a registered workflow defines (`workflowRegistry` / `workspaceStoreCanonicalIds`), refuse a patch touching `CANONICAL_OWNED_FIELDS` with the message `reseedStoreFromCanonical.ts:275` already writes — naming `overlayStoreNode`, naming `npm run nodes:update` + redeploy as the real path, and saying plainly that the write would not have taken effect. A store-authored node canonical does not know is unaffected (it has no canonical row to be pinned from, and adding one is a supported act — `seedNodesScoping.test.ts:51-59`).

**Acceptance test.** New test: `workspace.update_node_dependencies` on `artifact_plan` rejects with a message containing `overlayStoreNode` and `nodes:update`; the same call on a store-only node succeeds. `npm test` green. Then, against a scratch store, re-running T2's acceptance command still shows `1 problem` — i.e. no new topology divergence can be introduced.

**Land order.** 5. **Model:** Opus, high (MCP write surface; adjacent to K-M5).

---

### T6 — The CI watch (§5E)

**Goal.** A gate that is real, attributable, and actionable in one command.

**Two checks, deliberately different in kind.**

**(a) Blocking, no secrets — add to the existing `drift` job in `.github/workflows/ci.yml`.**
```yaml
      # nodes.ts and seededSkills.ts are GENERATED (scripts/seedNodesFromWorkspace.ts). This proves they
      # round-trip through their own generator byte-for-byte — a hand-edit the generator would not
      # reproduce fails here. It does NOT prove parity with the live store; the scheduled
      # node-definition-parity workflow does that. No credentials, runs in-process.
      # Intentional changes: `npm run nodes:update`, then commit both files.
      - name: Detect generated node-definition drift
        run: npm run nodes:check:offline
```
Reads: `src/agent/workspace/nodes.ts`, `src/agent/skills/seededSkills.ts`, the compiled canonical set. **No network, no secrets, no store.** Cost: ~20 s on a job that already installs deps — call it ~$0.003/build on GitHub-hosted `ubuntu-latest`, and $0 if the repo is on included minutes. This is a **real gate**: its verdict is caused by the diff under review, so it blocks (invariant 4). **Prerequisite: T3, or it is red on every build from day one.**

**(b) Warning, credentialed — a new scheduled workflow, not a required check.**
```yaml
name: Node definition parity
on:
  schedule: [{ cron: "41 7 * * *" }]   # 24 min after cloud-run-plane's 07:17, so they never contend
  workflow_dispatch:
permissions: { contents: read, id-token: write }
jobs:
  parity:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: npm, cache-dependency-path: package-lock.json }
      - run: npm ci --no-audit --no-fund
      - uses: google-github-actions/auth@v2
        with: { credentials_json: "${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}" }
      - name: canonical vs live store (store -> canonical)
        env: { WORKSPACE_STORE: gcs, GCS_BUCKET: cms-agent-503015-cms-agent-state }
        run: npm run nodes:check
      - name: live store vs canonical (canonical -> store)
        if: always()
        env: { WORKSPACE_STORE: gcs, GCS_BUCKET: cms-agent-503015-cms-agent-state }
        run: npm run store:check
```
**What it reads:** the GCS object(s) behind `WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state` — `workspace/current.json` and whatever `bootstrapWorkspaceStore` (`seedNodesFromWorkspace.ts:185-186`) resolves. Read-only; neither script writes without `--write`.

**IAM grant needed:** exactly one. `roles/storage.objectViewer` on `gs://cms-agent-503015-cms-agent-state`, to the service account behind `GCP_SERVICE_ACCOUNT_KEY`. That secret already exists and is already wired to `google-github-actions/auth@v2` (`cloud-run-plane.yml:21-26, 80, 88-90`) — **confirmed**; no new secret, no new auth mechanism.

**Per-build cost:** zero on PRs and pushes — it does not run there. ~3 min of `ubuntu-latest` once a day (~$0.024/day at the standard Linux rate, $0 on included minutes).

**Why it must NOT be a required per-PR check.** Fork PRs receive no secrets, so it would be permanently red or permanently skipped on external contributions. More importantly its verdict is caused by *the store*, which moves independently of the diff: a developer would get a red check they did not cause and cannot fix from the branch. That is the precise shape of "a gate nobody can action gets disabled". Scheduled + `workflow_dispatch` keeps it informative and keeps it alive.

#### Red-gate runbook (put this in the workflow's own header comment, where the developer will find it)

> **`nodes:check` is red.** The live store has content `nodes.ts` does not. This is normal after a prompt promotion and is **not** an incident — live runs are correct either way, because the store wins at dispatch.
> 1. Read the output. `drift`/`DRIFTED` lines = ordinary lag. `refuse` lines = something needs a decision.
> 2. Ordinary lag: `WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state npm run nodes:update` → commit `src/agent/workspace/nodes.ts` and `src/agent/skills/seededSkills.ts` → PR. **No deploy is needed for the change to be live** — it already is. The commit is bookkeeping.
> 3. `would drop N canonicalRule(s)`: the store row lost a rule canonical carries. **Do not pass `--allow-prompt-shrink`.** Decide whether the rule is retired. If not, put it back in the store (`workspace.update_node_metadata`, union of both lists) and re-run. Only pass the flag when a human has said the rule is genuinely dead.
> 4. `prompt would shrink … past the 40% ceiling`: same posture. Diff the two prompts before anything else.
> 5. `assigned skill "<id>" is not in the seeded skill set`: the live registry has a skill code does not. Re-seed **both halves together** — `npm run nodes:update` reads skills from the same store. If you are working from an MCP snapshot, you must pass `--skills` as well (§C).
> 6. `tail:` lines: the store holds topology that cannot reach a run. After T2 this should be impossible; if it appears, T5's write guard has a hole — file it, do not pass `--adopt-store-topology`.
>
> **`store:check` is red.** Read `KNOWN_ISSUES` C-19 **first**. As of 2026-09-08 and still on 2026-09-13, every pair it wants to write is canonical being stale, not the store drifting. `store:update --allow-prompt-shrink` would delete the `style.visualStandardId` hook from `brief_architect` and `artifact_plan` and the check would go green — the capability loss looks like tidiness. The correct direction for this drift is `nodes:update`.

**Acceptance test.** `act` or a branch push showing the `drift` job runs four → five steps and is green. For (b): `workflow_dispatch` the new workflow once and confirm it authenticates, reads 51 nodes, and prints the bucket name on the `store` line (`reseedStoreFromCanonical.ts:469` — naming the backend on every run is the guard against the 2026-08-14 false green).

**Land order.** 6, after T1–T3 and the T7 reconciliation — otherwise (a) is red on merge. **Model:** Opus, high (CI).

---

### T7 — Retire the reseed allowlist entries the reconciliation settles

**Goal.** After T8, `RESEED_ALLOWLIST`'s W8 entries have done their job. Leaving them arms a future `store:update` to push a now-stale canonical over a corrected store.

**Files.** `scripts/reseedStoreFromCanonical.ts` (`:97-139`); `tests/agent/workspace/reseedStoreFromCanonical.test.ts`.

**Exact change.** After T8 lands and a re-run of `store:check` reports each pair `up to date`, remove that pair's entry, keeping the comment as a dated historical note. Do **not** remove `publish_executor`'s absence note (`:132-138`) — it documents a hazard, not a completed task. Do not remove entries still reporting drift.

**Acceptance test.** `npm run store:check` (credentialed) reports zero `drift` and zero `refuse` lines and exits 0, with `allowlist N (nodeId, field) pair(s)` showing the reduced N. `npm test -- reseedStoreFromCanonical` green.

**Land order.** 7. **Model:** Opus, high.

---

## §5D verdict — the two "orphan" nodes

**They are not orphans, they are live, and the re-seeder's exclusion list is simply incomplete.**

| Question | Answer | Evidence |
|---|---|---|
| Are they live? | **Yes.** Both `status: "active"` in the live store. `visual_standard_materializer` carries `metadata.visualStandardMaterializerDeterministic` and is executed by **engine code, not a model** | live export; `executor.ts:3082-3120`; `visualStandardMaterialization.ts:1-50` |
| Does anything dispatch them? | **Yes, three ways.** `node_execute('brand_imagery_writer')` (the chat path — platform's `brand_imagery_propose` proxies to it); applying from the approval card via a `visual_identity` run; and a full `visual_identity` run at site genesis | `visualIdentityWorkflow.ts:5-20`; `routeRegistry.ts:371,422`; `gateRegistry.ts:84`; `operationWorkflowBindings.ts:22-23` |
| Where do they belong? | **`src/agent/workspace/visualIdentityNodes.ts`, where they already are** — `:145-261`, registered as their own workflow (`visualIdentityWorkflow.ts:23`) and unioned into the store document by `workspaceStoreNodes.ts:67`. They must **never** enter `nodes.ts`: that array is `publishing_conductor`'s run topology, and folding them in is the tail-forking hazard `workspaceStoreNodes.ts:8-22` exists to prevent | as cited |
| Why "missing schema"? | Because `schema` is `@deprecated` and optional (`nodeTypes.ts:15-16`) and only `workspace.update_node_output_schema` ever writes it (`tools.ts:927`). Capture, clone and visual-identity nodes correctly never declared it. `REQUIRED_FIELDS` (`seedNodesFromWorkspace.ts:88`) still demands it — which is exactly the trap `:112-118` documents for capture/clone, recurring for a third node set | as cited |

**Action: T1 only.** No node moves, no definition changes, nothing is added to canonical. `brand_imagery_writer`/`visual_standard_materializer` are also the *consumer* of the `style.visualStandardId` hook C-19 warns is about to be deleted from `brief_architect`/`artifact_plan` — the two halves of one capability, one in each plane. Do not let a tidy-up sever them.

---

## §5F blast radius if this is left alone — named failures

Not "drift is bad". Each of these is armed today.

1. **The next tenant genesis ships four broken nodes.** The live store assigns `magnetic_marketing` to `brief_architect`, `draft_writer`, `narrative_movement`, `angle_strategy`; `seededSkillDefinitions` does not contain it (13 vs the registry's 14). A fresh workspace seeds skills from code (`skillRegistry.ts:33`), so a new site starts with four blocker-severity "assigned skill not found" attention items and its own direct-response discipline silently absent from every planning and drafting node. **This is the 2026-07-26 incident `seedNodesFromWorkspace.ts:212-218` was written about, recurring, and nothing is watching.**
2. **The only credential-free gate for this seam is red by construction and nobody knows.** `npm run nodes:check:offline` exits 1 on a clean checkout (`seededSkills.ts DRIFTED`, N2 above) and is in no workflow. A gate that cannot be green will never be added; a seam with no gate drifts. This is the shape `seedNodesFromWorkspace.ts:112-118` names, one level up from where it names it.
3. **K-A13 re-arms on the next correction pass.** `scripts/dtcPublishingNodeCorrections.ts:95-96` unconditionally appends to a top-level `allOf` on `research`, `draft_writer`, `trust_factual`, `review_aggregator`. The provider adapter now strips root keywords (#320, B1), so the 400 does not return — instead those invariants quietly stop being provider-enforced and survive only post-turn. A re-run reintroduces the divergence with no visible symptom at all, which is worse than the original.
4. **A good-faith `--allow-prompt-shrink` deletes a load-bearing rule permanently.** The documented remedy for the `article_body` refusal. The rule it removes — *"Media comes from artifact_plan's already-verified media_slots only…"* — is the exact invariant the whole W8 `artifact_plan`/`artifact_materializer` split was bought to enforce (`publishingTail.ts:46-51`). It is a two-way divergence (both planes carry five rules, one differs); the flag resolves it in the deleting direction.
5. **C-19's trap is unchanged and still the first thing a newcomer will hit.** `store:update --allow-prompt-shrink` strips `style.visualStandardId` from the two nodes that plan every generated image, and `store:check` then goes green. The consumer of that hook is `visual_standard_materializer` (§5D), which the same run would have been told is an orphan.
6. **K-A9 is live, not theoretical.** The store carries `publish_executor.publishExecutorDeterministic = "execute"` (confirmed in the export) and canonical sets neither that flag nor `publicationControllerDeterministic`. Any path that writes canonical metadata onto that row puts a **model** on the publish step. `store:update` cannot (metadata is unallowlisted, deliberately), but `workspace.update_node_metadata` can and `scripts/applyNodeOps.ts:520` writes metadata from a markdown doc.
7. **Every hour of continued divergence widens the prompt gap past the 40% ceiling for more nodes.** Two prompts are already past it. The ceiling is the erosion guard; once a node is over it, the only way through is the flag that disables the guard. Drift converts a safety property into a nuisance, and nuisances get flagged away.

---

## One-off reconciliation

Run **after T1, T2 and T3 have landed**. Everything below was rehearsed against the 2026-09-13 live snapshot.

### Step 0 — capture the store, with skills

```bash
# From a chat holding an MCP session (no GCP credentials needed):
#   workspace_export_workspace  -> cms-agent-store-export.json
#   skill_list                  -> cms-agent-skills-export.json
```
**`workspace_export_workspace` does not carry skills.** Its `data` keys are `nodes, conversationalAgents, stageOutputs, learningObservations, versions, events, relationships, reducedContractCache, schemaVersion, workspaceVersion, updatedAt, currentRevisionId` — there is no `skills` key, and `readSkillSource` (`seedNodesFromWorkspace.ts:202-210`) looks only at the root, `.skills`, `.data.skills`. Without a second file the run falls back to `seededSkillDefinitions` and refuses on `magnetic_marketing` (measured). **Save `skill_list`'s payload separately and pass `--skills`.** With GCP credentials instead, skip this step entirely and drop both `--from`/`--skills` — the live read handles both halves.

### Step 1 — fix the store, first, in the direction that adds

Two writes, both **additive**, both through the sanctioned surface:

```
workspace_update_node_metadata {
  id: "article_body",
  patch: { metadata: { ...<the row's current metadata, verbatim>,
    canonicalRules: [ <the store's 5 rules, in order>,
      "Media comes from artifact_plan's already-verified media_slots only — never re-planned, re-generated, or re-verified here, and never an unverified reference in a rendered field" ] } } }
```
Writes: `article_body.metadata.canonicalRules` → 6 entries (union). `workspace.update_node_metadata` replaces `metadata` wholesale (`tools.ts:929`), so **re-send every sibling key** (`approvalRequired`, `externalStageMapping`) or they are lost.

Skills: if `magnetic_marketing` is only in the registry and not referenced from code, nothing to write — Step 2's `--skills` carries it into `seededSkills.ts`.

**Do not** touch `dependsOn`, `produces`, `riskLevel`, `status` on any node. T2 makes the store's copies irrelevant; correcting them is churn with a CAS-conflict risk and no benefit.

### Step 2 — re-seed canonical from the store

```bash
npx tsx scripts/seedNodesFromWorkspace.ts \
  --from cms-agent-store-export.json \
  --skills cms-agent-skills-export.json          # dry run first — MUST print no ✗
npx tsx scripts/seedNodesFromWorkspace.ts \
  --from cms-agent-store-export.json \
  --skills cms-agent-skills-export.json --write
```
Writes: `src/agent/workspace/nodes.ts` and `src/agent/skills/seededSkills.ts`. **Nothing else. No store write. No deploy.**

Expected dry-run output (measured on the rehearsal, with `canonicalRules` unioned and `magnetic_marketing` supplied):
```
source            49 nodes from cms-agent-store-export.json
scoped            26 non-publishing node(s) excluded
skills            14 from cms-agent-skills-export.json
graph             valid
openai schema     5 node(s) carry root keywords OpenAI response_format rejects — stripped when sent, still enforced post-turn
                  artifact_plan: if, then
                  artifact_materializer: if, then
                  publication_controller: if, then
                  publish_executor: if, then
                  release_executor: if, then
nodes added       none
edges changed     none
publish-risk      publication_controller, publish_executor, release_executor
nodes.ts          DRIFTED from the source
seededSkills.ts   DRIFTED from the source
```
The five `openai schema` lines are **advisory and expected** (`seedNodesFromWorkspace.ts:444-454`; K-A13). They are not a regression from this change.

### Step 3 — verify

```bash
npm run nodes:check:offline          # expect: both files "up to date", exit 0
npm run typecheck && npm test        # expect: green
npm run nodes:check -- --from cms-agent-store-export.json --skills cms-agent-skills-export.json
                                     # expect: "nodes.ts up to date", exit 0
```

### Step 4 — after merge, close the loop

Redeploy is **not** required for content (the store already serves it). It **is** required before `store:check` can be expected to agree, and before T7 retires allowlist entries. Then:
```bash
WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state npm run store:check
```
Expect the four `drift` pairs to become `up to date` and the two `refuse` lines to disappear — the refusals existed because canonical was 60%/44% shorter; after Step 2 canonical *is* the store's text.

### What a reviewer checks in the diff

1. **`git diff --stat`** touches exactly two files: `src/agent/workspace/nodes.ts`, `src/agent/skills/seededSkills.ts`. Anything else means a script wrote outside its remit.
2. **No topology moved.** `git diff -U0 src/agent/workspace/nodes.ts | grep -E '^\+\s*"(dependsOn|produces|riskLevel|position|status|id|kind|requiredInputs)"'` → **empty**. This is the single most important line in the review. It is also what the dry run asserted with `edges changed none`.
3. **Prompts grew, did not shrink.** `brief_architect.prompt` 3939 → 9910, `artifact_plan.prompt` 5206 → 9369, `article_body.prompt` 10822 → 10878. Every prompt delta is positive or near-zero. A negative delta means the direction was reversed.
4. **Schemas gained the `style` block.** `brief_architect.outputSchema` +1828 chars, `artifact_plan.outputSchema`/`.schema` +1587 each, and `style.visualStandardId` now appears in `nodes.ts`. That string appearing in this repo's `src/` for the first time is the point of the exercise (C-19).
5. **`artifact_plan.schema` and `artifact_plan.outputSchema` are byte-identical.** They are kept in lockstep by `tools.ts:927`; a divergence here is a bug in the source, not in the re-seed.
6. **`article_body.metadata.canonicalRules` has 6 entries**, including both the media rule and the no-regeneration rule. Five means something was dropped.
7. **`seededSkills.ts` gained `magnetic_marketing`** and **kept** the `import { standardsPackSkillDefinition } from "./standardsPack.js";` line and its trailing bare identifier. Losing that import is T3 regressing.
8. **No node was added or removed.** The dry run said `nodes added none`; the array length is unchanged at 25.
9. **`--allow-prompt-shrink` and `--allow-capability-loss` appear nowhere** in the commands run. If either was needed, the reconciliation was done in the wrong direction and must be redone.

---

## Non-goals

Explicitly excluded. The runner must not widen into any of these; each would be **its own decision requiring Wolf's approval**, stated as such before any code is written.

| Excluded | Why it is excluded here | Where it belongs |
|---|---|---|
| **Publish gates and publish authority** — `publisher.ts`, `publishDecision.ts`, `publishExecution.ts`, `releaseExecution.ts`, `objectPublishExecution.ts` | Untouched by anything in this plan. Widening the publish charter is forbidden outright (CLAUDE.md; ADR-2026-08-25-publish-autonomy) | a new ADR |
| **Tool grants on publish/admin nodes** — `allowedTools` on `publication_controller`, `publish_executor`, `release_executor`, `visual_standard_materializer` | `seedNodesFromWorkspace.ts:360-368` and `reseedStoreFromCanonical.ts:300-307` already refuse changes in both directions. The reconciliation must not carry one, and the review checks for it (reviewer check 2 covers the topology half; a grant change would show as an `allowedTools` diff on those ids) | operator decision via `workspace_update_node_tools` |
| **The tail declaration** — `publishingTail.ts`'s `publishingTailNodeIds`, `publishingTailDeclaration`, segment partitions | The plan's whole point is that canonical's tail is **correct** and the store's is stale. Nothing here changes the declaration, and T2's `--adopt-store-topology` is the only path that would demand it — deliberately gated behind an explicit flag | a topology change PR that moves `publishingTail.ts` and `nodes.ts` together |
| **`metadata.*Deterministic` pinning (K-A9)** | The right fix, and it changes publish-path behaviour. ADR §7.1 records it as unmade | its own decision |
| **K-A10 / K-M5 tool-grant review gating** | Adjacent to T5 and tempting to fold in. Different risk, different reviewer | its own decision |
| **`REQUIRED_FIELDS` dropping the `@deprecated` `schema` alias** | Looks like the "obvious" fix for the two orphan nodes and is the wrong one — `seedNodesFromWorkspace.ts:112-122` explains why backfilling or relaxing it is the hazard. T1 scopes instead | a separate deprecation task |
| **Deleting `dependsOn`/`produces`/`riskLevel` from store rows** | `assertGraphValid` (`store.ts:347-355`) rejects it on the next unrelated mutation | — |
| **Anything on `WORKSPACE_NODES_SOURCE`'s default** | C-4 is a docs defect, not a behaviour one | doc fix |

---

## Land order and model assignments, summary

| # | Task | Part | Model / effort | Blocked by |
|---|---|---|---|---|
| T1 | Scope visual_identity out of the publishing re-seed | 1 | **Opus, high** | — |
| T2 | Pin canonical-owned fields at re-seed (+ `--adopt-store-topology`) | 1 | **Opus, high** | T1 |
| T3 | `renderSkills` round-trip + `--from-canonical` label fix | 1 | **Opus, high** | — |
| T4 | Correct the stale metadata-merge comment | 1 | Sonnet, medium | — |
| T8 | **One-off reconciliation** (see above) | 1→2 | **Opus, high** | T1, T2, T3 |
| T5 | Refuse canonical-owned writes at the MCP surface | 2 | **Opus, high** | T2 |
| T6 | CI: blocking offline gate + scheduled parity workflow | 2 | **Opus, high** | T3, T8 |
| T7 | Retire settled `RESEED_ALLOWLIST` entries | 2 | **Opus, high** | T8 + redeploy |

Part 1 (T1–T4 + T8) is a complete, shippable change on its own: it unblocks both scripts and reconciles the two planes. Part 2 is what stops it recurring.
