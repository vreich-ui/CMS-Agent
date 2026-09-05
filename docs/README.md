# docs/ — index and status of every document

Canonical, current documentation (maintained with the code; each fact has one home):

| Document | Scope |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System context, runtime topology, component relationships, source layout, invariants |
| [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) · [reference/DATA_ENTITIES.md](reference/DATA_ENTITIES.md) | Authority matrix, storage keys, ERD, concurrency, migration, retention; per-entity reference with JSON examples |
| [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md) | Agent types, dispatch lifecycle, workflows/stages, skills, tools, memory, learning (current vs future) |
| [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) · [reference/MCP_TOOLS.md](reference/MCP_TOOLS.md) | Transport, sessions, auth, catalog/namespaces, schema alignment; generated per-tool reference |
| [PUBLISHING_ARCHITECTURE.md](PUBLISHING_ARCHITECTURE.md) | Responsibility boundary, end-to-end trace, gates, store-flag modes, tenant client, Dr. Lurie specifics |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Cloud Run service/jobs, Netlify, CI, release path, environment variable table, health checks, local dev |
| [SECURITY.md](SECURITY.md) | Trust boundaries, credentials, authorization gaps, dangerous operations, input validation |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Signals that exist, what does not, correlation ids, debugging recipes |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Confirmed defects, suspected risks, infrastructure/test gaps, documentation contradictions |
| [GLOSSARY.md](GLOSSARY.md) | Terminology as used in code, with legacy meanings flagged |
| [AI_CONTEXT.md](AI_CONTEXT.md) | Compact briefing for coding agents |

Generated / CI-locked artifacts (never hand-edit): `mcp-tool-manifest.json` (`npm run drift:update`), `ui-glossary.md` (`npm run glossary:update`), `engine-objects.md` + `generated/` (`npm run objects:update`), `site-credential-scope-lock.json` (`npm run scope:update`), `reference/MCP_TOOLS.md` (`npx tsx scripts/generateMcpToolReference.ts`).

## Status of the older documents

Verdicts from the 2026-09-05 documentation audit: **CURRENT** (still authoritative for its subject), **RUNBOOK** (commands an operator may still copy, with noted caveats), **HISTORICAL** (dated plan/log/finding; kept for the decision record, superseded by the canonical docs above; a banner marks it), **MIXED** (partly current — read the banner). Files are kept at their paths because code comments link to them.

| Path | Verdict | Notes |
|---|---|---|
| `SESSION_HANDOFF.md` | HISTORICAL (2026-07-27) | Blobs-era; "protection rings" idea lives on in ARCHITECTURE.md §7 |
| `architecture/repositories.md` | MIXED | Canonical-vs-operational and change-history sections still true; "Future JSON/Blobs" section describes dead/retired code |
| `architecture/mcp-authorization-and-sessions.md` | MIXED | Flow is current, wording is Netlify-era (`/api/mcp`, Blobs); Cloud Run and `gcs` semantics in MCP_ARCHITECTURE.md |
| `mcp-scoped-bearer-auth.md` | CURRENT | Add: managed registry key `auth/managed-scoped-bearers.v1.json` (see DATA_ARCHITECTURE.md) |
| `engine-objects.md`, `ui-glossary.md`, `generated/*` | CURRENT (generated) | |
| `platform/DIRECTION.md` | HISTORICAL (decision record, phases 1–8 shipped) | "Dual control plane / UI switch / Netlify not retired" framing was reversed in August 2026; `WORKSPACE_NODES_SOURCE` default is `store` |
| `platform/CONTINUATION_TICK.md` | RUNBOOK | Still the tick's deploy recipe; add `TASK_TIMEOUT_MS` when setting `--task-timeout` (KNOWN_ISSUES C-11) |
| `platform/PHASE1_RUNBOOK.md` | MIXED | `WORKSPACE_NODES_SOURCE` + re-seed section and the conductor job's config/exit-code tables are current; `gcloud` commands are Blobs-era; `--approved` is not publish authority |
| `platform/PHASE2_RUNBOOK.md` | HISTORICAL | Blobs→GCS cutover executed; GCS design rationale still true |
| `platform/PHASE4_RUNBOOK.md` | MIXED | Deploy/CORS/`--set-env-vars`/`verify:deploy` sections current (superseded in detail by `scripts/deploy-mcp.sh` + DEPLOYMENT.md); "UI switch" and "coexistence" sections obsolete |
| `improvement/STRATEGY.md` | HISTORICAL (July 2026 research) | Implemented subset described in AGENT_ARCHITECTURE.md §7–8 |
| `projects/dr-lurie-integration-notes.md` | HISTORICAL | Fully superseded by PUBLISHING_ARCHITECTURE.md §5 and the policy doc |
| `projects/dr-lurie-agent-publishing-policy.md` | CURRENT (tenant-side contract) | §8.2 (`approved:true` as authority) is stale — see PUBLISHING_ARCHITECTURE.md §2.1 |
| `plan/ADR-2026-08-25-publish-autonomy.md`, `plan/ADR-2026-08-25-structure-studio.md` | CURRENT (ADRs) | |
| `plan/CAPTURE-CLONE-SPEC.md` | CURRENT with two stale rows | four workflows, not three; `publish.mjs` was deleted (T15.7) |
| `plan/W8-ARTIFACT-MATERIALIZER-SPEC.md` | CURRENT | |
| `plan/PUBLISH-SMOKE.md` | RUNBOOK | approval is `workflow_set_operator_publish_decision`; release evidence comes from `release_executor` |
| `plan/RETIREMENT.md`, `plan/TRACK-A-RUNBOOK.md` | CURRENT (pending decisions, not executed) | |
| `plan/HANDOFF.md` | HISTORICAL (2026-08-12) | Gates G1–G6 and standing habits remain good practice |
| `plan/CHANGE-PLAN.md`, `plan/WORK-ORDER-2026-08-12-determinism.md`, `plan/SESSION-BRIEF.md`, `plan/GUI-PLAN.md`, `plan/TEST-PROTOCOL.md`, `plan/T15-LIVE-ACCEPTANCE.md`, `plan/brand-imagery-node-ops.md` | HISTORICAL | dated work orders / protocols |
| `plan/findings/*.md` (10) | HISTORICAL | `self-describing-engine.md` and `determinism-regression-envelope.md` carry principles still applied in code |
| `constellation/*.md` (5) | HISTORICAL | UI specs for the root `ui/` app, which `workbench/docs/RETIREMENT.md` designates as the old UI |

Obsolete terms you will still meet in those files (and what they mean now): *Netlify Blobs store* → GCS; `/api/workspace-mcp` / *Identity secure proxy* → deleted, SPAs call Cloud Run; `/api/agent` → legacy scaffold; `learning/{observationId}.json` → observations inside `workspace/current.json`; *18-node graph* → 25 canonical nodes; `WORKSPACE_STORE=blobs` → `gcs`; *scheduled function* → Cloud Run job; `src/agent/workflows` → `src/agent/workspace/`.
