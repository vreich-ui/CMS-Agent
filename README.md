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
