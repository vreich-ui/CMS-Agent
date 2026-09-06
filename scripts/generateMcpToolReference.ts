#!/usr/bin/env tsx
// Generates docs/reference/MCP_TOOLS.md from the LIVE tool catalog (createWorkspaceTools) so the
// reference can never drift from what tools/list serves. Documentation tooling only — it imports
// the catalog, it never changes it.
//
//   npx tsx scripts/generateMcpToolReference.ts            # write docs/reference/MCP_TOOLS.md
//   npx tsx scripts/generateMcpToolReference.ts --check    # exit 1 if the file is stale
//
// Each tool gets: canonical wire name, internal dotted name, namespace, an effect class, the storage
// it touches, whether it reaches an external system, autonomy guidance, and its input schema. The
// effect classification is a CURATED table below (keyed by internal name); anything not listed is
// classified by verb heuristic and flagged `(heuristic)` so a reviewer can see it was not hand-checked.
// The three DEPRECATED_TOOL_ALIASES are listed separately: tools/list never advertises them.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "../src/agent/workspace/executor.js"; // registers every workflow (side-effect imports) before the catalog is built
import { createWorkspaceTools } from "../src/agent/mcp/workspace/tools.js";
import { canonicalToolName } from "../src/agent/mcp/workspace/toolKit.js";
import { DEPRECATED_TOOL_ALIASES } from "../src/agent/mcp/workspace/server.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = path.resolve(ROOT, "docs/reference/MCP_TOOLS.md");
const catalogSize = (): number => createWorkspaceTools({}).length;

type Effect = "read" | "mutate-workspace" | "mutate-run" | "mutate-registry" | "mutate-learning" | "execute-model" | "external-read" | "external-mutate" | "publish" | "admin";
type Row = { effect: Effect; storage: string; external: string; autonomy: "safe" | "caution" | "operator"; note?: string };

// Curated classification. `storage` names the key spaces written (see docs/DATA_ARCHITECTURE.md);
// `external` names systems reached outside the CMS-Agent store. `autonomy`: safe = an unattended
// agent may call it freely; caution = spends money, or writes durable state, or reaches a tenant;
// operator = irreversible / fleet-wide / production-affecting — expect a human in the loop.
const CURATED: Record<string, Row> = {
  // node.*
  "node.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.get_effective_prompt": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.get_effective_tools": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.get_effective_skills": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.get_input_schema": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.get_output_schema": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.validate_input": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.validate_output": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.prepare_execution": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.execute": { effect: "execute-model", storage: "runs/, usage/, artifacts/, workspace/current.json (stage mirror)", external: "model provider; controlled tools may reach project MCP / web", autonomy: "caution", note: "Standalone node execution (nodeRuntime.executeNode). Spends model budget." },
  "node.list_executions": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.get_latest_output": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.list_outputs": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "node.retry": { effect: "execute-model", storage: "runs/, usage/", external: "model provider", autonomy: "caution" },
  "node.cancel": { effect: "mutate-run", storage: "runs/", external: "-", autonomy: "caution" },
  // tool.*
  "tool.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "tool.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "tool.test": { effect: "external-read", storage: "in-process tool audit map only", external: "whatever the controlled tool reaches (web, project MCP)", autonomy: "caution", note: "Executes a controlled tool through toolExecutor; mutating tools require approval flags." },
  "tool.get_effective_for_node": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "tool.get_execution": { effect: "read", storage: "in-process only (lost on restart)", external: "-", autonomy: "safe" },
  "tool.list_executions": { effect: "read", storage: "in-process only (lost on restart)", external: "-", autonomy: "safe" },
  // skill.*
  "skill.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "skill.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "skill.create": { effect: "mutate-workspace", storage: "skills/current, skills/versions, skills/events", external: "-", autonomy: "caution" },
  "skill.update": { effect: "mutate-workspace", storage: "skills/*", external: "-", autonomy: "caution" },
  "skill.delete": { effect: "mutate-workspace", storage: "skills/*", external: "-", autonomy: "caution" },
  "skill.clone": { effect: "mutate-workspace", storage: "skills/*", external: "-", autonomy: "caution" },
  "skill.assign": { effect: "mutate-workspace", storage: "workspace/current.json (node.assignedSkills), changes/, revisions/", external: "-", autonomy: "caution" },
  "skill.unassign": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "skill.list_versions": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "skill.get_version": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "skill.restore_version": { effect: "mutate-workspace", storage: "skills/*", external: "-", autonomy: "caution" },
  "skill.validate": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "skill.resolve_for_node": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  // workspace.*
  "workspace.get_nodes": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workspace.get_graph": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workspace.get_node": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workspace.create_node": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.delete_node": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "operator", note: "Canonical nodes cannot be removed without adminApproved+allowCanonicalNodeRemoval." },
  "workspace.clone_node": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.update_node": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution", note: "Store-mode overlay: prompt/schema/tools/model/metadata changes reach the NEXT run of every workflow sharing the node id." },
  "workspace.update_node_prompt": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.update_node_input_schema": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.update_node_output_schema": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution", note: "Changes what the executor validates model output against; publisher.ts still validates article_body against the CANONICAL schema." },
  "workspace.update_node_tools": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "operator", note: "Changing tool grants on a publish/admin node is an operator decision (canonical publish nodes already carry project.call_tool); this tool records only change history as a guard." },
  "workspace.update_node_skills": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.update_node_dependencies": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution", note: "Topology is PINNED to canonical at run time (overlayStoreNode); a store dependsOn edit does not change what runs." },
  "workspace.update_node_metadata": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "operator", note: "Metadata carries the *Deterministic route flags (incl. publishExecutorDeterministic). This tool replaces the row's metadata field; the run-time overlay merges it per key with canonical." },
  "workspace.update_node_model_config": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.reorder_nodes": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  "workspace.update_graph": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "operator" },
  "workspace.validate_graph": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workspace.validate_node": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workspace.get_node_effective_config": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workspace.export_workspace": { effect: "read", storage: "-", external: "-", autonomy: "safe", note: "Returns the whole document incl. stage outputs and observations (can be large)." },
  "workspace.import_workspace": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "operator", note: "Upserts nodes/stage outputs/observations by id with no version check." },
  "workspace.update_relationships": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution" },
  // stage.* / learning.*
  "stage.save_output": { effect: "mutate-workspace", storage: "workspace/current.json (stageOutputs)", external: "-", autonomy: "caution", note: "Every save is a full-document CAS write." },
  "stage.get_output": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "stage.list_outputs": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "learning.record_observation": { effect: "mutate-learning", storage: "workspace/current.json (learningObservations)", external: "-", autonomy: "caution" },
  "learning.list_observations": { effect: "read", storage: "-", external: "-", autonomy: "safe", note: "KNOWN DEFECT on gcs/blobs: lists the learning/ prefix, which the conversation-turn ledger shares (docs/KNOWN_ISSUES.md C-1)." },
  "learning.archive_observation": { effect: "mutate-learning", storage: "workspace/current.json", external: "-", autonomy: "caution" },
  "learning.archive_observations": { effect: "mutate-learning", storage: "workspace/current.json", external: "-", autonomy: "caution" },
  // publish.* / repository.*
  "publish.build_payload": { effect: "external-read", storage: "-", external: "one read-only object_validate on the project MCP (runId form)", autonomy: "safe", note: "Never publishes." },
  "publish.validate_payload": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "repository.get_health": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  // workflow.*
  "workflow.start_dry_run": { effect: "mutate-run", storage: "runs/, run-index/", external: "-", autonomy: "caution", note: "Creates a run record (snapshotting publishing policy). Despite the name, executionMode defaults to \"openai\" and the run can publish live." },
  "workflow.get_run": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workflow.list_runs": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workflow.run_next_node": { effect: "execute-model", storage: "runs/, artifacts/, usage/, node_timings/, workspace/current.json (stage mirror)", external: "model provider; project MCP; pdf-tool; web", autonomy: "caution", note: "Advances one node under the per-run lock + CAS. Publish-risk nodes are gated by resolvePublishAuthority." },
  "workflow.run_node": { effect: "execute-model", storage: "runs/, artifacts/, usage/", external: "model provider; project MCP", autonomy: "caution" },
  "workflow.run_until": { effect: "execute-model", storage: "runs/, artifacts/, usage/", external: "model provider; project MCP", autonomy: "caution", note: "Bounded by RUN_DRIVER_TIME_BUDGET_MS (<=45s); the continuation tick continues the run." },
  "workflow.run_all": { effect: "execute-model", storage: "runs/, artifacts/, usage/", external: "model provider; project MCP; may PUBLISH under autonomous policy", autonomy: "caution", note: "Can reach publish_executor/release_executor when the run's policy snapshot is autonomous." },
  "workflow.pause_run": { effect: "mutate-run", storage: "runs/", external: "-", autonomy: "caution" },
  "workflow.cancel_run": { effect: "mutate-run", storage: "runs/", external: "-", autonomy: "caution" },
  "workflow.resume_run": { effect: "mutate-run", storage: "runs/", external: "-", autonomy: "caution" },
  "workflow.retry_node": { effect: "execute-model", storage: "runs/, usage/", external: "model provider; project MCP", autonomy: "caution" },
  "workflow.set_operator_publish_decision": { effect: "mutate-run", storage: "runs/ (operatorPublishDecision)", external: "-", autonomy: "operator", note: "THE operator approval/veto. \"approved\" authorizes live publishing for that run." },
  "workflow.set_node_budget_override": { effect: "mutate-run", storage: "runs/", external: "-", autonomy: "caution" },
  "workflow.reset_run": { effect: "mutate-run", storage: "runs/, artifacts/ (deletes prior artifacts)", external: "-", autonomy: "caution" },
  "workflow.get_run_context": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workflow.get_run_cost": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "workflow.publish_run": { effect: "publish", storage: "runs/ (via hooks), workspace/current.json (observation)", external: "project MCP object_create/checkout/validate/patch/publish/checkin", autonomy: "operator", note: "Five closed gates (publisher.ts). live:true + all gates → irreversible tenant write. Never releases to production (release_executor does)." },
  "workflow.publish_readiness": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  // usage.*
  "usage.record": { effect: "mutate-learning", storage: "usage/", external: "-", autonomy: "caution" },
  "usage.list_records": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "usage.get_summary": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "usage.get_budget_status": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  // project.*
  "project.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "project.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "project.test_connection": { effect: "external-read", storage: "-", external: "project MCP initialize", autonomy: "safe" },
  "project.list_tools": { effect: "external-read", storage: "-", external: "project MCP tools/list", autonomy: "safe" },
  "project.call_tool": { effect: "external-mutate", storage: "-", external: "ANY allowed tool on the project MCP (incl. publish/deploy/commerce for full-access projects)", autonomy: "operator", note: "Permission = toolPolicies > allowedTools > defaultToolPolicy > blocked. Dr. Lurie defaults to allowed for everything except wipe_blob_stores." },
  "project.call_read_tool": { effect: "external-read", storage: "-", external: "READ_TOOL_ALLOWLIST operations on the project MCP", autonomy: "safe" },
  "project.validate_handoff": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "project.get_registration_contract": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "project.create": { effect: "mutate-registry", storage: "projects/", external: "-", autonomy: "caution" },
  "project.update": { effect: "mutate-registry", storage: "projects/", external: "-", autonomy: "operator", note: "Can widen tool policies and set autonomyMode; no version check on save." },
  "project.delete": { effect: "mutate-registry", storage: "projects/", external: "-", autonomy: "operator" },
  // site.* / credentials / visual identity
  "site.duplicate": { effect: "admin", storage: "projects/, runs/, auth/managed-scoped-bearers.v1.json, run-index/", external: "Netlify API (site create, env vars, build hook, deploy), platform create-site CLI, project MCP; starts a capture/clone run", autonomy: "operator", note: "Genesis. SITE_GENESIS_NETLIFY_MODE=live performs real writes." },
  "site.duplicate_status": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "site_credentials_plan": { effect: "read", storage: "-", external: "-", autonomy: "safe", note: "Internal name has no dot: MCP_EXPOSED_TOOL_PREFIXES=site does NOT expose it." },
  "site_credentials_apply": { effect: "admin", storage: "-", external: "Cloud Run Jobs API (fires site-credential-reconciler --apply)", autonomy: "operator", note: "Requires SITE_CREDENTIAL_RECONCILER_GCP_PROJECT/REGION on the service." },
  "site_credentials_execution_status": { effect: "external-read", storage: "-", external: "Cloud Run Jobs API", autonomy: "safe" },
  "visual_identity.propose": { effect: "execute-model", storage: "usage/", external: "vision model provider", autonomy: "caution", note: "One model turn, no site write." },
  // agent.*
  "agent.resolve": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "agent.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "agent.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "agent.update": { effect: "mutate-workspace", storage: "workspace/current.json (conversationalAgents), changes/, revisions/", external: "-", autonomy: "caution" },
  "agent.converse": { effect: "execute-model", storage: "conversation-turn-claims/, conversations/, usage/", external: "model provider (exactly one request)", autonomy: "caution", note: "Idempotent on (conversation_id, turn_id). Returns tool calls as proposals; never executes them." },
  // changes.* / constellation.*
  "changes.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "changes.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "changes.compare": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "changes.restore": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "caution", note: "Restore is a new revision; history is never deleted." },
  "constellation.get_structure": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "constellation.get_metrics": { effect: "read", storage: "-", external: "-", autonomy: "safe", note: "Full-fleet run scan." },
  "constellation.get_relationship": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "constellation.get_summary": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "constellation.get_attention": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  // evaluation.* / feedback.* / dataset.* / optimizer.* / playbook.*
  "evaluation.create_rubric": { effect: "mutate-learning", storage: "evaluation/rubrics, evaluation/rubric-versions", external: "-", autonomy: "caution" },
  "evaluation.update_rubric": { effect: "mutate-learning", storage: "evaluation/rubrics, evaluation/rubric-versions", external: "-", autonomy: "caution" },
  "evaluation.get_rubric": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "evaluation.list_rubrics": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "evaluation.list_rubric_versions": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "evaluation.restore_rubric_version": { effect: "mutate-learning", storage: "evaluation/rubrics", external: "-", autonomy: "caution" },
  "evaluation.run": { effect: "execute-model", storage: "evaluation/results, usage/", external: "judge model provider", autonomy: "caution" },
  "evaluation.list_results": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "evaluation.get_result": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "evaluation.run_regression": { effect: "execute-model", storage: "evaluation/regression, evaluation/results, runs/ (trial_ runs), usage/", external: "model provider (replay + judge)", autonomy: "caution" },
  "evaluation.list_regression_reports": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "feedback.record": { effect: "mutate-learning", storage: "evaluation/feedback", external: "-", autonomy: "caution" },
  "feedback.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "feedback.ingest_monetizer": { effect: "external-read", storage: "evaluation/feedback", external: "Monetizer MCP read tools", autonomy: "safe" },
  "feedback.ingest_tracking": { effect: "external-read", storage: "evaluation/feedback", external: "tracking sink HTTPS", autonomy: "safe" },
  "dataset.build": { effect: "mutate-learning", storage: "improvement/datasets", external: "-", autonomy: "caution" },
  "dataset.list": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "dataset.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "dataset.export_sft": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "dataset.export_preferences": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "dataset.finetune_readiness": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "optimizer.analyze": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "optimizer.propose": { effect: "execute-model", storage: "improvement/proposals, usage/", external: "reflector model (mode openai) or none (mock)", autonomy: "caution", note: "Propose-only; nothing is applied." },
  "optimizer.run_trial": { effect: "execute-model", storage: "improvement/trials, runs/ (trial_ prefix), usage/", external: "model provider", autonomy: "caution" },
  "optimizer.promote": { effect: "mutate-workspace", storage: "workspace/current.json (node prompt), changes/, revisions/, improvement/proposals", external: "-", autonomy: "operator", note: "Changes a live prompt (store mode = next run)." },
  "optimizer.status": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "optimizer.auto_promote": { effect: "mutate-workspace", storage: "workspace/current.json, changes/, revisions/", external: "-", autonomy: "operator", note: "Eval-gated; low-risk nodes only; has a dry-run preview." },
  "playbook.get": { effect: "read", storage: "-", external: "-", autonomy: "safe" },
  "playbook.apply_delta": { effect: "mutate-learning", storage: "improvement/playbooks", external: "-", autonomy: "caution", note: "Playbooks are injected into node prompts on the next dispatch." },
  "playbook.curate": { effect: "mutate-learning", storage: "improvement/playbooks, usage/ (openai mode)", external: "curator model (mode openai)", autonomy: "caution" },
  "playbook.migrate_observations": { effect: "mutate-learning", storage: "improvement/playbooks", external: "-", autonomy: "caution" }
};

const heuristic = (name: string): Row => {
  const verb = name.split(".").pop() ?? name;
  const read = /^(get|list|validate|compare|resolve|status|analyze|readiness|export|prepare|test)/.test(verb);
  return { effect: read ? "read" : "mutate-workspace", storage: read ? "-" : "UNKNOWN (heuristic)", external: "UNKNOWN (heuristic)", autonomy: read ? "safe" : "caution", note: "(heuristic — not hand-classified)" };
};

const namespaceOf = (internal: string): string => (internal.includes(".") ? internal.split(".")[0] : internal);
const fence = (value: unknown): string => "```json\n" + JSON.stringify(value, null, 2) + "\n```";
const esc = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function render(): Promise<string> {
  const tools = createWorkspaceTools({}).map((tool) => ({ internal: tool.name, wire: canonicalToolName(tool.name), description: tool.description, inputSchema: tool.inputSchema }));
  tools.sort((a, b) => a.wire.localeCompare(b.wire));
  const byNamespace = new Map<string, typeof tools>();
  for (const tool of tools) {
    const ns = namespaceOf(tool.internal);
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), tool]);
  }
  const lines: string[] = [];
  lines.push("# MCP tool reference (generated)");
  lines.push("");
  lines.push("<!-- GENERATED by scripts/generateMcpToolReference.ts — do not edit by hand. Regenerate: npx tsx scripts/generateMcpToolReference.ts -->");
  lines.push("");
  lines.push(`Source of truth: \`createWorkspaceTools\` in \`src/agent/mcp/workspace/tools.ts\` (and the modules it composes). ${tools.length} tools, ${byNamespace.size} namespaces, ${Object.keys(DEPRECATED_TOOL_ALIASES).length} deprecated aliases. The wire-surface lock is \`docs/mcp-tool-manifest.json\` (\`npm run test:drift\`).`);
  lines.push("");
  lines.push("How to read this file: **wire name** is what `tools/list` advertises and what remote connectors must call; the **internal** dotted name is also accepted by `tools/call`. **Effect** classes: `read` (no writes), `mutate-workspace` (workspace document / skills — change-history recorded), `mutate-run` (a run record), `mutate-registry` (project records), `mutate-learning` (evaluation / improvement / usage / observations), `execute-model` (spends model budget), `external-read` / `external-mutate` (reaches a project MCP or another external system), `publish` (writes a tenant's live site), `admin` (fleet / infrastructure). **Autonomy**: `safe` = an unattended agent may call it; `caution` = writes durable state, spends money, or reaches a tenant; `operator` = irreversible, fleet-wide, or production-affecting — a human should be in the loop. No MCP tool requires a human approval step inside CMS-Agent itself; approval semantics live in the publish gates (`docs/PUBLISHING_ARCHITECTURE.md`) and project tool policies (`needs_approval`). Authorization is per bearer, see `docs/MCP_ARCHITECTURE.md` (a static `MCP_API_TOKEN` or OAuth token can call every listed tool; a scoped bearer only its allowlist).");
  lines.push("");
  lines.push("## Summary by namespace");
  lines.push("");
  lines.push("| Namespace | Tools | read | mutating | execute-model / external | operator-only |");
  lines.push("|---|---|---|---|---|---|");
  for (const [ns, list] of [...byNamespace.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = list.map((tool) => CURATED[tool.internal] ?? heuristic(tool.internal));
    const count = (predicate: (row: Row) => boolean) => rows.filter(predicate).length;
    lines.push(`| \`${ns}\` | ${list.length} | ${count((r) => r.effect === "read")} | ${count((r) => r.effect.startsWith("mutate"))} | ${count((r) => r.effect === "execute-model" || r.effect.startsWith("external") || r.effect === "publish" || r.effect === "admin")} | ${count((r) => r.autonomy === "operator")} |`);
  }
  lines.push("");
  lines.push("## Deprecated aliases (accepted by tools/call, never listed)");
  lines.push("");
  lines.push("| Alias (dotted / wire) | Resolves to |");
  lines.push("|---|---|");
  for (const [alias, target] of Object.entries(DEPRECATED_TOOL_ALIASES)) lines.push(`| \`${alias}\` / \`${canonicalToolName(alias)}\` | \`${canonicalToolName(target)}\` |`);
  lines.push("");
  lines.push("## Tools");
  lines.push("");
  for (const [ns, list] of [...byNamespace.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### \`${ns}\``);
    lines.push("");
    lines.push("| Wire name | Effect | Storage written | External reach | Autonomy | Note |");
    lines.push("|---|---|---|---|---|---|");
    for (const tool of list) {
      const row = CURATED[tool.internal] ?? heuristic(tool.internal);
      lines.push(`| [\`${tool.wire}\`](#${tool.wire}) | ${row.effect} | ${esc(row.storage)} | ${esc(row.external)} | ${row.autonomy} | ${esc(row.note ?? "")} |`);
    }
    lines.push("");
    for (const tool of list) {
      const row = CURATED[tool.internal] ?? heuristic(tool.internal);
      lines.push(`#### \`${tool.wire}\``);
      lines.push("");
      lines.push(`Internal name: \`${tool.internal}\` · Effect: **${row.effect}** · Autonomy: **${row.autonomy}**`);
      lines.push("");
      lines.push(tool.description);
      lines.push("");
      if (row.note) { lines.push(`> ${row.note}`); lines.push(""); }
      lines.push("<details><summary>Input schema</summary>");
      lines.push("");
      lines.push(fence(tool.inputSchema));
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }
  lines.push("## Output envelope");
  lines.push("");
  lines.push("Success: `{ \"ok\": true, \"data\": <result> }` inside the MCP `structuredContent` (and JSON-stringified in `content[0].text`). Failure: a JSON-RPC error `{ code: -32603, message: \"<code>: <summary>\", data: { ok: false, error: { code, message?, issues? } } }` — see `toolError` / `toolErrorSummary` in `src/agent/mcp/workspace/toolKit.ts`. Unknown tool: `-32602`. Output schemas are not declared per tool on the wire (no `outputSchema` in `tools/list`); the TypeScript return types in the tool modules are the only contract.");
  lines.push("");
  return lines.join("\n");
}

// The hand-written docs quote the catalog size ("151 tools", "all 151"). Those numbers are prose,
// not derived, so --check also scans them and refuses when any quoted count disagrees with the live
// catalog — the reference stays derived, and the prose can only ever be stale by one failing check.
const COUNT_QUOTING_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", "docs/AI_CONTEXT.md", "docs/ARCHITECTURE.md", "docs/MCP_ARCHITECTURE.md", "docs/SECURITY.md", "docs/GLOSSARY.md", "docs/KNOWN_ISSUES.md"];
const COUNT_PATTERNS = [/\b(\d{2,3}) (?:MCP )?tools\b/g, /\ball (\d{2,3})\b(?=[^\n]{0,40}tool)/g];
const checkQuotedToolCounts = async (expected: number): Promise<string[]> => {
  const problems: string[] = [];
  for (const relative of COUNT_QUOTING_DOCS) {
    const text = await readFile(path.resolve(ROOT, relative), "utf8").catch(() => "");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const pattern of COUNT_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line))) {
          const quoted = Number(match[1]);
          // Only catalog-sized numbers are treated as a catalog count; small numbers ("11 tools" in a
          // scoped allowlist, "49 controlled tools") describe other things and are left alone.
          if (quoted >= 100 && quoted !== expected) problems.push(`${relative}:${index + 1} says "${match[0]}" but the catalog has ${expected} tools`);
        }
      }
    });
  }
  return problems;
};

const main = async () => {
  const check = process.argv.includes("--check");
  const content = await render();
  if (check) {
    const existing = await readFile(OUTPUT, "utf8").catch(() => "");
    if (existing !== content) { console.error(`docs/reference/MCP_TOOLS.md is stale; run: npx tsx scripts/generateMcpToolReference.ts`); process.exit(1); }
    const problems = await checkQuotedToolCounts(catalogSize());
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    console.log(`docs/reference/MCP_TOOLS.md is current (${catalogSize()} tools); quoted counts in ${COUNT_QUOTING_DOCS.length} docs agree.`);
    return;
  }
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, content, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), OUTPUT)}`);
};

await main();
