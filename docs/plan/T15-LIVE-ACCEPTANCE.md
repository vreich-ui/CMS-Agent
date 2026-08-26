# T15.26 (#201) — the LIVE acceptance run

**This is the runbook a human with deploy access executes.** `tests/agent/capture/endToEndAcceptance.test.ts`
(this branch, `t15/201-end-to-end`) proves the machinery is wired correctly in mock/test execution mode
against a mocked MCP transport. It is not, and cannot be, a substitute for this document — no session
without `gcloud`/Cloud Run credentials can run these steps. Follow them in order; do not skip the
verification sub-steps to save time, because the two things this program has broken on before
(silently-dropped env vars, a deploy mistaken for "merged code is live") are both invisible unless
checked explicitly.

**Hard boundary, the whole way through: never touch `dr-lurie` beyond reads.** Every mutating step below
names `zilberman` (or a to-be-provisioned second target for the generalization run) explicitly. If a
step is ambiguous about which project it targets, stop and confirm before running it.

## 0. What was verified live, this session (2026-08-26), read-only

The CMS_Agent MCP connector was reachable for part of this session (it later disconnected; the
Zilberman_FF direct connector needs re-authorization — its OAuth token expired, and re-authorizing an
MCP connector cannot be done from an unattended session). Everything below is a **fact captured live**,
not inferred from code, and should be re-confirmed at the start of a real run since it will have moved
on:

| Fact | Value |
|---|---|
| Serving revision | `cms-agent-mcp-00166-dqp` (service `cms-agent-mcp`) |
| `gitSha` / `deployedAt` in `repository_get_health` | both `null` — this deployment does not stamp them; do not rely on this field to answer "which commit is live", use `npm run verify:deploy`'s surface-hash check instead (§4) |
| `workspaceVersion` | 696 |
| `zilberman` project registration | live, active, `mcpEndpoint: https://zilbermanfilmfoundation.netlify.app/mcp`, `capturePolicy.maxPages: 20`, `allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"]`, `publishingPolicy.publishEnabled: true` |
| `dr-lurie` project | live, active, `mcpEndpoint: https://drluriescience.netlify.app/mcp` — **reads only, per the hard boundary above** |
| `pdf-tool` project (the *bridge*, not the render-service itself) | live, `mcpEndpoint: https://pdf-x.netlify.app/mcp` |
| The blocked run named in this task's brief | **confirmed live and still blocked**, see §1 below |

### The blocked run, read in full

`mcp__CMS_Agent__workflow_get_run` for `run_1787582215829_u5rncz` returned (trimmed to what matters):

```
workflowId: clone_conductor        projectId: zilberman
status: blocked                    currentNodeId: clone_report
executionMode: openai (a REAL model run — this already cost real money)
mode.nodeSource: "store"
mode.notice: "LIVE MODEL RUN: node outputs came from the configured model provider. Node
  definitions were overlaid from the workspace store, so authoring edits (prompt, schemas, tools,
  skills, model config) are in this run. Topology — edges, riskLevel, new nodes — is pinned to the
  canonical definitions and still requires a deliberate re-seed (npm run nodes:update) plus redeploy."
initialInput: { captureRunId: "run_1787497206104_nckgkv", targetProjectId: "zilberman" }
publishingPolicySnapshot: null            operatorPublishDecision: null
nodes (9, none of them a publish-tail node): clone_intake, layout_analyst, recipe_designer,
  recipe_mint, theme_reconciler, theme_bind, fit_adjudicator, layout_restamp — all "completed";
  clone_report — "blocked":
    { code: "output_schema_invalid",
      message: "clone stage \"report\" produced an envelope its own node schema rejects:
                 $.capabilityBacklog must be array" }
```

This is the live system's own words confirming, independently of anything in this task's brief, both
halves of what T15 shipped and has not yet reached production:

1. **The schema mismatch.** `clone_report`'s deterministic builder (`cloneConductorNodes.ts`,
   `capabilityBacklog: { type: "object" }` on this branch — a map keyed by missing section type, per
   T15.33/#209) now produces an OBJECT. The **live, store-overlaid** `outputSchema` for `clone_report`
   still says `capabilityBacklog` must be an ARRAY — an older shape. `mode.nodeSource: "store"` is the
   mechanism: this workflow's node definitions (prompt, schema, tools, model config — everything except
   `dependsOn`/`riskLevel`/topology, which are pinned to canonical/code) are read from the live
   **workspace store**, not from whatever `nodes.ts`/`cloneConductorNodes.ts` says in a deployed image.
   Deploying new code alone does not fix this node's output schema; the store's own copy of that schema
   has to be updated too. This is a genuine, live, confirmed bug — not a hypothetical — and closing it is
   §3 below.
2. **The topology gap the brief described, confirmed independently.** `clone_conductor`'s live node list
   has exactly 9 nodes, ending at `clone_report`. There is no `publish_payload`, `publication_controller`,
   `publish_executor`, or `release_executor` anywhere in it. The shared publishing tail this whole T15
   series composed onto `clone_conductor` (T15.10/#189) is simply **not present** on the live graph. This
   run — and every other live `clone_conductor` run before a re-seed — cannot reach a publish decision,
   let alone a release, no matter what fixes ship in code.

Cost so far on this blocked run (`workflow_get_run_cost`, live, verified): **$0.18042**, 20,009 tokens
across `layout_analyst`/`recipe_designer`/`theme_reconciler`/`fit_adjudicator` — matching the brief's
cited clone-phase figure (≈$0.18) closely enough to trust the brief's other cost estimate too. Its
`captureRunId`, `run_1787497206104_nckgkv`, is a **completed** capture run, cost **$0.10442** (brief
said ≈$0.125 — same order, the brief's figure may be a different run or include a small rounding/markup;
re-read it live before treating either number as gospel for budgeting the real run in §7). Both runs are
well inside their $25 `budgetUsd` ceilings.

## 1. Preconditions

- `gcloud` authenticated against the `cms-agent-503015` project, with rights to: `gcloud run deploy`,
  `gcloud run jobs update`, `gcloud run jobs describe`, `gcloud builds submit`.
- A CMS_Agent MCP session with an **unscoped operator bearer** (`MCP_API_TOKEN`, not one of the
  per-site scoped tokens) — the scoped tokens cannot call `workspace_*` or `workflow_retry_node`.
- This repo checked out at (or merged past) `t15/201-end-to-end` — it carries the fixed
  `capabilityBacklog` schema, the `release_executor` tail node, and capture/clone's recomposition onto
  the shared publish segment. **Do not run any step below against an older commit.**
- Whoever owns the pdf-tool / render-service deployment (a separate service from `cms-agent-mcp`) is
  reachable — §4 needs its current URL, which this repo does not have and cannot derive (T15.1/#182:
  two plausible hostnames both 404'd; the real URL is generated at deploy time and never committed
  anywhere this repo can read).

## 2. Free reads — reconfirm §0's facts before touching anything

Everything in §0 will be stale by the time this runs. Before any mutating step:

```
repository_get_health                       # revision id, workspaceVersion — compare to §0
project_list                                # zilberman still active, capturePolicy unchanged
workflow_get_run { runId: "run_1787582215829_u5rncz" }
workflow_get_run_cost { runId: "run_1787582215829_u5rncz" }
```

If the blocked run's `currentNodeId` is no longer `clone_report`, or its `status` is no longer
`blocked`, someone else has already acted on it — read what happened before proceeding, don't retry
blind.

## 3. Push the fixed node definitions into the live workspace STORE

**Direction matters and is easy to get backwards.** `npm run nodes:update` reads the live STORE and
writes `src/agent/workspace/nodes.ts` (code) from it — it is a **store → code** sync for
`publishing_conductor`'s canonical file. It cannot, by itself, put this branch's fixes into the live
store; running it against today's (unfixed) store would produce a diff that looks like reverting this
work, not shipping it. The order that actually ships the fix (matching how this project's prior
engine-handoff push was done — see `claude/cms-agent-engine-handoff-result-2026-08-10.md`):

1. **Push this branch's node definitions to the live store**, via `workspace_*` MCP tools, an operator
   bearer, and this repo's own code as the source of truth:
   - `workspace_update_node_output_schema` for `clone_report` — the `capabilityBacklog: {type:"object"}`
     shape from `cloneConductorNodes.ts` on this branch. This alone unblocks `run_1787582215829_u5rncz`
     (§6) without touching topology.
   - The new tail composition: `workspace_create_node` for `release_executor` (metadata
     `releaseExecutorDeterministic: true`, `kind: "releaser"`, `riskLevel: "publish"` — copy the exact
     shape from `publishingTail.ts` on this branch) if it does not already exist in the store; then
     `workspace_update_node_dependencies` / `workspace_update_relationships` so `clone_report` (and
     capture's terminal report node) depend on `release_executor`, and `release_executor` depends on
     `publish_executor`, matching `publishingTail.ts`'s `publishingPublishSegmentIds` order exactly.
   - Every other field the T15 series changed on `publish_payload`/`publication_controller`/
     `publish_executor` for both `capture_conductor` and `clone_conductor` (prompts, schemas, tool
     grants) — diff this branch's `captureConductorNodes.ts`/`cloneConductorNodes.ts` against
     `workspace_get_nodes` output for each workflow and push every field that differs. Do this
     deliberately, field by field — a re-seed is allowed to ADD gates, never remove one
     (`seedNodesFromWorkspace.ts`'s own safety rule); if a diff looks like it would lower a riskLevel or
     drop a publish gate, stop and re-derive rather than push it.
2. **Run `npm run nodes:check`** (read-only diff) against the now-updated store. For
   `publishing_conductor` specifically this should be a no-op (nodes.ts already matches, on this
   branch). If it is not a no-op, something in step 1 was pushed wrong — reconcile before proceeding,
   per `nodes:check`'s own drift-report output.
3. Confirm via a fresh `workspace_get_nodes` / `workspace_get_graph` call for BOTH `clone_conductor` and
   `capture_conductor` that `release_executor` (and the rest of the shared tail) now appears in the
   live graph, with the dependencies §3.1 set. This is the actual proof the push worked — `nodes:check`
   only covers `publishing_conductor`'s own canonical file; capture/clone's topology has no local file
   to diff against, only the live store itself (this is the same blind spot the Conductor Workbench
   build found: "`workspace_get_graph`/`get_nodes`/`get_node` only ever return publishing_conductor's
   23 nodes" through some UI-facing calls — call `workspace_get_nodes` with the specific
   `workflowId`/`clone_conductor` filter, or `node_get` per node id, not the unfiltered listing, to be
   sure you're actually seeing clone's graph and not an empty/wrong result read as "nothing changed".)

## 4. Redeploy

- **`cms-agent-mcp`** (the MCP service): `scripts/deploy-mcp.sh` with `PROJECT=cms-agent-503015`,
  `REGION=us-central1` (confirm against `repository_get_health`'s revision name, which encodes no
  region but the service is presumed us-central1 per existing docs), and the other required env vars
  named at the top of that script. This also updates every job listed in `cloudbuild.deploy.yaml`'s
  `_EXECUTOR_JOBS` (currently just `continuation-tick`) to the same image digest, via the CI trigger
  (`cloudbuild.deploy.yaml`) rather than this script directly if deploying through the normal
  push-to-main path.
- **Open question this session could not resolve (no deploy access): does `job:conductor`
  (`src/agent/entrypoints/runConductorJobMain.ts`) need its own separate `gcloud run jobs update`?**
  It is not listed in `cloudbuild.deploy.yaml`'s `_EXECUTOR_JOBS` (only `continuation-tick` is). If a
  separate conductor job exists and executes workflow nodes on its own image, it needs the same digest
  update `_EXECUTOR_JOBS` gets, by whatever mechanism deploys it (not committed to this repo as far as
  this session found). Check `gcloud run jobs list --project cms-agent-503015 --region us-central1`
  for its actual name before assuming either "it doesn't exist" or "the executor-jobs step already
  covered it".
- **The pdf-tool render-service** (a separate deployment from `cms-agent-mcp`/`pdf-x.netlify.app` — the
  latter is CMS-Agent's *bridge* to it, not the render service itself). This repo has no script for it
  and no record of its current URL (§0). Whoever owns that deployment redeploys it; get the resulting
  URL from them directly (Cloud Run console / `gcloud run services list` in whatever project hosts it)
  rather than guessing — T15.1/#182 already burned two guessed hostnames.

## 5. Health verification — before spending anything on a real run

1. `npm run verify:deploy` against `cms-agent-mcp` (`MCP_URL=https://<service>/mcp`,
   `MCP_API_TOKEN=<operator bearer>`). This checks TWO things in one command, per the script's own
   header: the served tools/list surface hash matches `docs/mcp-tool-manifest.json` (proves the running
   revision really is this commit, not merely "a recent one"), and every registered project's
   `endpointConfigured`/`tokenConfigured` is still true (catches an env-var wipe from a bad
   `--set-env-vars` deploy — this has happened twice before per the script's own comment; the merge-
   style flags in `deploy-mcp.sh` are supposed to prevent a third time, confirm rather than assume).
2. `repository_get_health` — expect a NEW revision id (different from `cms-agent-mcp-00166-dqp`, §0) and
   `workspaceVersion` higher than 696 (bumped by §3's pushes).
3. The pdf-tool render-service's own `/health` endpoint (once §4 supplies its real URL) — expect
   `chromium.available: true` and a commit SHA matching the intended deploy. This is the render-service's
   OWN health surface, distinct from `cms-agent-mcp`'s — do not substitute one for the other.

## 6. Retry the blocked run — confirms the schema fix is live, on a run that already cost real money

```
workflow_retry_node { runId: "run_1787582215829_u5rncz", nodeId: "clone_report" }
```

This resets `clone_report` (and only that node — its 8 completed upstream siblings, $0.18042 of real
model work, stay reusable per `retryNode`'s own semantics: it clears one node's output/status and
requeues the RUN, it does not touch the others) and puts the run back to `status: "queued"` where the
`continuation-tick` job will pick it up on its own next tick — no `workflow_run_all`/`run_next_node`
call needed, though either works for a faster manual check.

**What "the fix is live" looks like:** `clone_report` completes (not `blocked` again with the same
`output_schema_invalid`), and its output actually validates against the array-or-object question —
read the completed node's own output and confirm `capabilityBacklog` came back as the object/map shape
this branch's code produces. **What "the topology re-seed also landed" looks like:** the run does NOT
stop at `clone_report` — it proceeds into `publish_payload` → `publication_controller` →
`publish_executor` → `release_executor`, nodes that do not exist at all in §0's read of this run. If
`clone_report` completes but the run halts immediately after with no further nodes to run, §3's
topology push did not take — go back and re-verify with `workspace_get_nodes` (§3.3) before spending
anything on §7's real run, since it would just hit the same wall.

This run has no `publishingPolicySnapshot` (§0: `null` — it predates that mechanism). If the retried run
reaches the tail, publish authority resolution for THIS specific run may need special-casing (a run
created before the policy snapshot existed has nothing to resolve against) — read
`workflow_publish_readiness` for this run before assuming it will behave like a fresh one. If it refuses
cleanly with a clear "no publishingPolicySnapshot" reason, that is expected for THIS old run and does
not indicate a fresh §7 run would have the same problem (§7's run is started fresh, after the re-seed,
and will be stamped normally at creation).

## 7. The real acceptance run

```
site.duplicate("https://www.zilbermanfilmfoundation.com")
  targetProjectId: "zilberman"        (already registered, capturePolicy.maxPages already 20)
  executionMode: "openai"             (a real run — mock mode would prove nothing here, see the
                                        test file's own header for why)
  budgetUsd: 1.00                     (generous headroom over the ≈$0.10–0.18 per phase this
                                        session measured live on the most recent real run of each
                                        half; raise it if §6's retry or judgment-node variance runs
                                        notably hotter than that)
```

Zilberman's project is `autonomyMode`-eligible for the autonomous path this whole series built —
confirm its `publishingPolicySnapshot` resolution (via `workflow_publish_readiness` once the run
starts) actually reads `autonomyMode: "autonomous"` rather than falling back to the OLDER
`publishingPolicy.operatorDefault: "approved"` field §0 also showed on this project's live config.
Those are two different mechanisms from two different points in this project's history — confirm which
one is actually driving THIS run's authority before treating a clean run as proof of the NEW policy
working; if it turns out the live project only has the old `operatorDefault` field set and not the new
`autonomyMode` field, set the latter (`project.update`, `autonomyMode: "autonomous"`) before this run,
or the run will behave correctly for the wrong (legacy) reason.

## 8. Drive to completion — do not manually poll-loop from a human terminal

The whole point of T15.9/#188 is that nothing but the `continuation-tick` Cloud Run job (§4) needs to
touch this run after it starts. Poll `site_duplicate_status` (read-only, free) every few minutes rather
than repeatedly calling `workflow_run_all`/`run_next_node` by hand — a human driving it manually would
not be testing the thing this issue is chartered to prove. If it stalls for longer than a few tick
intervals, that itself is a finding (write it into the acceptance report, §11) — do not paper over it
with a manual advance and report a clean result.

## 9. The exact assertions that constitute acceptance

Mirror `endToEndAcceptance.test.ts`'s own assertions, against real state instead of a mock transport:

- **Capture** reaches `status: "completed"`; `stageOutputs.release_executor.status === "executed"`,
  `verification.productionConfirmed === true`, `verification.deployStatus === "ready"`.
- **Clone chains automatically** — `site_duplicate_status`'s `chain` block is non-null, `cloneRunId`
  differs from the capture run's id, and the clone run's own `initialInput.captureRunId` equals the
  capture run's id. No human ever called `workflow_start_dry_run` for the clone half.
- **Clone reaches release too** — same `release_executor` check as capture, on the clone run.
- **Zero human content-path actions** — `operatorPublishDecision` stays `undefined`/`null` on BOTH runs
  the entire time; every `approvalsRequired` entry that gated a publish-risk node carries
  `source: "policy_autonomous"` and no `pending: true` entry ever existed. (There is no live "call
  count" API for `workflow.set_operator_publish_decision` the way the mock test's `vi.spyOn` proves it
  — this is the closest live equivalent: the durable field it would have set never got set.)
- **An explicit withheld still halts it — OPTIONAL, and only on a THROWAWAY run.** This property is
  already exhaustively proven deterministically by this branch's test suite (every test file this task
  built on: `clonePublishTail.test.ts`, `capturePublishTail.test.ts`,
  `siteDuplicateChainClonePublishes.test.ts`, and this branch's own `endToEndAcceptance.test.ts` Part
  2). Re-proving it live would mean starting a SECOND real, paid run for the sole purpose of vetoing
  it — real spend to re-confirm something code-level determinism already covers. Do this only if the
  re-seed (§3) changed the veto's own code path in a way the deterministic tests can't see (they
  shouldn't have — nothing in this task's scope touches `publishDecision.ts`); otherwise, skip it and
  cite the test suite instead.
- **Coverage ≥ 90% on the T12.6 rubric, via `capture_score`.** Read `stageOutputs.capture_score.rubric.
  coverage` off the completed capture run. **Report the actual number, whatever it is** — this session's
  mock run (no live model, see the test file's own note) measured 89.47% on this identical fixture, one
  block below the bar; a live run with a real `block_classifier` judgment call may well close that
  final margin, but that is exactly the thing only a live run can settle. Do not round up, do not treat
  "close" as "met" in the written report.
- **Pages, theme, and navigation visible at the production URL.** The zilberman project's registered
  `mcpEndpoint` is `https://zilbermanfilmfoundation.netlify.app/mcp` — confirm (this session could not,
  the Zilberman_FF connector's OAuth token had expired) whether the site itself is served at
  `https://zilbermanfilmfoundation.netlify.app/` or a different public domain, then open it and look.
  This is the one acceptance criterion that has no MCP-tool substitute — it needs a human (or a browser
  automation tool) actually looking at the rendered page.

## 10. Write the acceptance report

`docs/cms-architecture/cms-pipeline/reports/` (per the issue's own item 4 — this directory does not
exist yet in this repo; create it). Include: both run ids, the measured cost (`workflow_get_run_cost`
for each), the measured coverage number and gap ledger
(`stageOutputs.capture_report.gapsByCapability`), the §9 assertions with actual pass/fail per line
(never "should be fine"), and any deviation from this runbook (a step that needed a different order, a
tool that behaved differently than described here) — the next person to run this needs the corrections,
not just the happy path.

## 11. Generalization — a second, non-Zilberman URL (T15.13)

This is a materially separate undertaking, not a quick follow-on to §7: `zilberman`'s registered
`capturePolicy.allowedCrawlOrigins` is locked to `https://www.zilbermanfilmfoundation.com` only (§0), so
a second real source needs either a second already-registered, reachable target project with its own
capture policy, or the `site.duplicate({ newSite: ... })` genesis path (proven in mock mode by
`siteDuplicateGenesis.test.ts` on this branch, never proven live in this session). Pick a real,
crawlable, non-Zilberman URL small enough to keep cost low (a handful of pages, same spirit as
`maxPages: 20` above), provision or register its target project first, then repeat §7–§10 against it.
Do not reuse Zilberman's project id or crawl origin for this — the entire point is a genuinely
different source.
