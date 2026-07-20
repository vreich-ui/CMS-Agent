# Constellation redesign — data-model gaps and technical debt

Findings from the architecture audit (UI, MCP workspace server, repositories,
auth). Each item states the current behavior with file references, why it
blocks or degrades the redesign, and the proposed direction. Items marked
**[pre-shell]** must be fixed before the shell migration begins; the rest can
land with their consuming feature. `migration-plan.md` sequences them.

## 1. Credential lifecycle bug **[pre-shell]**

### Symptom

A valid MCP bearer token that is present in UI state (pasted or restored from
`localStorage`) is not used until the endpoint field changes.

### Reproduction (verified against the running app, request headers captured)

1. Local mode, endpoint `/api/mcp`, paste the valid token → Refresh: **5/5
   MCP requests carry `Authorization: Bearer …`** and all sections load.
2. Change the endpoint to the documented deployed value
   `/api/workspace-mcp` (token still in state and `localStorage`): the token
   field disappears and **5/5 requests are sent with no Authorization header
   at all** → every section 401s. The stored token is silently dropped.
3. Click "Test connection" on the same endpoint: this panel **does** send the
   manual token (`Authorization: Bearer …` captured) and gets HTTP 401 —
   i.e. two parts of the same screen disagree about which credential to use
   for the same endpoint.
4. Change the endpoint back to `/api/mcp` → the token is used again. Hence
   the folk procedure "edit the endpoint to make the token take".

In deployed mode the same defect inverts: the app correctly uses the Netlify
Identity token, but "Test connection" throws
`Enter an MCP bearer token before calling workspace tools.`
(`ui/src/mcp/client.ts:24`) without sending anything, because it only knows
about the hidden, empty manual token.

### Root cause

Credential selection is **derived from a string comparison on the endpoint
field and computed in two different places**:

- `ui/src/App.tsx:58` — `usingSecureProxy = endpoint === DEPLOYED_ENDPOINT`
  (exact match against `"/api/workspace-mcp"`, `App.tsx:25`).
- `ui/src/App.tsx:61` — the canonical config memo drops the manual token
  whenever that string matches:
  `token: usingSecureProxy ? undefined : token,
   authToken: usingSecureProxy ? session.accessToken : undefined,
   requiresToken: !usingSecureProxy`.
  The memo's dependency list is correct (`token` is included) — this is not a
  stale-memo bug in App; it is intentional-but-implicit mode switching keyed
  on the endpoint string, with no user-visible mode concept.
- `ui/src/hooks/useConnection.ts:11` — `ConnectionPanel` builds a **second**
  `McpConfig` from raw `(endpoint, token)` props (`ConnectionPanel.tsx:14-15`)
  with no `authToken` and no `requiresToken`, so it never learns about
  secure-proxy mode. This is the stale/duplicated **configuration
  dependency**: the panel's client diverges from the app's client.

Aggravating stale-lifetime dependencies (why nothing recovers when the
credential finally arrives):

- `ui/src/components/WorkflowControls.tsx:18` — mount-only, lint-suppressed
  effect (`useEffect(..., [])`) captures `onListRuns` (and through it the
  config) from the first render and swallows failures; a token pasted later
  never re-triggers the initial run list.
- `ui/src/components/NodeConsole.tsx:74` — auto-refresh effect keyed on
  `[selectedNodeId]` only; a config/credential change does not re-run it.
- `ui/src/hooks/useOverview.ts:61-63` — mount-only load by design (explicit
  Refresh recovers, so Overview degrades gracefully rather than silently).
- `ui/src/hooks/useIdentitySession.ts:31,51-52` — the Identity JWT is captured
  once at login into `session.accessToken` and never renewed; after the JWT
  expires every proxied call 401s until logout/login. Stale **credential
  value** with no refresh path.

### Resolution (implemented — session S0)

Status: **fixed**. Final design:

- **Discriminated union** `McpConnection` in `ui/src/connection.ts`:
  `{ mode: "direct"; endpoint; token }` |
  `{ mode: "secure-proxy"; endpoint; getAccessToken }`. Authentication state
  is modeled explicitly; the endpoint string carries no credential meaning.
  Mode is user-chosen (radio group in the connection panel); switching modes
  resets the endpoint to that mode's default and swaps the credential source
  with the union variant.
- **Call-time credential resolution**: `createMcpClient(getConnection)`
  (`ui/src/mcp/client.ts`) resolves the connection when a request fires, and
  `useMcpClient` binds it through a ref with a stable client identity. Any
  callback or mount-only effect may capture `client.call` — the credential
  used is always current, eliminating the stale-closure class outright.
  Direct mode refuses to send a request without a token (no unauthenticated
  spray); secure-proxy mode calls `getFreshIdentityToken()` per request
  (`user.jwt()` refreshes expired JWTs), so nothing captures the identity
  token at login.
- **One config source**: `useConnection` now consumes the shared client;
  ConnectionPanel's divergent second `McpConfig` is deleted, so "Test
  connection" and app requests are the same code path by construction.
- **Redaction at the error boundary**: `McpClientError` passes its message
  and details through `redactSecretText`/`redactSecretValue`
  (`ui/src/connection.ts`) — pattern-based for `Bearer <value>` strings,
  key-based for credential-named fields — so tokens cannot reach logs, status
  banners, DOM text, or serialized error details even when a server echoes a
  header.

Verified live (request-header captures): a pasted token is used by the next
request with the endpoint untouched; replacement and clearing take effect on
the next request (clearing sends nothing); mode switches swap credential
sources cleanly; direct mode pointed at `/api/workspace-mcp` still sends the
token (the original bug's exact regression); Test connection agrees with app
requests. Regression suite: `tests/ui/credentialLifecycle.test.ts` and
`tests/ui/connection.test.ts` (see `test-strategy.md`).

## 2. Change/revision system gaps **[pre-shell for Changes/History]**

> **Status update (S1, implemented):** first-class change history now exists —
> immutable `WorkspaceChangeEvent` + `WorkspaceRevision` records in a
> dedicated `ChangeRepository` (memory/json/blobs, `RecordEnvelope`-wrapped),
> recorded from the single `mutate()` funnel; paginated/filterable
> `changes.list` + `changes.get` / `changes.compare` / `changes.restore`
> tools; structured server-stamped actors (`human|agent|system` +
> `mcp|ui|system` source, secure proxy stamps verified identity); typed
> `revision_conflict` on stale `baseRevisionId`; snapshot spam fixed
> (revisions only on structural change; the in-doc `versions[]` append is
> retired, legacy data still readable). Typed relationships
> (`data/memory/policy/evaluation/approval`) are stored in the document and
> covered by history; `constellation.*` read tools expose structure, derived
> per-agent/per-relationship metrics (estimated/actual never merged), a
> system summary with caveats, and evidence-cited attention items. The
> OpenAI-mode usage double-count is fixed. **Still open from this section:**
> `workflow.list_runs` pagination/filtering (D3), `usage.record` metadata
> sanitization at the tool boundary, meta on `skill.delete`, and the in-doc
> `events[]` thin-append retirement.

The original findings (pre-S1 state), kept for context:

- Every mutation appends a full node snapshot to `document.versions[]` and an
  event (`beforeHash`/`afterHash`, optional `actor`/`summary`) to
  `document.events[]` (`src/agent/mcp/workspace/store.ts:219-220`;
  types `src/agent/workspace/nodeTypes.ts:33-34`).
- **No read API**: no `workspace.list_events` / `get_versions` / diff tool is
  registered (`tools.ts:191-210`); the only access is
  `workspace.export_workspace`, which returns the entire document.
- **No restore**: `skill.restore_version` exists (`tools.ts:188`) but there is
  no workspace/node equivalent; snapshots cannot be re-applied through any
  tool.
- **Attribution is caller-asserted**: `actor` is an optional free-form string
  (`tools.ts:53`), never bound to the authenticated principal
  (`server.ts:25,51` passes arguments straight through), and has no
  human/agent/system kind. Three mutation paths accept **no meta at all** yet
  still bump the version: `workspace.import_workspace`, `stage.save_output`,
  `learning.record_observation` (`tools.ts:210,213,216`;
  `store.ts:253-272`). `skill.delete` also lacks meta (`tools.ts:182`).
- **Version inflation / snapshot bloat**: stage-output and observation writes
  increment the same global `workspaceVersion` and clone all nodes into a new
  snapshot even though nodes are unchanged (identical before/after hashes);
  one dry run writes a stage output per node, so run activity floods the
  future Changes ledger and bloats `workspace/current.json` (write
  amplification grows with history). No cap, TTL, or pruning exists.
- Snapshots capture `nodes` only — not stage outputs or observations — so
  restore semantics are node-scoped by construction.

Direction: add paginated `workspace.list_events` / `workspace.get_version` /
`workspace.restore_node_version` tools; stamp actor server-side from the auth
context (`{kind, id}`); require meta on all version-bumping mutations; stop
snapshotting on non-node mutations (or move stage outputs / observations out
of the versioned document); define a retention/compaction policy.

## 3. Graph model gaps

- **No edge entity**: edges are derived from `node.dependsOn` on read
  (`tools.ts:192`). Fine for v1 rendering; becomes limiting if edges need
  their own metadata (labels, gating conditions).
- **Artifact contracts are unenforced**: nothing checks that a node's
  `requiredInputs` are satisfied by its `dependsOn` producers' `produces` —
  the taxonomy's `produces/consumes` layer is honest only as "declared", not
  "validated". Candidate new validation in `validateWorkspaceGraph`
  (`src/agent/workspace/nodes.ts:1752-1789`, which today covers duplicates,
  unknown risk/status, dangling deps, cycles, and canonical structure).
- **Graph rendering honesty** **[pre-shell]**: the current UI fabricates a
  linear chain (`ui/src/components/WorkspaceGraph.tsx:25-29` links display
  order i→i+1) and synthesizes positions on a fixed 280×180 grid
  (`WorkspaceGraph.tsx:20`), ignoring MCP `position` — so the graph humans
  see is not the graph agents execute (the real topology has a 4-way review
  fan-out/fan-in). Design mode must render `workspace.get_graph` truthfully;
  until then, supervision decisions are being made against a fiction.
- Position doubles as canonical ordering (`sortWorkspaceNodes` by y-then-x,
  `nodes.ts:1730`; reorder rewrites y as `index*100`, `store.ts:251`) —
  free-form dragging in Design mode will interact with ordering; the plan is
  to treat ordering as derived and let validation own correctness. **S3
  status:** the Design canvas never sends `orderedNodeIds`, so drags only
  reposition; ordering remains a derived view. The legacy Builder's Move
  up/down keeps its rewrite behavior until S5 retires it.
- **`deleteNode` partial-mutation hazard** (found in S3, worked around, not
  yet fixed): `store.deleteNode`'s mutator filters `document.nodes` in
  place, and `mutate()` runs its unconditional `assertGraphValid
  (document.nodes)` only *after* the mutator — so a refused delete (e.g. a
  canonical node) throws after the in-memory document was already mutated,
  without a version bump. `updateGraph` instead edits a copy and validates
  before assignment, failing atomically. The S3 UI therefore deletes via
  `workspace.update_graph {delete: [id]}`. Backend fix candidate: make
  `deleteNode` (and any in-place mutator) work on a copy, or have
  `mutate()` snapshot/restore on validation failure. Related: canonical
  removal is effectively impossible even with
  `allowCanonicalNodeRemoval + adminApproved` because the post-mutator
  re-check runs with defaults — the UI refuses honestly and surfaces the
  server message verbatim.

## 4. Run and execution gaps

- **No pagination or filtering** beyond `projectId`/`workflowId`:
  `workflow.list_runs` returns every run (`tools.ts:223`); the blob backend
  does an N+1 scan (`store.list({prefix:"runs/"})` then one read per run)
  with in-memory sort (`BlobExecutionRepository.ts:28-36`). A Runs page needs
  `{limit, cursor, status?, from?, to?}` server-side. **[pre-shell for Runs]**
- **Pause is indistinguishable from approval-block**: both set
  `status: "blocked"` (`tools.ts:228`); `approvalsRequired` presence is the
  only discriminator. Needs a distinct `paused` status or a `blockReason`.
- `workflow.run_node` ignores its `nodeId` input and just advances the next
  node; `workflow.run_all` parses an `approved` flag it never uses
  (`tools.ts:225,227`) — dead contract surface that will confuse agent
  callers of the new UI's tooling docs.
- `publication_controller` blocking is hardcoded in the executor
  (`executor.ts:116-130`) rather than policy-driven off `riskLevel` — correct
  behavior, brittle shape; fine to keep until the PUBLISH gate work.
- Runs have no version/etag — optimistic concurrency is impossible on run
  mutations (acceptable for now; single-writer executor).
- **Usage double-count risk**: independent node execution in `openai` mode
  records usage in the runner (`OpenAINodeRunner.ts:82`) *and* in
  `executeNode` (`nodeRuntime.ts:106`). Fix before analytics trends.
- Reset leaves orphaned artifact blobs (`BlobExecutionRepository.ts:38-48`
  re-persists without deleting stale `artifacts/*` keys).

## 4b. Product-entity gaps (from the expanded product brief)

The product model names entities and encodings the backend cannot express
yet. The UI treats each as progressive disclosure of *real* data only — no
fake entities, no unexplained placeholders:

- **Missions** and **Roles/teams**: no backend representation. Nearest
  substrate: `node.kind` (free-form string) could seed role/grouping display;
  missions have nothing. Grouping-by-kind is a UI projection until a real
  model exists.
- **Policies** as an entity: policy behavior exists (tool policy resolution,
  skill policies, canonical-node guards) but there is no queryable policy
  object; the modal ▸ Permissions section is read-mostly.
- **Approvals** as an entity: only `approvalsRequired` entries on runs plus
  the hardcoded `publication_controller` block; no approval records,
  grant/deny path, or latency data.
- **Evaluation**: review-stage nodes exist in the canonical graph, but no
  evaluation results/relationship data is modeled; modal ▸ Evaluation is a
  placeholder.
  > **Status update (platform Phase 3, implemented):** first-class evaluation now
  > exists — versioned per-node `EvalRubric`s, append-only `EvalResult`s (criterion
  > scores + evidence + subject provenance), pairwise comparisons with both-ordering
  > position-bias control, and `FeedbackRecord`s (approve/reject/edit-diff/outcome),
  > exposed via the `evaluation.*`/`feedback.*` MCP tools and stored through
  > Evaluation/Improvement repositories on all backends. The Evaluation UI section
  > can consume `evaluation.list_results`. Experiments/A-B exist as optimizer
  > proposals + replay trials (`optimizer.*`). See `docs/improvement/STRATEGY.md`.
- **Per-edge activity metrics**: Operate-mode connector-thickness encoding
  needs interaction counts per relationship; nothing records per-edge
  activity today (usage is per node/run/model/project). Requires backend
  aggregation before the encoding ships.
- **Memory**: surfaced memory is limited to global learning observations and
  unenforced skill memory-policy declarations; no per-node/namespace memory
  reads.
- **Change "why" and risk**: events carry a free-form `summary` and nodes a
  `riskLevel`, but changes have no structured reason or per-change risk
  classification; the Changes ledger derives risk from the touched node's
  riskLevel until the backend stamps it.

## 5. Project scoping gap

The product model implies per-project constellations, but the workspace
document is a single global graph; only runs and usage are project-scoped.
The project registry (`project.list`) carries safe connection metadata for
external MCPs, not workspace ownership. Decision for v1: the selector scopes
Runs/usage/run-creation and the Constellation shows a shared-workspace badge.
True multi-workspace support (per-project documents, keyed blob storage,
selector-driven workspace switching) is a backend project deferred past this
redesign; the UI must not fake it.

## 6. Storage and observability gaps

- **`WORKSPACE_STORE=json` is not persistent**: `RepositoryManager` routes
  everything except `blobs` to the in-memory implementations
  (`RepositoryManager.ts:62-79`); the file-backed `JsonWorkspaceStore`
  (`store.ts:279-306`) is never instantiated, and the README's promised
  `NODE_ENV=production` fail-fast for json does not exist in `src/`. README
  §"Workspace MCP storage" overstates the json backend. **[pre-shell: fix the
  docs or wire the store — Settings ▸ Storage must not lie.]**
- **`repository.get_health` is cosmetic**: `readable`/`writable` are
  hardcoded `true` (`RepositoryHealth.ts:12-17`), so `storageHealth` can never
  be `"degraded"` and the Overview's degraded-storage attention item can never
  fire. Real probes (round-trip read/write) or honest relabeling required.
  Project repo health is also excluded from the aggregate
  (`RepositoryManager.ts:92-101`).
- **Lost-update race**: `mutate()` is load→check→save with no CAS/etag on the
  blob backend (`store.ts:211-221`, `BlobWorkspaceRepository.ts:11-24`); two
  concurrent Lambda writers both pass the optimistic check and the last write
  wins, silently discarding versions. Matters more once the UI makes
  mutations routine.
  > **Status update (platform Phase 2, implemented):** closed at the store layer.
  > `BlobWorkspaceRepository.save` is now conditional on the last-accepted ETag
  > (losers get `workspace_version_conflict`; seeding is create-only), and run saves
  > already carried revision+ETag CAS. On the **GCS backend** (`WORKSPACE_STORE=gcs`,
  > `docs/platform/PHASE2_RUNBOOK.md`) ETags are always present (object generations)
  > and reads are strongly consistent, making the CAS deterministic; on Netlify Blobs
  > the same code degrades to the historical behavior only where the environment
  > exposes no ETags. Race tests: `tests/agent/gcsBackend.test.ts`.
- **Learning blob dead branch**: observations are written into the workspace
  document, but `BlobLearningRepository.listObservations` scans a `learning/`
  prefix nothing writes (`BlobLearningRepository.ts:12-21`).
- `BlobUsageRepository.clear()` throws (blobs) — any "clear usage" affordance
  must be memory-only or removed.
- `usage.record` persists free-form `metadata` without running the
  observability sanitizer (`modelUsage.ts:44` vs
  `consoleObservability.ts:3-5`) — the tool description promises "no secrets"
  but nothing enforces it. Sanitize at the tool boundary. **[pre-shell]**
- OpenAI runner injects **all** learning observations into every prompt
  (`OpenAINodeRunner.ts:65,69`), ignoring skill memory-policy namespaces;
  `retention` on `SkillMemoryPolicy` is never enforced.
  > **Status update (platform Phase 3, implemented):** the runner now injects the
  > node's curated ACE playbook (deduplicated, budgeted, per-node — `playbook.*`
  > tools) instead of global observations. `learning.*` tools and storage are
  > untouched; `playbook.migrate_observations` curates legacy observations that
  > carry `metadata.nodeId`. `SkillMemoryPolicy.retention` remains unenforced.

## 7. UI-layer debt (beyond the credential bug)

- Raw-JSON textareas for schemas/metadata/modelConfig in `Inspector.tsx:49-57`
  — `JSON.parse` throws propagate as opaque errors; replaced by the modal's
  structured editors.
- `ui/src/mcpClient.ts` is a one-line re-export shim of `ui/src/mcp/client.ts`
  — delete during shell migration.
- Legacy raw-color CSS coexists with the semantic tokens introduced with the
  Overview; migrate per page, never mixing literals into new rules.
- The RJSF "Selected node form" preview submits nowhere by design; fold into
  the modal ▸ Schemas section.
- `App.tsx` accumulates ~20 handler closures and a global status banner; the
  shell migration moves per-page actions into pages and scopes status to a
  notification region.

## 8. Security constraints to preserve (non-negotiable in the redesign)

- The browser must never receive `MCP_API_TOKEN`, `AGENT_API_TOKEN`,
  `OPENAI_API_KEY`, or project endpoint/token values; the secure proxy
  overwrites the Authorization header server-side
  (`netlify/functions/workspace-mcp.mts:17`) and project views expose env-var
  *names* + configured booleans only (`projectTypes.ts:44-49`).
- Remote project errors stay sanitized (`projects/mcpClient.ts:96-98`);
  nothing in the new Changes/Runs surfaces may render raw remote error bodies.
- Publishing stays disabled end-to-end; the UI never adds an approval path
  the backend doesn't have.
