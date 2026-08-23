# Client Manager Conversation Contract

Status: **G1 REVIEW REQUIRED**

Wire version: **`client_manager.turn.v1`**

MCP tool: **`agent_converse`** (internal dotted name `agent.converse`)

This document freezes the CMS-Agent side of the Platform PF1/PF2 integration. Additive versions may be introduced later, but this version must not change incompatibly.

## Surface policy

- **All content is directed through a single chat surface**: the site ADMIN CHAT (platform admin-agent-chat → `client_manager`). It is the only editor surface; it owns approval, learning mode and the human record.
- `agent_converse` is the raw single-turn primitive used BY that chat. Humans and editor-agents do not call it directly.
- Direct CMS-Agent MCP use is for **workspace authoring only** (agent prompts, node prompts/schemas/tools/model config, projects, evaluations) — not for producing or publishing content.
- `workflow.*` / publish tools remain callable directly for operators and tests; their descriptions carry a wrong-path notice, nothing is blocked.
- Policy: single content surface — Wolf, 2026-08-17.

## Ownership and execution

CMS-Agent owns the workspace-stored `client_manager` prompt, model selection, project-aware prompt assembly, one provider request, usage metering, and a bounded learning/audit mirror. Platform owns the authoritative `ChatDoc`, transcript trimming policy, editor visibility, tool registry, tool execution, autonomy, approval, locking, retries, and the human-facing wait state.

`agent_converse` executes exactly one model request. Caller tool definitions are sent to the selected provider. CMS-Agent never executes a caller tool and never enters a provider tool loop. Returned tool calls are proposals for Platform to gate and execute.

## Strict request

The entire request and every named nested object are strict: unknown properties are rejected as `invalid_turn_request`.

```jsonc
{
  "agent_ref": "agt_client_manager@1", // 1..256 chars; opaque value from agent_resolve
  "project_id": "platform",           // 1..63 chars; registered and active
  "conversation_id": "obj:page_home", // 1..256 chars; Platform ChatDoc id
  "turn_id": "t_run_123_0",           // 1..256 chars; Platform-minted idempotency key
  "actor": {
    "kind": "human",                  // literal; required
    "id": "usr_123"                   // stable id, 1..256 chars; email-shaped ids rejected
  },
  "context": {
    "site_id": "site_platform",       // required, 1..128 chars
    "object_type": "page",            // optional, paired with object_id
    "object_id": "page_home",         // optional, paired with object_type
    "focus": "Homepage → Hero",       // optional, 1..500 chars
    "learning_mode": false,            // optional
    "approval_note": "Propose only."  // optional, 1..1000 chars
  },
  "messages": [],                      // 1..200 ChatMsg values; see below
  "tools": [],                         // 0..96 WireTool values; see below
  "constraints": {
    "max_tokens": 16000,               // integer 1..32000
    "timeout_ms": 90000                // integer 1000..120000
  }
}
```

`object_type` and `object_id` must appear together. Effective `max_tokens` and `timeout_ms` are the lower of the request constraint and the stored agent definition constraint.

### `messages`: Platform provider-neutral `ChatMsg`

Exactly one of these strict shapes is accepted:

```jsonc
{ "role": "user", "text": "..." }
{ "role": "assistant", "text": "...", "tool_calls": [{ "id": "call_1", "name": "patch", "args": {} }] }
{ "role": "tool", "tool_call_id": "call_1", "content": "...", "is_error": false }
```

For an assistant message, `text` and `tool_calls` are individually optional but at least one must be present. Tool names match `^[A-Za-z0-9_-]{1,64}$`. A tool result must answer a call in the immediately preceding assistant turn; parallel results may be consecutive. A desynchronized transcript is `invalid_turn_request`.

The transcript bound is both:

- at most **200 messages**; and
- at most **256,000 serialized JSON characters**.

Exceeding either bound returns `transcript_too_large`. Platform should trim oldest messages and retry with a new request only when its own transcript rules allow it.

### `tools`: Platform `WireTool`

Each tool is strict:

```json
{
  "name": "patch",
  "description": "Propose a governed patch.",
  "input_schema": { "type": "object", "additionalProperties": false }
}
```

The tool list is bounded to **96 tools** (raised from 64 in W19, 2026-08-23 — the caller's registry had reached the old ceiling with no headroom; the character bound below is unchanged and is what actually protects payload size) and **256,000 serialized JSON characters**. Context is bounded to **64,000 serialized JSON characters**. These adjacent request-limit violations are `invalid_turn_request`.

## Successful result

The standard CMS-Agent MCP success envelope is `{ "ok": true, "data": <result> }`. `<result>` is exactly:

```jsonc
{
  "assistant_text": "I can propose that change.", // optional
  "tool_calls": [                                  // optional
    { "id": "call_1", "name": "patch", "args": { "ops": [] } }
  ],
  "usage": {
    "input_tokens": 120,
    "output_tokens": 30,
    "cost_usd": 0.00048
  },
  "agent_rev": 3,
  "model": "gpt-4.1"
}
```

At least one of `assistant_text` or `tool_calls` is present. Tool arguments are decoded JSON objects. `cost_usd` uses the existing CMS-Agent pricing catalog and remains an estimate, not billing-grade truth.

## Resolution and prompt ordering

`agent_ref` may be the current canonical id or its revision-pinned form returned by `agent_resolve`. An unknown id, disabled definition, or stale pinned revision returns `agent_unresolved`; callers should re-resolve.

The provider system prompt order is fixed:

1. canonical workspace-stored `client_manager` prompt (rev 3 — adds "Starting and reporting production": brief passed verbatim as `input.instructions`, `trafficSource`/`awarenessStage`/`mediaRequest` carried, caller-supplied `requestId`, reusable-first failure reporting; rev 2 = CA6 house rules; rev 1 = CA2 seed);
2. project knowledge from the registered project hook;
3. project editorial voice from the registered project hook, or `null` when the project has none;
4. caller `context` serialized as deterministic JSON between `<caller_context_json>` markers.

Caller context is explicitly labelled untrusted data. CMS-Agent performs no placeholder substitution, template evaluation, code evaluation, or instruction interpolation on it. Tenant-specific facts belong in the project registry/hook, never in the project-neutral canonical prompt.

## Provider behavior

- OpenAI-family definitions issue one Chat Completions request with tools in function-calling format.
- Anthropic definitions issue one Messages request with tools in `input_schema` format.
- Neither family executes tool calls inside CMS-Agent in this mode.
- Provider cancellation/elapsed timeout is `model_timeout`; other provider failures are `model_error`.
- `budget_exceeded` is reserved for an explicit provider/request-constraint budget rejection. CA3 introduces **no stored per-conversation budget ceiling**. Conversation spend is metering-only through usage records.

## Replay and concurrency

The idempotency key is `(conversation_id, turn_id)`. The normalized strict request is hashed. Reusing the key with different input returns `invalid_turn_request`.

Before provider execution, CMS-Agent creates a durable claim with a create-only/CAS write. One concurrent caller owns the claim; other callers wait for it and return the completed stored result. A completed duplicate performs zero provider calls and returns the same result fields and values. Failed turns are not successful replay records and may be retried with the same input.

## Persistence and record authority

Only after a successful provider response, CMS-Agent writes:

- one CA1 `ConversationTurnRecord` containing `turnId`, `conversationId`, `projectId`, `agentRef`, `agentRev`, stable-id actor, bounded request preview, assistant/tool output, usage, and `createdAt`; and
- one deterministic `ModelUsageRecord` with `metadata: {conversationId, turnId, siteId}`.

The turn repository keeps the last **200** completed records per conversation and an observable trim marker. These records are the CMS-Agent learning/audit mirror. Platform `ChatDoc` remains the sole human-facing conversation authority. Actor data is attribution, not authorization. No email is accepted or stored.

## Typed errors

The frozen tool-error codes are:

`unknown_project | project_disabled | agent_unresolved | transcript_too_large | model_timeout | model_error | budget_exceeded | invalid_turn_request`

They appear in the existing MCP JSON-RPC error envelope at `error.data.error.code`; the JSON-RPC message begins with the same code. No error implies that a tool executed or that content changed.

### Replay example

Two concurrent calls carrying the same strict request and `(conversation_id, turn_id)` produce one provider request. Both receive the same `<result>`. A later retry receives that stored `<result>` without contacting the provider.

### Tool-proposal example

If the provider returns `patch({"ops": [...]})`, CMS-Agent returns it in `tool_calls` and stops. Platform then applies its existing autonomy, approval, validation, lock, and execution rules. CMS-Agent does not approve, execute, wait for, or resume that proposal.
