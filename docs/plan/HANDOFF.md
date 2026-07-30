# CMS-Agent — session handoff

**This file lives in the repo on purpose.** Earlier handoffs lived in Claude Project knowledge, which
neither a Cowork session nor Claude Code can read — one cost a session-start to a screenshot. Anything
the next session must know goes here.

**Rule: a gate check is a command with an expected result. Prose is not a gate check.** If you cannot
write the call and what it should return, it is context, not a gate — put it under "State".

_Last updated 2026-07-30 after PR #96 (R-6 + R-23 delete half)._

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

## State — 2026-07-30

Workspace **v226**, backend `gcs`, graph valid. Registry: `dr-lurie`, `monetizer` (disabled),
`pdf-tool` (Ring 0 service), `platform` (client 0). All publish locks closed.

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

1. **Client-0 content advertises another client.** `review_aggregator` instructed a Dr. Lurie CTA on a
   `platform` article and `article_body` correctly copied it. Root cause: `clientProjectId` first
   appears at `contract_intelligence`, *after* the entire editorial chain, so every editorial node
   writes blind and defaults to Dr. Lurie. This is W-4, now evidenced rather than theorised. Fixing it
   in `article_body` would mask an upstream defect.
2. **`private.strategy` / `private.intent` absent from every block** — not empty, absent.
   `article_body` cannot carry them through: its `dependsOn` is only `review_aggregator` +
   `contract_intelligence`, and `review_aggregator` emits prose priorities with no per-block
   reasoning. The reasoning exists upstream in `narrative_movement` / `angle_strategy` and is
   discarded. This is W-5.

### Unmeasured

**#95's contract-prefetch effect on `contract_intelligence`** (was $3.79 pre-fix, target ~$0.10).
Measure with a fresh run plus `run_until(contract_intelligence)` — roughly $0.95 of known upstream
editorial cost plus the node itself. **A single-node `node.execute` will not measure it**: the
prefetch is applied in the workflow executor (`executeRunnableNode` gates on
`metadata.contractPrefetch`), so a single-node run bypasses it and returns a meaningless number.

### Owed

- **Deploy.** PR #96 is merged but not serving; until it is, agents can still call the two retired
  validators and the conductor still hands out the old bundle.
- **`npm run nodes:update`.** `nodes.ts` drifted from live before 2026-07-30 (live prompts edited via
  MCP 07-29 17:17; last re-seed #80 on 07-28). The re-seed also carries the v226 `article_body` prompt
  fix, so no hand-edit is needed or wanted.
- **R-23 rename half** — `article_body.v1` → `client_object.v1`, plus deleting the now-dead
  `canonicalArticleBody` field.
- **Real pricing in `modelPricingCatalog`** before any further cost-driven decision.

### Known defects, unfixed

- **Two sources for one schema.** `getWorkspaceNode()` reads the compiled canonical node list, and
  seven call sites take `article_body.outputSchema` from it — the conductor run bundle, both
  `publishReadiness` hooks, `project.validate_handoff`, `publisher` twice, and the publish-payload
  tool. The executor instead validates against `resolveConductorNodes()`, which overlays the live
  store (`outputSchema: stored.outputSchema ?? canonical.outputSchema`, default source `store`). They
  are byte-identical today, so nothing is broken — but the invariant is not guaranteed by
  construction, and `nodes:check` needs live access so CI cannot enforce it. `getRunContext` is
  already `async` and already receives a repository.
- `workflow.get_run_cost` returns `strategy: "poll"` for a run that is `failed` on one retryable node
  with reusable stages; the correct advice is `retry_node`.
- `tool.get_execution` advertises `runId`/`nodeId`/`toolId` as optional but rejects any call without
  `toolExecutionId`. Same advertised-vs-actual class as R-3 and R-19.
- Dr. Lurie's `validateArticleBodyImagePlacement` reads top-level `nodes[]` (the legacy shape), so it
  never fires on the envelope the pipeline actually hands it. Also `drLurie/artifactPolicy.ts` assumes
  flat `nodes[].media` while `publisher.ts` assumes `nodes[].public.media` — one of the two is wrong.
- `AnthropicNodeRunner` has no tool loop and `validateConfiguration()` does not refuse a tool-using
  node, so setting `modelConfig.provider: "anthropic"` on `article_body`, `artifact_plan` or
  `publish_payload` would silently strip the client-validation grant. `modelPricingCatalog` also has
  no Anthropic entries, so those nodes would be priced as `gpt-5.5`.

---

Deep background: `docs/plan/CHANGE-PLAN.md` (governing plan and every wave log),
`docs/plan/findings/`, `docs/plan/TEST-PROTOCOL.md`, `docs/platform/DIRECTION.md`.
