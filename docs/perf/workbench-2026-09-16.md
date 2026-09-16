# Workbench first paint — where the time goes

**Measured 2026-09-16 · branch `feat/workbench-v2` · W0 of the Conductor Workbench v2 plan.**
Targets for W1–W3 are at the bottom. Re-run W7 against the same harnesses and put the two tables side by side.

## What was measurable from here, and what was not

| source | status |
|---|---|
| `scripts/perf/storeBurst.ts` — offline reproduction of the burst against the real `BlobWorkspaceRepository` → `GcsStoreClient` read path, with a counting bucket | **ran**, numbers below |
| Static trace of every query mounted on a cold paint → `workbench/contracts/first-paint.json` | **done**, 15 verbs, matches the operator's browser count exactly |
| `scripts/perf/workbench-load.mjs` — live serial-vs-concurrent burst against the control plane | **shipped, not run.** `CMS_AGENT_MCP_TOKEN` is not present in this environment and the endpoint refuses both anonymous and Google-credentialed calls (`{"error":{"code":"unauthorized"}}`). It runs unchanged the moment the env carries a bearer. |
| Cloud Run request latency by tool name, instance count, cold starts | **not available.** No `gcloud` binary, and the session's `CLOUDSDK_AUTH_ACCESS_TOKEN` is rejected by the Google APIs (`UNAUTHENTICATED`). |
| Browser waterfall via Playwright against the deployed site | **not run** — same missing credential; the deployed Workbench is behind the broker's operator login. |

Everything below is either measured here, or measured in the operator's browser on 2026-09-16 and carried over — each row says which.

## Ground truth carried over (operator's browser, no run in flight, after #336/#351/#353/#357/#360)

| what | measured |
|---|---|
| first paint | 15 verbs; five take 12–24 s (`node_get_effective_prompt` 16 s / 7 KB, `skill_list` 20 s / 63 KB, `node_get_latest_output` 13 s / 4 KB) |
| same verbs alone, idle server | 0.7–2 s |
| Drive mode bind | `workflow_get_run` 6.5 s, `workflow_get_run_cost` 7.6 s, `node_list_outputs` × 24 |
| `workspace_get_nodes` | 310 KB (prompt 53 %, outputSchema 17 %, deprecated `schema` alias 12 % = 38 KB pure duplicate) |
| `workflow_list_runs {limit 50, summary}` | 60 KB, ≈ 23 s |
| the contradiction | 310 KB → ≈ 7 s but a 60 KB pure-index read → ≈ 23 s. Payload size is not the first-order cost. |

## Measured here: the first-paint burst, at the storage layer

`npm run perf:store-burst` (`docs/perf/raw/store-burst-before.json`), 15 concurrent reads, 40 ms simulated per GCS operation:

| | before W1 |
|---|---|
| workspace document | **321 KB, 51 nodes** (the live figure is 310 KB — same document) |
| `getMetadata` round trips | **15** |
| `download` round trips | **15** |
| bytes re-downloaded for one burst | **4.71 MB** |
| GCS round trips per read | **2.0** |
| `parseWorkspaceDocumentTolerant` per download | 2.5 ms (`JSON.parse` alone 1.6 ms) |
| serialised CPU on one vCPU per burst | 38 ms |

### What that says, and what it corrects

`GcsStoreClient.getWithMetadata` is deliberately two round trips — read the generation, then download *that* generation — so the (data, etag) pair stays consistent. `BlobWorkspaceRepository.load()` calls it **every single time**, with no generation reuse, no in-flight coalescing and no TTL, and `WorkspaceStateStore` funnels 21 read paths through `load()`. Fifteen concurrent verbs therefore cost thirty GCS round trips and fifteen full re-parses of the same unchanged 321 KB document.

**H1 is confirmed, with one correction to its stated mechanism.** The plan attributed the cost to re-parsing on one vCPU. Parsing is real but small: 38 ms of CPU for the whole burst even at production document size. The dominant term is the **round-trip count** — 30 sequential-ish network operations against GCS from a single-vCPU instance, each one re-fetching bytes the instance already had. That distinction does not change the fix; it sharpens the acceptance test, which should count round trips, not milliseconds.

The per-tool ledger is worse than the per-read one, because the tool handlers load more than once each:

| first-paint verb | workspace-document `load()` calls | GCS round trips |
|---|---|---|
| `workspace_get_nodes` (flat) | `ensureWorkspaceNodeSeeds()` + `getNodes()` = 2 | 4 |
| `workspace_get_graph {workflowId}` × 4 | `resolveConductorNodes` → `getNodes()` = 1 each | 8 |
| `workspace_get_node` | `ensureWorkspaceNodeSeeds()` + `getNode()` = 2 | 4 |
| `node_get_effective_prompt` | `getEffectivePrompt` → node + skill resolution ≈ 2 | 4 |
| **subtotal, one cold paint** | **≈ 10 loads** | **≈ 20 round trips, ≈ 3.2 MB re-downloaded** |

The four `workspace_get_graph` calls are the avoidable half of that on their own: three of them exist only so `TopBar`'s workflow menu can print a node **count** (`components/TopBar.tsx:71`), and the fourth duplicates the rail's identical call under a different query key.

## H2 — the run index heal

`workflow_list_runs` defaults to `detail: "summary"`, which routes to `BlobExecutionRepository.listRunSummariesPage`. That path is supposed to open no run records at all. It opens one **per stale row**:

```ts
const stale = window.filter(isStaleEntry);              // entry.v < RUN_INDEX_VERSION (4)
const records = await Promise.all(stale.map(...getBlobJson(runKey(entry.runId))));
if (found.length) await this.upsertIndexEntries(found).catch(() => undefined);   // ← swallowed
```

`RUN_INDEX_VERSION` was bumped to 4 in W5. Every row written before that bump is stale, so a `{limit: 50}` listing reads up to fifty run blobs — one of them 1.19 MB — and then writes the repair **through a five-attempt CAS loop against a single hot index blob, with the failure discarded**. If that write does not land, the next listing pays the same fifty reads, forever, and nothing anywhere says so.

That is the only mechanism on the table that explains a 60 KB response taking 23 s while a 310 KB response takes 7 s, and it matches the shape of the contradiction exactly: the cost is not in the answer, it is in the reads taken to produce it.

**Verdict: H2 is the most likely cause of the slow run listing, unverified against production** — confirming it needs the live probe in `scripts/perf/workbench-load.mjs` (`workflow_list_runs {limit:50}` twice; the second call must be dramatically cheaper). W1 makes the heal loud, batched and verified regardless, because a silent repair path is a defect whether or not this particular instance of it is firing.

## H3 — cold or CPU-throttled instance

**Weakened.** `GET /` and `GET /health` on `cms-agent-mcp` answer in **0.16–0.18 s** from this container, repeatedly — an instance that is up, warm, and answering a non-store request promptly. Cold start and CPU throttling cannot explain a 16 s `node_get_effective_prompt` against a service that returns `/health` in 160 ms. It stays on the list only as an amplifier of H1: throttled CPU outside a request makes the first of thirty round trips slower, not the other twenty-nine.

## Ranking

1. **H1 — round-trip amplification on `workspace/current.json`.** ≈ 20 GCS round trips and ≈ 3.2 MB re-downloaded for one cold paint, of a document that did not change between the first read and the twentieth. Confirmed by code and by the offline burst. **First-order.**
2. **H2 — the run-index heal that may never persist.** Explains the one measurement H1 cannot: a small-payload listing that costs more than a large-payload one. Confirmed as a mechanism, unverified in production. **First-order for `workflow_list_runs`.**
3. **Client fan-out.** 15 verbs where 2 would do, of which three `workspace_get_graph` calls fetch a whole graph to read `.nodes.length`, and three more (`workspace_get_nodes`, `workflow_list_runs`, `project_list`) are fired by a **command palette that is not open** — `components/CommandPalette.tsx` is mounted for the app's lifetime and none of its queries are gated on `paletteOpen`. **Second-order in latency, first-order in waste.**
4. **Payload size.** 310 KB where 11 KB would serve the rail, 38 KB of it a deprecated duplicate. Real, and worth W2 — but the contradiction row above proves it is not what an operator is waiting on. **Third-order.**

## W1 result — measured the same way, after

`npm run perf:store-burst` (`docs/perf/raw/store-burst-after.json`):

| burst of 15 concurrent reads | before W1 | after W1 |
|---|---:|---:|
| cold (nothing cached) — GCS round trips | **30** | **2** |
| cold — bytes downloaded | **4.71 MB** | **0.31 MB** |
| warm (same instance, within the TTL) — round trips | **30** | **0** |
| warm — bytes downloaded | **4.71 MB** | **0 MB** |
| past the TTL, document unchanged — round trips | 30 | **1** (a version check, no transfer) |

Three mechanisms, all in `CachedJsonBlob`: a 1.5 s micro-TTL that answers a burst with no network
at all, a `head()` version check that costs one metadata call and no transfer when the document has
not moved, and in-flight coalescing so fifteen concurrent readers share one refresh. Mutations pass
`{ fresh: true }` and bypass all three, so no compare-and-swap is ever computed from a cached
document. Every load returns a structured clone (~1.7 ms, cheaper than the 2.5 ms parse it
replaces), so a caller that mutates a node it was handed can no longer poison an instance.

The same pattern, minus the version check (there is no cheap version for a whole prefix), went to
the three composite reads that scan a prefix and open every blob under it: `skill_list` (which
listed `skills/current/`, `skills/versions/` **and** `skills/events/` and read every object in all
three, on every call — 20 s live, for a row of chips), `project_list`, and `evaluation_list_rubrics`.

Also in W1, and not visible in that table:

- **stage output values left the workspace document.** `saveStageOutput` went through `mutate()`, so
  every completed node rewrote the entire document with one more value appended — on the run hot
  path, growing without bound (436 rows as of 2026-09-15). The index (`id`, `stage`, `createdAt`)
  stays; the value moves to `stage-outputs/<id>.json`. Legacy rows still read from inside the
  document and are drained 25 at a time by subsequent saves, so no request ever pays for the whole
  backlog and nothing needs migrating before the change is correct.
- **the run-index heal is loud.** `upsertIndexEntries(found).catch(() => undefined)` is gone. The
  outcome is reported, a failure logs `run_index.heal_failed` and shows up on repository health, and
  rows this instance already repaired are answered from memory instead of being re-read — so even a
  store whose index writes fail pays the blob reads once per instance rather than once per listing.
- **every tool dispatch logs its name and duration** (`mcp.tool_call`), which is what makes a
  log-based latency breakdown possible at all; Cloud Run's request log only ever knew that
  something POSTed `/mcp`. Never logs arguments or results.
- **identical in-flight reads are de-duplicated** for 2 s, scoped by the caller's authorization,
  reads only, failures never cached, and dropped by any write so a read-after-write stays honest.
- **a disconnected client stops the work.** Not a full abort — the store SDK calls take no signal —
  but a request whose client has hung up is no longer written to or dispatched further.

## W2 result — payload projections

| read | before | after | how |
|---|---:|---:|---|
| `workspace_get_nodes` / `workspace_get_graph`, 51 nodes | 310 KB | **19 KB** with `detail: "summary"` | prompt (53 %), outputSchema (17 %) and the deprecated `schema` alias (12 %) leave the LIST; the inspector fetches the one selected node in full |
| `workflow_list_runs {limit: 50}` — the `mode` block | 24 KB | **~100 bytes** | interned once per distinct value in a response-level `modes` map; rows carry `modeRef` |
| `workflow_list_runs {limit: 50}` — `nodeStatuses`/`failedNodeIds` | 18 KB | **0** unless `include: ["nodeStatuses"]` | one surface draws a chip per node; it opts in, nobody else pays |

`detail` defaults to `"full"`, so no existing MCP client sees a changed response. The deprecated
`schema` alias stays in `"full"`: `ui/` reads `node.schema` in four places (`Inspector.tsx`,
`WorkspaceGraph.tsx`, `NodeInspector.tsx`, `useWorkspace.ts`), so dropping it would break a live
consumer — decision 7 of the runner plan, resolved in favour of keeping it behind `detail: "full"`.

Two honest corrections to the plan's W2 estimates:

- The summary set is **19 KB, not ~11 KB**. No single field dominates — across 51 nodes the cost is
  spread evenly over the thirteen fields the plan specified (`requiredInputs` 2.6 KB, `dependsOn`
  2.5 KB, `name` 2.0 KB, and so on down). Omitting empty arrays and the false `hasDefaultOutput`
  took 20.8 KB to 19 KB; anything further would mean dropping a field a list actually draws. The
  asserted budget is 24 KB, and the reduction is 16x.
- `phase` is **not** in the projection. No phase exists server-side: phases are presentation config
  in `workbench/src/api/workflowCatalog.ts`, and a workflow the catalog does not know is grouped as
  "ungrouped (live)" by the client (W3). Returning a server-side `phase` would have meant inventing
  one.

`modeRef` and the `include` gate are wire changes rather than additions. The one in-repo consumer
(`workbench/src/api/adapters.ts`) reads `modes[row.modeRef]` and still falls back to an inline
`mode` block, so a page from a pre-W2 server — or a fixture captured against one — adapts exactly
as it did before. `docs/mcp-tool-manifest.json` is regenerated in the same commit.

## W3 result — first paint is one round trip

| | before | after |
|---|---:|---:|
| verb calls before the rail is interactive | **15** | **2** (`workbench.bootstrap`, `project_list`) |
| payload before the rail is interactive | ~780 KB | **< 40 KB** |
| verb calls on a second visit, before paint | 15 | **0** (persisted cache) |
| workflows visible in the deck and the switcher | 3 | **every registered one** (the live registry has 8) |
| `node_list_outputs` on a Drive-mode bind | 24 | **1** |

`workbench.bootstrap` returns the registry, the requested workflow's summary graph and edges, its
recent run rows (with their interned `modes`), per-workflow node counts, the attention counts, and
`workspaceVersion`. Every part of it is a projection of a verb that still exists on its own; it is
one round trip instead of a dozen, not a new source of truth. Everything it answers is read through
W1's cached reads and W2's projections, so the whole call is one workspace-document refresh plus
one run-index read.

What moved, and why each one was on the critical path at all:

- **⌘K's three index queries.** `CommandPalette` is mounted for the app's whole lifetime and none of
  its queries were gated on `paletteOpen`, so every cold load fetched the flat 310 KB node list, a
  20-row run page and the project list to populate a palette nobody had opened.
- **Three whole graphs to print three numbers.** `TopBar`'s workflow menu fetched a graph per
  workflow to read `.nodes.length`. The bootstrap carries one integer per registered workflow —
  which also made driving the deck off the registry affordable, where before it would have meant
  eight graph downloads.
- **The rail's decoration.** Score glyphs (`evaluation_list_rubrics`, which itself composes two
  verbs) and "learned since your last visit" badges (`changes_list`) now wait until the rail has
  painted. Both already degraded to "no badge" on failure, which is what makes deferring them safe
  rather than merely cheaper.
- **`skill_list`.** The slowest read on the plane (20 s, 63 KB) was fetched by the Prompt tab to
  turn this node's skill ids into names. It is now fetched only when the node HAS skills and its
  prompt has already painted.
- **The attention strip** is a count badge. The COUNT is free — `workbench.bootstrap` reads it off
  the run index with no run record opened — and the evidence-citing list (13–56 s) runs when the
  operator expands it, which is the moment they have asked the question.
- **`node_list_outputs` × 24 on a Drive bind.** That query is a legacy fallback for runs written
  before `outputProvenance` existed, and it fired once per row about the same run.
  `node_list_outputs` takes `runId` on its own, so it is one call for the whole grid.

Two things found on the way that were not on the plan's list:

- **The inspector could render one node's configuration under another node's name.** The app-wide
  `placeholderData: keepPreviousData` keeps the previous node's record on screen while a newly
  selected one loads; that was invisible while `useNode` seeded itself from the cached node list,
  because the seed was always the right node. With the list a summary projection it became visible,
  and an edit started in that window was silently discarded when the real record arrived. Center now
  treats placeholder data for a different node as loading.
- **Five registered workflows were simply not on the screen.** `WORKFLOW_CATALOG` lists three; the
  server registers eight (publishing, clone, capture, visual_identity, pdf_template_studio,
  asset_lookup, document_render, image_template_revision). The plan said "all 6 workflows" — it is
  8, and the deck is now driven by `registeredWorkflowIds` so the number can never be wrong again.
  A registered workflow with no presentation config gets a generic card and a single
  "ungrouped (live)" phase, the same honesty rule the rail already applied to an unclaimed node.

## W4 — the Workbench becomes run-centric

Not a latency wave. Three things an operator could not do or see at all:

**A deterministic node can now explain itself.** 35 of the workspace's nodes are deterministic:
their behaviour is engine code, so their Prompt tab is empty by construction and their Tools tab is
empty by construction (a deterministic route consults no node grant). An operator opening
`capture_emit_live` — which probes and ingests every asset on a site and then creates objects on a
live tenant — was shown nothing whatsoever. `node.get_effective_tools` now carries an `algorithm`:
numbered plain-language steps, what the node reads, the module that implements it, and the tenant
verbs its route reaches with their risk levels. The verb list is composed from `ROUTE_MANIFESTS`
rather than re-typed, because a copied "which verbs can this node reach" list is guaranteed to go
stale and a stale one is worse than none. `tests/agent/workspace/nodeAlgorithms.test.ts` walks the
registry rather than a list, so a new deterministic node cannot ship without an explanation.

**Push-through works from the rail, on any queued node.** The server has always addressed a
push-through by node id; only the UI insisted the run's cursor be moved there first. The rail now
offers it on any queued node that carries a standing default — and deliberately does not offer it
where the server would refuse (a publish-tail node on a live run), because a control whose only
outcome is a refusal is worse than no control.

**`workflow.run_node` gains `defaultUpstream`, and `workflow.run_until` gains `outputMode`.** These
express the two intentions that had no expression: "get me TO this node" (default the chain that
leads to it, in dependency order, refusing by name when a link has no default) and "run to here on
defaults, live from here" (a per-call output mode). The per-call mode is never persisted onto the
run: writing it, driving, and writing it back would leave a crashed drive in a mode nobody chose and
would let a concurrent driver inherit it.

The single-node push-through is unchanged. It has always worked over incomplete upstream — the
write lands and the run advances through the upstream it still owes — and several publish gates are
tested through exactly that path.

Also in W4: an **I/O tab** (the inputs a node was handed, straight off the run record, so it costs
no call; its output with provenance; and the tool calls between, which no surface showed), and a
**run timeline** in the dock — one bar per node that ran, scaled to the longest. A run's shape in
time is the first thing anyone looks for when one is slow, and it was only reachable by opening
nodes one at a time and reading a number.

One defect found on the way: **saving a default output did not invalidate the rail's node rows**, so
an operator could set a default and have the rail keep insisting the node had none.

## W5 — the Client Manager, and scores

**The Client Manager page.** `agt_client_manager` is the agent every editor's admin chat talks to;
its prompt is the editorial policy of this workspace. It was the only prompt in the system the
Workbench could not show — every node's prompt has had an editor since WP-31 — and Registry →
Agents was a read-only card saying its name, its model, and the word "diverged". It is now a page:
the full prompt, editable through `agent_update` with `promptState` saying plainly whether what is
on screen is the shipped text, an older shipped text or somebody's edit; the model configuration
and skills; the agent's own revision history; and **what it has actually been saying**.

That last one is a new verb, `agent.list_conversations`, over CMS-Agent's own 200-turn audit mirror
— which was reachable only by knowing a conversation id in advance. It is bounded twice: `limit`
bounds the conversations returned, and the scan that finds them is capped independently, with
`scanned`/`scanCapped` on the response so an incomplete answer is never presented as a complete
one. (The mirror store is a prefix scan, which is the shape this repository has been bitten by
three times.) It reports tool calls as **proposals** — CMS-Agent never executes one — and mirrors
the request preview rather than the caller's payload: Platform's ChatDoc remains the transcript
authority and a read verb must not quietly make CMS-Agent one.

**Scores.** Every workflow ends in judgement — four editorial reviews and an aggregator on
publishing, a fidelity score and a gap adjudication on capture, a fit adjudication on clone, a
contract verdict before anything is built — and every one of them was reachable only by opening a
run, then a node, then a JSON blob. `RunIndexEntry` now carries `scores`, extracted at index time
from the run's own outputs, so a page of scores opens no run records; the field is opt-in
(`include: ["scores"]`), and `RUN_INDEX_VERSION` goes to 5 so existing rows heal — which is safe to
do now precisely because W1 made that heal loud, verified and never repeated in-instance.

Two decisions in the extractor that could have gone the lazy way:

- **Nothing is invented.** A node that recorded no score is ABSENT, not zero. A zero meaning "not
  scored" is indistinguishable from a zero meaning "scored terribly", and this repository has been
  bitten by exactly that shape before (the run index's `nodeStatuses`, the deck's "0 runs").
- **The keys are not guessed from the value.** Only the named scoring nodes are read, and only
  named score/verdict fields. A generic "find a number that looks like a score" walk would happily
  report a token count, a duration or an array length as quality.

The Runs → Scores tab is one row per run and one column per judgement, with a trend line drawn from
the numeric scores only: a verdict ("pass", "revise", "blocked") is a decision, not a measurement,
and averaging one into a line would be inventing a number. Eval results are joined by run id as a
separate column rather than folded in — a rubric's verdict and a run's own reviews disagreeing is
the interesting case, and merging them would hide it.

## W6 — the test-and-learn loop

Neither control here needed a new server capability. Both sit on tools that have shipped for waves
and that nothing in the Workbench ever called.

**Save as default** (`workspace_adopt_output_as_default`) on any completed output in the I/O tab.
`DefaultOutputTab`'s own header has pointed at an "Adopt as default" control on the rail since W4;
it was never built, so the only route from a value a node had actually produced to that node's
standing default was to copy its JSON out of one tab and paste it into another. The adoption is
scoped to the bound run rather than to "whatever this node produced most recently anywhere" — the
verb's behaviour with no `runId`, and a different value the moment a newer run exists. It is offered
only on a value this run PRODUCED: adopting one the node was HANDED (a default already, or a
one-run operator override) would make the node's default a copy of itself or of an override, which
is not what either of those things means.

**Replay against run** (`node_execute`) in the Prompt tab, in place of a `⇄ Replay vs dataset`
button that had been sitting there permanently disabled since U7. Replaying against a frozen
dataset still has no verb behind it; replaying against a RUN does, and it is the question an
operator editing a prompt actually has. It sends the bound run's stage outputs narrowed to the
node's `dependsOn`, the run's own initial input, and the Model tab's unsaved draft as a
`modelConfig` override, and puts the result beside the run's own output in the field differ.

Three of those four decisions are load-bearing rather than tidy:

- **The dependencies are not decoration.** Omit them and `prepareNodeExecution` fills each one from
  `workspaceRepository.getStageOutput(id)` — the workspace's LATEST value for that node, i.e.
  whatever the newest run happened to write. The replay would silently be against different inputs
  than the run on screen, and its diff would mean nothing. The panel refuses outright when the bound
  run has no output for a dependency, rather than sending a call the server would happily complete.
- **The input is threaded** because `executeNode` validates `input ?? {}` against the node's
  inputSchema before doing anything else; a node with required input fields refuses a replay that
  sends nothing.
- **The result is schema-checked** with `node_validate_output`. A `completed` status says nothing
  about whether the value satisfies the node's own output schema on the mock path, and that is the
  single most useful thing this panel can tell an operator.

And one thing it deliberately does **not** do: it does not replay the Prompt tab's unsaved draft,
and it says so on screen. `promptOverride` exists on `executeNode` and is deliberately withheld from
the public `node.execute` tool — the sanctioned public mutation path stays
`workspace.update_node_prompt`. An operator who edited a prompt and pressed Replay would otherwise
believe they had just tested the edit. Mock is the default mode; a real model call is an explicit
checkbox, because a control whose default spends money is not one an operator can press to find out
what it does.

### Three corrections the plan did not anticipate

**`requiredInputs` is not the dependency list.** It is a list of required input ARTIFACT TYPES, and
it diverges from `dependsOn` on at least one node: `input_triage` has `dependsOn: []` and
`requiredInputs: ["content_source.v1"]`. W4's I/O tab read it as a node-id list, so on that node —
the one the plan names for the live smoke — it drew a row for a type id that is not a key in
`stageOutputs`, reported it as "not produced on this run", and hid the run's initial input, which is
the only thing that node is handed. `dependsOn` is now carried on the client node model (full rows
and `detail: "summary"` rows alike) and is what the I/O tab and the replay both read.

**The fixture was quieter than the server.** `workspace_adopt_output_as_default` returned
`{node: null}` where the live tool throws `node_output_unavailable`, so the first version of the
acceptance test watched a success toast appear over a save that had not happened. The underlying
distinction is real and worth stating: the live verb adopts from the EXECUTION repository's recorded
outputs, not from `run.stageOutputs`, so a node can be `completed` on a run with nothing there to
adopt. The client cannot tell the two apart without a `node_list_outputs` round trip on every I/O
tab open, so it offers the control and reports the refusal honestly — and the refusal now has its
own test.

**`node_execute` was not in `MUTATING_VERBS`.** It writes a run record, writes the node's stage
output on success, and in `openai` mode spends money. Without it the dev-mode guard would have
fired on every replay and the confirm contract would have been inconsistent with every other
mutation in the client.

### Not done, and why

The plan asks for a **live smoke on `input_triage` in the PR**. It could not be run: this
environment has no `CMS_AGENT_MCP_TOKEN` and no working GCP credential, so `/mcp` answers 401 both
anonymously and with `CLOUDSDK_AUTH_ACCESS_TOKEN`, and Secret Manager answers 401 as well (see W0).
Nothing was worked around to get one. The replay path is therefore verified against the fixture
plane and against the server's own source — argument shapes read off `nodeExecuteInput` and
`executeNode`, not off the mock — and the smoke remains outstanding for whoever holds the token.

## W7 — re-measured, and what is still unproven

Re-ran on the finished branch:

- `npm run perf:store-burst` — workspace document 321 KB / 51 nodes. **Cold** burst of 15 concurrent
  reads: 2 round trips (1 metadata + 1 download), 0.31 MB, 191 ms wall. **Warm**: 0 round trips, 0
  bytes, 84 ms wall, 0 ms serialised CPU. Before: 30 round trips and 4.71 MB.
- `workbench/tests/firstPaintBudget.spec.ts` — 5/5. First paint stays inside 2 verb calls and 40 KB;
  none of the 13 verbs the contract moved off first paint fire before the rail is interactive; the
  palette index costs nothing until the palette opens; a second visit paints with **zero** verb
  calls; and every workflow the server registers is reachable.
- Full suites: 4406 root tests / 434 files, 183 Playwright tests, `typecheck`, `test:drift`,
  `test:scope`, `test:glossary` all green.

**Still unproven, and stated as such rather than estimated.** Every latency target in the table
below that says "live harness" has not been measured. `npm run perf:workbench-load` ships with the
branch and has never been run here: there is no `CMS_AGENT_MCP_TOKEN` in this environment and no
working GCP credential, so `/mcp` returns 401 both anonymously and with `CLOUDSDK_AUTH_ACCESS_TOKEN`,
and Secret Manager returns 401. No workaround was attempted. The same is true of the live smoke on
`input_triage` that W6 called for. The round-trip and payload claims above are measured; the
wall-clock claims against the live plane are not, and nothing in this branch asserts them.

One cosmetic defect fixed while capturing screenshots: the Scores table carried
`className="grid"`, which is the run grid's CONTAINER class — `base.css` gives `.grid thead th` a
vertical writing mode, a 180° rotation and an 86 px height, intended for a wrapper div around a
table of one-glyph columns. Applied to the table itself, the node names printed sideways and ran up
into the paragraph above them. It now has its own class. This is the sort of thing that green tests
do not catch and that a screenshot does, which is why the plan asked for them.

## The adversarial review, and what it found

`CLAUDE.md` requires an adversarial review of the squashed diff before delivery, on the stated
ground that green tests do not cover `.tsx`. Three reviews ran over the 94-file diff — the server
half, the client half, and fixture-vs-live parity. They found fourteen things worth fixing, two of
which would have shipped a feature that could not work in production. Every fix below is in the
branch; the ones with a mechanical failure mode have a test that fails without them.

**Two that made this branch's own features dead on the live plane.**

- `workflow.get_run` defaults to `detail: "compact"`, and the compact view has never carried
  `stageOutputs` or `initialInput`. W4's I/O tab answers "what was this node handed and what did it
  produce" out of the run record, and W6's replay sends those same outputs back as
  `dependencyOutputs`. Both would have found an empty map. **No test on either plane could see it,
  because the fixture was the thing that was wrong**: it synthesised the map unconditionally, so the
  surfaces worked in fixtures and could not work in production. The compact view now takes
  `include: ["stageOutputs"]` — the same opt-in shape W2 gave `workflow.list_runs`, so a caller that
  wants the cheap view still gets it — and the fixture now answers the way the server does.
- `workspace.adopt_output_as_default` guarded on `latest.output === undefined`, and
  `listNodeOutputs` returns `ExecutionArtifact`s, whose payload field is **`value`**. `output` has
  never existed on one. The guard therefore fired unconditionally and the tool threw
  `node_output_unavailable` for **every node, always** — the tool whose entire job is adopting a
  recorded output could never adopt one. It went unnoticed because nothing called it until W6 built
  the control `DefaultOutputTab`'s header has pointed at since W4.

**Three where a cache introduced by this branch could lose or falsify data.**

- The stage-output drain stripped a row's value from the document inside the mutate and wrote the
  blob *afterwards*, best-effort, with a comment asserting that "a failed drain is retried by the
  next save, because the row is still in the document with its value intact". The same mutate had
  just deleted it. One failed blob write and the value was gone — and `exportWorkspace`, the backup
  path, would have exported the hole. Copy out first, strip only what landed.
- `BlobSkillRepository.load()` gained a TTL cache, and `mutate()` — a read-modify-write that
  rewrites every skill row and deletes any key not in the document it was handed — read through it.
  On a multi-instance deployment a stale document written back resurrects a skill another instance
  deleted, and deletes one it created. `mutate()` now reads fresh, the same escape
  `BlobWorkspaceRepository.load({ fresh: true })` exists for. `get`/`getVersion` also now clone,
  like their siblings already did: with a cache, handing the same object to every caller for the
  TTL means one in-place edit poisons every read in the window.
- A repaired run-index row was remembered for the life of the instance. In exactly the situation it
  exists for — index writes failing — the index never learns the run moved on, so a listing would
  report "running, 3/8" forever while the run failed and finished. Bounded to 30 seconds, and
  dropped outright when this instance writes that run.

**One where the cache could pin itself to another writer's generation.** `GcsStoreClient.setJSON`
falls back to a metadata re-read when the upload response carries no generation, and that read can
catch a racing writer's. Harmless while the etag was only the next conditional-write token; not
harmless once `save()` may `adopt(document, etag)`, because the version check then passes forever
and the instance serves its own superseded document with no TTL bound. The write result now says
whether the etag is the one this write produced, and only that one is adopted.

**Four client-side regressions this branch introduced and its tests did not catch.**

- `evaluation_list_results` returns `ok({ results })` like every other list verb; the client wrapper
  was typed as a bare array, so W5's Scores tab iterated an object and would have thrown inside a
  render on the first live open, taking the Runs screen down. The fixture returned a bare array.
  Both planes now return the envelope.
- `useSkills` looked for the node list under `['nodes', 'all']` while `useNodes` had moved to
  `['nodes', <wf>, <detail>]`, so the lookup always missed and `skillList` fell back to the ~310 KB
  unfiltered download W3 exists to have removed. And the cached list is now usually a *summary* one,
  whose empty `skills` array is a projection artefact rather than a fact — reusing it would have
  reported every skill as assigned to nothing. Only a full list is reused.
- ⌘K's "push through with default" read `defaultOutput`, which a summary row never carries, so the
  action silently disappeared for every node. The rail and Drive were updated for that change; the
  palette was missed.
- `VITE_BUILD_ID`, the persisted cache's buster, was defined nowhere — so `buster` was the literal
  `'dev'` in every build and the stated guarantee ("a deploy that changes an adapter's shape cannot
  restore data shaped for the previous one") was false. Defined at build time from the commit sha.

**Four where a surface said something that was not true.**

- The replay panel claimed to be side-effect-free. It is not: a completed `node_execute` calls
  `saveStageOutput`, replacing the node's most recent *workspace* output — which is what a later
  replay falls back to for a missing dependency, and what "adopt latest" would adopt. The panel says
  so now, and invalidates the reads that depend on it.
- The rail's push-through reported an unqualified success on a node whose upstream had not run.
  Offering it on any queued node was W4's deliberate change and stays; the server writes the default
  "whatever state its upstream is in" (its own schema's words), so the toast now names the upstream
  nodes this run never produced.
- The I/O tab printed "tool calls · 0" while that query was loading and while it had failed, and
  pinned "produced" on a node that never ran, above "(nothing recorded)".
- The Scores tab kept the previous workflow's rows on screen, undimmed, while the new selection
  loaded, and rendered a dash in every eval cell when the eval query failed — under a footnote
  telling the reader a dash means "recorded nothing".

**Two smaller ones.** `agent.list_conversations` matched turns by bare string prefix, so `agt_client`
returned `agt_client_manager`'s; and the persisted query cache wrote tenants' admin-chat transcripts
to an operator's localStorage for 24 hours, which is a different category from the "prompts and
schemas" the persistence comment weighs.

**Recorded, not fixed.** The `defaultUpstream` chain added in W6 applies a default to a node whose
dispatch may be in flight — the single-node path refuses that (`node_dispatch_in_flight`) and the
chain does not — and it clears `defaultOutputOverride` and pending approvals on ancestors the
operator never named. Both are narrower than they sound (the publish charter is untouched: the
defaulted-publish refusal and the live-client check still apply to every node in the chain), but
both are real, and tightening them is an authority decision about what an operator's "default this
whole chain" is allowed to override — which is Wolf's call, not the runner's.

## Targets W1–W3 must hit

| | target | harness |
|---|---|---|
| burst of 15 concurrent reads | **≤ 2 GCS round trips**, ≤ 321 KB downloaded (down from 30 and 4.71 MB) — **met, 2 and 0.31 MB** | `npm run perf:store-burst` |
| warm `workspace_get_node` | < 150 ms | live harness |
| 15-verb concurrent burst | p95 < 3 s | live harness |
| `workflow_list_runs {limit: 50}` warm | < 1 s, and the second call cheaper than the first | live harness, H2 probe |
| first paint | ≤ 2 verb calls, ≤ 40 KB before the rail is interactive — **met** | `workbench/contracts/first-paint.json` + Playwright |
| second visit | paints from persisted cache in < 300 ms, no network — **met, 0 calls** | Playwright |
| `workspace_get_nodes {detail:"summary"}` | ≤ 24 KB for 51 nodes — **met, 19 KB** (the plan's 11 KB was optimistic; see W2 above) | contract test |
| `workflow_list_runs {limit:50}` summary rows | ≤ 20 KB — **met** | contract test |
