# Repository abstraction

CMS-Agent uses repositories to put one boundary between runtime orchestration and storage. The current implementation intentionally preserves the existing in-memory behavior while giving the runtime a single place to ask for workspace, execution, artifact, learning, and usage storage.

## Why repositories exist

The agent runtime has several operational stores today: workspace data, dry-run executions, model usage records, learning observations, and stage or execution artifacts. Keeping those access patterns behind repository interfaces lets the runtime and MCP tools depend on capabilities rather than storage details.

This boundary is useful because it allows future storage backends to be added without changing MCP contracts, Netlify function request/response shapes, workflow behavior, or UI behavior. `RepositoryManager` owns repository construction and exposes the repositories through explicit getters.

## RepositoryContext

`RepositoryContext` describes the storage scope that a repository manager was created for:

- `backend`: selected repository backend (`memory`, `json`, or `blobs`)
- `workspaceId`: optional future workspace scope
- `projectId`: optional future project scope
- `runId`: optional future workflow-run scope

The optional fields exist before full multi-project workspace support so repository APIs do not need to be redesigned later. Current memory repositories preserve existing behavior and may ignore `workspaceId`, `projectId`, and `runId`; the backend remains part of health reporting and future adapter selection.

## RepositoryHealth

Every repository exposes `health()` and `RepositoryManager.getRepositoryHealth()` aggregates health for workspace, execution, artifact, learning, and usage repositories. Health responses intentionally contain only safe operational metadata:

- `backend`
- `readable`
- `writable`
- `version`
- optional `latencyMs`
- optional sanitized `details`

Memory repositories return deterministic healthy values. Future adapters can add latency or sanitized details, but they must not expose storage paths, raw API keys, authorization headers, or secret-derived values.

## Canonical RecordEnvelope

`RecordEnvelope<T>` is the future canonical persistence wrapper:

```ts
interface RecordEnvelope<T> {
  id: string;
  record_type: string;
  schema_version: string;
  created_at: string;
  updated_at: string;
  data: T;
}
```

Future persisted records should use this envelope for:

- `workspace`
- `workflow_run`
- `artifact`
- `learning_observation`
- `model_usage`
- `project_configuration`

The envelope standardizes identity, record type, schema version, and timestamps across backends. That makes migrations, exports, imports, debugging, and cross-backend validation easier without changing each domain object independently.

## Runtime objects vs. persisted records

Runtime objects are the in-memory TypeScript objects used while workflow code, MCP tools, and tests execute. They should stay shaped for runtime ergonomics and backwards-compatible behavior.

Persisted records are backend storage units. Over time, persisted records should wrap runtime objects or canonical project data in `RecordEnvelope<T>` so storage metadata is consistent. This PR does not migrate stored data, does not wrap current in-memory runtime objects, and does not change execution behavior.

## Canonical data vs. operational data

Canonical data is project-owned source-of-truth content and configuration. Examples include project profiles, reusable workflow definitions, publishing target configuration, and externally owned CMS records. Canonical data should remain authoritative in the system that owns it.

Operational data is runtime state created while the agent works. Examples include dry-run workflow execution records, stage outputs, model usage records, learning observations, and generated artifacts. Operational data supports traceability, debugging, budget tracking, learning loops, and resumability.

Repositories are primarily the boundary for operational data. They should not make CMS-Agent silently take ownership of canonical records from an external CMS, MCP server, or project repository.

## Current backend

For this PR, every repository returned by `RepositoryManager` uses the existing in-memory implementation. The declared `RepositoryBackend` values are:

- `memory`
- `json`
- `blobs`

Only the memory implementation is wired at runtime right now. Selecting `json` or `blobs` is accepted by the config type for forward compatibility, but repository construction still returns memory repositories in this PR to avoid persistence or behavior changes.

## Workspace change history

The change-history repository family is the first production adopter of
`RecordEnvelope<T>`. Every workspace mutation that funnels through
`WorkspaceStateStore.mutate()` produces an immutable
`WorkspaceChangeEvent`; a full `WorkspaceRevision` snapshot (nodes +
relationships) is minted only when structural state actually changed, and the
document tracks `currentRevisionId`. Records persist as
`changes/{eventId}.json` (`workspace_change_event` / `.v1`) and
`revisions/{revisionId}.json` (`workspace_revision` / `.v1`) on the Blobs
backend, and in per-manager memory for the memory/json backends. The store
records history through the `WorkspaceChangeSink` interface and never imports
a concrete repository.

Guarantees and trade-offs:

- **Append-only**: nothing updates or deletes an existing event or revision;
  `changes.restore` re-applies a historical node state as a new forward
  mutation (`operation: "restore"`).
- **Write ordering**: the workspace document is saved first, then history
  records. A crash between the two loses one history record but never
  fabricates history for a mutation that did not persist.
- **Conflicts**: callers may send `expectedWorkspaceVersion` (legacy counter)
  and/or `baseRevisionId`; stale values throw
  `workspace_version_conflict: …` / `revision_conflict: expected X, current Y`.
- **Attribution is not authorization**: actors are structured
  `{kind: human|agent|system, id?, label?}` with a source (`mcp|ui|system`).
  The secure proxy stamps a verified human actor via `x-workspace-actor` /
  `x-workspace-source` headers after Netlify Identity checks; direct
  bearer-token callers default to an agent actor and could self-describe, so
  change records must never be treated as an access-control log.
- **Redaction**: before/after values and revision snapshots pass through the
  shared recursive key-based redactor (`src/agent/observability/redaction.ts`)
  so credential-shaped values never land in history records.
- **Legacy compatibility**: documents persisted before change history existed
  parse via schema defaults; the in-document `events[]` continues to append
  (thin records), while the unbounded full-node `versions[]` snapshots are no
  longer written — `getVersions()` merges legacy snapshots with new revision
  records.

## Future JSON implementation

A JSON backend can be useful for local development, deterministic fixture generation, and debugging. It should remain a local/dev adapter unless the deployment environment provides durable filesystem semantics. On Netlify serverless functions, local filesystem writes are not durable application storage, so JSON must not be presented as production persistence.

A future JSON repository should keep the same interfaces and preserve request validation, dry-run publishing defaults, and MCP tool contracts. JSON records should use `RecordEnvelope<T>` so local fixtures match the same persistence shape as durable backends.

## Future Netlify Blobs implementation

A Netlify Blobs backend can provide durable operational storage for deployed runtimes. It should be implemented as a replaceable adapter behind these repository interfaces rather than inside Netlify function handlers or workflow nodes.

The Blob adapter should:

- read credentials and site configuration from `process.env` only;
- avoid logging raw API keys, authorization headers, or sensitive payloads;
- keep mutating operations explicit and auditable;
- preserve dry-run defaults for publishing workflows;
- maintain compatibility with existing memory repository behavior and MCP contracts;
- persist records with `RecordEnvelope<T>` to keep schema versions and timestamps consistent across backends.
