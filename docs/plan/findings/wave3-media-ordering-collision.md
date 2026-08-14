# Wave 3 T8: the media ordering is circular against the Platform artifact bridge

**Status: T8's sequencing is blocked by a client precondition. Everything else in T8 is proven live.**
Verified on `run_1786690830195_jcluq8` (2026-08-14), a deliberate media-request run.

## What T8 assumed

> the artifact must EXIST before `article_body` may reference it

So `artifact_plan` was moved ahead of `article_body`.

## What the client actually requires

`create_agent_artifact_job`'s own parameter schema:

    request_id: "Existing content_item object id that will own the artifact."

`article_body` is the node that CREATES the content_item. So:

- T8 needs the artifact before the body node runs.
- The bridge needs the body's object before an artifact can be attached.

That is circular. Reached live, in order, with the capability grant in place:

1. `site_id: platform` → `artifact_site_mismatch`; the service named `site_platform` as owner.
2. `site_id: site_platform` → reached the bridge → `artifact_request_not_found: content_item
   req_agent_plan_media_artifact_before_article_body_20260814_01 does not exist on site_platform`.

The FIX PLAN's evidence ("`create_agent_artifact_job` generates + verifies in ONE call, ~30s,
~$0.01 — proven") was accurate, but it was obtained while a content_item already existed — i.e.
under the OLD ordering. Moving the node earlier removed the precondition that made it work.

## The conflation at the root of it

"The image must be verified before it is referenced in a rendered field" and "the `artifact_plan`
NODE must run before the `article_body` NODE" are different claims. Only the first is a real
requirement. T8 implemented the second to get the first.

## What IS proven, and should be kept

Everything except the edge order held up under a live run:

- `brief_architect` derives a populated `mediaSlots[]` from the envelope's media request, and an
  empty array when none is asked for.
- `artifact_plan` runs instead of being wrongly skipped — the original defect
  (`run_1786557897658_elj34j` published a media run with no media) is fixed at the predicate level.
- It confirms the request id against the client's own convention via `object_validate`, reads the
  artifact protocol from the live contract, and resolves the owning site.
- Under two DIFFERENT failures (capability denied, then request-not-found) it emitted
  `artifactReferences: []`, both slots `blocked`, and typed blockers naming the exact missing
  capability and pending action. No unverified reference, raw key, guessed public path, data URI or
  placeholder ever reached `article_body`. That contract is the point of T8 and it holds.

## Options (operator decision — none taken)

1. **Bind after materialize, keep the old edge order.** `article_body` creates the content_item
   WITHOUT media, `artifact_plan` materializes against that now-existing id, then a small
   deterministic binder patches `body.image = {src: publicPath, alt}`. Matches the client's own
   model (create object → attach artifacts → patch → publish) and needs no new node powers. Most
   likely correct.
2. **Shell-first.** `artifact_plan` creates a minimal owning content_item itself via `object_create`,
   materializes, then `article_body` patches that object. Keeps T8's edge order but hands
   object-creation power to a `write`-risk node.
3. **Three-phase split.** A dedicated shell node before `artifact_plan`, with `article_body` last.
   Cleanest separation, largest topology change.

## Also found while getting here

`platform.allowedTools` was `[]`. `toolPolicy.ts:23` treats that as a MASTER SWITCH — it denies
`project.call_tool` outright (`project_has_no_allowed_tools`), so no agent-initiated client write of
any kind was possible. It is not a per-tool allowlist: once non-empty, per-tool permission comes from
`toolPolicies`/`defaultToolPolicy`, which is what `ProjectMcpAdapter.callTool` actually reads.

Set to `["create_agent_artifact_job"]` on 2026-08-14 with operator approval. Blast radius stated at
the time and worth re-reading: `object_publish` and `release_to_production` are `allowed` in
`toolPolicies`, so they are now node-reachable from the four `write`-risk nodes that hold
`project.call_tool`, guarded by prompt prohibition rather than policy. Narrowing that needs a code
change in `toolPolicy.ts` (make the switch consult the client tool name), not a config change —
`publisher.ts` goes through the same `callTool` gate, so demoting those two verbs to
`needs_approval` would break publishing.
