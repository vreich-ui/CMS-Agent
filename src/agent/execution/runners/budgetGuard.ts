// Per-model-request budget enforcement (the node-system overhaul, run_1785435947311_jl8hl4).
//
// The previous in-loop guard (#95 H4) listened to the Agents SDK's `agent_start` lifecycle event and
// read `runContext.usage` for "spend so far". That usage object is not reliably populated while a
// node's own loop is still running, so `spentSoFar` stayed pinned at the pre-node figure for the whole
// loop and only the single upcoming turn's prospective size ever grew. Result, measured live:
// artifact_plan consumed 386,138 input tokens ($1.95) in one dispatch and the $3 run ceiling landed at
// 138% — the guard never fired because its accrued-spend term never moved.
//
// This module intercepts at the only place a turn actually becomes spend: the Model itself. Every
// model request passes through `getResponse`, so the guard
//   1. BEFORE each request: estimates the request's own prospective cost from the exact input about to
//      be sent plus the node's configured maxOutputTokens, and refuses (throws) if prior-node spend +
//      this node's ACTUAL accrued spend + the prospective turn would cross the ceiling;
//   2. AFTER each response: accumulates the response's actual token usage, so the accrued term is real
//      measured spend, not an estimate that silently stays at zero.
// The throw aborts the run() loop before the crossing turn spends anything, and the accumulated usage
// survives the failure so the runner can record what the aborted node really cost (previously a failed
// node recorded NO usage at all, hiding exactly the overshoot this guard exists to stop).
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { estimateModelCost, estimatePricedCost } from "../../observability/modelUsage.js";

export class NodeBudgetExceededError extends Error {
  readonly code = "budget_exceeded";
  constructor(
    readonly details: {
      nodeId: string;
      budgetUsd: number;
      ceiling: "node" | "run";
      spentUsdEstimate: number;
      prospectiveTurnUsd: number;
      accruedNodeUsage: { inputTokens: number; outputTokens: number };
      // T6: set when the node was stopped because its model has NO listed rate, rather than because
      // a real ceiling was crossed. The dollar figures above are then meaningless and the sentence
      // below says so instead of quoting them.
      pricingUnknown?: true;
      reason?: string;
    }
  ) {
    super(
      details.pricingUnknown
        ? `budget_exceeded: node "${details.nodeId}" stopped before its first model turn. ${details.reason}`
        : `budget_exceeded: node "${details.nodeId}" stopped before the model turn that would cross the ${details.ceiling} ceiling: ` +
          `$${details.spentUsdEstimate.toFixed(4)} already spent (actual, ${details.ceiling === "node" ? "this node" : "run-wide"}) + ~$${details.prospectiveTurnUsd.toFixed(4)} for the upcoming turn ` +
          `exceeds the $${details.budgetUsd} ${details.ceiling} budget. Caught before the turn ran, not after.`
    );
    this.name = "NodeBudgetExceededError";
  }
}

// ~4 chars per token, the same deterministic estimator the executor's dry-run accounting uses. The
// request input is what the SDK is about to send — the full growing conversation, tool results
// included — so a node that balloons its own context sees that growth priced into every next turn.
export const estimateRequestTokens = (request: ModelRequest): number =>
  Math.ceil((JSON.stringify(request.input ?? "").length + (request.systemInstructions?.length ?? 0)) / 4);

// A thrown tool-execute error reaches the model through the Agents SDK's OWN default error
// formatter (tool.js's defaultToolErrorFunction), which always prefixes the text with this exact
// string before it re-enters conversation history as that call's function_call_result. Matching on
// it (rather than on our own tool-denial/tool-failure error codes) means this also catches SDK-level
// tool errors we never authored a message for.
const SDK_TOOL_ERROR_PREFIX = "An error occurred while running the tool.";

// True when the newest item in this dispatch's conversation is the SDK's own error text for a tool
// call that just threw — i.e. the immediately preceding tool call in THIS turn's history errored.
const lastItemWasToolError = (request: ModelRequest): boolean => {
  const items = Array.isArray(request.input) ? request.input : undefined;
  const last = items?.[items.length - 1] as { type?: string; output?: unknown } | undefined;
  if (!last || last.type !== "function_call_result") return false;
  const text = typeof last.output === "string" ? last.output : (last.output as { text?: string } | undefined)?.text;
  return typeof text === "string" && text.startsWith(SDK_TOOL_ERROR_PREFIX);
};

export type BudgetGuardState = {
  // Actual token usage accumulated across this node's completed model turns.
  accrued: { inputTokens: number; outputTokens: number };
  // ACTUAL inputTokens usage from the most recently completed (successful) turn only — not
  // cumulative like `accrued`. See gate()'s use of this below.
  lastSuccessfulTurnInputTokens?: number;
  // Set when the guard refused a turn; the runner uses it to tell "budget tripped" from other aborts.
  exceeded?: NodeBudgetExceededError["details"];
};

export type BudgetGuardConfig = {
  nodeId: string;
  model: string;
  // TWO ceilings, deliberately separate. The node's own budgetUsd bounds THIS NODE's spend; the
  // run's budgetUsd bounds the whole run's. The previous guard collapsed them to
  // min(nodeBudget, runBudget) and compared RUN-WIDE prior spend against it — harmless while no
  // node declared a budget, but the moment every node carries one (the node-limits audit), any node
  // dispatched after cumulative run spend passed its own small ceiling would refuse to run at all.
  nodeBudgetUsd?: number;
  runBudgetUsd?: number;
  // Spend accrued by the whole run BEFORE this node started (summarizeModelUsage, queried once).
  priorSpendUsd: number;
  // The node's configured output cap — the worst-case output cost reserved for each upcoming turn.
  maxOutputTokens: number;
};

// Wraps a Model so every request is budget-gated and every response's actual usage is captured.
// Deliberately a plain object wrapper, not an SDK subclass: the Model interface is two methods, and
// this must keep working across SDK refactors of everything else.
export function wrapModelWithBudgetGuard(inner: Model, config: BudgetGuardConfig, state: BudgetGuardState): Model {
  const gate = (request: ModelRequest): void => {
    // T6 — a ceiling enforced against an invented rate is not a ceiling. When this node's model is
    // not in the pricing catalog, every number below is an upper-bound guess, so a budgeted node
    // refuses the turn by name instead of gating on it. Only a node with NO ceiling at all may run
    // unpriced — there is nothing to enforce there, so there is nothing to get wrong.
    const priced = estimatePricedCost({ model: config.model, inputTokens: state.accrued.inputTokens, outputTokens: state.accrued.outputTokens });
    if (priced.pricingUnknown && (config.nodeBudgetUsd !== undefined || config.runBudgetUsd !== undefined)) {
      const details = {
        nodeId: config.nodeId,
        budgetUsd: (config.nodeBudgetUsd ?? config.runBudgetUsd)!,
        ceiling: config.nodeBudgetUsd !== undefined ? ("node" as const) : ("run" as const),
        spentUsdEstimate: 0,
        prospectiveTurnUsd: 0,
        accruedNodeUsage: { ...state.accrued },
        pricingUnknown: true as const,
        reason: `model_pricing_unknown: "${config.model}" has no entry in the model pricing catalog, so this node's budget ceiling cannot be enforced against a real rate. Add the model to modelPricingCatalog (src/agent/observability/modelUsage.ts) or point the node at a listed model; the turn is refused rather than gated against a guess.`
      };
      state.exceeded = details;
      throw new NodeBudgetExceededError(details);
    }
    const accruedNodeUsd = priced.costUsd;
    // run_1786557897658_elj34j (2026-08-12, verified live): topic_opportunity was stopped here with
    // only $0.02 of its $0.10 node ceiling actually spent. Cause: a stray workspace.get_node call
    // ERRORED the turn before, and the SDK's own error text for that call became the newest history
    // item — a one-off detour, not real conversation growth — which estimateRequestTokens still
    // prices into this turn like any other. Capping the input-token estimate at the last SUCCESSFUL
    // turn's ACTUAL usage (never below it, and only when the error detour is what's inflating the
    // request) removes that one-time spike without hiding genuine growth: a node whose history is
    // truly ballooning turn over successful turn (the $3->138% overshoot this guard exists to stop)
    // keeps growing this cap every time a turn actually succeeds.
    const rawRequestTokens = estimateRequestTokens(request);
    const requestTokens = lastItemWasToolError(request) && state.lastSuccessfulTurnInputTokens !== undefined
      ? Math.min(rawRequestTokens, state.lastSuccessfulTurnInputTokens)
      : rawRequestTokens;
    const prospectiveTurnUsd = estimateModelCost({ model: config.model, inputTokens: requestTokens, outputTokens: config.maxOutputTokens });
    // Node ceiling: this node's own accrued spend + the upcoming turn. Run ceiling: everything the
    // run has spent (prior nodes + this node) + the upcoming turn. Whichever trips first stops the
    // turn; the details name the ceiling that tripped so the remedy is unambiguous.
    const nodeCeilingTripped = config.nodeBudgetUsd !== undefined && accruedNodeUsd + prospectiveTurnUsd > config.nodeBudgetUsd;
    const runCeilingTripped = config.runBudgetUsd !== undefined && config.priorSpendUsd + accruedNodeUsd + prospectiveTurnUsd > config.runBudgetUsd;
    if (nodeCeilingTripped || runCeilingTripped) {
      const details = {
        nodeId: config.nodeId,
        budgetUsd: (nodeCeilingTripped ? config.nodeBudgetUsd : config.runBudgetUsd)!,
        ceiling: nodeCeilingTripped ? ("node" as const) : ("run" as const),
        spentUsdEstimate: Number((nodeCeilingTripped ? accruedNodeUsd : config.priorSpendUsd + accruedNodeUsd).toFixed(6)),
        prospectiveTurnUsd: Number(prospectiveTurnUsd.toFixed(6)),
        accruedNodeUsage: { ...state.accrued }
      };
      state.exceeded = details;
      throw new NodeBudgetExceededError(details);
    }
  };
  const absorb = (usage: { inputTokens?: number; outputTokens?: number } | undefined): void => {
    state.accrued.inputTokens += usage?.inputTokens ?? 0;
    state.accrued.outputTokens += usage?.outputTokens ?? 0;
    // Recorded on every completed (successful) turn, never on a gated-out or thrown turn, so gate()
    // always caps against a request size that actually reached the model and got a real response.
    if (usage?.inputTokens !== undefined) state.lastSuccessfulTurnInputTokens = usage.inputTokens;
  };
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      gate(request);
      const response = await inner.getResponse(request);
      absorb(response.usage);
      return response;
    },
    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      gate(request);
      for await (const event of inner.getStreamedResponse(request)) {
        // The final stream event carries the response with its usage; capture it when present.
        const maybe = event as { type?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number } } };
        if (maybe.type === "response_done" && maybe.response?.usage) absorb(maybe.response.usage);
        yield event;
      }
    }
  };
}
