# Repository abstraction

CMS-Agent uses repositories to put one boundary between runtime orchestration and storage. The current implementation intentionally preserves the existing in-memory behavior while giving the runtime a single place to ask for workspace, execution, artifact, learning, and usage storage.

## Why repositories exist

The agent runtime has several operational stores today: workspace data, dry-run executions, model usage records, learning observations, and stage or execution artifacts. Keeping those access patterns behind repository interfaces lets the runtime and MCP tools depend on capabilities rather than storage details.

This boundary is useful because it allows future storage backends to be added without changing MCP contracts, Netlify function request/response shapes, workflow behavior, or UI behavior. `RepositoryManager` owns repository construction and exposes the repositories through explicit getters.

## Canonical data vs. operational data

Canonical data is project-owned source-of-truth content and configuration. Examples include project profiles, reusable workflow definitions, publishing target configuration, and externally owned CMS records. Canonical data should remain authoritative in the system that owns it.

Operational data is runtime state created while the agent works. Examples include dry-run workflow execution records, stage outputs, model usage records, learning observations, and generated artifacts. Operational data supports traceability, debugging, budget tracking, learning loops, and resumability.

Repositories are primarily the boundary for operational data. They should not make CMS-Agent silently take ownership of canonical records from an external CMS, MCP server, or project repository.

## Current backend

For this PR, every repository returned by `RepositoryManager` uses the existing in-memory implementation. The declared `RepositoryBackend` values are:

- `memory`
- `json`
- `blobs`

Only the memory path is wired at runtime right now. Selecting `json` or `blobs` is accepted by the config type for forward compatibility, but repository construction still returns memory repositories in this PR to avoid persistence or behavior changes.

## Future JSON implementation

A JSON backend can be useful for local development, deterministic fixture generation, and debugging. It should remain a local/dev adapter unless the deployment environment provides durable filesystem semantics. On Netlify serverless functions, local filesystem writes are not durable application storage, so JSON must not be presented as production persistence.

A future JSON repository should keep the same interfaces and preserve request validation, dry-run publishing defaults, and MCP tool contracts.

## Future Netlify Blobs implementation

A Netlify Blobs backend can provide durable operational storage for deployed runtimes. It should be implemented as a replaceable adapter behind these repository interfaces rather than inside Netlify function handlers or workflow nodes.

The Blob adapter should:

- read credentials and site configuration from `process.env` only;
- avoid logging raw API keys, authorization headers, or sensitive payloads;
- keep mutating operations explicit and auditable;
- preserve dry-run defaults for publishing workflows;
- maintain compatibility with existing memory repository behavior and MCP contracts.
