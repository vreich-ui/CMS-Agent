# CMS-Agent — Session Handoff

_Handoff for a fresh session. Repo: `vreich-ui/CMS-Agent`. Work branch:
`claude/mcp-node-auth-browser-redirect-tgi19z`. `main` HEAD after this session: `fa4398d` (PR #45)._

---

## 1. TL;DR

Over this session, the workspace MCP was taken from "tool RPC that Claude couldn't even connect to"
to a hardened, connectable, project-agnostic control server (8 PRs, #38–#45, all merged). The last
exchange opened a **larger architectural decision that is NOT yet started** — a two-plane split
(control vs execution), per-project credential storage, project-scoped data, and wiping the
`/api/workspace-mcp` proxy. **That decision is the main open item. Read §5 first if you're here to
continue the work.**

There is one pending question the user must answer before building §5: **encrypted vs plaintext
credential storage** (see §5.4).

---

## 2. What shipped this session (all merged to `main`)

| PR | SHA | What |
|----|-----|------|
| #38 | — | MCP OAuth 2.1 authorization server (RFC 9728/8414 discovery, DCR, PKCE, consent screen) + Streamable-HTTP session control (`Mcp-Session-Id`) + `netlify.toml` routes ahead of the SPA catch-all. Fixes "Claude opens the dashboard, can't finish auth." |
| #39 | — | OAuth/session state auto-persists in Netlify Blobs (decoupled from `WORKSPACE_STORE`). Fixes `invalid_client` (register/authorize hit different stateless invocations). |
| #40 | — | Anthropic-safe tool names: `tools/list` serves underscore names (`workspace_get_nodes`); `tools/call` accepts dotted + underscore. Fixes claude.ai `tools.92` pattern rejection. Adds `ping`. |
| #41 | — | Agentic project registration: `project.create/update/delete` + `project.get_registration_contract`. Secrets accepted only as env-var NAMES; publishing policy server-forced. |
| #42 | — | Fix `workspace.create_node` crash on minimal nodes (`normalizeNode` defaults all collection/scalar fields). |
| #43 | — | Node-write validation (`coerceNodeInput`, `assertPersistableNode` in `mutate`) + self-healing tolerant document load (`parseWorkspaceDocumentTolerant`). Recovered a workspace bricked during live testing. |
| #44 | `e5be08c` | Architecture decoupling: generic `ProjectMcpAdapter` moved out of `drLurie/` → `projectMcpAdapter.ts`; seed list → `defaultProjects.ts`; seed graph neutralized; `MCP_EXPOSED_TOOL_PREFIXES` catalog scoping; **4 audit follow-ups** — per-project hooks (`projectHooks.ts`), tool aliases (`DEPRECATED_TOOL_ALIASES`), heal observability (`health.details.healedDroppedNodes`), `registry.ts`→`agentProfiles.ts`. |
| #45 | `fa4398d` | `coerceJsonObjectInput` on `project.validate_handoff` + `article_body.validate` (MCP clients stringify object args). |

Test suite: **389 passing**, typecheck clean. Root tests: `npm test` (vitest). UI tests: `npm run test:ui`.
Note `npm install` needs `--ignore-scripts` here (netlify-cli's `sharp` build 403s through the proxy);
`ui` deps must also be installed for a clean root typecheck (`tests/ui/*` import `ui/src`).

---

## 3. Live production state (verified via the connector)

- Deploy is on Netlify Blobs, all 7 repositories healthy, workspace at v9.
- Workspace **recovered** from the #43 corruption: `workspace.get_nodes` returns the 18 seed nodes.
- Project registry: **`dr-lurie` only** (the `acme-daily` live-test project was created then deleted).
- Catalog: **102 tools** exposed (105 minus 3 unlisted aliases).
- `MCP_OAUTH_APPROVAL_SECRET` and `WORKSPACE_STORE=blobs` are set in prod (OAuth + Blobs both work).
- `DR_LURIE_MCP_ENDPOINT` / `DR_LURIE_MCP_TOKEN` are set (dr-lurie `endpointConfigured/tokenConfigured: true`).

---

## 4. Architecture as it stands ("MCP" plays 3 roles)

1. **The app's own MCP server** — `publishing-workspace-mcp` (`src/agent/mcp/workspace/server.ts`),
   ~102 tools over a **single global workspace**. Two HTTP doors, same handler/catalog:
   - `/api/mcp` (`netlify/functions/mcp.mts`) — bearer OR OAuth. What Claude connects to.
   - `/api/workspace-mcp` (`netlify/functions/workspace-mcp.mts`) — Netlify Identity proxy → same
     handler. Redundant since OAuth (#38). **User wants this wiped.**
2. **External MCP servers it calls (as a client)** — registered `ProjectConnectionConfig`s reached via
   `project.call_tool`, gated by an `allowedTools` allow-list. Only **Dr. Lurie** by default (separate
   deployment, not in this repo).
3. **Agent-SDK hosted MCP (`/api/agent` runtime)** — **a FACADE.** `runAgent` calls local skill
   functions directly and never reads `agent.mcpServers`; `buildMcpServers` output is dead. NOTE: the
   OpenAI Agents SDK *is* used elsewhere and works — `src/agent/execution/runners/OpenAINodeRunner.ts`
   builds a real `Agent`+`run()` per workspace node (internal controlled tools, not project MCPs).

**Data storage is global, not per-project.** Blob keys are flat: `workspace/current.json` (ONE shared
workspace), `runs/`, `usage/`, `changes/`, `revisions/`, `artifacts/`, `projects/<id>.json` (project
*config* only). `RepositoryContext.projectId` exists but is **ignored** — no scoping anywhere.

**Credentials never persist today.** `ProjectConnectionConfig` stores env-var *names*;
`resolveProjectConnection` reads values from `process.env` at request time. Nothing writes a token to a
blob. Redaction is wired throughout.

---

## 5. THE OPEN DECISION — two-plane architecture (NOT STARTED)

The user's last message gave four directives + one strategy question. My assessment and recommendation:

**Recommended shape: split control plane from execution plane.**

| Plane | Endpoint | Purpose | Connects |
|-------|----------|---------|----------|
| **Control** | `/api/mcp` (workspace MCP) | Author the constellation, register projects, manage credentials, inspect history | Claude / human |
| **Execution** | `/api/agent` (Agent-SDK runtime) | Per-`projectId` agent connects to *that project's own MCP* as a hosted server — passthrough creds, **full R/W, client owns permissions**, per-project data + memory | The runtime |

**Answer to "is Agent-SDK-hosted-MCP-per-project a better strategy?"** → **Yes**, for *running* projects
that is the right model and it's what the user's other three asks describe. Caveat: `/api/agent` is a
stub, so this is *build*, not switch. It matches the README's stated long-term flow
("user auth → project selection → passthrough credentials → project MCP") and AGENTS.md. The current
`project.call_tool` proxy-with-allow-list is the interim shim, and the allow-list is exactly the thing
the user says should be the client MCP's job.

### 5.1 Wipe `/api/workspace-mcp`
Redundant post-OAuth. Dependency chain to cut: the function + `netlify.toml` redirect; UI **secure-proxy**
mode (`ui/src/App.tsx` `DEFAULT_MODE = isDeployedMode ? "secure-proxy" : "direct"`,
`ui/src/connection.ts`, `ConnectionPanel.tsx`, `useIdentitySession.ts`); `/api/session` +
`src/agent/runtime/adminSession.ts`. Deployed UI must move to OAuth or manual-token against `/api/mcp`.

### 5.2 Project-scoped data storage (build it)
Thread `projectId` through `RepositoryManager`; namespace blobs `projects/<id>/workspace/current.json`,
`projects/<id>/runs/...`, etc. Seam already exists (`RepositoryContext.projectId`) — just unused.

### 5.3 Full R/W, client decides permissions
Drop/soften the `allowedTools` gate in `ProjectMcpAdapter.callTool` (`src/agent/projects/projectMcpAdapter.ts`);
forward all calls and let the client MCP authorize.

### 5.4 ⚠️ PENDING USER DECISION — credential storage
User wants project credentials "saved locally in project blobs." **Netlify Blobs are not encrypted at
rest by the app** — raw tokens in `projects/<id>.json` is a security downgrade (the whole env-name +
redaction design exists to prevent it). Options put to the user, awaiting answer:
- **(a) Encrypted vault** — AES-GCM, key from an env secret (e.g. `MCP_SECRET_KEY`); blob holds
  ciphertext. **Recommended.**
- **(b) Plaintext** in blobs — simpler, secrets at rest.
`resolveProjectConnection` would then read vault-first, env-fallback.

### Proposed sequence (one isolated PR each, after the user confirms direction + 5.4)
1. Wipe `/api/workspace-mcp` + Identity plumbing → single OAuth'd `/api/mcp`.
2. Project-scoped storage (thread `projectId`; namespace blobs).
3. Per-project credential vault (per 5.4) + full R/W (drop allow-list).
4. Real `/api/agent` execution plane — wire Agents SDK to connect each project's stored MCP as a hosted
   server with passthrough creds + per-project memory.

**Do not** turn the workspace MCP into the per-project execution engine — mixing planes is why
credentials/permissions/storage feel awkward now.

---

## 6. Key files

- MCP transport/handler: `netlify/functions/mcp.mts`, `src/agent/mcp/workspace/server.ts`
- Tools (102): `src/agent/mcp/workspace/tools.ts`; helpers `toolKit.ts`; changes/constellation tool modules
- OAuth: `src/agent/mcp/auth/*` (metadata, pkce, oauthService, consent, wwwAuthenticate); handlers `netlify/functions/oauth-*.mts`
- Sessions: `src/agent/mcp/transport/session.ts`; state store `src/agent/mcp/state/stateStore.ts`
- Workspace store (self-heal, node validation): `src/agent/mcp/workspace/store.ts`
- Repositories: `src/agent/repository/**` (memory + blobs); manager `RepositoryManager.ts`; facade `src/agent/runtime/repositories.ts`
- Projects: `projectMcpAdapter.ts` (generic), `projectRegistry.ts`, `projectAdmin.ts`, `projectHooks.ts`, `defaultProjects.ts`, `agentProfiles.ts`, `drLurie/*`
- Agent runtime (facade): `src/agent/runtime/{runAgent,createAgent}.ts`, `src/agent/mcp/buildMcpServers.ts`
- Real SDK usage: `src/agent/execution/runners/OpenAINodeRunner.ts`
- UI connection: `ui/src/connection.ts`, `ui/src/App.tsx`, `ui/src/hooks/useIdentitySession.ts`
- Docs: `docs/architecture/mcp-authorization-and-sessions.md` (the canonical write-up), `README.md`, `AGENTS.md`, `PRODUCT_VISION.md`

---

## 7. Environment variables

Required: `OPENAI_API_KEY`, `OPENAI_AGENT_MODEL`, `AGENT_API_TOKEN`, `MCP_API_TOKEN`, `ADMIN_EMAIL_IDS`,
`WORKSPACE_STORE=blobs` (prod), `DR_LURIE_MCP_ENDPOINT`, `DR_LURIE_MCP_TOKEN`.
Added this session (all optional): `MCP_OAUTH_APPROVAL_SECRET` (consent secret; falls back to
`MCP_API_TOKEN`), `MCP_REQUIRE_SESSION` (default false), `MCP_STATE_STORE` (auto→blobs on Netlify),
`MCP_EXPOSED_TOOL_PREFIXES` (catalog scoping). Also: `NETLIFY_BLOBS_STORE_NAME` (default `cms-agent`),
`TOOL_BLOB_PREFIXES` (default `agent-tools/`).

---

## 8. Gotchas / operational notes

- **MCP clients stringify nested object args.** claude.ai delivered `node`/`articleBody` as JSON
  strings — this caused the #43 corruption. Any NEW tool taking an object param MUST run it through
  `coerceNodeInput`/`coerceJsonObjectInput`, and `mutate()` validates every node before save.
- **Controlled `blob.*` tools are locked to the `agent-tools/` prefix** — they cannot touch
  `workspace/current.json`. That's why the bricked workspace needed a code-level self-heal, not a tool.
- **Connector flaps.** The `mcp__CMS-Agent__*` tools disconnect/reconnect every few minutes. Use
  `SearchMcpRegistry(["CMS-Agent"])` to read `connected` / `enabledInChat` / `tools:[]` state; `tools:[]`
  while connected means the deploy is mid-settle. Load tools via `ToolSearch "select:mcp__CMS-Agent__..."`.
- **Direct `curl` to the site is blocked** by the sandbox egress proxy (403). The connector is the only
  live path from here.
- **Tool names:** internal dotted (`workspace.get_nodes`); wire serves underscore; `tools/call` takes both.
- **New session = fresh clone.** For this handoff to reach the next session, commit it to the branch or
  paste it in. Scratchpad does not survive.
- **PR flow:** open draft PRs; user says "merge"; the harness auto-subscribes + auto-unsubscribes on
  merge. Merge method used all session: `merge` (matches repo history). Co-author trailer + Claude-Session
  line go on commits (not the model id).

---

## 9. Immediate next action for the continuing session

1. Confirm the **two-plane direction** and the **§5.4 credential-encryption choice** with the user
   before writing code — those gate everything else.
2. If confirmed, start with **§5-step 1** (wipe `/api/workspace-mcp` + Identity plumbing; repoint UI).
3. If the user instead wants the literal directives bolted onto the current workspace MCP (no split),
   flag that it fights the architecture but proceed as directed.
