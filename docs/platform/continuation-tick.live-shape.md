# continuation-tick — live shape (recon, 2026-09-08)

Read-only capture of what is actually deployed, taken before `scripts/deploy-continuation-tick.sh`
existed. It is the contract the script must declare: anything the script omits and the live job has
is a field the merge-style update will silently leave behind, and anything the script declares that
the job does not have is a change it will make on `APPLY=1`.

Captured with `gcloud run jobs describe` / `gcloud scheduler jobs describe` /
`gcloud run services describe` / `gcloud run jobs get-iam-policy`, project `cms-agent-503015`,
region `us-central1`, as `vreich@kugelbrands.com`. **No secret VALUE was read, printed, or stored —
only Secret Manager secret NAMES and their pinned version alias.**

## Cloud Run Job `continuation-tick`

| Field | Live value |
| --- | --- |
| service account | `cms-agent-run@cms-agent-503015.iam.gserviceaccount.com` |
| image | `us-central1-docker.pkg.dev/cms-agent-503015/cms-agent/mcp-service@sha256:2b708bbf58d965a4aac4b5f55d5c68a55ff08bef16654122e6df292a73a6c618` (digest — pinned by `scripts/pin-job-images.sh`) |
| command | `node` |
| args | `--import tsx src/agent/entrypoints/runContinuationTickMain.ts` |
| cpu / memory | `1000m` / `1Gi` |
| task timeout | `600s` |
| max retries | `0` |
| task count | `1` |
| execution environment | `gen2` |

### Environment (literal values — none is a credential)

| Name | Value |
| --- | --- |
| `WORKSPACE_STORE` | `gcs` |
| `GCS_BUCKET` | `cms-agent-503015-cms-agent-state` |
| `CONTINUATION_TICK_BUDGET_MS` | `240000` |
| `TASK_TIMEOUT_MS` | `600000` |
| `PLATFORM_MCP_ENDPOINT` | `https://kugel-platform.netlify.app/mcp` |
| `DR_LURIE_MCP_ENDPOINT` | `https://drluriescience.netlify.app/mcp` |
| `FERNWELL_MCP_ENDPOINT` | `https://kugel-fernwell.netlify.app/mcp` |
| `ZILBERMAN_MCP_ENDPOINT` | `https://zilbermanfilmfoundation.netlify.app/mcp` |

### Secret bindings (names only)

| Env name | Secret | Version |
| --- | --- | --- |
| `OPENAI_API_KEY` | `openai-api-key` | `latest` |
| `PLATFORM_MCP_TOKEN` | `platform-mcp-token` | `latest` |
| `DR_LURIE_MCP_TOKEN` | `dr-lurie-mcp-token` | `latest` |
| `FERNWELL_MCP_TOKEN` | `fernwell-mcp-token` | `latest` |
| `ZILBERMAN_MCP_TOKEN` | `zilberman-mcp-token` | `latest` |

### IAM on the job

`roles/run.invoker` → `serviceAccount:cms-agent-run@cms-agent-503015.iam.gserviceaccount.com`.
That is the only binding. It is also the account Cloud Scheduler authenticates as, which is why the
schedule fires at all — the PERMISSION_DENIED (code 7) story in `CONTINUATION_TICK.md`.

## Cloud Scheduler job `continuation-tick-schedule`

| Field | Live value |
| --- | --- |
| schedule | `*/2 * * * *` |
| time zone | `Etc/UTC` |
| state | `ENABLED` |
| attempt deadline | `180s` |
| uri | `https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/cms-agent-503015/jobs/continuation-tick:run` |
| method | `POST` |
| auth | **OAuth** token, SA `cms-agent-run@cms-agent-503015.iam.gserviceaccount.com` (no OIDC token) |
| retry | minBackoff `5s`, maxBackoff `3600s`, maxDoublings `5`, maxRetryDuration `0s` (unbounded) |

## Cloud Run Service `cms-agent-mcp` — parity reference (names only)

Service account and bucket match the job. Image is tag-pinned `mcp-service:59fa323` where the job is
digest-pinned; cpu `1`, memory `1Gi`.

- Env the service has and the job does NOT: `CMS_AGENT_PUBLIC_MCP_ENDPOINT`, `MCP_ALLOWED_ORIGINS`,
  `MCP_STATE_STORE=blobs`, `PDF_TOOL_MCP_ENDPOINT`, `TRACKING_SINK_URL`,
  `DR_LURIE_PUBLISH_ENABLED=true`, `PLATFORM_PUBLISH_ENABLED=true`.
- Secrets the service has and the job does NOT: `MCP_API_TOKEN`, `MCP_SCOPED_TOKENS_JSON`,
  `NETLIFY_API_TOKEN`, `PDF_TOOL_MCP_TOKEN`, `TRACKING_SINK_TOKEN`.
- Secrets both bind: `OPENAI_API_KEY`, `PLATFORM_MCP_TOKEN`, `DR_LURIE_MCP_TOKEN`,
  `FERNWELL_MCP_TOKEN`, `ZILBERMAN_MCP_TOKEN` — all `:latest`.

## Findings (report only — not fixed here)

**F1 — `TASK_TIMEOUT_MS` is already live at `600000`, and it already equals task-timeout × 1000.**
The plan assumed it was absent and that `--check` would show exactly one diff. It will not: if the
script declares the shape above faithfully, `--check` should come out clean. Treat any diff at all as
a reason to reconcile the script, not the job.

**F2 — the job binds five secrets and four tenant MCP endpoints, not one secret and three env vars.**
A deploy script that declared only `WORKSPACE_STORE`/`GCS_BUCKET`/`CONTINUATION_TICK_BUDGET_MS` +
`OPENAI_API_KEY` would pass `--update-*` harmlessly (merge semantics keep the rest) but would report
four false diffs on every `--check`, and would recreate the job wrong if it ever hit the create
branch. The script declares all of it.

**F3 — nothing on Cloud Run binds `ANTHROPIC_API_KEY`.** Not the job, not the service. The code path
exists and is complete: `runnerRegistry` routes any node whose `modelConfig.provider` is `anthropic`
to `AnthropicNodeRunner`, which fails validation with "ANTHROPIC_API_KEY is required for anthropic
execution" when the variable is unset. No node or rubric outside tests declares
`provider: "anthropic"` today, so nothing is broken right now — but the first node flipped to that
provider fails on the tick plane within two minutes, fleet-wide, with a validation error rather than
a deploy error. Genesis provisions `ANTHROPIC_API_KEY` into the Netlify `fleet_shared_keys` set for
tenant sites, so the fleet already assumes the key exists somewhere; Cloud Run is the plane where it
does not. Filed as a K- entry, not fixed in this wave.

**F4 — the job has no `TRACKING_SINK_URL`/`TRACKING_SINK_TOKEN`.** Correct as far as the tick's own
work goes (ingest is `tracking-ingest`'s plane), recorded so a future reader does not "restore" it.

**F5 — scheduler auth is OAuth, not OIDC**, matching `deploy-tracking-ingest-schedule.sh`. The
scheduler SA and the job's runtime SA are the same account.
