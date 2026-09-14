# Genesis completeness — acceptance (Track A, G6)

_2026-09-14. cms-agent branch `feat/genesis-mint-only-parity`; platform branch `feat/genesis-mint-only-parity`._

---

## 1. What this document is, and what it is not

G6 asks for a live run: mint `genesis-lab-3`, drive `publishing_conductor` to `release_executor`,
confirm the build, and record the run id, cost, wall-clock and every warning.

**That run did not happen in this session, and could not have.** It needs three things this cloud
session does not hold and must not invent:

| Prerequisite | State here |
|---|---|
| `NETLIFY_API_TOKEN` with site-create rights | absent — and it is a catalogued genesis refusal (`netlify_token_missing`), not something to stub |
| A deployed `cms-agent-mcp` carrying this branch | the branch is undeployed; the running revision is `3ec3395` |
| The long-run planes (`continuation-tick`) pointed at that revision | operator-owned; repinning the tick needs Wolf's explicit go |

So section 3 is the **acceptance protocol** an operator runs after redeploy, written so it can be
executed without re-deriving anything, and section 2 is **what was actually proven here** — offline,
against real engine code, with the results a live run would have to reproduce. Nothing below is
labelled as a live result that was not one.

---

## 2. Proven offline (LOCAL, this branch)

### 2.1 Test evidence

| Suite | Result |
|---|---|
| cms-agent `npx vitest run` (full) | **379 files / 3764 tests, 0 failures** |
| cms-agent `npm run typecheck` | clean (the pre-existing `ui/src/types/workspace.ts` `@rjsf/utils` resolution error is unchanged from `main` and is a missing `ui/` dev dependency, not a type error in this change) |
| cms-agent `npm run test:drift` | manifest regenerated (`npm run drift:update`), 157 tools, plane parity ok, surfaceHash `67cde75925d9…` |
| platform `packages/core/cli/create-site.test.ts` | 24/24 pass, including the two new G4 cases |
| platform `npx eslint` on the changed files | clean |

### 2.2 The G6 assertions that can be made without a Netlify account

`tests/agent/capture/siteDuplicateMintOnly.test.ts` drives the real `site_duplicate` tool through the
real MCP handler, in genesis dry-run mode, with a `fetch` stub that **fails the test on any network
call at all**. It asserts, on the record the call actually writes:

| G-task | Assertion |
|---|---|
| G1 | `{newSite}` with no `sourceUrl` returns `{mode:"mint_only", projectId, mcpEndpoint, humanChecklist}`, carries no `runId`/`statusTool`, and leaves the **execution repository empty** — the "no run was created" half is checked against the store, not against the response shape |
| G1 | `{}` is refused (`exactly one of …`); `{targetProjectId}` with no source is refused naming `sourceUrl` |
| G1 | the seeded capture policy is **deny-all** (`allowedCrawlOrigins: []`) |
| G2 | the record's `objectDialect` is exactly `{site_genesis_lab_3, tax_genesis_lab_3, server_minted, ^req_…$, content_item, voice_genesis_lab_3, strat_genesis_lab_3}` |
| G3 | the genesis ledger carries `tenant_object_store_env` with `installed: [PUBLISH_SECRET, ARTIFACT_UPLOAD_TOKEN_SECRET, TRACKING_SALT, NETLIFY_SITE_ID]` and `onlyIfAbsent: true`, and no 32-hex value appears anywhere in it |
| G4 | the scaffold subprocess received `--editorial-voice` carrying the derived provisional voice (and does **not** receive it when the caller supplied one) |
| G5 | the record is `autonomyMode: "autonomous"`, and `genesisParityDivergences` on it returns `[]` |

`tests/agent/projects/platformScaffoldIds.test.ts` pins the id derivation across the two repos over a
four-slug table, with the platform-side ground truth (`sites/genesis-lab-2/config/site-identity.ts`)
named in the header, and asserts the deliberate *disagreement* with `conventionalTenantSlug` so
neither is "simplified" into the other later.

`packages/core/cli/create-site.test.ts` parses the ceiling literal the scaffold template emits and
runs it through platform's own `assertAggressionCeiling` and `siteIdentityConfigSchema` — so the value
is legal by the real validator, not by a regex.

### 2.3 What is therefore still unproven

- That a **live** Netlify site receives the four object-store variables (the dry-run path records the
  intent; only a live run writes them).
- That the tenant's `/mcp` then answers `object_list {type:"site"}` with the site object — the F3
  acceptance. This needs the site **built**, which needs its repo tree committed.
- That `publishing_conductor` reaches `release_executor` on a minted tenant.
- Whether the `stale_dispatch_reclaimed` class (Runner B2's territory) shows up on this run.

---

## 3. The acceptance protocol

### 3.0 Precondition that the brief does not state and that decides everything

**A minted tenant cannot build until its `sites/<slug>/` tree is committed to `vreich-ui/platform`.**
Genesis's scaffold step runs `create-site.mjs` against a checkout named by `PLATFORM_REPO_ROOT`;
with none mounted it is a `requires_human` ledger entry, and with one mounted the files land in that
checkout and still have to be committed and pushed by a human. Until that commit exists the Netlify
site builds nothing, `/mcp` serves nothing, and every step below fails for that reason and not for
any reason this patch addresses.

So the order is: **mint → commit the scaffolded tree → let Netlify build → then run the workflow.**

### 3.1 Mint

```
site_duplicate {
  newSite: {
    name: "genesis-lab-3",
    niche: "senior and aging pets",
    audience: "owners of aging dogs noticing mobility and comfort changes",
    ownerEmail: "vreich@kugelbrands.com"
  }
}
```
No `sourceUrl`. Expect `{mode: "mint_only", projectId: "genesis-lab-3", mcpEndpoint, humanChecklist}`
and **no `runId`**. Read `genesis.ledger` for `tenant_object_store_env` and `tenant_mcp_token_custody`.

### 3.2 Record parity, before anything else runs

```
WORKSPACE_STORE=gcs GCS_BUCKET=<bucket> npm run genesis:parity-check -- genesis-lab-3
```
Exit 0 and "no record-level divergences" is the G5 acceptance. Anything else prints the field, the
expected and actual values, **what it breaks**, and whether `genesis:reconcile` can repair it.

### 3.3 Commit the tree, and wait for the build

`git add sites/genesis-lab-3 && git commit && git push`. Then Netlify builds under the deploy binding
genesis copied from the reference site (base `sites/genesis-lab-3`, empty package directory, empty
build command).

### 3.4 The F3 acceptance

```
project_call_read_tool genesis-lab-3 object_list {type: "site"}
```
Expect the site object. `"Server-side object storage credentials are not configured."` means
`PUBLISH_SECRET` did not reach the site — check the `tenant_object_store_env` ledger entry's `failed[]`
and the `tenant_object_store_env` checklist item, which names the variable and what its absence looks
like from the outside.

Then `health` on the tenant for the storage half.

### 3.5 Seed the baseline objects

The scaffold writes seed **data files**; the store is empty until the seed drive runs
(`scripts/home-conversion-roundtrip.mjs` and siblings, per the provisioning runbook). Until then
`object_get voice_genesis_lab_3` is `not_found` and the engine uses the record fallback with
`voice_prefetch_fallback:voice_object_not_found` — a loud, correct degradation, not a failure.

`object_validate` on each of the five is the G4 acceptance.

### 3.6 The run

```
workflow.start_dry_run {
  projectId: "genesis-lab-3",
  workflowId: "publishing_conductor",
  executionMode: "openai",
  budgetUsd: 8,
  input: {
    requestId: "req_publish_senior_dog_stairs_20260914_01",
    title: "Why your senior dog hesitates at the stairs",
    reader: "owner of an aging dog noticing stairs hesitation",
    riskPosture: "lower-risk lifestyle content, never a diagnosis",
    nextStep: "observation checklist for the vet",
    sourcesPlacement: "below the article",
    trafficSource: "organic_search",
    awarenessStage: "problem_aware"
  }
}
```
Let `continuation-tick` drive it. Intervene only on a recorded blockage. Must reach
`release_executor` → `deploy_status {commit}` → `verify_article_images`.

**Standing rules that apply to this run:** a `release_to_production` 502 is never retried — read
`deploy_status {commit}` instead; every release attempt needs a fresh `idempotency_key`.

### 3.7 What to record here afterwards

Run id, total cost, wall-clock, every node warning verbatim, and every `stale_dispatch_reclaimed`
(note it, do not fix it — Runner B2 owns that class on `fix/driver-silence`).

---

## 4. Warnings this branch is expected to remove, and the ones it is not

| Warning from the proof run | After this branch |
|---|---|
| `artifact_site_scope_missing` | **gone** — the dialect is written at mint (G2) |
| `contract_prefetch_failed:prefetch_object_type_unresolved` | **gone** — `defaultObjectType: "content_item"` (G2) |
| `site_prefetch_withheld:contract_prefetch_failed` | **gone** — downstream of the above |
| `resolved_vector_unclamped:no_ceiling` | **gone once the tenant is rebuilt** — the ceiling is scaffolded into `site-identity.ts` and surfaced by `object_contract` (G4). A tenant scaffolded before this branch needs the block added to its committed config. |
| `voice_prefetch_fallback:voice_object_unconfigured` | **gone** — `voiceObjectId` is on the dialect (G2) |
| `strategy_prefetch_fallback:strategy_object_invalid` | **gone** — it was the F3 tool error failing the body-shape check. Expect `strategy_object_unconfigured` instead until somebody decides the strategy: that one is correct and is the warning doing its job. |
| `stale_dispatch_reclaimed` | **untouched** — Runner B2 |
