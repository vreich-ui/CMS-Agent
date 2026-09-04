# Scoped MCP bearer tokens

`MCP_API_TOKEN` is the existing unscoped break-glass bearer path and OAuth-issued access tokens
remain unchanged. Client-site scoped credentials are genesis-managed: the bearer is minted inside
CMS-Agent, only its SHA-256 digest and policy are persisted in the durable workspace store, and the
raw value is sent directly to the site's Netlify secret environment. It is never returned through
MCP, printed, committed, or copied by an operator.

`MCP_SCOPED_TOKENS_JSON` remains a deployment-time compatibility source for sites not yet migrated.
Once the managed registry contains a credential for a project, static-map bearers for that project
are automatically superseded. This makes a reconciler rotation effective without hand-editing the
shared JSON or forcing another Cloud Run revision.

Its secret value is a JSON object mapping each opaque bearer token to its policy:

```json
{
  "scoped-example-platform": {
    "projects": ["platform"],
    "toolAllowlist": ["agent_resolve", "agent_converse"]
  }
}
```

This example is synthetic. Do not place real bearer values in source control, manifests, test
fixtures, logs, responses, or schemas.

`projects` must be a non-empty, duplicate-free list of registered lowercase-kebab project ids.
`toolAllowlist` must be a non-empty, duplicate-free list of canonical underscore tool names as
reported by `tools/list`; aliases are rejected. Every policy object has exactly those two fields.
An empty/unset variable disables scoped bearer support. Malformed configuration, duplicate entries,
or a scoped token that collides with `MCP_API_TOKEN` makes Cloud Run fail startup; the Netlify path
fails closed without returning parser detail.

Authentication precedence is deterministic: exact `MCP_API_TOKEN` first, then an exact managed
scoped bearer, then a non-superseded static scoped bearer, then OAuth access-token verification.
The break-glass and OAuth paths receive the existing unscoped catalog and behavior unchanged.

For a scoped caller, `initialize` remains available after authentication and `tools/list` exposes
only the policy's allowed canonical tool names. `tools/call` is checked before tool dispatch: the
wire name must be allowed and any `projectId` or `project_id` argument must be in that token's
project list. Calls without a direct project argument are still denied unless explicitly listed in
`toolAllowlist`; operators should grant such cross-workspace tools only deliberately.
Other workspace-wide MCP discovery methods (`prompts/*`, `resources/*`) are unavailable to scoped
tokens so an allowlist intended for one site cannot bypass the tool channel.

Genesis requires `CMS_AGENT_PUBLIC_MCP_ENDPOINT` (the credential-free public `https://.../mcp`
URL) and `NETLIFY_API_TOKEN` in its service environment. A new site automatically receives
`CMS_AGENT_MCP_ENDPOINT` and a production-context, secret/function-only `CMS_AGENT_MCP_TOKEN`.
The new digest remains pending while genesis verifies an `initialize` call, so it cannot supersede
the preceding credential until verification succeeds. A failed install revokes the pending digest.

Existing registered tenants use `npm run job:reconcile-site-credentials` for a safe plan and add
`-- --apply` to rotate/install/verify them. The report contains only project ids, Netlify site names,
statuses, and catalogued error codes. Client sites are selected only through a durable, non-secret
genesis binding. For the existing fleet, `CMS_AGENT_SITE_BINDINGS_JSON` supplies an explicit one-time
project-id to Netlify-site-name backfill map; a successful apply persists the binding on each project
record. New genesis and clone runs persist the same binding at birth. Project status, bearer auth,
endpoint shape, and the public `project.create` API do not make a project a client site; internal
projects remain excluded and disabled client sites remain eligible. Token values are never accepted
as arguments.

An existing site's Functions keep the environment captured by their currently published deploy.
After installing and directly verifying a generated credential, reconciliation therefore schedules
a fresh production build through the authenticated Netlify API and waits until that exact deploy is
both `ready` and the site's `published_deploy`. Only then does it activate the new digest and retire
the preceding credential. If Netlify times out after accepting the site env write, the digest stays
pending rather than being revoked underneath a deploy that may still become live; the next
successful reconciliation replaces all older pending/active digests atomically.

The reconciler runs as the dedicated `site-credential-reconciler` Cloud Run Job configured by
`scripts/deploy-site-credential-reconciler.sh`. The job and public service receive the standing fleet
`NETLIFY_API_TOKEN` directly from Secret Manager as `netlify-api-token:latest`: the job needs it to
repair existing sites, while the service needs it for future live genesis/clone calls. The script
never executes the job automatically. Run it once without arguments, review the dry-run result, and
only then execute it with
`--args=--import,tsx,src/agent/entrypoints/reconcileSiteCredentialsMain.ts,--apply`. Cloud Run
replaces the configured argument list on an execution override, so passing only `--args=--apply`
would drop the TypeScript entrypoint. The existing-client binding map is non-secret; every minted
per-site bearer remains internal to CMS-Agent and the Netlify API call.

Before configuring either runtime, create `netlify-api-token` once and grant the named CMS-Agent
service account `roles/secretmanager.secretAccessor` on that secret. The deployment script requires
the runtime service account explicitly and checks that the secret exists, but it does not widen IAM.
After the first successful apply persists every existing binding, later job updates may omit
`CMS_AGENT_SITE_BINDINGS_JSON`; the script normalizes it to an empty object.

The legacy JSON may still be attached with merge-style `--update-secrets`; never put bearer values
in `--update-env-vars` and never use `--set-*` on an existing service.

## The narrow site-scoped tool family (`visual_identity_propose`)

A site bearer's `toolAllowlist` is `SITE_CLIENT_MANAGER_TOOLS` (`src/agent/capture/siteGenesis.ts`),
pinned by `docs/site-credential-scope-lock.json` (`npm run test:scope` / `npm run scope:update`).

Platform's `brand_imagery_propose` originally reached the brand-imagery writer through
`node_execute('brand_imagery_writer')`. That could never work and never did: `node_execute` is
workspace-**programming** scope — it takes a caller-supplied `nodeId`, runs any node in the store for
any project, and accepts `modelConfig` — so granting it to a tenant bearer would hand every tenant
the whole workspace. The credential refused the call, correctly, and the writer path sat dead in
production behind an opaque "CMS-Agent rejected the credential".

**Ruling R1 (2026-09-04): `node_execute` is never widened to a site token.** Instead there is one
narrow, site-scoped tool family, whose first member is `visual_identity_propose`
(`src/agent/mcp/workspace/visualIdentityTools.ts`). Any later member must copy its shape:

- **No caller-supplied node.** A `kind` selects from a fixed in-source map. The set of nodes a site
  bearer can reach is a compile-time constant a reviewer can read in one line. `pdf_template` is
  declared on the wire contract but absent from the map, so naming it is a named refusal
  (`visual_identity_kind_not_available`) rather than a surprise when E2 half-lands.
- **`project_id` is required and is the scoping key.** `mcpEndpoint.ts`'s `isScopedMessageAllowed`
  reads `projectId`/`project_id` off the call's arguments and refuses any scoped call naming a
  project outside the bearer's own `projects`. The tool also refuses unknown/disabled projects
  itself (`unknown_project`, `project_disabled`) for non-scoped callers.
- **No execution-mode lever.** `executionMode` is not on the wire, so the run is always live and a
  proposal on an approval card can never be a mock placeholder.
- **No writes to the client.** The writer node has `allowedTools: []` and creates, patches, applies
  and publishes nothing. Materializing and applying a standard stay where they were — a
  `visual_identity` run, then the owner-gated `site_apply_brand_imagery` verb. A call does still
  persist workspace bookkeeping, which "zero writes" read literally would deny: `executeNode` records
  an execution run (under projectId `workspace`, not the tenant's), a node timing, model usage, and the
  workspace-global stage output for `brand_imagery_writer`, which each call overwrites. No tool a site
  bearer holds can read any of that back.

### Shipping a change to this family

Adding the tool is three steps, and the third is the one that is always forgotten:

1. The tool module, wired into `createWorkspaceTools`.
2. The wire name in `SITE_CLIENT_MANAGER_TOOLS`, then `npm run scope:update` (and
   `npm run drift:update` when the wire catalog changes). `tests/agent/capture/siteClientManagerScope.test.ts`
   pins the constant against Platform's bridge calls — update `PLATFORM_BRIDGE_CALLS` in the same commit.
3. **A reconciler run with `--apply`.** Widening the constant only changes what NEW sites are minted
   with; every already-registered tenant keeps its old scope, and every call to the new tool 401s at
   the door, until `site-credential-reconciler` re-mints it.

If a deployment sets `MCP_EXPOSED_TOOL_PREFIXES`, it must include `visual_identity` — the exposure
filter keys on the namespace before the first dot, and an unlisted namespace is neither advertised
nor callable, which reads to the caller as an unknown tool.
