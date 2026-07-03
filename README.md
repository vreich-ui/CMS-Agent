# CMS Agent Workspace

A Netlify-hosted TypeScript workspace for Agent SDK content workflows and a local MCP control server.

## Endpoints

* `POST /api/agent` runs agent workflows.
* `POST /api/mcp` exposes the workspace MCP JSON-RPC server.

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

Do not commit real secrets. Configure production values in Netlify environment settings.

## Authentication

### `/api/agent`

Requests must include:

```http
Authorization: Bearer <AGENT_API_TOKEN>
```

Missing or invalid credentials return `401`.

### `/api/mcp`

Requests must include:

```http
Authorization: Bearer <MCP_API_TOKEN>
```

Missing or invalid credentials return `401`.

Authorization headers and token values must never be logged.

## Architecture

```text
netlify/functions/agent.mts   Thin /api/agent handler
netlify/functions/mcp.mts     Thin /api/mcp handler
src/agent/runtime             Agent orchestration, request validation, auth helpers
src/agent/projects            Project profiles and registry
src/agent/skills              Reusable local capabilities
src/agent/workflows           Workflow definitions
src/agent/mcp                 MCP setup and workspace server
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


## Workspace MCP storage

By default, the workspace MCP server uses an in-memory store. This is intentionally simple for tests and serverless safety, but it is ephemeral: prompt, schema, stage output, and learning observation updates can disappear after process restarts, Netlify cold starts, or deployments.

For local development persistence, opt into the JSON workspace store:

```text
WORKSPACE_STORE=json
WORKSPACE_STORE_PATH=.data/workspace.json
```

`WORKSPACE_STORE` supports `memory` and `json`; if it is unset, the server defaults to `memory`. When `json` is selected and the file does not exist, the store initializes it with the default workspace nodes. The JSON document includes `schemaVersion`, `workspaceVersion`, `updatedAt`, `nodes`, `stageOutputs`, and `learningObservations`; writes are performed atomically through a temporary file followed by rename.

Do not use `WORKSPACE_STORE=json` in Netlify production. The JSON store is intended for local/dev persistence only because the Netlify serverless filesystem is not durable storage. If `NODE_ENV=production` and `WORKSPACE_STORE=json`, startup fails fast with a configuration error. Production persistence will require a database or object store adapter; until then, production workspace state is ephemeral unless backed externally.

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

### Bearer token

Enter the MCP bearer token in the UI token field. The token must match `MCP_API_TOKEN` for the Netlify MCP endpoint. For now, the UI stores that token only in browser `localStorage`; do not hardcode it and do not commit secrets.

### Current capabilities

The UI can:

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
