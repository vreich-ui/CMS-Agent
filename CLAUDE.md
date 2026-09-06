# CMS-Agent — navigation and safety card

Read [AGENTS.md](AGENTS.md) (the contract) and [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md) (the briefing) first. This file only tells you where things are and what not to break.

## Where things are

| Need | Go to |
|---|---|
| How the system actually works | `docs/ARCHITECTURE.md`, then the domain doc for your area |
| MCP tools (all 151) | `docs/reference/MCP_TOOLS.md` (generated) · code `src/agent/mcp/workspace/tools.ts`, `*Tools.ts` |
| Run engine | `src/agent/workspace/executor.ts` (`advanceRun`, `executeRunnableNode`, `retryNode`) |
| Node definitions | `src/agent/workspace/nodes.ts`, `captureConductorNodes.ts`, `cloneConductorNodes.ts`, `visualIdentityNodes.ts` (generated-locked) |
| Publishing | `src/agent/workspace/{publisher,publishDecision,publishExecution,releaseExecution,objectPublishExecution}.ts`, `src/agent/projects/<tenant>/hooks.ts` — `docs/PUBLISHING_ARCHITECTURE.md` |
| Storage | `src/agent/repository/**`, `src/agent/mcp/workspace/store.ts` — keys in `docs/DATA_ARCHITECTURE.md` §3 |
| Auth / OAuth / scoped bearers | `src/agent/mcp/http/mcpEndpoint.ts`, `src/agent/mcp/auth/*` — `docs/MCP_ARCHITECTURE.md`, `docs/SECURITY.md` |
| Jobs and deploy | `src/agent/entrypoints/*`, `cloudbuild.deploy.yaml`, `scripts/deploy-*.sh` — `docs/DEPLOYMENT.md` |
| Known bugs / risks | `docs/KNOWN_ISSUES.md` |
| Vocabulary | `docs/GLOSSARY.md` |

Repo: GitHub `vreich-ui/CMS-Agent`; `main` is protected — land through a PR, never push to `main`. Netlify site `cms-agent` hosts only the SPAs; production is Cloud Run `cms-agent-mcp` + jobs on GCS.

## Checks

`npm ci && npm ci --prefix ui`, then `npm run typecheck` and `npm test` (~4 min). CI also gates on `npm run test:drift`, `test:glossary`, `test:objects`, `test:scope`, and the ui suite (`npm run test:ui`, `npm run ui:build`).

## Do not break

- Publish gates and publish authority (`publisher.ts`, `publishDecision.ts`); never widen the publish charter; never change tool grants on publish/admin nodes on your own initiative (operator decision via `workspace_update_node_tools`). If a change lets a node publish something it could not before, stop and ask Wolf.
- Run CAS (`rev`, `withRunLock`) and workspace CAS (`mutate()`); never write store keys directly.
- Locked artifacts: regenerate with `npm run nodes:update` / `drift:update` / `glossary:update` / `objects:update` / `scope:update`; never hand-edit them. Node literal changes also need a redeploy and `npm run store:update`.
- Merge-style deploy flags only (`--update-env-vars`, `--update-secrets`).
- Secrets: names/refs only, never values.
- Netlify functions must not import each other.

## Do not assume

`dryRun: true` on a run means nothing — it is a literal on every run and no gate reads it; a `workflow_start_dry_run` run publishes live when its gates pass; `WORKSPACE_NODES_SOURCE` defaults to `store`; `netlify/functions/` and `src/agent/runtime/runAgent.ts` are legacy; only `dr-lurie` and `platform` can publish articles; the publish gates govern only the run-based path — `project_call_tool` (full bearer) and a model turn holding `project.call_tool` reach tenant verbs without them; a tenant's scoped chat bearer can approve/run ANY run by `runId` (KNOWN_ISSUES K-M9); `learning_list_observations` is broken on the GCS backend once a conversation ledger exists (KNOWN_ISSUES C-1).

## Discipline

Commit per milestone, not per session. Every task ships with its own acceptance test. Content production belongs in the site's admin chat, not in the MCP workspace surface. An adversarial review of the squashed diff is mandatory before delivery — green tests do not cover `.tsx`.
