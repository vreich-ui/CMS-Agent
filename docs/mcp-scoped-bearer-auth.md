# Scoped MCP bearer tokens

`MCP_API_TOKEN` is the existing unscoped legacy bearer path and remains unchanged. OAuth-issued
access tokens also remain unchanged. Scoped bearer support is opt-in through the secret-backed
`MCP_SCOPED_TOKENS_JSON` environment variable.

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

Authentication precedence is deterministic: exact `MCP_API_TOKEN` first, then an exact scoped
bearer token, then OAuth access-token verification. The legacy and OAuth paths receive the existing
unscoped catalog and behavior unchanged.

For a scoped caller, `initialize` remains available after authentication and `tools/list` exposes
only the policy's allowed canonical tool names. `tools/call` is checked before tool dispatch: the
wire name must be allowed and any `projectId` or `project_id` argument must be in that token's
project list. Calls without a direct project argument are still denied unless explicitly listed in
`toolAllowlist`; operators should grant such cross-workspace tools only deliberately.
Other workspace-wide MCP discovery methods (`prompts/*`, `resources/*`) are unavailable to scoped
tokens so an allowlist intended for one site cannot bypass the tool channel.

Deploy the JSON as a single Secret Manager secret and attach it with merge-style
`--update-secrets`; never put bearer values in `--update-env-vars` and never use `--set-*` on an
existing service. `MCP_SCOPED_MCP_TOKEN` and `MCP_SCOPED_PROJECT_ID` may be supplied only in the
operator's shell to let `npm run verify:deploy` exercise a scoped `agent_resolve` call.
