# Engine vocabulary

Every coded value the CMS-Agent interface puts in front of a human, with what it means and — where
there is one — what to do about it.

**This file is generated.** It is rendered from `ui/src/explain.ts`, which is the same registry the
interface reads when it renders a definition beside a badge or a table cell. Editing this file by hand
will be overwritten; edit the registry and run `npm run glossary:update`. CI fails if the two
disagree, because a stale glossary is the kind of wrong that goes unnoticed — nobody re-reads a
definitions page, so an out-of-date one gets trusted indefinitely.

Codes are shown exactly as they appear on the wire, in logs, and in the runbooks, so this document can
be searched with the string you actually have in front of you.

## What do read, write, publish and admin mean?

A rung on the risk ladder. A node's own risk level is the CEILING for the tools it may call: a read node cannot call a write tool, however the tool is granted.

| Code | Name | Meaning |
|---|---|---|
| `read` | Read | Reads state and returns it. Nothing anywhere changes. |
| `write` | Write | Changes workspace state — prompts, schemas, tools, stage outputs. Every change is attributed in the ledger and can be restored. |
| `publish` | Publish | Sends content out to a client's live site. This workspace cannot take it back, so publish nodes stay behind an explicit human approval. |
| `admin` | Admin | Reconfigures the engine itself — connections, policy, protected records. The top rung, granted deliberately and never by default. |

## What do the run states mean?

Where a node or run currently stands. The distinction that matters is blocked versus failed: one is the safety design working, the other is something wrong. Paused is a third thing again — a person pressed stop.

| Code | Name | Meaning |
|---|---|---|
| `queued` | Queued | Waiting to start — either for its turn or for a dependency to finish. |
| `running` | Running | Executing now — calling its model and any tools it is granted. |
| `completed` | Completed | Finished and produced output that satisfied its schema. |
| `paused` | Paused | Stopped because someone pressed pause. Nothing is wrong and nothing is waiting on a decision — the run simply stays where it is until it is resumed.<br>**What to do:** Resume the run when you are ready; no node state was changed. |
| `blocked` | Blocked | Stopped on purpose, waiting on a human decision — either an approval before a publish-risk node, or a run that reached its cost ceiling. This is a safety hold, not an error, and it is resumable.<br>**What to do:** Review what it is asking for — the approval list or the budget ceiling — and resume the run. |
| `failed` | Failed | Stopped because something went wrong — a tool error, a schema violation, an unreachable client.<br>**What to do:** Read the node's error, fix the cause, then retry that node rather than the whole run. |
| `cancelled` | Cancelled | Called off by a human or by the system before it finished. |
| `skipped` | Skipped | The conductor decided this node had nothing to contribute to this run — a rule on the node matched the run's own facts — so it was never started and cost nothing. Nothing is wrong: the run carries the rule that fired and what it fired on, and the nodes that depend on this one treat its output as deliberately absent.<br>**What to do:** If it should have run, retry that node — an explicit retry overrides the skip for this run. |

## Who made a change — human, agent or system?

Every change in the ledger records its origin, because most configuration here is eventually edited by agents rather than people. The interface never assumes a human authored a change.

| Code | Name | Meaning |
|---|---|---|
| `human` | Human | A person, acting through the UI or an authenticated MCP session. |
| `agent` | Agent | An AI agent acting through MCP. The reason field is the only account of intent a reviewer gets, which is why it is mandatory. |
| `system` | System | The engine itself — migrations, seeded defaults, automatic bookkeeping. No one chose it in the moment. |

## Why can a tool be denied?

The resolver's verdict on one tool for one node. Several reasons can apply at once, and all of them have to clear before a call goes through.

| Code | Name | Meaning |
|---|---|---|
| `tool_disabled` | Switched off in the registry | The tool is disabled for everyone, not just this node, so no grant anywhere will enable it.<br>**What to do:** Enable it in the tool registry, or use a different tool. |
| `node_tool_not_allowed` | Not granted to this node | The node's own allowedTools list does not include this tool.<br>**What to do:** Tick it in the Own column and save — that is the grant. |
| `skill_tool_not_allowed` | Not granted to the assigned skill | A skill assigned to this node does not list the tool in its own allowedTools, so the skill's instructions assume a capability it cannot use.<br>**What to do:** Widen the skill's allow-list, or unassign the skill. |
| `platform_tool_not_allowed` | Excluded platform-wide | The platform-wide allow-list for this run does not include the tool. |
| `run_tool_not_authorized` | Not authorized for this run | This particular run was started without authorization for the tool, whatever the node allows. |
| `risk_level_exceeds_authorization` | Above the node's risk ceiling | The tool's risk level sits higher than the ceiling this node runs under, so granting it alone changes nothing.<br>**What to do:** Raise the node's own risk level deliberately, or achieve the step with a lower-risk tool. |
| `approval_required` | Approval required | The tool needs an approval and none is present for this call. Note that a resolved view carries no approval context, so every approval-gated tool reads this way when inspected — it is not evidence of a fault.<br>**What to do:** Approve the call at run time; nothing needs changing on the node. |
| `project_has_no_allowed_tools` | Client connection has an empty allow-list | project.call_tool is granted, but the target client connection permits no tools, so there is nothing it could call.<br>**What to do:** Allow-list the client tools this node needs on the Access page. |

## What do allow, ask and block mean?

Per-tool permission on a client's own MCP server, enforced by project.call_tool before anything leaves this workspace.

| Code | Name | Meaning |
|---|---|---|
| `allowed` | Allowed | Agents may call this tool directly, with no human in the loop. |
| `needs_approval` | Needs approval | Calls are held until a human approves. The tool never runs on its own. |
| `blocked` | Blocked | Calls are refused here, before any request reaches the client's server. |

## What are the Method, Effective and Identity layers?

The same value can differ between what is stored, what actually runs, and what the client says — so the inspector never blends the three into one number.

| Code | Name | Meaning |
|---|---|---|
| `method` | Method · stored | What is saved on the node: its prompt, granted tools, assigned skills, schemas. Always available, and the only layer that is editable. |
| `effective` | Effective · resolved | What the workspace resolves at run time, including instructions a skill appends to the prompt and the resolver's verdict per tool. Always available; it needs no client connection. |
| `identity` | Identity · live contract | What the client's own live contract says, fetched now. Needs a configured, reachable connection; when it is down the layer greys out and names the environment variable that would fix it, rather than showing a stale value as current. |

## What is the difference between a blocker and a warning?

How seriously to take a conflict the resolver reported.

| Code | Name | Meaning |
|---|---|---|
| `blocker` | Blocker | The configuration contradicts itself in a way that stops the node from working as written. |
| `warning` | Warning | Worth knowing and often deliberate — a publish gate holding, for instance — but nothing is broken. |

## Reported by the interface rather than the resolver

One code is produced by the interface itself, so it will not appear in the engine's policy code:

| Code | Name | Meaning |
|---|---|---|
| `tool_not_in_registry` | Not in the registry | The node lists a tool the registry does not know about, so it can never resolve — the config looks populated while granting nothing.<br>**What to do:** Remove it from the node, or check the name against the registry. |
