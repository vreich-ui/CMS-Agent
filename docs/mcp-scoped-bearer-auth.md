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
