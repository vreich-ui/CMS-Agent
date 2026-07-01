# Netlify Agent SDK Scaffold

A TypeScript scaffold for running multi-project content creation and publishing agents in a Netlify environment using the OpenAI Agents SDK.

This repo is designed for teams that want one reusable agent runtime that can serve multiple projects, each with its own instructions, workflows, skills, MCP servers, memory namespace, and publishing targets.

## Overview

This project provides a serverless agent orchestration layer for:

* Content creation agents
* Publishing agents
* Project-specific workflows
* MCP server communication
* JSON-based memory exchange
* Future observability and learning loops
* Dry-run-first publishing safety

The core idea is simple:

```txt
One Netlify-hosted runtime
        +
One reusable base agent
        +
Project-specific profiles
        =
Flexible multi-project agent system
```

Instead of creating a separate agent for every project, this scaffold uses a project registry. Each project can define its own brand voice, editorial rules, allowed skills, MCP servers, memory namespace, and publishing configuration.

## Architecture

```txt
User / Dashboard / Webhook / Cron
        |
        v
Netlify Function: /api/agent
        |
        v
Agent Runtime
        |
        +-- Project Registry
        |     +-- projectId
        |     +-- brand voice
        |     +-- audience
        |     +-- editorial rules
        |     +-- allowed skills
        |     +-- MCP servers
        |     +-- memory namespace
        |
        +-- Skill Registry
        |     +-- draft content
        |     +-- editorial review
        |     +-- SEO optimization
        |     +-- publishing
        |
        +-- MCP Manager
        |     +-- remote MCP servers
        |     +-- tool allowlists
        |     +-- tool blocklists
        |
        +-- Memory Adapter
        |     +-- JSON memory import
        |     +-- JSON memory export
        |
        +-- Observability Adapter
              +-- run logs
              +-- tool-call logs
              +-- future tracing integrations
```

## Repository Structure

```txt
.
├── AGENTS.md
├── README.md
├── netlify.toml
├── package.json
├── tsconfig.json
├── netlify/
│   └── functions/
│       └── agent.mts
└── src/
    └── agent/
        ├── runtime/
        │   ├── createAgent.ts
        │   ├── runAgent.ts
        │   ├── types.ts
        │   └── validateRequest.ts
        ├── projects/
        │   ├── registry.ts
        │   └── project-a.ts
        ├── skills/
        │   ├── registry.ts
        │   ├── contentDraft.ts
        │   ├── editorialReview.ts
        │   ├── seo.ts
        │   └── publish.ts
        ├── workflows/
        │   ├── contentCreation.ts
        │   ├── publishOnly.ts
        │   └── refreshExistingContent.ts
        ├── mcp/
        │   ├── buildMcpServers.ts
        │   └── toolFilters.ts
        ├── memory/
        │   ├── memoryEnvelope.ts
        │   ├── MemoryAdapter.ts
        │   └── JsonMemoryAdapter.ts
        └── observability/
            ├── ObservabilityAdapter.ts
            └── consoleObservability.ts
```

## Core Concepts

### Project Profiles

Each project is configured through a project profile.

A project profile can define:

* Project ID
* Display name
* Default workflow
* Brand voice
* Audience
* Editorial rules
* Allowed skills
* MCP servers
* Memory namespace
* Publishing target

Example:

```ts
export const projectA = {
  projectId: "project-a",
  displayName: "Project A",
  defaultWorkflow: "content_creation",
  brandVoice: "Clear, practical, expert, non-hype.",
  audience: "Business owners and content operators.",
  editorialRules: [
    "Prefer concise sections.",
    "Use concrete examples.",
    "Avoid unsupported claims.",
    "Return publish-ready Markdown unless another format is requested."
  ],
  allowedSkills: [
    "research",
    "draft_content",
    "editorial_review",
    "seo_optimize",
    "publish"
  ],
  memoryNamespace: "project-a"
};
```

### Skills

Skills are local capabilities exposed to the agent as tools.

Examples:

* Draft content
* Review content
* Optimize for SEO
* Prepare publishing payloads
* Publish content
* Export memory
* Validate brand rules

Skills should be deterministic where possible and should avoid unnecessary side effects.

### MCP Servers

MCP servers allow the agent to communicate with external systems and tools.

This scaffold is designed to support remote MCP servers, especially for production/serverless environments.

Potential MCP use cases:

* CMS access
* Document repositories
* Brand knowledge bases
* Search systems
* Asset libraries
* Analytics platforms
* Social publishing tools
* Internal APIs

### Memory

The initial scaffold uses JSON memory exchange.

Memory is passed into a run, updated during processing, and returned in a structured envelope.

Future adapters can persist memory to:

* Supabase
* Neon
* Upstash
* S3
* Postgres
* Redis
* A custom memory API

### Observability

The initial observability layer logs:

* Run start
* Run end
* Errors
* Project ID
* Workflow
* Thread ID
* Tool activity summaries

Future integrations may include:

* OpenAI tracing
* Langfuse
* Helicone
* Custom dashboards
* Evaluation datasets
* Human review feedback
* Learning loops

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a local `.env` file:

```bash
OPENAI_API_KEY=
OPENAI_AGENT_MODEL=gpt-5.5

MCP_CONTENT_REPO_URL=
MCP_CONTENT_REPO_TOKEN=

PROJECT_A_PUBLISH_ENDPOINT=
PROJECT_A_PUBLISH_TOKEN=

OPENAI_AGENTS_DISABLE_TRACING=0
```

For production, configure these variables in Netlify environment settings.

Do not commit secrets to GitHub.

### 3. Start local development

```bash
npm run dev
```

### 4. Typecheck

```bash
npm run typecheck
```

### 5. Run tests

```bash
npm test
```

## API Usage

### Endpoint

```txt
POST /api/agent
```

### Example Request

```json
{
  "projectId": "project-a",
  "workflow": "content_creation",
  "threadId": "thread-123",
  "userId": "user-123",
  "dryRun": true,
  "input": "Create a blog post about how small businesses can use AI agents for content operations.",
  "memory": {
    "schemaVersion": "agent.memory.v1",
    "facts": [],
    "preferences": {},
    "openLoops": [],
    "artifacts": []
  }
}
```

### Example Response

```json
{
  "projectId": "project-a",
  "workflow": "content_creation",
  "output": {
    "title": "How Small Businesses Can Use AI Agents for Content Operations",
    "status": "draft_ready",
    "content": "# How Small Businesses Can Use AI Agents for Content Operations\n\n...",
    "memory": {
      "schemaVersion": "agent.memory.v1",
      "facts": [],
      "preferences": {},
      "openLoops": [],
      "artifacts": []
    }
  }
}
```

## Dry-Run Publishing

Publishing is dry-run by default.

This means the agent can prepare content, validate it, and generate publishing payloads without mutating external systems.

To allow actual publishing, a request must explicitly set:

```json
{
  "dryRun": false
}
```

Publishing tools and adapters should always check this flag before performing external mutations.

## Adding a New Project

Create a new project file:

```txt
src/agent/projects/project-b.ts
```

Then register it in:

```txt
src/agent/projects/registry.ts
```

Each project should define:

```ts
{
  projectId: "project-b",
  displayName: "Project B",
  defaultWorkflow: "content_creation",
  brandVoice: "...",
  audience: "...",
  editorialRules: [],
  allowedSkills: [],
  mcpServers: [],
  memoryNamespace: "project-b"
}
```

## Adding a New Skill

Create a new skill file:

```txt
src/agent/skills/mySkill.ts
```

Then expose it from:

```txt
src/agent/skills/registry.ts
```

Skills should:

* Have clear names
* Use strict input schemas
* Return structured JSON
* Avoid hidden side effects
* Respect `dryRun` where relevant
* Avoid logging secrets or private payloads

## Adding MCP Servers

MCP servers are configured per project.

Example:

```ts
mcpServers: [
  {
    name: "content_repo",
    type: "streamable_http",
    url: process.env.MCP_CONTENT_REPO_URL ?? "",
    authorizationEnv: "MCP_CONTENT_REPO_TOKEN",
    allowedTools: ["search_documents", "get_document"]
  }
]
```

Use allowlists and blocklists to keep tool access scoped to each project.

## JSON Memory Envelope

The recommended memory format is:

```ts
export type MemoryEnvelope = {
  schemaVersion: "agent.memory.v1";
  projectId: string;
  userId?: string;
  threadId?: string;
  updatedAt: string;
  facts: Array<{
    key: string;
    value: unknown;
    confidence: number;
    source: "user" | "agent" | "tool" | "human_review";
  }>;
  preferences: Record<string, unknown>;
  openLoops: Array<{
    id: string;
    status: "open" | "resolved";
    description: string;
    nextAction?: string;
  }>;
  artifacts: Array<{
    id: string;
    type: "brief" | "draft" | "published_url" | "report";
    uri?: string;
    value?: unknown;
  }>;
};
```

This keeps memory portable and easy to exchange across systems.

## Deployment

This scaffold is designed for Netlify Functions.

Before deploying:

1. Add all required environment variables in Netlify.
2. Confirm publishing defaults to dry-run.
3. Confirm MCP server URLs are reachable from the Netlify environment.
4. Confirm secrets are not logged.
5. Run typechecks and tests.

Deploy with:

```bash
netlify deploy
```

Or connect the GitHub repository to Netlify for automatic deploys.

## Safety Principles

This project should follow these safety rules:

* Never publish unless `dryRun` is explicitly `false`.
* Never log API keys, bearer tokens, cookies, or authorization headers.
* Keep project access scoped by `projectId`.
* Use MCP tool allowlists wherever possible.
* Keep publishing adapters auditable.
* Return structured errors.
* Prefer human review before enabling autonomous publishing.
* Treat memory as portable but sensitive.
* Keep mutation tools separate from read-only tools.

## Roadmap

### Phase 1: Initial Scaffold

* Netlify Function endpoint
* Project registry
* Base agent factory
* Local skill registry
* Dry-run publishing
* JSON memory envelope
* Basic observability adapter

### Phase 2: MCP Integration

* Streamable HTTP MCP server support
* Tool allowlists
* Tool blocklists
* Partial failure handling
* MCP connection diagnostics

### Phase 3: Content Workflows

* Content creation workflow
* Publish-only workflow
* Refresh existing content workflow
* Editorial QA workflow
* SEO workflow

### Phase 4: Persistence

* Persistent memory adapter
* Run history
* Artifact storage
* User/project-level preferences
* Publishing status records

### Phase 5: Observability

* Trace integration
* Tool-call logs
* Run dashboards
* Human review outcomes
* Failed-run repair loops

### Phase 6: Learning Loops

* Feedback collection
* Content performance ingestion
* Prompt/profile refinement
* Evaluation datasets
* Workflow optimization

## Development Principles

Keep the system modular.

The Netlify function should remain thin. Most logic should live in reusable modules under `src/agent`.

Prefer this:

```txt
Netlify Function -> validate request -> load project -> run agent
```

Avoid this:

```txt
Netlify Function -> hundreds of lines of orchestration logic
```

## License

MIT
