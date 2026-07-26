# CMS-Agent — cowork session brief
*Paste this at the start of future sessions. State as of 2026-07-26.*

## Where things stand
- **Canonical plane:** Cloud Run + GCS (`CMS_Agent_GCloud`), workspace **v69**, graph valid, attention clean. Netlify plane = frozen archive (v89; holds run history, 17-stage golden traversal `run_1784213511374_gl5o0h`, 4 learning observations worth porting).
- **Alignment done:** 6 nodes + 6 skills rebuilt around *client-contract-as-truth* (contract fetched at runtime via `contract_intelligence`, validated by the client's own validator; workspace schemas advisory). Image loop proven live: grant → pdf-tool writes client blob → ArtifactReference → `verify_agent_artifact` → client index.
- **Platform repo:** mcp.ts core split **landed and verified** (PR #476): core engine + per-site shims, `serverInfo.name` from site-identity, `create-site` generates shims. NOT landed: client-0 self-README content, voice (`vox_`) object type.
- **Standing blockers:** Cloud Run env vars unset — `DR_LURIE_MCP_*`, `PDF_TOOL_MCP_*`, `PLATFORM_MCP_*` (ENV-1..3, Wolf manual). Everything client-facing waits on these.
- **Governing plan:** `change-plan.md` — 25 items by ID (ENV/W/R/P/T), dependency spine, **awaiting "go"**. Rule: no code or MCP changes outside approved plan items.
- **Clients:** platform = client 0 (canonical, self-documenting), dr-lurie = client 0001. pdf-tool = **service, never delete**. snoocle/monetizer = delete (W-2).
- **Known repo bugs (worst first):** R-1 single-field `update_node_*` writers silently wipe omitted fields (`ok:true` + data loss — use full `update_node` patches only); R-2 skill-schema compatibility check false-blocks anything but bare `{"type":"object"}`; R-4 version conflicts return untyped `-32603`; two resolvers disagree on effective tools (R-5). No CI (R-0).

## Model guidance per stage
| stage / task | model tier | why |
|---|---|---|
| Architecture, contract alignment, prompt/schema rewrites, plan synthesis, anything touching publish gates | **Opus-class (max effort)** | one wrong schema word costs a day; this session's value was here |
| Recon sweeps, inventory diffs, jq extraction, repo mapping | **Sonnet-class subagents** | mechanical + parallel; keep findings, not file dumps, in main context |
| Protocol Tiers 0–4, 7, D (read/validate, no judgment) | **Sonnet-class / CI-scripted** | deterministic assertions; eventually no model at all (R-13) |
| Adversarial verification of findings before acting | **Opus-class** | cheapest insurance; caught the "legacy tool" misdiagnosis |
| Docs: per-node mechanics from introspection | **Sonnet-class** | rendering, not authoring |
| Docs: architecture narrative, voice-object design, editorial | **Opus-class** | judgment-heavy |
| R-1..R-6 server fixes | **Opus-class**, Sonnet for test scaffolding | subtle store semantics |
| S4 inspector UI (read-only) | **Sonnet-class**, Opus review pass | spec is written; execution is mechanical |
| LibreChat Workspace Inspector (read/diagnose) | Sonnet-4.5 (current) — fine | keep read-only; separate Editor agent if writes needed |
| Tier 8 live publish | **Opus-class + human at the call** | irreversible |

Rule of thumb: **fan out cheap, decide expensive.** Subagents gather; the top-tier model concludes and writes.

## Protection rings (Wolf 2026-07-26 — ratified direction)
pdf-tool is OS; client MCPs and nodes are apps. Service connections and their instructions are **not agent-adjustable** by publishing agents:
- **Ring 0 — services** (`kind: service`: pdf-tool, future infra): `project.update`/`delete`/env-var fields refuse `actor.kind: agent` from the publishing surface; changes need human or a distinct ops credential. Publishing agents may *call* (`project.call_tool` under policy), never *reconfigure*.
- **Ring 1 — client connections** (`kind: client`): agent-adjustable behind `needs_approval` + ledger.
- **Ring 2 — method** (nodes, prompts, skills): the publishing agents' own editable surface, ledgered.
Caveat: actor identity is self-declared today ("coordination, not security") — full enforcement lands with per-agent credentials; until then implement as `needs_approval` policy + attention item on any Ring-0 change. Folded into plan as **R-7b**.

## Session artifacts (delivered files)
GUI plan · test protocol (+dry-run results) · migration status · image-pipeline status · client-truth alignment · voice-object findings · workspace-side alignment · self-describing-engine proposal · **change-plan.md** (governing).
