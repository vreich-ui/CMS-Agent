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
import { estimateModelCost } from "../../observability/modelUsage.js";

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
    }
  ) {
    super(
      `budget_exceeded: node "${details.nodeId}" stopped before the model turn that would cross the ${details.ceiling} ceiling: ` +
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

export type BudgetGuardState = {
  // Actual token usage accumulated across this node's completed model turns.
  accrued: { inputTokens: number; outputTokens: number };
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
    const accruedNodeUsd = estimateModelCost({ model: config.model, inputTokens: state.accrued.inputTokens, outputTokens: state.accrued.outputTokens });
    const prospectiveTurnUsd = estimateModelCost({ model: config.model, inputTokens: estimateRequestTokens(request), outputTokens: config.maxOutputTokens });
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
