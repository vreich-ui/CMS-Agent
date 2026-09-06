# CMS-Agent

CMS-Agent is a TypeScript workspace and orchestration service for autonomous content workflows. It exposes one MCP (Model Context Protocol) Streamable-HTTP endpoint through which operators, AI connectors and tenant admin chats program a workspace of agent nodes, and it runs those nodes as multi-stage "conductor" workflows that research, write, review, materialize media for and publish content into external tenant sites (Dr. Lurie, Kugel Platform, Fernwell, minted clones). Tenant sites run their own MCP servers (repo `vreich-ui/platform`) and are the canonical owners of published content; CMS-Agent owns workflow definitions, run state, evaluations and learning state.

Documentation map: this README → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → domain docs → [docs/reference/](docs/reference/) → code. AI coding agents: read [AGENTS.md](AGENTS.md) and [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md) first. Status of every older document: [docs/README.md](docs/README.md).

## Current production architecture (September 2026)

| Plane | What | Where |
|---|---|---|
| Control plane | MCP server (151 tools), OAuth 2.1 authorization server, `/health`; also drives runs inside a 45 s request window | Google Cloud Run service `cms-agent-mcp` (`us-central1`, project `cms-agent-503015`), image from `Dockerfile.mcp`, entrypoint `src/agent/entrypoints/mcpServerMainRun.ts` |
| Background drivers | `continuation-tick` (every 2 min, advances runnable runs), `conductor-run` (one run to completion), `site-credential-reconciler` (daily, tenant chat credentials) | Cloud Run jobs from the same image |
| State | Every repository (workspace document, runs, projects, skills, changes, evaluation, improvement, conversations, sessions, OAuth) | GCS bucket `cms-agent-503015-cms-agent-state` (`WORKSPACE_STORE=gcs`) |
| Secrets | API keys, tenant tokens, scoped bearers, Netlify token | Secret Manager → Cloud Run env; records hold names/references only |
| Operator UIs | `ui/` (workspace) at `/`, `workbench/` (conductor workbench) at `/workbench` — static SPAs calling the Cloud Run `/mcp` with a pasted bearer | Netlify site `cms-agent` |
| Legacy | `netlify/functions/*` (old Netlify control plane; `mcp` function 502s since 2026-08-14; only `session` is live), the `/api/agent` base-agent scaffold, Netlify Blobs store | kept for tests and the CI drift detector — do not build on them |

Key facts that older documents get wrong: node behaviour comes from the **store** by default (`WORKSPACE_NODES_SOURCE=store`), every run record says `dryRun: true` but runs publish live when their gates pass, and publish authority is resolved from the run's own operator decision or snapshotted autonomy policy — never from a caller flag. See [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) §D for the full list.

## Major components

- **Workspace MCP** — `src/agent/mcp/` (transport, auth, sessions, tool catalog). [docs/MCP_ARCHITECTURE.md](docs/MCP_ARCHITECTURE.md), [docs/reference/MCP_TOOLS.md](docs/reference/MCP_TOOLS.md).
- **Conductor / executor** — `src/agent/workspace/` (node literals, workflow registry, `executor.ts`, publishing modules, run continuation). Four workflows: `publishing_conductor` (25 nodes), `capture_conductor` (16), `clone_conductor` (18), `visual_identity` (2). [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md).
- **Node runners and controlled tools** — `src/agent/execution/` (OpenAI Agents SDK, native Anthropic, mock), `src/agent/tools/` (49 node-callable tools), `src/agent/skills/` (13 seeded skills).
- **Projects (tenants)** — `src/agent/projects/` (registry, MCP client/adapter, Secret Manager, per-tenant publish hooks for `dr-lurie` and `platform`). [docs/PUBLISHING_ARCHITECTURE.md](docs/PUBLISHING_ARCHITECTURE.md).
- **Persistence** — `src/agent/repository/` (interfaces, memory + blob implementations, GCS transport). [docs/DATA_ARCHITECTURE.md](docs/DATA_ARCHITECTURE.md), [docs/reference/DATA_ENTITIES.md](docs/reference/DATA_ENTITIES.md).
- **Capture, clone, genesis** — `src/agent/capture/` (site capture/clone engines, `site.duplicate` genesis, credential reconciler).
- **Conversations** — `src/agent/conversations/` (`agent_converse` single-turn primitive for tenant admin chats; contract in [CLIENT-MANAGER-CONTRACT.md](CLIENT-MANAGER-CONTRACT.md)).
- **Improvement / learning** — `src/agent/improvement/` (rubrics, judge, optimizer, playbooks, regression, ingestion). Learning today = per-node playbooks injected into prompts; automatic loops are flag-gated and default off.
- **Observability** — run records, usage/cost, tick ledger, change history; no request log or tracing. [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Local development

```bash
npm ci && npm ci --prefix ui         # ui install is required for the root typecheck
npm run typecheck                    # tsc --noEmit (also `npm run build`)
npm test                             # vitest, ~290 files, ~4 min, no network or secrets
npm run serve:mcp                    # Cloud Run entrypoint locally on :8080 (in-memory store)
npm run ui:dev                       # http://localhost:5173 — paste a bearer, endpoint http://localhost:8080/mcp
npm run workbench:dev                # Conductor Workbench (fixtures unless VITE_MOCK=0)
```

Useful environment (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §5 for the complete table): `MCP_API_TOKEN` (static bearer for local calls), `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for real node runs, `WORKSPACE_STORE=gcs GCS_BUCKET=…` to work against a real bucket with Application Default Credentials. `WORKSPACE_STORE=json` is **not** file-backed (in-memory). Never commit `.env`.

Repository locks that CI enforces (`.github/workflows/ci.yml`): typecheck + tests, ui tests + build, two-plane MCP drift (`docs/mcp-tool-manifest.json`), glossary, object docs, site-credential scope. Node literals are generated-locked: after editing them run `npm run nodes:update` and redeploy; the store is updated separately with `npm run store:update`.

## Deployment

Push to `main` runs the Cloud Build trigger (`cloudbuild.deploy.yaml`): build `Dockerfile.mcp`, push `mcp-service:<sha>`, `gcloud run deploy cms-agent-mcp` with merge-style env/secret flags (never `--set-env-vars`), verify the served image and client variables, sync the `continuation-tick` job image. Manual alternative: `scripts/deploy-mcp.sh`. Jobs: `scripts/deploy-site-credential-reconciler*.sh`; the conductor and ingest jobs are created by hand per `docs/platform/` runbooks. Netlify builds the SPAs from `netlify.toml`. Full detail, differences between the two deploy paths, rollback and health checks: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Where deeper docs live

| Topic | Document |
|---|---|
| System, runtime topology, invariants | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Persistence, authority matrix, keys, ERD | [docs/DATA_ARCHITECTURE.md](docs/DATA_ARCHITECTURE.md) · [docs/reference/DATA_ENTITIES.md](docs/reference/DATA_ENTITIES.md) |
| Agents, workflows, skills, memory, learning | [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md) |
| MCP transport, auth, catalog | [docs/MCP_ARCHITECTURE.md](docs/MCP_ARCHITECTURE.md) · [docs/reference/MCP_TOOLS.md](docs/reference/MCP_TOOLS.md) · `docs/mcp-scoped-bearer-auth.md` |
| Publishing and tenant boundaries | [docs/PUBLISHING_ARCHITECTURE.md](docs/PUBLISHING_ARCHITECTURE.md) · `docs/plan/ADR-2026-08-25-publish-autonomy.md` |
| Deployment, environment variables | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Security | [docs/SECURITY.md](docs/SECURITY.md) |
| Observability, debugging | [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) |
| Defects, risks, doc contradictions | [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) |
| Terminology | [docs/GLOSSARY.md](docs/GLOSSARY.md) · `docs/ui-glossary.md` (generated) |
| Compact briefing for coding agents | [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md) |
| Product direction | [PRODUCT_VISION.md](PRODUCT_VISION.md) |
| Chat contract (Platform ↔ CMS-Agent) | [CLIENT-MANAGER-CONTRACT.md](CLIENT-MANAGER-CONTRACT.md) |
| Historical plans and runbooks | [docs/README.md](docs/README.md) |
