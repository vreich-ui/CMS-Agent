# CMS-Agent — session handoff

**This file lives in the repo on purpose.** Earlier handoffs lived in Claude Project knowledge, which
neither a Cowork session nor Claude Code can read — one cost a session-start to a screenshot. Anything
the next session must know goes here.

**Rule: a gate check is a command with an expected result. Prose is not a gate check.** If you cannot
write the call and what it should return, it is context, not a gate — put it under "State".

_Last updated 2026-07-30 after PR #99 (W-4 + W-5)._

---

## Gates — run these before spending anything

All are free. Run in order. Any FAIL stops the session.

### G1 — Is the merged code actually serving?

```
MCP_URL=… MCP_API_TOKEN=… npm run verify:deploy
```

PASS: served tool surface hashes equal to `docs/mcp-tool-manifest.json`, endpoint/token configured for
every project. As of PR #96 the manifest is **135 tools**; a live count of 137 means the pre-#96
revision is still serving.

FAIL: a stale revision is serving. **Merging is not deploying** — there is no CI/CD for the MCP image.
Deploy with `scripts/deploy-mcp.sh` and re-run. Never `--set-env-vars`: it replaces the whole
environment and has silently deleted the six client-connection variables twice while health stayed
green.

### G2 — Does every publish-capable project have its object dialect?

```
repository_get_health()
```

PASS: `data.health.project` exists and carries **no** `details.objectDialectFindings`.

FAIL (key present): a project whose hooks export `executePublish` is missing required `objectDialect`
fields; it is named in the finding. Fix in `src/agent/projects/<id>/definition.ts` and deploy —
**`project.update` has no `objectDialect` field, so no live MCP path can ever set it.**

> Do **not** check this by reading `project_get(<id>).knowledge` for a `site` block. `project.get`
> returns connection metadata plus the project's static hook-knowledge module; `objectDialect` is in
> neither. `dr-lurie`'s `knowledge.site` is a hand-written doc block missing `objectIdSource` and
> `defaultObjectType`, which is proof the two are different things. A 2026-07-30 handoff made exactly
> this mistake and would have produced a false STOP on a healthy workspace.

### G3 — Graph valid

```
workspace_validate_graph()
```

PASS: `{ valid: true, issues: [] }`.

### G4 — Attention clean

```
constellation_get_attention()
```

PASS: zero `blocker`-severity items. `action` items that are publish-gate approvals are the locks
working as designed and are expected.

### G5 — Publish locks closed

```
project_list()
```

PASS: every project has `publishingPolicy.publishEnabled: false`. Nothing proceeds with a lock open
unless opening it is the explicit, human-approved task.

### G6 — Do the live workspace and the seeded code agree?

```
npm run nodes:check
```

PASS: clean, no rewrite proposed.

FAIL: live and `nodes.ts` have drifted. Re-seed with `npm run nodes:update` (needs live access) and
commit. **Never hand-copy live prompts over the seed** — that overwrites drift you cannot see, which
is the R-1 failure mode in a different hat.

### Before merging any code

```
npm test && npm run test:ui && npm run test:drift && npm run test:glossary && npm run test:objects
```

---

## Standing habits, earned the hard way

1. **After any workspace-data fix, check whether the code-defined defaults carry the same defect.**
   Taught three times: snoocle, the 14 ungrantable `stage.save_output` grants, and the whole node set.
   A data write looks complete and the next fresh workspace undoes it.
2. **A blocker recorded once and then cited by later documents acquires the appearance of having been
   verified.** Taught three times: R-3 and the S4 Schemas tab, F-1's "stale fixture" diagnosis, and
   the G2 gate above. Re-derive a claimed dependency from the code before building on it.
3. **Merging is not deploying.** Confirm the serving revision before concluding a fix shipped.
4. **Every dollar figure in these docs is an estimate, not a bill.** Every entry in
   `modelPricingCatalog` is `placeholder: true, "not billing-grade."`

---

## State — 2026-07-31

Workspace **v259**, backend `gcs`, graph valid, skill store **v21**. Registry: `dr-lurie`,
`monetizer` (disabled), `pdf-tool` (Ring 0 service), `platform` (client 0). All publish locks closed.

**Node-system overhaul (2026-07-31): PR #100 (behavioural) + the mechanical follow-up PR.** All 21
nodes carry all five limits live (maxTurns / toolCallLimit / timeout / budgetUsd / maxOutputTokens —
sizing and the three cost diagnoses in `docs/plan/findings/node-limits-audit.md`). The budget guard
now gates each model request *before* it is sent, holding node and run ceilings separately; runs
carry a dispatch-claim heartbeat so a dead driver is detected and reclaimed instead of hanging
silently; tool results are bounded (32k chars) and `toolCallLimit` is enforced with per-call audit
records persisted on node state. The shared prompt/skill layer is client-neutral — Dr. Lurie's voice
and domain caution live in `src/agent/projects/drLurie/`, awaiting `vox_drlurie_default` (P-2). The
R-23 rename is done in the code plane (`client_object.v1`, `canonicalArticleBody` deleted).

**The engine works end to end in live mode against client 0.** `run_1785405350649_9u5mjz` produced a
schema-valid 12-block `content_item` — strict root fields, opaque `n_*` ids, no undeclared keys,
taxonomy correctly omitted because `tax_platform` has zero active terms. T6.3 passes on the live path;
the publish gate held.

**`article_body.v1`, settled.** It was born in the platform repo on 2026-06-21 as the structured
replacement for markdown articles, when an article *was* one document. On 2026-07-19 the decision was
that `article_body.v1` nodes pass **verbatim** into `content_item`, whose node schema is a superset —
so `content_item` **wraps** it and never replaced it. On the platform side it is not an object; it is
the node grammar `content_item` imports (`private`, `commercial`, `rendering`, `chat`). **Leave the
platform side alone.** CMS-Agent hand-copied that schema into `store.ts` on 2026-07-01, and that copy
is what grew into five competing shapes. PR #96 deleted the copy and every consumer. What remains of
R-23 is the **rename**: the surviving envelope is not an "article body", it is one client object plus
its provenance, and `client_object.v1` describes it.

### Blocking T-3

1. **W-4 fixed in PR #99 (2026-07-30), unverified live.** The conductor now delivers
   `clientProjectId` (from `run.projectId`) in EVERY node's input (`executor.ts`); an unresolvable
   client fails the node with the named `client_project_unresolved` (same contract as
   `prefetch_object_type_unresolved`); the five branded editorial prompts and the
   `dr_lurie_dtc_science_editorial` skill (now "Editorial craft") are client-neutral craft in both
   planes (live v229→v238, skill store v13→v14, then `nodes:update` re-seed); and
   `contract_intelligence.metadata.projectId` is gone (verified unread — the prefetch uses
   `run.projectId`). No client was substituted; the Dr. Lurie voice text sits in skill version
   history awaiting `vox_drlurie_default` (P-2). **The executor half needs a deploy to take effect.**
2. **W-5 fixed in PR #99 (2026-07-30), unverified live.** `article_body` now depends on
   `narrative_movement` + `angle_strategy` (requiredInputs in lockstep), so the per-block reasoning
   arrives in its input instead of being discarded, and its prompt mandates populating
   contract-declared private annotation fields on every emitted node, enum values strictly from the
   contract's own enums (confirmed first-hand: `private.strategy` 12 values, `private.intent` 5,
   `additionalProperties: false`). **The dependency change is topology — it reaches conductor runs
   only through #99's `nodes.ts` re-seed plus a deploy.** Verification is a fresh platform run
   checking every block carries `private.strategy`/`private.intent` and no foreign-client CTA.

### Unmeasured

**#95's contract-prefetch effect on `contract_intelligence`** (was $3.79 pre-fix, target ~$0.10).
Measure with a fresh run plus `run_until(contract_intelligence)` — roughly $0.95 of known upstream
editorial cost plus the node itself. **A single-node `node.execute` will not measure it**: the
prefetch is applied in the workflow executor (`executeRunnableNode` gates on
`metadata.contractPrefetch`), so a single-node run bypasses it and returns a meaningless number.

### Owed

- **Deploy — now urgent, not just owed.** #96/#99 remain unserved, and the overhaul raises the
  stakes twice over. First, the live limit-writes **armed a latent bug in the DEPLOYED budget
  guard**: the old code compares `min(nodeBudgetUsd, runBudgetUsd)` against run-wide accrued spend,
  so now that every node carries a small `budgetUsd`, any live run under the old deploy starts
  failing pre-checks the moment cumulative run spend passes a node's own ceiling (~$0.10–0.75).
  PR #100 fixes the conflation; until it serves, expensive multi-node runs on the live plane will
  false-trip. Second, none of the new semantics (pre-send gating, heartbeat, bounded tool results,
  enforced toolCallLimit) exist on the serving revision.
- **Post-deploy live write** — `article_body`'s live `produces`/`outputSchema` still say
  `article_body.v1`: the *deployed* graph validator hardcodes that string and refused the rename
  (chicken-and-egg). The mechanical PR updates the validator; once it serves, write
  `client_object.v1` to the live node (produces + outputSchema `artifact` const) so the store
  overlay agrees with the seeds. Until that write, the store's `outputSchema` overlay keeps the old
  artifact name authoritative at run time.
- ~~**`npm run nodes:update`.**~~ Re-done 2026-07-31: re-seeded from live v259 (limits + purge +
  rename patch) via the generator.
- ~~**R-23 rename half.**~~ Done in the code plane (mechanical PR); live-plane write owed above.
- ~~**Real pricing in `modelPricingCatalog`.**~~ Done 2026-07-31: OpenAI/Anthropic published list
  rates as of that date, entries still honestly flagged `placeholder` (hand-maintained, not
  billing-grade).

### Known defects, unfixed

- **Two sources for one schema.** `getWorkspaceNode()` reads the compiled canonical node list, and
  seven call sites take `article_body.outputSchema` from it — the conductor run bundle, both
  `publishReadiness` hooks, `project.validate_handoff`, `publisher` twice, and the publish-payload
  tool. The executor instead validates against `resolveConductorNodes()`, which overlays the live
  store (`outputSchema: stored.outputSchema ?? canonical.outputSchema`, default source `store`).
  Re-verified byte-identical 2026-07-31 (against v259) — but the invariant is still not guaranteed
  by construction, and `nodes:check` needs live access so CI cannot enforce it. Note the rename
  makes this bite until the post-deploy live write lands: seeds say `client_object.v1`, the store
  overlay still says `article_body.v1`. `getRunContext` is already `async` and already receives a
  repository.

Fixed 2026-07-31 (mechanical PR, deploy-gated like everything else): `get_run_cost` now answers
`retry_node` for a failed-node run; `tool.get_execution` requires `toolExecutionId` in its
advertised schema and `tool.list_executions` lists by run from persisted per-node records; the
Dr. Lurie image-placement validator reads the real contract shape (envelope `.body`,
`nodes[].public.media` — publisher.ts had it right); `AnthropicNodeRunner.validateConfiguration`
refuses tool-using nodes by name and `modelPricingCatalog` has Anthropic entries.

---

Deep background: `docs/plan/CHANGE-PLAN.md` (governing plan and every wave log),
`docs/plan/findings/`, `docs/plan/TEST-PROTOCOL.md`, `docs/platform/DIRECTION.md`.
