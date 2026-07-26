# Aligning the agent workspace to the platform ruling

**Context:** platform is about to move `mcp.ts` into core — per-client *endpoints*, not per-client *code*; committed per-site config, not env-var tenant selection; **tools are law, instructions are data**.

This is the agent-workspace side of that ruling. One collision to resolve, three things already right, and a set of concrete moves keyed to their five steps.

---

## 1. The collision: their table puts node prompts on the wrong side

Their split:

| | Where |
|---|---|
| Mechanics — verbs, lifecycle, validation, locks, tool schemas | Core code, identical for every client |
| Publication instruction — **agent nodes, prompts, workflow definitions**, approval posture, taxonomy, themes, editorial rules | Per-client data and committed config |

The bolded items are the problem. Today CMS-Agent has **one constellation shared across all projects** — the UI states it outright: *"The constellation is shared across projects; `dr-lurie` scopes runs and usage only."* 21 nodes, one graph, four registered clients.

If agent nodes and prompts become per-client data, **their own argument against forked servers applies verbatim**:

> *"N forked servers means N drifting dialects and experience that doesn't transfer. The uniform contract isn't just compatible with the learning goal — it's a precondition for it."*

Swap "servers" for "prompts" and it holds exactly. A learning layer comparing runs across publications needs the *method* held constant so the *outcome* differences mean something. Fork the prompts per client and every run is an incomparable one-off. You'd have preserved tool uniformity and thrown away method uniformity — and method is what the optimizer, rubrics and regression reports actually operate on.

### The refinement: three layers, not two

| layer | what | where | why |
|---|---|---|---|
| **Mechanics** | verbs, lifecycle, locks, validation, tool schemas | platform `packages/core` | fleet law — a fix propagates |
| **Method** | node roster, prompts, graph shape, rubrics, evaluation criteria | **CMS-Agent workspace — one constellation** | fleet law — makes runs comparable |
| **Identity** | voice, story, positioning, taxonomy, theme, approval posture, capability flags | platform per-site objects | genuinely per-publication |
| *(operational)* | runs, usage, approvals, stage outputs | CMS-Agent, scoped by `projectId` | already correct today |

**The test for which layer something belongs to:** *if two publications did this differently, would comparing their runs still teach you anything?* If yes → identity, put it in client data. If no → method, keep it fleet law.

"Write in a calm dermatologist voice" is identity. "Fetch the contract before shaping content, and never build to a local schema" is method. Today those are fused in the same prompts — which is exactly the fusion we spent this session pulling apart.

**Recommendation: amend their table to move `agent nodes, prompts, workflow definitions` from the per-client column to a third Method column owned by the agent workspace.** Everything else in their ruling stands unchanged.

---

## 2. What the workspace already gets right — don't let the ruling break it

**Their pushback #1 is about tenant *selection*, and doesn't apply here.** CMS-Agent uses `<CLIENT>_MCP_ENDPOINT` / `<CLIENT>_MCP_TOKEN` env pairs — which looks like the pattern they're rejecting, but isn't. Platform resolving *"which tenant am I"* from env is the footgun. CMS-Agent is a **client holding N connections**, each explicitly addressed by `projectId`. There is no ambient tenant to get wrong.

And it already implements their exact principle. From `project.get_registration_contract`:

> *"Endpoint and token are referenced by environment variable NAME only; values are configured in the deployment and are never persisted or returned."*

Identity and policy in committed data (the project record: `projectId`, `allowedTools`, `toolPolicies`, `contentContract`, `publishingPolicy`); secrets in env. That is their rule, already shipped. **Worth stating explicitly in the ruling so nobody over-applies "no env vars" and rips out a registry that's doing the right thing.**

**Fail-closed already holds too.** `project.test_connection("dr-lurie")` on the GCloud plane returns a hard error — *"Project MCP endpoint is not configured"* — rather than falling back to a default. Same posture they want from `mcp.ts` without bindings.

**Per-project tool policy is already the capability-flag seam** they say they'll need later: `allowedTools` + per-tool `toolPolicies` + `defaultToolPolicy: blocked`. It exists; it just needs to be *driven by the contract* instead of hand-maintained (see §3.4).

---

## 3. Concrete moves, keyed to their five steps

### 3.1 — Pin `serverInfo.name` per site *before* the move (their steps 1–3) · **risk**

They noted MCP connectors key on `serverInfo.name` per site. `sites/drlurie/config/site-identity.ts` carries `mcpServerName: 'Dr_Lurie_MCP_Server'` and `mcpDiagnosticName: 'Dr_Lurie_Science_MCP'` — and the live diagnostic confirms it: `ping` returns `{"server":"Dr_Lurie_Science_MCP"}`.

When `mcp.ts` becomes core, **the server name must still resolve from site-identity, not from a core constant.** Otherwise every client's endpoint announces the same name and connectors collide or silently rebind. Cheap to get right during the move, ugly to discover after two clients are live.

**Add to their step 2:** assert `serverInfo.name` comes from the site-identity provider, and add a fleet test that two sites' `initialize` responses return different names.

### 3.2 — Make the request-id convention contract-declared (their step 4)

They're de-siting example ids like `req_publish_drlurie_…` from tool descriptions. Do one better: **the id *format* should be contract-declared, not just the examples de-branded.**

This is not theoretical. It cost us a real artifact today. pdf-tool accepts `^req_[a-z0-9_]+$`; Dr. Lurié enforces `req_<flow>_<topic>_<yyyymmdd>_<nn>`. An import under a non-conforming id **succeeded on the write side and became unlistable and undeletable** on the client side. One orphaned blob, still there.

Workspace side is already fixed — `artifact_plan` now carries `requestIdConvention` and `requestIdConfirmedByClient`, and must confirm before materializing. Platform side should expose the pattern in `object_contract` (it's already stated prose-side in the `id_object` constraint) so there's one authority instead of two validators disagreeing.

### 3.3 — Assert object-substrate-only per client

They're right to keep `publish-article.ts` / `save-json-blob.ts` at the repo root as Dr-Lurié-only legacy. The workspace already reflects this — `dr-lurie`'s `allowedTools` excludes every `save_json_blob_*` tool despite the connection exposing them.

**Make that positive rather than incidental.** Add `contentSubstrate: "object"` to the project record so a new client is born object-only by declaration, not by someone remembering not to add the legacy tools to an allowlist. Legacy stays an explicit per-client exception with a name.

### 3.4 — Drive `allowedTools` from the contract, not a hand-kept list

The pdf-tool regression this session was exactly this failure: the GCloud plane's pdf-tool project was re-registered from the read-only onboarding recipe and lost five artifact-generation tools. Nobody noticed until images couldn't be produced. The workspace's own `article_body` schema had declared the required set all along, in `requiredPdfToolCapabilities`.

**Two hand-maintained lists that must agree will eventually disagree.** With capability flags landing in site config, the registry should reconcile against them: `project.list_tools` + the contract's declared capabilities → the effective allowlist, with drift reported rather than silently tolerated.

### 3.5 — Make `requestId` the fleet-wide join key (their learning goal)

They call `workflow-contract.ts` core law so *"every client's workflow history is machine-comparable — exactly the corpus your future learning layer reads."*

There are **two** corpora, and today they don't join. Platform has workflow records; CMS-Agent has its own runs, stage outputs, usage records and an immutable change ledger with full before/after snapshots and `correlation.requestId`.

The natural join key is the client request id — the one thing both sides already handle. **Stamp `requestId` on CMS-Agent runs and usage records** (the change ledger already carries it) so a platform workflow record and the agent run that produced it are one query apart. Without this, the learning layer sees outcomes without method, or method without outcomes.

---

## 4. The idea worth taking: the workspace as fleet conformance harness

Their step 5 is *"verify live, both directions."* That's a manual check today. It doesn't have to be.

Register `platform` as a project in CMS-Agent and run the tiered protocol against it. Tier 0 is connectivity and contract health; Tier 2 is effective-config resolution; Tier 3 is contract validation with negative cases; Tier 7 is the publish-readiness gate. **Every one of those is client-agnostic after this session's alignment** — they read the contract rather than assuming Dr. Lurié's.

That makes onboarding measurable: **a new client is done when it passes the tiers.** Which is their T14.9 *"cost of a new client"* requirement expressed as a gate rather than a feeling. `create-site` scaffolds it; the conformance run proves it.

It also catches the failure class that actually bit us. Split-brain between two control planes, a project re-registered with defaults, a capability quietly dropped — none of those throw. They just make things not work later, in a way that looks like a content problem.

**Concretely:** after their step 5, register `platform` in the workspace and run Tiers 0–3. If they pass, the move is verified in both directions by machine. Add the drift detector to fleet CI and it stays verified.

---

## 5. One thing to decide now, cheaply

Their capability-flag seam is *"a seam to design later, not build now."* Agreed — with one exception worth reserving today, because retrofitting it is expensive: **where per-publication voice lives** (see the separate voice-object findings).

The reason it belongs in this decision rather than after: the five nodes still naming Dr. Lurié in the workspace are editorial-voice references, and they cannot be generalized until there's a client-side surface to fetch voice from. Every week they stay hardcoded is a week the "method is fleet law" boundary leaks. It's the last hardcoded client dependency in the graph, and it's blocked on a platform decision, not a workspace one.

---

## 6. Sequencing

**Before their move:** pin `serverInfo.name` per site (§3.1) — cheapest now, ugliest later.

**During:** de-site the id examples *and* publish the id pattern in the contract (§3.2).

**Immediately after step 5:** register `platform` in the workspace, run Tiers 0–3 (§4). That is the verification, and it's reusable for client three.

**Then, in the workspace:** `contentSubstrate` declaration (§3.3), contract-driven allowlist reconciliation (§3.4), `requestId` on runs and usage (§3.5).

**Ratify alongside the ruling:** the three-layer table (§1) — mechanics in core code, **method in the shared constellation**, identity in per-site objects.

---

## Bottom line

Their architecture is right and the workspace is closer to it than the ruling assumes — per-client endpoints with per-client credentials, identity in data, secrets in env, and fail-closed resolution are all already shipped.

The one correction: **method belongs with mechanics on the fleet-law side, not with identity on the per-client side.** Their own argument for uniform tools is the argument for uniform prompts, and putting node prompts in per-client config would quietly cost them the learning transferability the whole design exists to enable.
