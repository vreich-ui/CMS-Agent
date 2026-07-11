# Constellation redesign — test strategy

## Current state (audited)

- Single root `vitest run` with **no vitest config file** — node environment,
  no jsdom, no React plugin, no setup files. Root `tsconfig.json` includes
  `src/**`, `netlify/functions/**`, `tests/**/*.test.ts` only; `ui/src` enters
  compilation transitively through test imports.
- 30 test files, 194 tests. Backend coverage is solid in two styles:
  pure-unit against `src/**` exports, and handler-level integration driving
  the Netlify function modules with synthetic events (auth, JSON-RPC
  envelopes, node/project/skill tools, blob persistence and consistency
  fallback, tool-runtime policy including SSRF/path-traversal/redaction).
- UI coverage is limited to three framework-free modules
  (`accessState`, `workspaceOrder`, `overview`) imported from `tests/ui/*` by
  relative path **with a `.js` extension** (NodeNext resolves it to the `.ts`
  source). Implicit rule: anything root vitest tests must import nothing from
  `react`/`@rjsf`/`@xyflow`. All hooks and all components are untestable
  under the current setup.

## Known gaps (ranked by redesign impact)

1. **Credential lifecycle** — zero tests; the bug in `data-model-gaps.md` §1
   shipped invisibly. The UI MCP client (`ui/src/mcp/client.ts`) has five
   distinct throw paths and no tests at all.
2. **Optimistic concurrency** — `expectedWorkspaceVersion` /
   `workspace_version_conflict` (`store.ts:193`) has no test on either side;
   the one prompt-update handler test omits the field entirely.
3. **Graph validation failure branches** — `validateWorkspaceGraph` is tested
   only on the happy path; duplicates, cycles, dangling deps, canonical-node
   rules, and the store's `assertGraphValid` schema/canonical gates are all
   uncovered — exactly what Design mode will exercise.
4. **React components/hooks** — no DOM tests; no toolchain for them.
5. **History/Changes tools** — don't exist yet (S1); must arrive with
   handler-level tests.

## Target test architecture

Three layers, matching how the code is split:

1. **Framework-free model modules (root vitest, node env)** — keep and grow
   the existing convention. Every page gets a pure model module like
   `ui/src/overview.ts` (e.g. `constellationModel.ts`: node-summary
   projection, edge derivation, layout guards; `changesModel.ts`: event
   filtering/diff pairing; `runsModel.ts`: ledger grouping). Tests import via
   the established `../../ui/src/<module>.js` path convention. This is where
   most redesign logic should live anyway — the constraint is a feature.
2. **UI hooks/components (ui-scoped vitest project)** — add `vitest` +
   `jsdom` + `@testing-library/react` to `ui/` with its own
   `ui/vitest.config.ts` (jsdom env, React plugin), wired as
   `npm --prefix ui test` and a root `test:ui` script. Keeping it ui-scoped
   avoids forcing jsdom/React tooling into the root project whose tsconfig
   deliberately excludes `ui/src`. Lands in S2 (app shell) — the first
   session that adds nontrivial component logic.
3. **Handler-level backend tests (existing style)** — new S1 tools
   (`workspace.list_events`, `get_version`, `restore_node_version`, runs
   pagination) get the same synthetic-event treatment as
   `tests/agent/mcp/*.test.ts`.

End-to-end browser drives (Playwright against `netlify dev` + Vite, as used
to verify the Overview and reproduce the credential bug) remain a manual
verification harness per session, not CI — scripts live outside the repo.

## Credential lifecycle regression coverage (S0 gate) — shipped

Implemented in `tests/ui/credentialLifecycle.test.ts` (initial token entry,
replacement, clearing, endpoint changes including the deployed-path
regression, mode switches both directions, stale-closure capture, per-request
secure-proxy token resolution, and redaction of echoed credentials) and
`tests/ui/connection.test.ts` (union/auth-state modeling, endpoint defaults,
redaction helpers). The original proposal below is retained for context;
items 1–2 and 5 are covered as written, item 3 is enforced structurally
(ConnectionPanel consumes the shared client, so a divergent config can no
longer exist), and item 4 is subsumed by call-time credential resolution
(a stale closure can no longer pin a credential, so no epoch mechanism is
needed).

1. **Extract and unit-test config derivation.** Pull the config construction
   out of `App.tsx:58-61` into a framework-free
   `ui/src/connection.ts` — `deriveMcpConfig({endpoint, manualToken,
   identityToken, mode})` — and test at root: direct mode uses the manual
   token with `requiresToken: true`; secure-proxy mode uses the identity
   token with `requiresToken: false`; a manual token is never silently
   dropped without the mode saying so; endpoint string changes alone never
   change which credential is used once mode is explicit.
2. **UI MCP client header contract.** With `fetch` stubbed (framework-free):
   `callMcpMethod` sends `Authorization: Bearer <token>` when configured;
   prefers `authToken` over `token`; throws the "Enter an MCP bearer token"
   error only when `requiresToken !== false` and no credential exists; and
   the five error paths (missing token, HTTP error, non-JSON, JSON-RPC
   error, missing result) each produce a distinct `McpClientError`.
3. **Single-config invariant.** After S0, `useConnection` consumes the shared
   store; a hook test (layer 2) renders ConnectionPanel and the app shell
   with the same store and asserts both issue requests with identical
   Authorization headers for identical state — the divergence captured in the
   audit repro becomes a failing test.
4. **Retry-on-credential-arrival.** Hook test: initial load fails with no
   token; setting the credential bumps the connection epoch; the
   mount-triggered loads re-run. (Guards against the `WorkflowControls.tsx:18`
   / `NodeConsole.tsx:74` stale-closure family.)
5. **Identity token freshness.** Unit test on the connection store: the
   identity credential is obtained via a lazily invoked getter per request
   (mock `user.jwt()`), not a value captured at login.

## Concurrency and graph gates (S3/S4)

- Handler tests: mutation with stale `expectedWorkspaceVersion` returns
  `workspace_version_conflict: expected X, current Y`; omitted field means
  last-write-wins (documenting current semantics); meta-less mutation paths
  rejected once D2 lands.
- Model tests for the modal's conflict flow: conflict → reload → reapply
  preserves the user's draft.
- `validateWorkspaceGraph` failure matrix: duplicate ids, unknown
  risk/status, dangling `dependsOn`, cycle (assert the reported path),
  missing `article_body`, contract-chain rules, canonical-node removal with
  and without `allowCanonicalNodeRemoval && adminApproved`.

## History/Changes gates (S1/S6)

- Handler tests: events are append-only (mutation after restore adds, never
  rewrites); actor is server-stamped and caller-supplied actor strings cannot
  spoof `kind`; pagination cursors are stable under concurrent appends;
  restore produces a new version whose nodes equal the historical snapshot.
- Model tests: diff pairing (version N vs N-1), no-op event filtering,
  ledger filters (node, actor kind, time range).

## Per-session gates summary

| Session | Must-pass additions |
|---|---|
| S0 | Credential suite 1–5 above — **shipped** |
| S1 | History/pagination handler tests; meta-required enforcement; sanitizer on `usage.record` metadata |
| S2 | ui-scoped vitest project bootstrapped; shell nav + project-selector hook tests (search filtering, context preservation); a11y smoke (landmarks, nav semantics); **theme-system tests: contrast validation over every text/surface token pair (light + dark + presets), mode-switch persistence** |
| S3 | Graph model tests (summary projection, edge derivation, **relationship-kind filtering**); validation failure matrix; position-update guard tests; **position stability across mode switches** |
| S4 | Modal section save/conflict tests; schema editor validation tests; **gap-backed sections render honest placeholders, never fake controls** |
| S5 | Runs ledger model tests; pagination contract tests; pause vs approval-block rendering test; **encoding-scale model tests (metric→size mapping bounded and labeled; no color-only signals)** |
| S6 | History/Changes suite above; **attention items render their evidence and deep-link to it; human vs agent actor filters** |
| S7 | Token-only CSS lint (no raw color literals in new files); dead-shim removal doesn't break imports |

Every session also keeps the standing gates: `npm run typecheck`, `npm test`,
`npm run ui:build`.
