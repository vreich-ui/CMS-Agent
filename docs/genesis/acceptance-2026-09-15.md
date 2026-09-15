# A2.5 acceptance — genesis-lab-3, resumable mint (2026-09-15)

**Status: NOT YET RUN. Blocked on a cms-agent service redeploy.**

Everything in A2.1–A2.4 is landed, tested and delivered on `fix/genesis-resumable-mint`. A2.5 is a
LIVE test of the deployed service: it needs the branch merged and `cms-agent-mcp` redeployed before
the first command below means anything. This session had no push rights on `vreich-ui/CMS-Agent`
(patch zip delivery) and no deploy authority on `cms-agent-503015`, so this file is the runbook plus
the facts already established, not a record of a run.

Re-running the mint against the currently deployed sha (`9ed54cd`) would reproduce the same 422.

---

## 0. What the current live state is (verified 2026-09-15, read-only)

| fact | value |
|---|---|
| Netlify site | `genesis-lab-3` · `c063340c-4def-44e3-a553-de7754b2437f` · team `6917763e9afbf6f211be929b` · no deploy |
| site env vars | `NETLIFY_BUILD_HOOK_URL`, `TRACKING_PROJECT_ID` — and nothing else |
| account env vars | `TRACKING_SINK_URL`, `TRACKING_SINK_TOKEN` (both `context: all`, non-secret) |
| registry record | none (`project_test_connection genesis-lab-3` → `Unknown projectId`) |
| Secret Manager `genesis-lab-3-mcp-token` | not minted |

Diagnosis: `docs/genesis/incident-2026-09-15-env-422.md`.

---

## 1. The mint, after redeploy

Run the exact original call:

```
site_duplicate {
  newSite: {
    name: "genesis-lab-3",
    niche: "senior and aging pets — mobility, comfort, everyday care",
    audience: "owners of aging dogs noticing changes in mobility, comfort or everyday movement",
    ownerEmail: "vreich@kugelbrands.com"
  }
}
```

### What it will do, and the one thing to decide

A2.3 renames. There is no registry record for `genesis-lab-3`, so nothing is bound, so the site name
comes from the convention: **`kugel-genesis-lab-3`**. That is a NEW Netlify site, and the existing
`genesis-lab-3` site becomes an orphan.

Genesis handles it exactly as instructed: it never deletes a Netlify site. It creates
`kugel-genesis-lab-3`, and because a site named `genesis-lab-3` also exists it adds
`delete_orphan_netlify_site` to the human checklist and a `netlify_orphan_site` entry to the ledger,
naming the leftover. **Deleting it is Wolf's call**, in the Netlify console. The orphan holds two env
vars and no deploy; nothing points at it.

If you would rather keep the original name instead, pass `netlifySiteName: "genesis-lab-3"` on the
call. That records `netlifySiteNameSource: "override"`, adopts the existing site, and permanently
silences the parity check for this tenant. Recommendation: **take the rename** — genesis-lab-3 is a
lab tenant, `seniorpets` is the one that matters, and the convention should hold from here.

### Expected result shape

```jsonc
{
  "mode": "mint_only",
  "projectId": "genesis-lab-3",
  "mcpEndpoint": "https://kugel-genesis-lab-3.netlify.app/mcp",
  "status": "active",          // "provisioning" if anything blocked
  "blockages": [],             // each with {step, key, code, detail, remedy, resumable}
  "resumable": true,
  "humanChecklist": [ … ]      // blockages first, then delete_orphan_netlify_site, then the rest
}
```

### Acceptance checks

| # | check | pass condition |
|---|---|---|
| 1 | `blockages` | empty. A non-empty list is not a failure of the mint — it is the mint telling you what to fix — but A2.5 wants a clean one |
| 2 | `project_test_connection genesis-lab-3` | succeeds with `endpointConfigured` **and** `tokenConfigured`. NOTE: the endpoint half is on the record; the token half resolves from `tokenSecretRef`. A full `initialize` against the tenant's `/mcp` only answers once the site has BUILT (§2) |
| 3 | `npm run genesis:parity-check -- genesis-lab-3` | exits 0. It will flag `clientSiteBinding.netlifySiteName` if you took the override path — that is expected and correct |
| 4 | Netlify env list on `kugel-genesis-lab-3` | 14 keys: `NETLIFY_BUILD_HOOK_URL`, `TRACKING_PROJECT_ID`, `NETLIFY_AUTH_TOKEN`, `PUBLISH_SECRET`, `ARTIFACT_UPLOAD_TOKEN_SECRET`, `TRACKING_SALT`, `NETLIFY_SITE_ID`, `CMS_AGENT_MCP_ENDPOINT`, `CMS_AGENT_MCP_TOKEN`, `ADMIN_EMAILS`, `ROLE_EMAILS_ADMIN`, `ARTIFACT_URL_INGEST_ALLOWED_HOSTS`, `PDF_TOOL_STORAGE_SITE_ID`, `MCP_HTTP_AUTH_TOKEN` |
| 5 | `NETLIFY_AUTH_TOKEN`'s scopes | `builds, functions, runtime` — **no** `post_processing`. This is the A2.1 fix, observable in the Netlify UI |
| 6 | idempotency | run the identical call a second time. `blockages` empty, still ONE Netlify site, ONE build hook, `tenant_mcp_token_custody.rotated: false`, `cms_agent_client_manager_credential.adopted: true` |

---

## 2. What genesis did NOT do, and cannot — the operator steps

**Genesis does:** the Netlify site, the deploy binding (repo + `base = sites/genesis-lab-3` + empty
package dir + empty build command, copied from the reference site), the build hook, all 14 env vars,
the tenant bearer into Secret Manager, the Client Manager credential, and the registry record at
fleet parity.

**Wolf must do, in this order:**

1. **Commit the scaffolded tree.** `sites/genesis-lab-3/` must exist in `vreich-ui/platform@main`.
   No platform checkout is mounted on the cms-agent deployment (`PLATFORM_REPO_ROOT` unset), so
   genesis puts `scaffold_site_tree` on the checklist rather than scaffolding: run
   `node packages/core/cli/create-site.mjs --name genesis-lab-3 --dry-run`, then without
   `--dry-run`, then `npm install` at the repo root and **commit `package-lock.json`** (a new site is
   a new npm workspace; without it every `npm ci` fails). Commit and push.
2. **Register the tenant in the fleet map, then promote.** Since platform #758 a push to `main` does
   not build; production ships only through `npm run fleet:promote -- --site genesis-lab-3`. Two
   things that command needs, and genesis can supply neither:
   - **`FLEET_SITES` in `scripts/fleet-capability-probe.mjs`** (which `fleet-promote.mjs` imports) is
     a hand-maintained list, and `parseArgs` **refuses an unknown slug** — so `--site genesis-lab-3`
     errors out until a line is added:
     `{ slug: 'genesis-lab-3', endpoint: 'https://kugel-genesis-lab-3.netlify.app/.netlify/functions/mcp' },`
     That file's own comment already names the hazard: *"a site missing here is a site that silently
     never gets promoted, which is a worse failure than a missing probe column."* See §4 — this is a
     genesis-completeness gap in `vreich-ui/platform`, not something A2 could close from cms-agent.
   - **the build hook URL in your shell**, as `NETLIFY_BUILD_HOOK_URL__GENESIS_LAB_3` in `~/.zshrc`
     (`buildHookEnvName` upper-cases the slug and replaces non-alphanumerics with `_`). Genesis
     created the hook and wrote its URL into the SITE's env, not into your shell; copy it from the
     Netlify UI (Project configuration → Build & deploy → Build hooks). It is a bearer credential.
3. **Only then** does the tenant's `/mcp` answer, and only then is check #2 above fully meaningful.
4. **The orphan.** Delete the old `genesis-lab-3` Netlify site if you agree with the rename (§1).

Until step 2 completes, a `publishing_conductor` run on this tenant will reach `publish_executor`
and fail at go-live verification — the site serves nothing.

---

## 3. The G6 proof run (after §2)

From `runner-prompt-track-A-genesis.md`, unchanged:

```
provider        openai
budgetUsd       8
requestId       req_publish_senior_dog_stairs_20260915_01
brief           stairs hesitation
flow            organic_search
awareness       problem_aware
```

`workflow_start_dry_run` → `workflow_run_all` → publish → `release_to_production` → `deploy_status`.
Record run id, cost, wall-clock and warnings here, and the live article URL.

Known live-run hazards carried over from 2026-09-14, none of them A2's:

| symptom | status |
|---|---|
| `resolved_vector_unclamped:no_ceiling` | gone once the tenant is built — the aggression ceiling is scaffolded into `site-identity.ts` (platform #756) |
| `artifact_site_scope_missing` | gone — the object dialect is written at birth (G2), and the mint's record carries `site_genesis_lab_3` / `tax_genesis_lab_3` |
| `release_to_production` idempotency | every attempt needs a fresh `idempotency_key`; `deploy_status {commit}` is the read |

---

## 4. Outstanding, not part of A2

- **`continuation-tick` repin.** `scripts/deploy-continuation-tick.sh --check` was **not run** in this
  session (no GCP credentials here). The job fires every 2 minutes against live content on all tenant
  sites, so a repin is a human decision — run the `--check` and decide before, not after, the proof run.
- **B2 D5 live acceptance** still waits on that repin.
- **editorial-planner job** creation + `--dry-run` still not done.
- **`FLEET_SITES` is hand-maintained (`vreich-ui/platform`).** A minted tenant is not promotable until
  a human adds a line to `scripts/fleet-capability-probe.mjs`, and `create-site.mjs` does not do it.
  That breaks the standing rule that genesis builds identical tenants with no per-tenant hand steps,
  and it bites every future mint including `seniorpets`. The mechanism fix belongs in platform, in one
  of two shapes: have `create-site.mjs` append the entry when it scaffolds `sites/<slug>/`, or derive
  `FLEET_SITES` from the committed `sites/*/` directories and their `site-identity.ts` rather than
  restating it. Worth its own short session; out of A2's scope (cms-agent) on purpose.

---

## 5. Verdict: can `seniorpets` be minted with the same call?

**Yes — after the redeploy, and it is the better first mint.**

- The 422 is a fleet-wide defect in the fleet loop, not anything about `genesis-lab-3`. With A2.1 in
  place, `seniorpets` takes the same path with a legal payload.
- Its slug is hyphen-free, so it avoids every hyphenated-slug hazard in this area at once:
  `platformScaffoldObjectIds` and the platform scaffold agree on `site_seniorpets` / `tax_seniorpets` /
  `voice_seniorpets` / `strat_seniorpets` by convention, and the env prefix is a clean
  `SENIORPETS_MCP_*`.
- Its site name will be `kugel-seniorpets`, on convention, with no orphan to reconcile.
- The same §2 operator steps apply verbatim: commit `sites/seniorpets/`, add
  `{ slug: 'seniorpets', endpoint: 'https://kugel-seniorpets.netlify.app/.netlify/functions/mcp' }`
  to `FLEET_SITES`, put the hook URL in `~/.zshrc` as `NETLIFY_BUILD_HOOK_URL__SENIORPETS`, then
  `npm run fleet:promote -- --site seniorpets`.

Recommended order: redeploy → mint `genesis-lab-3` as the acceptance (it is a lab tenant; if anything
is still wrong, it is wrong on the lab) → mint `seniorpets` → do the commit/promote work once, for
`seniorpets`, and run G6 there.
