# Netlify retirement list — Conductor Workbench Pass 2, Track A

**Status: proposal only. Nothing described here has been deleted.** This document is the exact
list of Netlify resources to remove once Track A (`docs/plan/TRACK-A-RUNBOOK.md`) is live and its
parity checklist is fully checked off. **Wolf's explicit sign-off is required before any row below
is acted on** — do not delete anything here on inferred approval, a passage of time, or another
agent's say-so.

This is scoped to the **Netlify infrastructure** this consolidation retires. It does not cover the
UI-legacy/screen-inventory retirement questions in `workbench/docs/RETIREMENT.md` (a separate,
earlier document about which *screens* survive the workbench rewrite) — that document is owned by
whoever owns `workbench/**` and is unrelated to this one; this one is about which *Netlify
resources* survive Track A's consolidation onto Cloud Run.

---

## What's actually there (confirmed live, read-only, via the Netlify MCP connector — 2026-08-26)

There is exactly **one** Netlify project connected to this account matching this repo:

| Field | Value |
|---|---|
| Project name | `cms-agent` |
| Site/project id | `cdfcaf73-836f-4f75-b880-9124da18f400` |
| Team id | `6917763e9afbf6f211be929b` |
| Primary URL | `cms-agent.netlify.app` |
| Branch deploy URL | `main--cms-agent.netlify.app` |
| Current deploy state | `ready` (deploy id `6a8df81313e8da0008b7cc0f`) |
| Netlify dashboard | `https://app.netlify.com/projects/cms-agent` |

**There is no separate Netlify project or site specifically named "workbench."** Per this repo's
own `netlify.toml`, the Conductor Workbench SPA is built as *part of* this single `cms-agent`
project's build (`workbench/dist` is copied into `ui/dist/workbench`, published at
`cms-agent.netlify.app/workbench/*`) alongside the root `ui/` app and its Netlify Functions. So the
Track A brief's "the workbench site" and "the stale Netlify CMS-agent project" name the same
underlying Netlify project at two different granularities:

- **"the workbench site"** = the `/workbench/*` path and its build step within this project — the
  thing Wolf actually stops using once Track A's Cloud Run URL is live.
- **"the stale Netlify CMS-agent project"** = the `cms-agent` Netlify project as a whole —
  everything else it still serves (the root `ui/` app, its Netlify Functions, its own env vars and
  deploy history), once nothing on it is load-bearing anymore.

Practically: there is nothing to retire *within* the project that isn't retiring the whole project
— see §2's single recommendation below, not two separate actions.

---

## 1. What made this Netlify plane dead, for the record

Per the Track A brief and this repo's own comments (`workbench/src/api/client.ts`'s header,
`netlify.toml`'s comments): the Netlify Functions MCP proxy this site used to run
(`/api/workspace-mcp`, `/api/mcp`) has been returning `502 ERR_REQUIRE_ESM` on every call — a dead
control plane, not a live one being replaced pre-emptively. `ui/src/connection.ts`'s own comment
already states "GCloud is the only control plane the UI ever talks to (Netlify's MCP proxy paths
and the Identity secure-proxy auth mode were retired once Cloud Run became the sole target)." Track
A's Cloud Run + IAP consolidation removes the *other* half of the old picture — the browser talking
to Cloud Run directly with a manually pasted bearer token — leaving this Netlify project with no
live purpose for this workflow at all.

---

## 2. Recommended action, once parity is proven

**Delete the `cms-agent` Netlify project** (id `cdfcaf73-836f-4f75-b880-9124da18f400`), in full,
once every row of `docs/plan/TRACK-A-RUNBOOK.md`'s parity checklist is checked off against the
live Track A deployment. There is no partial "delete just `/workbench`" action available or
sensible — Netlify doesn't delete a subpath independently of its project, and the whole project's
own reason to exist (this repo's dead Netlify Functions MCP proxy) is gone regardless.

Before deleting, from the Netlify dashboard (`https://app.netlify.com/projects/cms-agent`) or CLI,
an operator with delete access should:

1. **Export the project's environment variables list** (names, not necessarily values — most are
   almost certainly duplicated in Secret Manager/Cloud Run env already, but confirm before
   deleting rather than after) — `Site configuration → Environment variables`, or
   `netlify env:list --context production` if reproducing locally with the Netlify CLI linked to
   this project.
2. **Note the deploy history is going away** — if there's ever a need to compare "what did the old
   UI actually look like," that history lives only in Netlify's own deploy log; screenshot or
   export anything worth keeping before deletion, since this is not reversible after the fact.
3. **Confirm no other site's DNS or redirect points at `cms-agent.netlify.app`** — a quick grep of
   other Netlify projects' `netlify.toml`/redirect rules for that hostname, since a stale inbound
   redirect elsewhere would silently 404 once this project is gone.
4. **Delete via Netlify dashboard** (`Site configuration → General → Danger zone → Delete this
   project`) or `netlify sites:delete cdfcaf73-836f-4f75-b880-9124da18f400` with the Netlify CLI.

---

## 3. Sign-off record

| Who | Confirmed parity checklist complete | Confirmed OK to delete | Date |
|---|---|---|---|
| Wolf | ☐ | ☐ | |

Do not check either box on Wolf's behalf. If this document is being acted on and these boxes are
still empty, stop and go get the sign-off — that is the entire point of this section existing.
