// blockage.v1 — THE ONE CONTRACT for "this stopped and a human can unstick it".
//
// WHY THIS EXISTS. The engine has always known both halves of an actionable wall: what happened
// (budgetGuard.ts's structured `details` — nodeId, ceiling, spentUsd, suggestedBudgetUsd) and what
// would fix it (`operatorAction`, a whole English sentence naming the raise). Neither half survived
// the trip to a human. The conductor kept them on `state.output.error`; the independent-node path
// (nodeRuntime.ts) threw them away and persisted `state.errors = [code, message]` — two strings;
// visual_identity.propose then string-joined THOSE into one prose line; platform flattened that
// twice more (`err(502, code, message)`, `new Error(body.error)`) until the browser held a sentence.
// A sentence cannot be a button. So the remedy the engine had computed was re-typed by a human into
// an MCP call, or more often not at all.
//
// The fix is not more prose. It is a payload that is minted ONCE, here, at the point where the code
// and its details are still structured, and is carried UNCHANGED to the browser. Every surface
// (Imagery card, Requests card, chat transcript, chat text answer) renders the same object and posts
// back the same `{blockage_id, remedy_id}` pair.
//
// DIVISION OF LABOUR, deliberately:
//   * The ENGINE owns what happened and what would fix it — semantics: "raise this node's budget to
//     $1.50, for this attempt". It has the numbers; nothing downstream can recompute them.
//   * The PLATFORM owns labels, role gating and rendering — "Raise to $1.50 for this attempt",
//     Owner-only, primary button. A remedy carries NO ui strings, NO colors, NO permissions.
// That line is what keeps a new blockage kind from needing UI work beyond a label, and what lets the
// remedy table be unit-tested without a DOM.
import { createHash } from "node:crypto";

export const blockageKinds = ["budget", "approval", "limit", "config", "auth", "validation", "other"] as const;
export type BlockageKind = typeof blockageKinds[number];

// SEMANTIC, not UI. `type` says what to do to the system; `args` carries the numbers the engine
// already computed. Platform maps type -> label + handler + required role in ONE pure module
// (packages/core/lib/admin/blockage.ts).
export const remedyTypes = [
  "raise_node_budget",   // args: { scope: "attempt"|"run"|"default", budgetUsd }
  "raise_run_budget",    // args: { budgetUsd }
  "raise_limit",         // args: { field, value }
  "retry",               // args: {}
  "resume",              // args: {}
  "approve_gate",        // args: { gateId? }
  "decline_gate",        // args: { gateId? }
  "set_project_field",   // args: { field }
  "open_settings",       // args: { path }
  "cancel"               // args: {}
] as const;
export type RemedyType = typeof remedyTypes[number];

export type Remedy = {
  /** Stable within a blockage; what a surface posts back. Never localized, never a label. */
  id: string;
  type: RemedyType;
  args?: Record<string, unknown>;
  /** The one a bare "yes"/"go ahead" in chat means. At most one per blockage. */
  default?: boolean;
};

export type BlockageScope = {
  run_id?: string;
  execution_id?: string;
  node_id: string;
  gate_id?: string;
  /** Present for a blockage minted on a synchronous tool path (visual_identity.propose), naming it. */
  tool?: string;
};

export type Blockage = {
  /** Deterministic: the same wall, re-derived from the same run/node/code/attempt, is the same id. */
  blockage_id: string;
  contract: "blockage.v1";
  code: string;
  kind: BlockageKind;
  message: string;
  details?: Record<string, unknown>;
  /** The engine's own English sentence, when it wrote one. UI may show it; it never parses it. */
  operator_action?: string;
  remedies: Remedy[];
  scope: BlockageScope;
};

/**
 * IDEMPOTENCY KEY, and the reason a card and a chat message can both offer the same raise without
 * charging twice: both post back this id, and the platform's ledger resolves it once (D4). Derived,
 * not random, so a second read of the same failed state mints the same id rather than a new one the
 * ledger has never seen.
 */
export const blockageId = (parts: { runId?: string; nodeId: string; code: string; attempt?: number }): string =>
  `blk_${createHash("sha1")
    .update([parts.runId ?? "", parts.nodeId, parts.code, String(parts.attempt ?? 1)].join("|"))
    .digest("hex")
    .slice(0, 16)}`;

/** The failed half of NodeRunnerResult, plus what the executor knows about where it happened. */
export type BlockageSource = {
  code: string;
  message: string;
  details?: unknown;
  operatorAction?: string;
};

export type BlockageContext = BlockageScope & {
  attempt?: number;
  /**
   * WHICH RAISES ARE REACHABLE FROM HERE — the distinction F4 turns on.
   *   "sync": nodeRuntime.executeNode / visual_identity.propose. The run record is synthetic
   *     (workflowId "independent_node"), so workflow.set_node_budget_override + retry_node cannot
   *     address it; a one-shot `modelConfigOverride` on the next call can ("attempt"), as can
   *     editing the node's stored default.
   *   "run": a real conductor run. The per-run override + retry_node path applies ("run"), as does
   *     the stored default. There is no "attempt" — a run's node is retried, not re-called.
   */
  surface: "sync" | "run";
};

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

// ONLY for a record the guard could not size itself: a legacy state, or a details bag that predates
// suggestedBudgetUsd. Without spend figures there is nothing to compute from, so this is a stated
// convention, not arithmetic: 4x the ceiling that just failed, floored at $0.50 and rounded to the
// nearest $0.50 (budgetGuard.suggestBudgetUsd's own rounding, so the two never differ by a cent).
// Deliberately not 2x — the case this fires for is a ceiling that could not cover ONE turn
// (brand_imagery_writer's $0.25 against a ~$0.78 vision turn), and a suggestion that trips again on
// the very next attempt teaches an operator to distrust the button.
const fallbackSuggestion = (budgetUsd?: number): number => Math.max(0.5, Math.ceil((budgetUsd ?? 0.25) * 4 * 2) / 2);

const budgetRemedies = (details: Record<string, unknown>, context: BlockageContext): Remedy[] => {
  const budgetUsd = num(details.suggestedBudgetUsd) ?? fallbackSuggestion(num(details.budgetUsd));
  const remedies: Remedy[] = [];
  if (context.surface === "sync") {
    // The cheap, reversible one, and therefore the default: it changes nothing stored.
    remedies.push({ id: "raise_budget_attempt", type: "raise_node_budget", args: { scope: "attempt", budgetUsd }, default: true });
  } else if (context.run_id) {
    remedies.push({ id: "raise_budget_run", type: "raise_node_budget", args: { scope: "run", budgetUsd, runId: context.run_id, nodeId: context.node_id }, default: true });
  }
  remedies.push({ id: "raise_budget_default", type: "raise_node_budget", args: { scope: "default", budgetUsd, nodeId: context.node_id } });
  remedies.push({ id: "cancel", type: "cancel" });
  return remedies;
};

/**
 * code -> kind + remedies. §4 of the plan, in code. Entries with no remedy beyond "cancel" are
 * deliberate: a card that says "nothing here can fix this, here is exactly what broke" is still
 * worth more than a red X, and it is what the header's Blocked (vs Needs you) count keys on (D7).
 */
export function toBlockage(source: BlockageSource, context: BlockageContext): Blockage {
  const details = isBag(source.details) ? source.details : undefined;
  const scope: BlockageScope = {
    node_id: context.node_id,
    ...(context.run_id ? { run_id: context.run_id } : {}),
    ...(context.execution_id ? { execution_id: context.execution_id } : {}),
    ...(context.gate_id ? { gate_id: context.gate_id } : {}),
    ...(context.tool ? { tool: context.tool } : {})
  };
  const base = {
    blockage_id: blockageId({ runId: context.run_id, nodeId: context.node_id, code: source.code, attempt: context.attempt }),
    contract: "blockage.v1" as const,
    code: source.code,
    message: source.message,
    ...(details ? { details } : {}),
    ...(source.operatorAction ? { operator_action: source.operatorAction } : {}),
    scope
  };

  switch (source.code) {
    case "budget_exceeded": {
      // T6's pricingUnknown case is NOT a budget wall: no real rate exists, so every dollar figure in
      // `details` is meaningless and a raise would not help. It is a catalog/config gap.
      if (details?.pricingUnknown === true) {
        return { ...base, kind: "config", remedies: [{ id: "open_model_settings", type: "open_settings", args: { path: "node_model", nodeId: context.node_id }, default: true }, { id: "cancel", type: "cancel" }] };
      }
      return { ...base, kind: "budget", remedies: budgetRemedies(details ?? {}, context) };
    }
    case "approval_required":
      return {
        ...base,
        kind: "approval",
        remedies: [
          { id: "approve", type: "approve_gate", args: { ...(context.gate_id ? { gateId: context.gate_id } : {}), runId: context.run_id }, default: true },
          { id: "decline", type: "decline_gate", args: { ...(context.gate_id ? { gateId: context.gate_id } : {}), runId: context.run_id } }
        ]
      };
    case "tenant_verb_needs_approval": {
      const match = source.message.match(/^"([^"]+)" is set to "needs approval" for project "([^"]+)"/);
      const verb = match?.[1];
      const projectId = match?.[2];
      return {
        ...base,
        kind: "approval",
        details: {
          ...(details ?? {}),
          ...(verb ? { verb } : {}),
          ...(projectId ? { projectId } : {}),
          transportAttempted: false,
          approvalTransportAvailable: false
        },
        remedies: [
          {
            id: "open_tenant_tool_policy",
            type: "open_settings",
            args: { path: "project_access", ...(projectId ? { projectId } : {}), ...(verb ? { tool: verb } : {}) },
            default: true
          },
          { id: "retry", type: "retry", args: { runId: context.run_id, nodeId: context.node_id } },
          { id: "cancel", type: "cancel" }
        ]
      };
    }
    case "max_turns_exceeded": {
      const maxTurns = num(details?.maxTurns);
      const toolCallLimit = num(details?.toolCallLimit);
      return {
        ...base,
        kind: "limit",
        remedies: [
          { id: "raise_max_turns", type: "raise_limit", args: { field: "maxTurns", value: maxTurns !== undefined ? maxTurns * 2 : undefined, nodeId: context.node_id }, default: true },
          ...(toolCallLimit !== undefined ? [{ id: "raise_tool_call_limit", type: "raise_limit" as const, args: { field: "toolCallLimit", value: toolCallLimit * 2, nodeId: context.node_id } }] : []),
          { id: "retry", type: "retry", args: { runId: context.run_id, nodeId: context.node_id } },
          { id: "cancel", type: "cancel" }
        ]
      };
    }
    case "truncated": {
      const maxOutputTokens = num(details?.maxOutputTokens);
      return {
        ...base,
        kind: "limit",
        remedies: [
          { id: "raise_max_output_tokens", type: "raise_limit", args: { field: "maxOutputTokens", value: maxOutputTokens !== undefined ? maxOutputTokens * 2 : undefined, nodeId: context.node_id }, default: true },
          { id: "cancel", type: "cancel" }
        ]
      };
    }
    case "model_error":
    case "model_timeout":
    case "timeout":
    case "tool_failed":
    case "provider_rate_limit":
    case "provider_quota":
    case "output_validation_failed":
      // The orchestrator already auto-retried these twice (nodeRetryPolicy) before anyone saw a card,
      // so "retry" here means "I have looked at it and want another attempt", not a first try.
      return { ...base, kind: "other", remedies: [{ id: "retry", type: "retry", args: { runId: context.run_id, nodeId: context.node_id }, default: true }, { id: "cancel", type: "cancel" }] };
    case "input_validation_failed":
    case "node_not_ready":
      return { ...base, kind: "validation", remedies: [{ id: "cancel", type: "cancel" }] };
    case "paused":
      return { ...base, kind: "other", remedies: [{ id: "resume", type: "resume", args: { runId: context.run_id }, default: true }, { id: "cancel", type: "cancel" }] };
    case "cancelled":
      // A cancelled node is a DECISION someone made, not a wall. Offering
      // "Resume" here would be a button that un-does a human's cancel by
      // implication; a retry is the honest re-entry and it says what it is.
      return { ...base, kind: "other", remedies: [{ id: "retry", type: "retry", args: { runId: context.run_id, nodeId: context.node_id } }, { id: "cancel", type: "cancel" }] };
    default: {
      // THE PREFIXED CODES, matched by prefix rather than equality — because
      // that is how the engine actually writes them. driverEnvPreflight.ts
      // emits `driver_env_missing:<VAR>`, `driver_auth_failed:<VAR>` and
      // `client_auth_failed:<VAR>`: the variable name is part of the code, so
      // an equality case for the bare token can never match and every
      // credential failure fell through to a "Try again" button that cannot
      // possibly help. The variable name is carried into details so the
      // settings link can say WHICH credential.
      const prefixed = AUTH_CODE_PREFIXES.find((prefix) => source.code.startsWith(`${prefix}:`) || source.code === prefix);
      if (prefixed) {
        return {
          ...base,
          kind: "auth",
          details: { ...(details ?? {}), envVar: source.code.slice(prefixed.length + 1) || undefined },
          remedies: [{ id: "open_credentials", type: "open_settings", args: { path: "credentials" }, default: true }, { id: "cancel", type: "cancel" }]
        };
      }
      if (CONFIG_CODE_PREFIXES.some((prefix) => source.code.startsWith(prefix))) {
        return { ...base, kind: "config", remedies: [{ id: "set_mcp_endpoint", type: "set_project_field", args: { field: "mcpEndpoint" }, default: true }, { id: "cancel", type: "cancel" }] };
      }
      if (source.code.endsWith("_scope_missing") || source.code.endsWith("_input_missing") || source.code === "client_project_unresolved") {
        return {
          ...base,
          kind: "config",
          remedies: [
            { id: "repair_scope", type: "open_settings", args: { path: "project_configuration", nodeId: context.node_id }, default: true },
            { id: "retry", type: "retry", args: { runId: context.run_id, nodeId: context.node_id } },
            { id: "cancel", type: "cancel" }
          ]
        };
      }
      return { ...base, kind: "other", remedies: [{ id: "retry", type: "retry", args: { runId: context.run_id, nodeId: context.node_id }, default: true }, { id: "cancel", type: "cancel" }] };
    }
  }
}

/** Written by driverEnvPreflight.ts as `<prefix>:<ENV_VAR>` — never bare. */
const AUTH_CODE_PREFIXES = ["driver_env_missing", "driver_auth_failed", "client_auth_failed"] as const;
const CONFIG_CODE_PREFIXES = ["mcp_endpoint_missing", "project_endpoint_missing"] as const;

/** True when at least one remedy actually changes something — D7's Needs-you vs Blocked rule. */
export const isResolvable = (blockage: Blockage): boolean => blockage.remedies.some((remedy) => remedy.type !== "cancel");

// ---------------------------------------------------------------------------------------------
// Run-level walls. These never pass through a NodeRunnerResult — the conductor writes them on the
// run record itself — so they get their own minters rather than being faked into a runner result.
// ---------------------------------------------------------------------------------------------

export type RunBudgetBlockLike = { blockedAt: string; budgetUsd: number; spentUsdEstimate: number; nextNodeId?: string; reason: string };
export type ApprovalRequiredLike = { nodeId?: string; reason?: string; gateId?: string; pending?: boolean };

/**
 * The between-nodes run ceiling. NOTE the remedy is `raise_run_budget`, which has NO engine setter
 * today (there is no workflow.set_run_budget) — §4 flags it. It is emitted anyway so the card reads
 * honestly and the platform's remedy table can disable it with a stated reason rather than the run
 * showing up as an unexplained "blocked" with no card at all.
 */
export const runBudgetBlockage = (runId: string, block: RunBudgetBlockLike): Blockage => {
  const nodeId = block.nextNodeId ?? "run";
  // A record written before `spentUsdEstimate` existed has neither figure to
  // reason from. `Math.max(3, undefined)` is NaN, which reached the operator as
  // a "Raise run budget to $null" button and "$undefined spent" in the
  // sentence — both worse than saying nothing. Fall back to the ceiling alone.
  const ceiling = num(block.budgetUsd) ?? 0;
  const spent = num(block.spentUsdEstimate);
  const suggested = Math.max(0.5, Math.ceil(Math.max(ceiling, spent ?? ceiling) * 1.5 * 2) / 2);
  return {
    blockage_id: blockageId({ runId, nodeId, code: "run_budget_block", attempt: 1 }),
    contract: "blockage.v1",
    code: "run_budget_block",
    kind: "budget",
    message: spent !== undefined
      ? `Run stopped before "${nodeId}": $${spent} spent against the $${ceiling} run ceiling. ${block.reason}`
      : `Run stopped before "${nodeId}": the $${ceiling} run ceiling was reached. ${block.reason}`,
    details: { ...block },
    remedies: [
      { id: "raise_run_budget", type: "raise_run_budget", args: { budgetUsd: suggested, runId }, default: true },
      { id: "resume", type: "resume", args: { runId } },
      { id: "cancel", type: "cancel" }
    ],
    scope: { run_id: runId, node_id: nodeId }
  };
};

export const approvalBlockage = (runId: string, approval: ApprovalRequiredLike): Blockage => {
  const nodeId = approval.nodeId ?? "run";
  return toBlockage(
    { code: "approval_required", message: approval.reason ?? `"${nodeId}" is held for approval.`, details: { ...approval } },
    { run_id: runId, node_id: nodeId, ...(approval.gateId ? { gate_id: approval.gateId } : {}), surface: "run" }
  );
};

export type RunLike = {
  runId: string;
  status?: string;
  budgetBlock?: RunBudgetBlockLike;
  approvalsRequired?: Array<ApprovalRequiredLike & { source?: "operator_explicit" | "policy_autonomous" }>;
  nodes?: Array<{
    nodeId: string;
    status?: string;
    blockage?: Blockage;
    errors?: string[];
    warnings?: string[];
    output?: unknown;
  }>;
};

const errorFromStoppedNode = (node: NonNullable<RunLike["nodes"]>[number]): BlockageSource | undefined => {
  const outputError = isBag(node.output) && isBag(node.output.error) ? node.output.error : undefined;
  const outputCode = typeof outputError?.code === "string" ? outputError.code : undefined;
  const outputMessage = typeof outputError?.message === "string" ? outputError.message : undefined;
  const errorCode = node.errors?.find((value) => typeof value === "string" && value.trim())?.trim();
  const warningCode = node.warnings
    ?.map((value) => value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value)
    .find((value) => value === "tenant_verb_needs_approval" || value.endsWith("_scope_missing") || value.endsWith("_input_missing"));
  const code = outputCode ?? errorCode ?? warningCode;
  if (!code) return undefined;
  return {
    code,
    message: outputMessage ?? node.errors?.[1] ?? `Node "${node.nodeId}" stopped with ${code}.`,
    ...(outputError && "details" in outputError ? { details: outputError.details } : {}),
    ...(typeof outputError?.operatorAction === "string" ? { operatorAction: outputError.operatorAction } : {})
  };
};

/**
 * EVERY pending wall on one run, in the order a human should see them: the node that actually
 * stopped first, then the run-level holds. Deduplicated by blockage_id, because a node blockage and
 * a run-level approval for the same gate are the same wall seen from two records.
 */
export function collectRunBlockages(run: RunLike): Blockage[] {
  const out: Blockage[] = [];
  const seen = new Set<string>();
  // TWO keys, because blockage_id alone is not enough here. The node-level
  // blockage is minted with the node's attempt number; the run-level one
  // (approvalsRequired) has no attempt and defaults to 1, so the same gate seen
  // from both records collides only on the first attempt. A node that failed
  // once and then blocked on approval offered the SAME gate twice, under two
  // ids — approving one left the other pending forever. The semantic key
  // (code + node + gate) is what actually identifies a wall.
  const push = (blockage: Blockage) => {
    const semantic = `${blockage.code}|${blockage.scope.node_id}|${blockage.scope.gate_id ?? ""}`;
    if (seen.has(blockage.blockage_id) || seen.has(semantic)) return;
    seen.add(blockage.blockage_id);
    seen.add(semantic);
    out.push(blockage);
  };
  for (const node of run.nodes ?? []) {
    // A node that has since been retried and completed is not a pending wall, whatever its old
    // state carried — only a node still stopped counts.
    if (node.blockage && (node.status === "failed" || node.status === "blocked" || node.status === "cancelled")) {
      push(node.blockage);
      continue;
    }
    if (node.status === "failed" || node.status === "blocked") {
      const source = errorFromStoppedNode(node);
      if (source) push(toBlockage(source, { run_id: run.runId, node_id: node.nodeId, surface: "run" }));
    }
  }
  if (run.budgetBlock) push(runBudgetBlockage(run.runId, run.budgetBlock));
  for (const approval of run.approvalsRequired ?? []) {
    // GENUINE HOLDS ONLY — `pending === true`, never merely "not false".
    // The executor stamps an ADVISORY approval record on every publish-risk
    // node that proceeded under an autonomous policy, and that record omits
    // `pending` entirely (its own reason string says "Advisory only — nothing
    // is held"). Treating an absent flag as pending put an Approve/Decline pair
    // on every finished, successful autonomous run and pinned the Needs-you
    // count forever.
    // Current look-ahead holds say pending:true. Older attempted publish-gate holds omitted the
    // field, so retain them only while the RUN is still blocked. Autonomous-policy entries are
    // advisory evidence and can never become a hold merely because another cause blocked the run.
    if (approval.pending !== true && !(
      run.status === "blocked"
      && approval.pending === undefined
      && approval.source !== "policy_autonomous"
      && !/advisory only/i.test(approval.reason ?? "")
    )) continue;
    push(approvalBlockage(run.runId, approval));
  }
  // A legacy blocked record can lack both a node error and an approval/budget marker. Preserve the
  // uncertainty as data instead of guessing that "blocked" means approval.
  if (run.status === "blocked" && out.length === 0) {
    const node = run.nodes?.find((candidate) => candidate.status === "blocked");
    if (node) {
      push(toBlockage(
        { code: "legacy_blocker_unknown", message: `Node "${node.nodeId}" is blocked, but this legacy run recorded no structured cause. Inspect the node state before choosing a recovery.` },
        { run_id: run.runId, node_id: node.nodeId, surface: "run" }
      ));
    }
  }
  return out;
}
