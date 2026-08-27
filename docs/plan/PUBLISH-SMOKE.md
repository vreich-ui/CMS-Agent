# PUBLISH-SMOKE — a real publish, through the main pipeline, with zero model calls

**What this is.** A mechanical end-to-end proof that an approved run reaches a tenant's live site.
It runs the *exact* tool sequence a real article runs. There is no test tool and no wrapper: a
wrapper would prove the wrapper works.

**Decision (Wolf, 2026-08-27).** `workflow.start_test_publish` was proposed and rejected for that
reason. The only things committed for this test are the fixture and this page — the test *is* the
existing tool sequence.

**Why not `executionMode: "mock"`.** Mock is unpublishable by design and is now refused outright by
`publishRun` (T5). Its node outputs are placeholders no model produced and no client judged. The
working vehicle is a **seeded `article_body` entrypoint + `executionMode: "openai"` + the
deterministic tail flags** — a real publish in which no model is ever called, because every node
before `article_body` is seeded completed and every node after it takes a deterministic route.

**Cost.** Zero model spend when the preconditions below hold. If they do not, the tail silently
calls the model instead — which is the single most expensive way to get this wrong, hence step 1.

---

## Target

Default to **`platform`**. It mints object ids server-side, so the same run can be repeated without
minting a new id each time.

On **`dr-lurie`** the object dialect is `objectIdSource: "request_id"` — the request id *becomes* the
object id, so ids are single-use. Increment `_nn` on every run there.

---

## 1. Precondition — the deterministic tail must actually be on

Without these the tail nodes call the model and the run costs real money.

Check, then set if needed:

| Node | Metadata flag | Required value |
|---|---|---|
| `publication_controller` | `publicationControllerDeterministic` | on |
| `publish_executor` | `publishExecutorDeterministic` | `execute` |
| `learning_recorder` | `learningRecorderDeterministic` | on |

```
npm run store:update -- --set-publish-executor-mode execute
```

`--set-publish-executor-mode` is the one supported way to move that flag: it is a merge-only write
that preserves every sibling metadata key. A blanket re-seed is **not** a substitute — it would
silently disable whichever deterministic route the store currently has switched on.

Read the flags back with `workspace_get_node` before running. Do not assume; a store flag is the
thing most likely to have drifted since the last smoke run.

Also confirm `article_body`'s live `budgetUsd` and `toolCallLimit` while you are there — the seeded
entrypoint means `article_body` never executes, but a wrong value there is what makes the *next*
real run fail.

---

## 2. Start the run

```jsonc
workflow_start_dry_run({
  projectId: "platform",                    // or "dr-lurie"
  workflowId: "publishing_conductor",
  executionMode: "openai",                  // NOT "mock" — mock is refused
  entrypoint: "article_body",
  articleBody: <tests/fixtures/publish-smoke.client-object.json>,
  requestId:        "req_test_smoke_20260827_01",
  publishRequestId: "req_test_smoke_20260827_01",
  budgetUsd: 0.05                            // small: nothing should spend it
})
```

**Both ids are required.** The 2026-08-25 run (`run_1787656120374_18bobg`) carried
`publishRequestId: null` and that is a distinct failure from the object_create one. Both must match
`^req_[a-z0-9_]+_\d{8}_\d{2}$` — lowercase snake_case. An `openai`-mode run for a project whose
dialect declares a request-id pattern is refused outright if the caller supplies none; request ids
are never auto-generated for those projects.

Set the fixture's `clientProjectId` to the project you are targeting.

The entrypoint seeds `article_body` **and every ancestor** completed (including `artifact_plan`), so
the run enters at `publish_payload`.

---

## 3. Approve, run, and check the evidence

```
workflow_set_operator_publish_decision(runId, "approved")
workflow_run_all(runId)
```

Then read the publish evidence off the run:

- `deployStatus: "ready"`
- `productionConfirmed: true`
- the publish steps are `object_create → object_checkout → object_validate → object_patch →
  object_publish → object_checkin`, in that order, and **`release_to_production` appears nowhere**
  (board B2 — `publishRun` never releases).

A failure here now names the client's own refusal sentence and its `issues[]`, not
`create_missing_object_id`. If you see `create_missing_object_id`, the create genuinely succeeded and
genuinely carried no id — that is a new fact, not the old masked refusal.

---

## 4. Teardown — part of the test, not an afterthought

Unpublish and retire the `zz-test-` object through the client's own tools. The fixture's slug is
`zz-test-publish-smoke`, which sorts to the end of any listing precisely so a missed teardown is
visible.

On `dr-lurie`, increment `_nn` before the next run; the previous request id is now spent.

---

## Repeating it

Run it twice against `platform` to prove repeatability (server-minted ids make the second run a
clean create, not a collision), then once against `dr-lurie` with a fresh `_nn`.

## What CI covers, so a live run does not have to

`tests/agent/workspace/publishSmokeFixture.test.ts` holds the fixture to `article_body`'s own
`outputSchema`, to the readiness gate's reader-visible content floor, and to the content_item shape
rules (lowercase-hyphen slug, opaque `n_*` node ids, at least one public content node, no media, no
taxonomy, no judgement substrate). Schema drift therefore breaks the build rather than a live publish.
