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
`CMS_AGENT_MCP_ENDPOINT` and secret/function-only `CMS_AGENT_MCP_TOKEN`, then genesis verifies an
`initialize` call before retiring the preceding managed digest.

Existing registered tenants use `npm run job:reconcile-site-credentials` for a safe plan and add
`-- --apply` to rotate/install/verify them. The report contains only project ids, Netlify site names,
statuses, and catalogued error codes. A custom-domain project whose registry endpoint does not end
in `.netlify.app` needs a non-secret `CMS_AGENT_SITE_BINDINGS_JSON` mapping from project id to
Netlify site name; token values are never accepted as arguments.

The legacy JSON may still be attached with merge-style `--update-secrets`; never put bearer values
in `--update-env-vars` and never use `--set-*` on an existing service.
