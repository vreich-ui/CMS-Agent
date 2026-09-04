# CMS-Agent

Read `AGENTS.md` first. It is the contract; this file is only the short version.

- GitHub `vreich-ui/CMS-Agent`. Netlify site `cms-agent`. `main` is protected -
  land with `/ship CMS-Agent <branch>`, never push to `main`.
- Checks: `npm run typecheck` and `npm test`. CI gates on
  `workspace (typecheck + tests)`, `ui (tests + build)`, `two-plane drift detector`.

## Discipline

- Commit per milestone, not per session.
- Every task ships with its own acceptance test.
- Never widen the publish charter. If a change would let a node publish
  something it could not publish before, stop and ask Wolf.
- Node literals are generated: after editing them run `npm run nodes:update`
  and redeploy, or the two-plane drift detector will fail.
- Content production belongs in the site's admin chat, not in the MCP
  workspace surface.
