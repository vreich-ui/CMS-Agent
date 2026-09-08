# Rotating `TRACKING_SINK_TOKEN`

The sink bearer is held in three places that do not know about each other, on three different
release cadences. Rotating it is not one change; it is three, in this order, with a grace window
spanning them. Every step below was checked against the live shape on 2026-09-08 — where a fact here
disagrees with an older document, this one was measured.

**No token VALUE appears in this runbook, and none should appear in any command you paste from it.
Every step names a variable or a secret; the value travels only through the Netlify UI, the Secret
Manager UI, or a `--data-file`.**

## Who holds it

| Holder | How it is stored | When a new value takes effect |
| --- | --- | --- |
| **kugel-data** (the sink itself) | Netlify env on the `kugel-data` site: `TRACKING_SINK_TOKEN` accepted, plus `TRACKING_SINK_TOKEN_PREVIOUS` as a grace token (`netlify/functions/_shared/bearer.ts`) | on the next deploy of `kugel-data` |
| **`cms-agent-mcp` service** (Cloud Run) | Secret Manager `tracking-sink-token`, bound at `:latest` | on the next **revision** — a running instance keeps the value it started with |
| **`tracking-ingest` job** (Cloud Run) | Secret Manager `tracking-sink-token`, bound at `:latest` | on its next **execution** (03:00 UTC) |
| **every tenant site** (19 on team `vreich`) | Netlify ACCOUNT-level variable `TRACKING_SINK_TOKEN`, inherited — except where a site-level copy shadows it | on that site's next **deploy**: Netlify snapshots env at build time |

Two corrections to what earlier notes assumed. `continuation-tick` and `site-credential-reconciler`
do **not** bind `tracking-sink-token` — only the service and `tracking-ingest` do, so there is no
repin to do on the other planes and no reason to touch them. And `:latest` is not the same promise on
both: a job resolves it when a task starts, a service when an instance starts, so neither picks up a
new version merely because it exists.

## Before you start

    npm run env:audit          # NETLIFY_AUTH_TOKEN required

Read the shadow table. **A site-level copy of `TRACKING_SINK_TOKEN` overrides the account value**, so
a rotation that only changes the account variable leaves that site on the old token — sending events
that 401 from a site whose configuration looks correct. As of 2026-09-08 the audit reports
`drluriescience` shadowing `TRACKING_SINK_TOKEN` (and `TRACKING_SINK_URL`), and `kugel-fernwell`,
`kugel-platform` and `zilbermanfilmfoundation` shadowing `TRACKING_SINK_URL`. Clearing those is step 4
and it is not optional.

## 1. Open the grace window (kugel-data)

Netlify site `kugel-data`:

1. Set `TRACKING_SINK_TOKEN_PREVIOUS` to the **current** token value.
2. Set `TRACKING_SINK_TOKEN` to the **new** token value.
3. Deploy `kugel-data`.

The sink now accepts both. This is what makes the rest of the rotation a sequence of ordinary
deploys instead of a synchronised outage: the senders are fire-and-forget, so any holder that 401s
during a window simply loses its events with nothing reporting it.

Confirm the window is open before going further — the new token must already work, or step 2 hands
every Cloud Run plane a credential the sink rejects.

## 2. Secret Manager (project `cms-agent-503015`)

Add a new version of `tracking-sink-token` with the new value. Use a file, never an argument:

    gcloud secrets versions add tracking-sink-token --project cms-agent-503015 --data-file=/path/to/new-token

Nothing to repin — the two holders bind `:latest`. But nothing picks it up on its own either:

- **`tracking-ingest`** picks it up at its next execution (03:00 UTC). To not wait, run it once by
  hand; the job is idempotent for a given day.
- **`cms-agent-mcp`** picks it up only on a new revision. Redeploy the service
  (`bash scripts/deploy-service.sh`, or the trigger) rather than assuming warm instances rotated.

Do not delete the old secret version yet. It is the rollback.

## 3. The Netlify ACCOUNT variable (team `vreich`)

Today `TRACKING_SINK_TOKEN` is an account variable with **`is_secret: false`** at context **`all`** —
a fleet credential readable in the UI and in any build log that echoes its environment. Rotation is
the moment to fix that, because the variable has to be rewritten anyway.

Recreate it as:

- `is_secret: true`
- contexts **`production`, `deploy-preview`, `branch-deploy`** — never `all`. Netlify refuses a secret
  written with context `all` because `all` includes `dev`, and the dev context forbids secret values.
- scopes `builds`, `functions`, `runtime`, `post_processing`. **`builds` must stay**: the tenant repo
  reads the tracking env at BUILD time, and a functions-only scope makes it silently no-op (the live
  `drluriescience` bug, T21.8).
- account level only. Never a site-level copy — that is what created this problem.

**Accepted consequence (decision D2, 2026-09-08): the `dev` context loses the sink token.** A local
`netlify dev` will not send tracking events after this. That is the cost of the variable being a
secret at all, and it was chosen deliberately over keeping a fleet credential readable.

## 4. Delete every site-level shadow

For each row the audit listed, delete the SITE-level variable (not the account one) in that site's
Netlify env. Then:

    npm run env:audit          # must now print "✓ No shadows"

Do not proceed while any shadow remains. A shadow is invisible from the account view and from this
repository; the audit is the only thing that sees it.

## 5. Redeploy every affected tenant

Netlify snapshots the environment at build time, so a site keeps the old token until it is rebuilt —
however correct the account variable now is. Redeploy each of the 19 sites, or at minimum every site
that sends tracking events. A site not rebuilt is a site still on the old token, and it will keep
working until step 6, then go quiet.

## 6. Close the window, and prove it closed

1. Remove `TRACKING_SINK_TOKEN_PREVIOUS` from `kugel-data` and deploy it.
2. Probe the sink with the **retired** token: it must answer **401**.
3. Probe with the **new** token, sending something that is not NDJSON: it must answer **415**, not
   401. A 415 proves the bearer was accepted and the body was rejected — authentication verified
   without writing a single event.
4. Re-run `npm run env:audit`: zero shadows, `TRACKING_SINK_TOKEN` marked secret at three contexts.
5. Check that events are still arriving (the sink's `/stats` for today, or a tenant's Insights).
   Step 5's redeploys are the step most likely to be incomplete, and a site missed there goes quiet
   at exactly this point rather than at step 1 — which is why this probe is the last step and not the
   first.

## Rolling back

Before step 6, rollback is: put the old value back as `TRACKING_SINK_TOKEN` on `kugel-data` and
deploy. Every holder still has a token the sink accepts, because the grace window is still open.

After step 6, there is no fast rollback — the retired token is refused everywhere. Do not run step 6
on the same day as steps 1-5 unless step 5 completed for every site.
