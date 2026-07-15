# CMS Agent Workspace

A Netlify-hosted TypeScript workspace for Agent SDK content workflows and a local MCP control server.

## Endpoints

* `POST /api/agent` runs agent workflows.
* `POST /api/mcp` exposes the workspace MCP server over Streamable HTTP (JSON-RPC). `DELETE` ends a session; `GET` returns `405` (no server-initiated SSE stream).
* `GET /api/workspace-mcp` (proxy) exposes the same MCP server behind a Netlify Identity session for the in-app UI.

MCP Authorization (OAuth 2.1) lets remote clients such as Claude connect without a shared token:

* `GET /.well-known/oauth-protected-resource` — RFC 9728 resource metadata.
* `GET /.well-known/oauth-authorization-server` — RFC 8414 authorization-server metadata.
* `POST /oauth/register` — RFC 7591 Dynamic Client Registration.
* `GET|POST /oauth/authorize` — human consent screen; issues the authorization code.
* `POST /oauth/token` — PKCE code exchange and refresh-token rotation.

Both endpoints return structured JSON for errors and successful API responses, except MCP notifications may return `202` with an empty body.

## Required environment variables

Only these environment variables are required at this stage:

```text
OPENAI_API_KEY=
OPENAI_AGENT_MODEL=gpt-5.5

AGENT_API_TOKEN=
MCP_API_TOKEN=
```

* `OPENAI_API_KEY` is used by the Agent SDK runtime.
* `OPENAI_AGENT_MODEL` selects the model used by the reusable base agent.
* `AGENT_API_TOKEN` protects `POST /api/agent` with bearer-token authentication.
* `MCP_API_TOKEN` protects `POST /api/mcp` with bearer-token authentication.

Optional, for remote MCP clients (Claude) and stricter transports:

```text
MCP_OAUTH_APPROVAL_SECRET=
MCP_REQUIRE_SESSION=false
```

* `MCP_OAUTH_APPROVAL_SECRET` gates the `/oauth/authorize` consent screen — a human enters it to approve a connection. Falls back to `MCP_API_TOKEN` when unset; set a dedicated value in production.
* `MCP_REQUIRE_SESSION`, when `true`, requires every non-`initialize` MCP request to carry a valid `Mcp-Session-Id`. Defaults to `false` so stateless bearer callers keep working.
* `MCP_STATE_STORE` forces the OAuth/session store to `blobs` or `memory`. Normally unset: state auto-persists in Netlify Blobs whenever a Blobs context is present (required, because `register` and `authorize` hit different function instances).

Do not commit real secrets. Configure production values in Netlify environment settings.

## Authentication

### `/api/agent`

Requests must include:

```http
Authorization: Bearer <AGENT_API_TOKEN>
```

Missing or invalid credentials return `401`.

### `/api/mcp`

The endpoint accepts **either** the static workspace token **or** an OAuth-minted access token:

```http
Authorization: Bearer <MCP_API_TOKEN | OAuth access token>
```

Missing or invalid credentials return `401` with a discovery pointer:

```http
WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
```

Authorization headers and token values must never be logged.

### Connecting a remote MCP client (Claude)

Add the deployed `https://<host>/api/mcp` URL as a custom/remote MCP connector. The client runs the
standard MCP Authorization handshake with no manual token:

1. The unauthenticated probe returns `401` + `WWW-Authenticate`, pointing at the protected-resource metadata.
2. The client reads `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server`, then registers itself at `/oauth/register` (Dynamic Client Registration).
3. The client opens `/oauth/authorize` in a browser. This renders a small **consent screen** — enter the `MCP_OAUTH_APPROVAL_SECRET` to approve — and redirects straight back to the client with a one-time code.
4. The client exchanges the code at `/oauth/token` (PKCE `S256`) for a bearer access token and connects.

> Why this matters: previously there was no OAuth metadata, so the connector's browser step landed on
> the SPA dashboard (served by the `/*` catch-all) and the flow could never complete. The well-known
> routes are now registered **ahead of** the catch-all in `netlify.toml`, and the consent screen closes
> the loop back to the client. Set `MCP_OAUTH_APPROVAL_SECRET` in Netlify before connecting.

### Session control (Streamable HTTP)

`initialize` returns a server-issued session id and the negotiated protocol version:

```http
Mcp-Session-Id: mcps_<hex>
MCP-Protocol-Version: 2025-06-18
```

Send `Mcp-Session-Id` on every subsequent request. Unknown or expired sessions return `404` so the
client re-initializes; `DELETE /api/mcp` with the header ends the session. Sessions expire on a sliding
idle window (30 min) capped by an absolute max age (12 h). Stateless bearer callers that omit the header
still work unless `MCP_REQUIRE_SESSION=true`.

### Tool naming

`tools/list` serves canonical underscore names (`workspace_get_nodes`) because remote connectors
forward them verbatim into the Anthropic API, which only accepts `^[a-zA-Z0-9_-]{1,64}$`.
`tools/call` accepts both the canonical and the legacy dotted spelling (`workspace.get_nodes`).

### Catalog scoping

The full catalog is 100+ tools. Set `MCP_EXPOSED_TOOL_PREFIXES` (comma-separated namespaces, e.g.
`workspace,node,project,workflow`) to expose only those namespaces — unexposed tools are neither
listed nor callable. Unset exposes everything.

## Architecture

```text
netlify/functions/agent.mts   Thin /api/agent handler
netlify/functions/mcp.mts     Thin /api/mcp handler (auth, sessions, Streamable HTTP)
netlify/functions/oauth-*.mts Thin OAuth discovery + authorize/token/register handlers
src/agent/runtime             Agent orchestration, request validation, auth helpers
src/agent/projects            Project profiles and registry
src/agent/skills              Reusable local capabilities
src/agent/workflows           Workflow definitions
src/agent/mcp                 MCP setup and workspace server
src/agent/mcp/transport       Streamable HTTP session lifecycle
src/agent/mcp/auth            OAuth 2.1 authorization server (metadata, PKCE, tokens, consent)
src/agent/mcp/state           TTL key/value store (memory + Netlify Blobs) for sessions and OAuth
src/agent/memory              JSON memory exchange types and adapters
src/agent/observability       Logging/tracing adapters
```

The workspace is designed around this long-term flow:

```text
User authentication
→ project selection
→ passthrough credentials
→ project MCP
```

Project-specific secrets are intentionally not stored as Netlify environment variables. Publishing will be performed through project MCP servers by updating canonical JSON workflow records. There is no separate publishing endpoint in this workspace.


## Dr. Lurie integration constraints

Dr. Lurie integration policy is documented in [docs/projects/dr-lurie-integration-notes.md](docs/projects/dr-lurie-integration-notes.md). In short:

* The workspace MCP is not the Dr. Lurie publishing backend and must not replace the Dr. Lurie MCP/repo as the canonical source for publishing behavior.
* `article_body.v1` remains canonical article content; Markdown is adapter/export output only.
* CMS-Agent adapter payloads must preserve Dr. Lurie `artifactReferences`.
* Raw image artifact references must not be treated as public reader-facing URLs. PDF refs may route through Dr. Lurie `/pdf/*`; images may not assume an equivalent `/image/*` fallback.
* Reader-visible inline images must include rendering placement metadata so future Dr. Lurie publishing can distinguish body images from hero/featured image paths.
* No Dr. Lurie publishing side effects or MCP calls are part of the current workspace flow.

## Workspace MCP storage

By default, the workspace MCP server uses an in-memory store. This is intentionally simple for tests and serverless safety, but it is ephemeral: prompt, schema, stage output, and learning observation updates can disappear after process restarts, Netlify cold starts, or deployments.

For local development persistence, opt into the JSON workspace store:

```text
WORKSPACE_STORE=json
WORKSPACE_STORE_PATH=.data/workspace.json
```

`WORKSPACE_STORE` supports `memory`, `json`, and `blobs`; if it is unset, the server defaults to `memory`. When `json` is selected and the file does not exist, the store initializes it with the default workspace nodes. The JSON document includes `schemaVersion`, `workspaceVersion`, `updatedAt`, `nodes`, `stageOutputs`, and `learningObservations`; writes are performed atomically through a temporary file followed by rename.

Use Netlify Blobs for durable deployed runtime storage:

```text
WORKSPACE_STORE=blobs
# Optional; defaults to cms-agent
NETLIFY_BLOBS_STORE_NAME=cms-agent
```

The Blobs repository backend stores records under stable keys: `workspace/current.json`, `runs/{runId}.json`, `artifacts/{artifactId}.json`, `learning/{observationId}.json`, and `usage/{usageId}.json`. Workspace reads initialize `workspace/current.json` from the Publishing Conductor defaults when it is empty, and blob reads request strong consistency so a write can be read by a new repository instance immediately afterward. Strong consistency requires the deployment to expose an `uncachedEdgeURL`; when that isn't available, reads automatically fall back to normal (eventual) Blobs consistency instead of failing the request — see Troubleshooting below.

Netlify Blobs must be available in the deployment context. In production, configure the site on Netlify and provide the standard Blobs environment/context that `@netlify/blobs` uses for site ID, deploy context, and authentication; do not hardcode tokens or site identifiers in source. For local development against the Netlify Blobs service, run through Netlify tooling or provide the required Netlify Blobs credentials in the local environment.

Do not use `WORKSPACE_STORE=json` in Netlify production. The JSON store is intended for local/dev persistence only because the Netlify serverless filesystem is not durable storage. If `NODE_ENV=production` and `WORKSPACE_STORE=json`, startup fails fast with a configuration error. Use `WORKSPACE_STORE=blobs` for deployed persistence, or keep `memory` for ephemeral test/dev behavior.

### Troubleshooting Netlify Blobs

If `/api/mcp` (or `/api/workspace-mcp`) fails with `MissingBlobsEnvironmentError: The environment has not been configured to use Netlify Blobs`, the Blob store was requested before the Lambda Blobs context was connected. These endpoints are Lambda-style Netlify Functions, so `@netlify/blobs` runs in compatibility mode and requires `connectLambda(event)` before the first `getStore()` call. Verify that:

- `connectLambda(event)` runs at the very beginning of the function handler, before the `RepositoryManager` or any Blob repository is constructed. In this project the connection is centralized in `connectLambdaBlobs(event)` (`src/agent/runtime/lambdaBlobs.ts`) and invoked at the top of each function handler.
- No `RepositoryManager` or Blob repository is instantiated at module-evaluation time. The shared `repositoryManager` is built lazily on first use, so `getStore()` never runs at import.
- The deploy actually provides a Blobs context (`event.blobs` plus the `x-nf-site-id` / `x-nf-deploy-id` headers). Without it, `getStore()` still throws `MissingBlobsEnvironmentError` even after `connectLambda(event)`.

If a request instead fails with `Netlify Blobs has failed to perform a read using strong consistency because the environment has not been configured with a 'uncachedEdgeURL' property`, Blobs is selected and initialized correctly, but the current Netlify Function environment does not expose the `uncachedEdgeURL` needed for strong-consistency reads. This is expected in some deployment contexts and is handled automatically: Blob reads (`src/agent/repository/blobs/blobClient.ts`, `getBlobJson`) try strong consistency first and, only when it is unavailable, retry the same read with normal (eventual) Blobs consistency instead of failing the request. Writes are unaffected. One practical consequence: immediately after a write, a read on a different repository instance may briefly observe stale data instead of the latest write until the fallback read (or Blobs' own cache) catches up. If `repository.get_health` or `workspace.get_nodes` still fail outright rather than degrading, that points at a different error — check the underlying `error.message` returned by the tool call, which never includes tokens, site IDs, or other Blobs internals.

## Local development

Install dependencies:

```bash
npm install
```

Create `.env` from `.env.example`, then start Netlify dev:

```bash
npm run dev
```

Run checks:

```bash
npm run typecheck
npm test
```

## Example requests

Run an agent workflow:

```bash
curl -sS http://localhost:8888/api/agent \
  -H "content-type: application/json" \
  -H "authorization: Bearer $AGENT_API_TOKEN" \
  -d '{"projectId":"project-a","workflow":"publish_only","input":"Draft this","dryRun":true}'
```

Initialize the workspace MCP server:

```bash
curl -sS http://localhost:8888/api/mcp \
  -H "content-type: application/json" \
  -H "authorization: Bearer $MCP_API_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

List MCP tools:

```bash
curl -sS http://localhost:8888/api/mcp \
  -H "content-type: application/json" \
  -H "authorization: Bearer $MCP_API_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Safety

* Publishing defaults to dry-run.
* Mutating external actions must be explicit and auditable.
* The current publishing skill does not call external publishing endpoints; project MCP publishing will be added later with passthrough credentials.

## Constellation redesign

The UI is migrating toward a project-scoped product model (Overview,
Constellation with Design/Operate/History modes, Runs, Changes, Settings).
The audit and specifications live in [docs/constellation/](docs/constellation/):
`product-model.md`, `information-architecture.md`, `data-model-gaps.md`,
`migration-plan.md`, and `test-strategy.md`.

## Visual workspace UI

A lightweight React/Vite UI lives in `ui/`. It is a local browser workspace for inspecting and editing MCP workspace state; it does not replace the Netlify functions and it is not the source of truth. The workspace MCP server at `POST /api/mcp` remains the source of truth.

### Run locally

Install root dependencies and UI dependencies:

```bash
npm install
npm --prefix ui install
```

Start Netlify dev so `/api/mcp` is available, then start the Vite app in a second terminal:

```bash
npm run dev
npm run ui:dev
```

By default, the UI points at `/api/mcp`. In local development, use the Vite URL shown by `npm run ui:dev`; if the Vite dev server is not proxying Netlify requests in your setup, enter the full Netlify dev endpoint in the UI, such as `http://localhost:8888/api/mcp`.

### Connection mode and bearer token

The UI has an explicit connection-mode switch: **Direct MCP token** (default
in local development) sends a manual bearer token to `/api/mcp`, and
**Identity secure proxy** (default in deployed mode) sends the Netlify
Identity session token to `/api/workspace-mcp`. The mode — not the endpoint
string — decides which credential is used; switching modes resets the
endpoint to that mode's default.

In direct mode, enter the MCP bearer token in the UI token field. The token
must match `MCP_API_TOKEN` for the Netlify MCP endpoint. A newly entered,
replaced, or cleared token takes effect on the next request. For now, the UI
stores that token only in browser `localStorage` in local development; do not
hardcode it and do not commit secrets. Tokens are redacted from error
messages and never rendered in the page.

### Current capabilities

The UI can:

* Show an attention-first Overview tab that surfaces approvals required, failed runs, degraded storage, and unconfigured project connections, plus read-only summaries of runs, nodes, usage estimates, projects, and storage health.
* Render workspace nodes from `workspace.get_nodes` as a React Flow graph.
* Inspect a selected node, including id, name, prompt, schema preview, and workspace version when returned by MCP.
* Save prompt edits through `workspace.update_node_prompt`.
* Render selected node schemas with react-jsonschema-form.
* Fetch and display the canonical `article_body.v1` schema from `article_body.get_schema`.
* Validate pasted JSON or RJSF-created article bodies with `article_body.validate`.
* Export the current workspace document with `workspace.export_workspace`.

The UI cannot:

* Publish content or call real project publishing MCP tools.
* Persist data outside whatever store backs the workspace MCP server.
* Act as the canonical workspace state. All reads and mutations must go through MCP tools, and the MCP workspace server remains authoritative.

## Publishing Conductor workspace graph

The default workspace MCP graph is the first real Publishing Conductor workflow. `workspace.get_nodes` returns typed nodes with UI-compatible `id`, `name`, `prompt`, `schema`, and `updatedAt` fields plus operational metadata for prompts, schemas, dependencies, risk level, status, produced artifacts, allowed tools, required inputs, and graph position.

Node ordering is canonical and stable. Editing a node's prompt or schema updates it in place and never changes workflow order — `workspace.get_nodes` always returns nodes in canonical conductor order (by graph `position.y` then `position.x`, falling back to the canonical Publishing Conductor order), regardless of storage insertion order, mutation order, or `updatedAt`. The `sortWorkspaceNodes` helper (`src/agent/workspace/nodes.ts`) applies this ordering on read, and the workspace UI graph applies the same position-based ordering defensively.

Current graph flow:

```text
input_triage
  -> topic_opportunity
  -> reader_insight
  -> research
  -> objection_mapping
  -> narrative_movement
  -> angle_strategy
  -> brief_architect
  -> draft_writer

draft_writer
  -> human_texture
  -> trust_factual
  -> emotional_resonance
  -> reader_simulation

human_texture
trust_factual
emotional_resonance
reader_simulation
  -> review_aggregator
  -> article_body
  -> publish_payload
  -> publication_controller
  -> learning_recorder
```

The richer internal conductor graph maps later to Dr. Lurie MCP's five external workflow stages:

| Internal node | Future external stage |
| --- | --- |
| `reader_insight` | `reader_insight` |
| `research` | `research` |
| `angle_strategy` | `angle` |
| `draft_writer` | `draft` |
| `article_body` | `final_article` |

Canonical content rules:

* `article_body.v1` is the canonical article content artifact.
* Markdown is not canonical. Markdown is only a render/export adapter.
* `content_source.v1` remains the canonical external project workflow envelope.
* The workspace MCP manages nodes, prompts, schemas, stage outputs, and learning observations only.
* Dr. Lurie MCP remains the future external project publishing backend; this workspace does not integrate it yet.
* `publish_payload` consumes `article_body.v1` and produces a dry-run adapter payload only.
* `publication_controller` is marked `publish` risk, but it is dry/approval-only for now and must not publish without future explicit approval support.
* `learning_recorder` records structured observations and improvement candidates, but it does not auto-edit prompts or schemas.

### Dry-run workflow execution

The workspace MCP exposes dry-run-only workflow controls for the Publishing Conductor:

* `workflow.start_dry_run` creates an in-memory execution record for a `projectId` and initial user input.
* `workflow.get_run` and `workflow.list_runs` read current execution state for UI display.
* `workflow.run_next_node` advances the next dependency-ready node and records node status, timings, deterministic mock output, stage outputs, artifacts, warnings, and errors.
* `workflow.reset_run` returns an existing run to its initial queued state.

Dry-run execution is intentionally mock and deterministic. It does not invoke OpenAI, does not call Dr. Lurie or other external project MCP servers, and does not perform publishing side effects. The executor preserves `article_body.v1` as the canonical article body, builds only dry-run `publish_payload` data, and stops at `publication_controller` with `approval_required`. When that block occurs, no publication has been performed and there is no approval execution path yet.

The workspace UI can start, advance, reset, refresh, and inspect these runs. It visualizes graph nodes with execution-state CSS classes (`queued`, `running`, `completed`, `blocked`, and `failed`) and displays run metadata, approval requirements, node outputs, artifacts, and stage outputs.

## Deployed workspace UI and Identity access

The Netlify site root (`/`) serves the Vite React workspace UI from `ui/dist`. The Netlify build installs root and UI dependencies, runs `npm run ui:build`, publishes `ui/dist`, and keeps Netlify functions available from `netlify/functions`.

Configured routes:

```text
/                         Vite workspace UI
/api/agent                /.netlify/functions/agent
/api/mcp                  /.netlify/functions/mcp
/api/session              /.netlify/functions/session
/api/workspace-mcp        /.netlify/functions/workspace-mcp
```

Production UI access is protected with Netlify Identity. Google login must be enabled in Netlify Identity provider settings. After login, the server-side `session` function reads the Netlify-verified identity context, compares the user email to `ADMIN_EMAIL_IDS`, and returns only authentication/authorization state and the email address. `ADMIN_EMAIL_IDS` is a comma-separated allowlist, for example:

```text
ADMIN_EMAIL_IDS=admin@example.com,owner@example.com
```

In deployed mode, the UI uses `/api/workspace-mcp`. That secure proxy verifies the Netlify Identity session, checks `ADMIN_EMAIL_IDS`, and forwards authorized JSON-RPC requests to the workspace MCP handler with the server-side `MCP_API_TOKEN`. The browser must never receive `MCP_API_TOKEN` or `AGENT_API_TOKEN`, and those values must not be stored in frontend source or browser storage.

Local development can still use direct MCP token mode with `/api/mcp`; in that mode the UI shows the manual MCP token field and stores the local token in browser `localStorage`. In deployed secure-proxy mode, the manual MCP token field is hidden and the UI sends the Netlify Identity access token only to the same-origin secure proxy.

Required production environment variables remain:

```text
ADMIN_EMAIL_IDS=
MCP_API_TOKEN=
AGENT_API_TOKEN=
OPENAI_API_KEY=
OPENAI_AGENT_MODEL=gpt-5.5
```

## Model usage and budget observability

CMS-Agent includes an in-memory model usage accounting layer for future OpenAI and agent execution. It does **not** call OpenAI and it does **not** perform real billing. Current values are estimates only.

Usage records are represented by `ModelUsageRecord` and can include run, workflow, project, node, agent, model, provider, token counts, estimated USD cost, status (`estimated` or `actual`), timestamp, and sanitized metadata. Metadata should not include raw prompts, API keys, authorization headers, cookies, JWTs, or other secrets.

The local pricing catalog currently includes placeholder estimates for:

* `gpt-5.5`
* `gpt-5.5-mini`
* `gpt-4.1`
* `gpt-4.1-mini`

These prices are deliberately documented as placeholders and must be updated before any production billing, quota enforcement, customer reporting, or financial decision-making. Estimates are not billing-grade and should not be treated as invoice truth.

The workspace MCP server exposes these usage tools:

* `usage.record` stores an estimated or actual usage record.
* `usage.list_records` lists records by optional `runId`, `projectId`, `workflowId`, `nodeId`, `from`, or `to` filters.
* `usage.get_summary` returns total input, output, reasoning, and combined tokens; estimated cost; record count; and breakdowns by model, node, and project.
* `usage.get_budget_status` returns estimated spend, remaining budget, percent used, and `ok`, `warning`, or `exceeded` status for an optional run/project budget.

Dry-run workflow node execution records deterministic mock usage for each executed node using `OPENAI_AGENT_MODEL` or `gpt-5.5`. The dry-run usage is always recorded with `status: "estimated"`; no model request is sent.

The workspace UI includes a Usage & Budget Estimates panel. When a dry-run is active, the panel filters usage by the current `runId`, shows estimated token/cost totals and model/node/project breakdowns, lets users enter a budget, and refreshes automatically after Run Next Node. The Refresh Usage button re-queries the MCP usage tools.

Future OpenAI integration should replace or supplement deterministic estimates with actual usage data returned by OpenAI responses while preserving the same storage and summary interfaces. External telemetry and durable billing storage are intentionally not integrated yet.

## Project MCP connections

CMS-Agent can register external **project** MCP servers and perform primitive, guarded tests against them. This is connection scaffolding only: it can initialize a project's MCP server, list its tools, discover schema/contract surfaces, and dry-validate a handoff payload. **Publishing execution is not part of this registry and remains disabled** until a future explicit `PUBLISH` approval gate is implemented — no `project.*` tool performs a publish side effect.

### Registry and Dr. Lurie adapter

* The project registry is defined in `src/agent/projects/projectTypes.ts` and `src/agent/projects/projectRegistry.ts`. Each project connection carries `projectId`, `name`, `mcpEndpointEnvVar`, `authMode`, `tokenEnvVar`, `allowedTools`, `contentContract`, `publishingPolicy`, and `status`.
* Connection configs are stored **through repositories** (`ProjectRepository`, backed by memory or Netlify Blobs like the other repositories), seeded from the code-defined defaults — not from hardcoded runtime state.
* The **Dr. Lurie** project (`dr-lurie`) is defined in `src/agent/projects/drLurie/definition.ts` with `contentContract: content_source.v1` and `canonicalArticleBody: article_body.v1`. Its publishing policy is disabled (`publishEnabled: false`, `requiresExplicitPublish: true`).
* Three additional MCP servers ship as code-defined defaults, each in its own folder under `src/agent/projects/` and following the same shape (`bearer_env` auth, publishing disabled, deny-all except an explicitly allow-listed set of **safe read-only** tools):
  * **PDF Tool** (`pdf-tool`, `src/agent/projects/pdfTool/definition.ts`) — server-side artifact/PDF/image generation. Allow-listed reads: `list_pdf_templates`, `get_pdf_template`, `get_agent_artifact_job_status`, `get_agent_artifact_by_filename`, `get_agent_artifact_by_slot`, `get_image_search_policy`, `get_image_search_bank`, `get_image_search_job_status`.
  * **Snoocle** (`snoocle`, `src/agent/projects/snoocle/definition.ts`) — audio-to-song-data foundry. Allow-listed reads: `server_status`, `list_songs`, `get_song`, `get_song_schema`, `list_song_versions`, `diff_song_versions`, `probe_audio`.
  * **Monetizer** (`monetizer`, `src/agent/projects/monetizer/definition.ts`) — affiliate/monetization intelligence. Allow-listed reads: `list_sources`, `list_connections`, `search_offers`, `performance`, `demand_signals`, `explain_decision`.
* The MCP connection adapter lives in `src/agent/projects/mcpClient.ts` (a minimal JSON-RPC client) and `src/agent/projects/drLurie/adapter.ts` (the project adapter). It supports the primitive calls `initialize`, `tools/list`, best-effort schema/contract discovery, and a best-effort dry validation call.

### Environment variables

The project endpoint and bearer token are resolved from environment variables at request time and are **never persisted** to workspace JSON or Blobs, and **never returned or logged**:

```text
DR_LURIE_MCP_ENDPOINT=
DR_LURIE_MCP_TOKEN=
PDF_TOOL_MCP_ENDPOINT=
PDF_TOOL_MCP_TOKEN=
SNOOCLE_MCP_ENDPOINT=
SNOOCLE_MCP_TOKEN=
MONETIZER_MCP_ENDPOINT=
MONETIZER_MCP_TOKEN=
```

Each connection uses its own `<CLIENT>_MCP_ENDPOINT` / `<CLIENT>_MCP_TOKEN` pair (per the `project_registration.v1` naming convention). Set the values in the Netlify deployment; no existing env var is reused across connections, because each outbound MCP server has its own endpoint and bearer token. Only non-secret metadata is stored and returned. Project views expose the env var *names* plus `endpointConfigured` / `tokenConfigured` booleans — never the endpoint value, token, authorization header, cookies, or JWTs.

### MCP tools

The workspace MCP server exposes these read-only project tools (no publishing side effects):

* `project.list` — list registered projects with safe, non-secret metadata.
* `project.get` — get one project's safe metadata and connection state.
* `project.test_connection` — run a primitive MCP `initialize` against the project's server and return safe server info.
* `project.list_tools` — list the project's remote tool names/descriptions via `tools/list`.
* `project.validate_handoff` — dry, local structural validation of a handoff payload against the project's `content_source.v1` / `article_body.v1` contract.

Agents can also register new publishing clients beyond the code-defined defaults:

* `project.get_registration_contract` — machine-readable onboarding contract: field rules, env-var naming conventions, and the step-by-step flow.
* `project.create` — register a new client connection. Endpoint/token are referenced by environment variable **name** only (validated against an identifier pattern, so URLs/secrets cannot be persisted); the publishing policy is server-forced to disabled.
* `project.update` — patch safe fields (name, env var names, auth mode, `allowedTools`, contract, status). Identity and publishing policy are not patchable.
* `project.delete` — remove an agent-registered project. Code-defined defaults (dr-lurie) are protected — disable them instead.

Typical agentic onboarding: `project.get_registration_contract` → `project.create` → set the referenced env vars in Netlify → `project.test_connection` → `project.list_tools` → `project.update` to allow-list safe tools → `project.validate_handoff`.

Publishing stays disabled: enabling it will require a future explicit `PUBLISH` approval gate, and until then these tools only read, initialize, list, validate, and manage registry entries.
