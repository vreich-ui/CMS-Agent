/**
 * Verb policy: which MCP tools are read-only vs mutating, transcribed
 * verbatim from spec/HANDOFF.md §6 ("Verb map (UI action -> MCP tool)").
 *
 * Any verb in neither set is refused by default (default-deny) — an
 * unrecognized verb reaching this broker is either a spec drift bug or an
 * attempted bypass, and either way the safe response is "no", not "sure,
 * I'll pass it through."
 */

// spec/HANDOFF.md §6, "Read:" list.
export const READ_VERBS: ReadonlySet<string> = new Set([
  "workspace_get_graph",
  "workspace_get_nodes",
  "workspace_get_node",
  "workspace_get_node_effective_config",
  "node_get_effective_prompt",
  "node_get_effective_skills",
  "node_get_effective_tools",
  "node_get_input_schema",
  "node_get_output_schema",
  "workflow_list_runs",
  "workflow_get_run",
  "workflow_get_run_context",
  "workflow_get_run_cost",
  "node_list_executions",
  "stage_list_outputs",
  "stage_get_output",
  "changes_list",
  "changes_get",
  "changes_compare",
  "project_list",
  "project_test_connection",
  "tool_list",
  "skill_list",
  "skill_resolve_for_node",
  "agent_list",
  "usage_get_summary",
  "usage_get_budget_status",
  "learning_list_observations",
  "playbook_get",
  "evaluation_list_rubrics",
  "evaluation_list_results",
  "evaluation_list_regression_reports",
  "dataset_list",
  "dataset_finetune_readiness",
  "feedback_list",
  "optimizer_status",
  "repository_get_health",
  // Read-shaped per §6 ("no confirm"), grouped with reads for policy purposes.
  "node_validate_input",
  "workspace_validate_node",
]);

// spec/HANDOFF.md §6, "Mutating (always confirmAction):" list.
export const MUTATING_VERBS: ReadonlySet<string> = new Set([
  "workflow_start_dry_run",
  "workflow_run_all",
  "workflow_run_next_node",
  "workflow_run_until",
  "workflow_run_node",
  "workflow_pause_run",
  "workflow_resume_run",
  "workflow_cancel_run",
  "workflow_reset_run",
  "workflow_retry_node",
  "workflow_set_operator_publish_decision",
  "workflow_publish_run",
  "workspace_update_node_prompt",
  "workspace_update_node_tools",
  "workspace_update_node_skills",
  "workspace_update_node_model_config",
  "workspace_update_node_input_schema",
  "workspace_update_node_output_schema",
  "workspace_update_node_metadata",
  "changes_restore",
  "skill_update",
  "skill_assign",
  "skill_unassign",
  "skill_restore_version",
  "learning_record_observation",
  "learning_archive_observation",
  "playbook_curate",
  "playbook_apply_delta",
  "playbook_migrate_observations",
  "feedback_record",
  "evaluation_create_rubric",
  "evaluation_update_rubric",
  "evaluation_run",
  "evaluation_run_regression",
  "evaluation_restore_rubric_version",
  "optimizer_analyze",
  "optimizer_propose",
  "optimizer_run_trial",
  "optimizer_promote",
  "optimizer_auto_promote",
  "dataset_build",
  "dataset_export_sft",
  "dataset_export_preferences",
]);

export type VerbClass = "read" | "mutating" | "unknown";

export function classifyVerb(verb: string): VerbClass {
  if (READ_VERBS.has(verb)) return "read";
  if (MUTATING_VERBS.has(verb)) return "mutating";
  return "unknown";
}

export interface PolicyDecision {
  allowed: boolean;
  code?: "unknown_verb" | "read_only";
  message?: string;
}

/**
 * Decides whether a verb call may proceed. Default-deny for unknown verbs;
 * blocks mutating verbs when readOnly is on, naming the env flag that
 * would unblock them.
 */
export function checkPolicy(verb: string, readOnly: boolean): PolicyDecision {
  const cls = classifyVerb(verb);

  if (cls === "unknown") {
    return {
      allowed: false,
      code: "unknown_verb",
      message: `Verb "${verb}" is not recognized (not in READ_VERBS or MUTATING_VERBS per spec/HANDOFF.md §6). Refusing by default.`,
    };
  }

  if (cls === "mutating" && readOnly) {
    return {
      allowed: false,
      code: "read_only",
      message: `Verb "${verb}" is mutating and this broker is running with READ_ONLY on. Set READ_ONLY=0 to allow mutations.`,
    };
  }

  return { allowed: true };
}
