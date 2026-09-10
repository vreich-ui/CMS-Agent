// Native Anthropic runner (docs/platform/DIRECTION.md Phase 6). Claude nodes previously had to run
// through the `openai_compatible` provider pointed at a gateway; this adds a first-class path that
// speaks the Anthropic Messages API directly, with schema-enforced structured output. It lets a node —
// or, crucially, a rubric's LLM-as-judge — run natively on Claude, enabling cross-family judging (a
// Claude judge grading an OpenAI generator, the recommended setup).
//
// Schema-enforced output uses the Messages API's forced-tool idiom: a single `emit_output` tool whose
// input_schema IS the node's outputSchema, with tool_choice pinned to it, so the model must return a
// tool_use block whose input matches the schema. No @anthropic-ai/sdk dependency — the request is a
// plain fetch, and fetchImpl is injectable so tests never hit the network. Sampling params
// (temperature/top_p) are intentionally omitted: the current Claude models reject them.
//
// Scope: this runner covers schema-constrained generation (judges, the reflector/curator synthetic
// nodes, and tool-less conductor nodes). Bridging CMS-Agent's controlled tools into the Messages API
// tool loop for tool-using conductor nodes is a tracked follow-up; such a node runs here without tool
// access, so keep tool-using nodes on the OpenAI runner until that lands.
import { estimatePricedCost, recordModelUsage, summarizeModelUsage } from "../../observability/modelUsage.js";
import { renderPlaybookForPrompt } from "../../improvement/playbook.js";
import { repositoryManager } from "../../runtime/repositories.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { ExecutionMode, NodeRunnerContext } from "../executionContext.js";
import { validateOutput } from "../outputValidator.js";
import { resolveNodeInstructions } from "../nodeInstructions.js";
import type { NodeRunner, NodeRunnerInput, NodeRunnerResult } from "./NodeRunner.js";
import { readRunContext, renderRunContextInstruction } from "../../workspace/runContext.js";
import { boundDependencyOutput, dependencyOutputMaxChars } from "./OpenAINodeRunner.js";
import { classifyProviderHttpError, operatorActionForBudgetExceeded, operatorActionForProviderHttpError, truncateProviderMessage } from "./providerHttpErrors.js";
import { buildAnthropicImageBlocks, extractImageRefs, resolveImageRefs, stripImageRefs } from "./imageRefs.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// W12 truncation retry (see OpenAINodeRunner.ts's matching header comment for the incident and the
// full detection rationale). Ceiling on how far the truncation retry may double this node's
// configured max_tokens; override per deployment via ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING if a
// model's real ceiling differs.
export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING = 64000;
export const anthropicMaxOutputTokensCeiling = (): number => {
  const configured = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING;
};
// Same ratio and rationale as OpenAINodeRunner's NEAR_CAP_TRUNCATION_RATIO: the fallback signal
// (no emit_output tool call — see below) only counts as truncation evidence when the response
// actually spent close to the cap it was given.
const NEAR_CAP_TRUNCATION_RATIO = 0.9;

const forbidden = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;
const redact = (value: unknown): unknown => typeof value === "string" ? value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") : Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, forbidden.test(key) ? "[REDACTED]" : redact(val)])) : value;
const numberFrom = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const stringFrom = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const cfg = (node: WorkspaceNode) => ({ ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) });
const apiKeyEnv = (node: WorkspaceNode) => stringFrom(cfg(node).apiKeyEnv) ?? "ANTHROPIC_API_KEY";

const instructions = (node: WorkspaceNode, playbookText: string, resolvedPrompt: string, input?: unknown): string => [
  "You are the CMS-Agent node runner running natively on Claude.",
  `Node: ${node.name} (${node.id})`,
  `Description: ${node.description}`,
  // W3 part 3 (determinism program, 2026-08-12): parity with the OpenAI runner — the run's client
  // facts stated once by the conductor, so a node on either provider works from the same delivered
  // context instead of echoing a dependency's envelope. Absent when the input carries no runContext.
  renderRunContextInstruction(readRunContext(input)),
  resolvedPrompt,
  playbookText ? `Playbook (curated lessons for this node):\n${playbookText}` : "",
  "Assigned dependencies and memory are provided in the user message. Never reveal secrets.",
  "Return your result by calling the emit_output tool exactly once with a value matching its schema."
].filter(Boolean).join("\n");

type AnthropicMessagesResponse = { id?: string; stop_reason?: string; content?: Array<{ type: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } };

// A run can execute a small independent batch concurrently. The usage ledger only receives an
// actual charge *after* a provider response, so two sibling attempts that both see the same
// remainder must reserve it before either sends a request. Serializing the read-reserve sequence
// also closes the smaller race where a sibling writes its actual usage after another attempt read a
// stale summary. The repository ledger remains the cross-process source of truth; this map only
// protects the in-flight interval no ledger can represent yet.
const inFlightRunReservations = new Map<string, Map<symbol, number>>();
const runReservationTails = new Map<string, Promise<void>>();
const reserveRunBudget = async (input: {
  runId: string;
  budgetUsd: number;
  priorSpendUsd: number;
  accruedThisDispatchUsd: number;
  thisAttemptUsd: number;
}): Promise<{ accepted: false; spentUsd: number } | { accepted: true; release: () => void; spentUsd: number }> => {
  const previous = runReservationTails.get(input.runId) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const tail = previous.then(() => turn);
  runReservationTails.set(input.runId, tail);
  await previous;
  try {
    // The executor's supplied spend remains a conservative floor; re-reading here is necessary to
    // make concurrent local attempts see a sibling that completed after that earlier summary.
    const liveSpendUsd = (await summarizeModelUsage({ runId: input.runId })).actualCostUsdEstimate;
    const priorSpendUsd = Math.max(input.priorSpendUsd, liveSpendUsd);
    const reservations = inFlightRunReservations.get(input.runId) ?? new Map<symbol, number>();
    const reservedUsd = [...reservations.values()].reduce((total, value) => total + value, 0);
    const spentUsd = priorSpendUsd + input.accruedThisDispatchUsd;
    if (spentUsd + reservedUsd + input.thisAttemptUsd > input.budgetUsd) return { accepted: false, spentUsd };
    const token = Symbol(input.runId);
    reservations.set(token, input.thisAttemptUsd);
    inFlightRunReservations.set(input.runId, reservations);
    return {
      accepted: true,
      spentUsd,
      release: () => {
        reservations.delete(token);
        if (reservations.size === 0) inFlightRunReservations.delete(input.runId);
      }
    };
  } finally {
    releaseTurn();
    void tail.then(() => {
      if (runReservationTails.get(input.runId) === tail) runReservationTails.delete(input.runId);
    });
  }
};

export class AnthropicNodeRunner implements NodeRunner {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  // Selected by PROVIDER (modelConfig.provider === "anthropic") in the runner registry, never by
  // ExecutionMode, so it does not claim any mode — mode-based lookup keeps returning the OpenAI runner.
  supports(_mode: ExecutionMode): boolean { return false; }

  validateConfiguration(node: WorkspaceNode) {
    const errors: string[] = [];
    if (!node.outputSchema) errors.push("outputSchema is required.");
    if (numberFrom(cfg(node).budgetUsd) !== undefined && numberFrom(cfg(node).budgetUsd)! < 0) errors.push("budgetUsd must be non-negative.");
    // K-A12. This fires as a per-NODE validation error, which is what makes it misleading: the
    // node is fine and the plane is not. `anthropic-api-key` exists in Secret Manager and is bound
    // to neither the cms-agent-mcp service nor any executor job, so the first node switched to this
    // provider fails within two minutes across four tenant sites, reads as a bad node rather than a
    // missing binding, and has an entirely clean deploy behind it. The message says so, because
    // whoever reads it will be looking at the node.
    if (!process.env[apiKeyEnv(node)]) {
      errors.push(
        apiKeyEnv(node) === "ANTHROPIC_API_KEY"
          ? `ANTHROPIC_API_KEY is required for anthropic execution and no Cloud Run plane binds it. This is a DEPLOY gap, not a defect in node "${node.id}": the secret exists in Secret Manager and is attached to neither the service nor the executor jobs. Bind it on both planes (one --update-secrets each) before switching any node to provider=anthropic. See KNOWN_ISSUES K-A12.`
          : `${apiKeyEnv(node)} is required for anthropic execution, and nothing sets it on this plane. Node "${node.id}" names it through modelConfig.apiKeyEnv, so bind it where the plane is deployed rather than changing the node.`
      );
    }
    // This runner has no tool loop (see the header): a tool-using node would run WITHOUT its granted
    // tools — for article_body/artifact_plan/publish_payload that silently strips the client
    // validation their prompts mandate. A provider switch on such a node must fail by name at
    // configuration time, not degrade at run time.
    const grantedTools = node.allowedTools ?? [];
    if (grantedTools.length > 0) {
      errors.push(`provider=anthropic cannot execute tool-using nodes yet: the Messages-API tool loop is not implemented, and node "${node.id}" grants ${grantedTools.length} tool(s) (${grantedTools.join(", ")}) that would be silently stripped. Keep tool-using nodes on the OpenAI runner until the Anthropic tool loop lands.`);
    }
    return errors.length ? { ok: false as const, errors } : { ok: true as const };
  }

  async run({ node, input }: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult> {
    const valid = this.validateConfiguration(node);
    if (!valid.ok) return { ok: false, code: "invalid_node_configuration", message: valid.errors.join("; ") };
    const resolvedInstructions = await resolveNodeInstructions(node);
    if (resolvedInstructions.errors.length) return { ok: false, code: "invalid_node_configuration", message: resolvedInstructions.errors.join("; ") };
    const c = cfg(node);
    const model = stringFrom(c.model) ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const baseURL = (process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env[apiKeyEnv(node)]!;

    const playbook = await repositoryManager.getImprovementRepository().getPlaybook(node.id).catch(() => undefined);
    const playbookText = playbook ? renderPlaybookForPrompt(playbook) : "";
    // C4 — node runner image support (BRIEF 3.9). imageRefs never enter the JSON text: they are
    // resolved (fetched/validated/bounded — see imageRefs.ts) into their own leading content blocks,
    // and stripped out of `input` before it is serialized below. A node with no imageRefs resolves to
    // an empty array here and takes the exact same path as before this feature existed — `messageContent`
    // stays the plain string `userContent`, so the request body is byte-identical to today's.
    const rawImageRefs = extractImageRefs(input);
    const { resolved: resolvedImageRefs, warnings: imageRefWarnings } = await resolveImageRefs(rawImageRefs, { fetchImpl: this.fetchImpl });
    // Dependencies arrive in one bounded envelope only. Keeping them inside input as well as in
    // dependencyOutputs makes every retry pay for the same evidence twice and defeats the bound.
    const strippedInput = stripImageRefs(input);
    const inputRecord = strippedInput && typeof strippedInput === "object" && !Array.isArray(strippedInput)
      ? strippedInput as Record<string, unknown>
      : undefined;
    const deliveredDependencies = inputRecord?.dependencies && typeof inputRecord.dependencies === "object"
      ? inputRecord.dependencies as Record<string, unknown>
      : undefined;
    const { dependencies: _deliveredDependencies, ...inputSansDependencies } = inputRecord ?? {};
    const dependencyMaxChars = dependencyOutputMaxChars();
    const dependencyOutputs = Object.fromEntries(node.dependsOn.map((dependency) => [
      dependency,
      boundDependencyOutput(deliveredDependencies?.[dependency] ?? context.run.stageOutputs[dependency] ?? context.suppliedDependencies?.[dependency], dependencyMaxChars)
    ]));
    const userContent = JSON.stringify(redact({
      input: inputRecord ? inputSansDependencies : strippedInput,
      // T12.22 fleet parity: the OpenAI runner bounds these; an unbounded confluence payload hangs
      // the same way on either provider, so the same bound applies here rather than waiting for
      // the second incident to prove it.
      dependencyOutputs,
      ...(playbookText ? { playbook: playbookText } : {}),
      outputSchema: node.outputSchema
    }));
    const imageBlocks = buildAnthropicImageBlocks(resolvedImageRefs);
    const messageContent: string | Array<Record<string, unknown>> = imageBlocks.length > 0
      ? [...imageBlocks, { type: "text", text: userContent }]
      : userContent;
    const body = {
      model,
      max_tokens: numberFrom(c.maxOutputTokens) ?? 4096,
      system: instructions(node, playbookText, resolvedInstructions.prompt, input),
      messages: [{ role: "user", content: messageContent }],
      tools: [{ name: "emit_output", description: "Emit this node's structured output. Call exactly once with the full result matching the schema.", input_schema: node.outputSchema as Record<string, unknown> }],
      tool_choice: { type: "tool", name: "emit_output" }
    };
    // F5 (T-2, run_1785352838155_l544ye): matches the OpenAI runner's default bump — 60s proved too
    // tight for at least one real generation node (draft_writer, on the OpenAI path); raised here too
    // for parity in case a node's provider is switched to anthropic.
    const timeoutMs = numberFrom(c.timeout) ?? 120000;
    const maxRetries = Math.max(0, Math.floor(numberFrom(c.retryCount) ?? 0));
    const nodeBudgetOverride = numberFrom(context.run.nodeBudgetOverrides?.[node.id]);
    const nodeBudgetUsd = nodeBudgetOverride !== undefined ? nodeBudgetOverride : numberFrom(c.budgetUsd);
    const runBudgetUsd = numberFrom(context.run.budgetUsd);
    const budgetGuardEngaged = nodeBudgetUsd !== undefined || runBudgetUsd !== undefined;
    // Use the executor's just-computed value where available, exactly as the OpenAI runner does;
    // direct node execution falls back to the durable actual-usage ledger.
    const priorRunSpendUsd = budgetGuardEngaged
      ? (numberFrom(context.priorRunSpendUsd) ?? (await summarizeModelUsage({ runId: context.run.runId })).actualCostUsdEstimate)
      : 0;
    const cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    const recordAccruedUsage = async (failureCode: string, attempt: number, extraMetadata?: Record<string, unknown>): Promise<void> => {
      if (cumulativeUsage.inputTokens === 0 && cumulativeUsage.outputTokens === 0) return;
      await recordModelUsage({
        runId: context.run.runId, requestId: context.run.requestId, workflowId: context.run.workflowId, projectId: context.run.projectId,
        nodeId: node.id, model, provider: "anthropic", inputTokens: cumulativeUsage.inputTokens, outputTokens: cumulativeUsage.outputTokens,
        totalTokens: cumulativeUsage.inputTokens + cumulativeUsage.outputTokens, status: "actual",
        metadata: { executionMode: "anthropic", partial: true, failureCode, attempt: attempt + 1, attemptsTotal: attempt + 1, ...extraMetadata }
      }).catch(() => undefined);
    };
    // W12 — tracked outside the loop for the same reason as OpenAINodeRunner: the truncation retry is
    // ONE bonus attempt at double the cap, granted independently of maxRetries/retryCount, and
    // `initialMaxOutputTokens` preserves the node's ORIGINAL configured cap for the failure message
    // even after body.max_tokens has been doubled.
    const initialMaxOutputTokens = body.max_tokens;
    let truncationRetryUsed = false;

    // The loop's normal bound is attempt<=maxRetries, exactly as before; +1 accommodates the single
    // bonus truncation retry (see OpenAINodeRunner.ts's identical widened bound for the termination
    // proof — this loop has the same shape: every branch either returns or bounds its own continue by
    // maxRetries, except the new truncation branch, which bounds itself by truncationRetryUsed).
    for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
      // The guard prices the exact serialized Messages request that will be sent on THIS attempt,
      // including a doubled max_tokens cap after a truncation retry. Actual charges from earlier
      // attempts stay in cumulativeUsage, so a retry cannot spend the same remainder twice.
      let releaseReservation: (() => void) | undefined;
      if (budgetGuardEngaged) {
        const accrued = estimatePricedCost({ model, inputTokens: cumulativeUsage.inputTokens, outputTokens: cumulativeUsage.outputTokens });
        const prospective = estimatePricedCost({ model, inputTokens: Math.ceil(JSON.stringify(body).length / 4), outputTokens: body.max_tokens });
        if (accrued.pricingUnknown || prospective.pricingUnknown) {
          await recordAccruedUsage("budget_exceeded", attempt, { pricingUnknown: true });
          return {
            ok: false,
            code: "budget_exceeded",
            message: `Node "${node.id}" stopped before a model turn because "${model}" has no listed pricing and its budget cannot be enforced against a real rate.`,
            details: { nodeId: node.id, pricingUnknown: true, ceiling: nodeBudgetUsd !== undefined ? "node" : "run" },
            operatorAction: "Add the model to the pricing catalog or select a listed model before retrying."
          };
        }
        if (nodeBudgetUsd !== undefined && accrued.costUsd + prospective.costUsd > nodeBudgetUsd) {
          await recordAccruedUsage("budget_exceeded", attempt);
          return {
            ok: false,
            code: "budget_exceeded",
            message: `Node "${node.id}" stopped before the model turn that would cross its node budget.`,
            details: { nodeId: node.id, ceiling: "node", budgetUsd: nodeBudgetUsd, spentUsdEstimate: accrued.costUsd, prospectiveTurnUsd: prospective.costUsd },
            operatorAction: operatorActionForBudgetExceeded(nodeBudgetUsd, accrued.costUsd)
          };
        }
        if (runBudgetUsd !== undefined) {
          const reservation = await reserveRunBudget({
            runId: context.run.runId,
            budgetUsd: runBudgetUsd,
            priorSpendUsd: priorRunSpendUsd,
            accruedThisDispatchUsd: accrued.costUsd,
            thisAttemptUsd: prospective.costUsd
          });
          if (!reservation.accepted) {
            const spentUsd = reservation.spentUsd;
            await recordAccruedUsage("budget_exceeded", attempt);
            return {
              ok: false,
              code: "budget_exceeded",
              message: `Node "${node.id}" stopped before the model turn that would cross the shared run budget.`,
              details: { nodeId: node.id, ceiling: "run", budgetUsd: runBudgetUsd, spentUsdEstimate: spentUsd, prospectiveTurnUsd: prospective.costUsd },
              operatorAction: operatorActionForBudgetExceeded(runBudgetUsd, spentUsd)
            };
          }
          releaseReservation = reservation.release;
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(`${baseURL}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify(body),
          signal: context.signal ?? controller.signal
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          if (attempt < maxRetries && response.status >= 500) continue;
          // Provider-error-details (2026-08-29 incident): a 429 must never fall into the opaque
          // model_error bucket below (or, worse, our own budget_exceeded — reserved for OUR usd
          // budget guard) without saying WHY, so the operator does not lose an hour hunting a code
          // bug that is actually an empty provider wallet.
          const classified = classifyProviderHttpError(response.status, detail);
          if (classified) {
            const parsedBody = (() => { try { return JSON.parse(detail) as { error?: { message?: unknown } }; } catch { return undefined; } })();
            const rawMessage = parsedBody?.error?.message;
            const providerMessage = truncateProviderMessage(typeof rawMessage === "string" && rawMessage.trim() ? rawMessage.trim() : detail);
            // This response has no usage envelope, but earlier retry attempts may have one.
            // Preserve only that known prior usage before returning this terminal provider error.
            await recordAccruedUsage(classified, attempt);
            return {
              ok: false,
              code: classified,
              message: `Node "${node.id}" received ${response.status} from anthropic: ${providerMessage}`,
              providerStatus: response.status,
              providerMessage,
              operatorAction: operatorActionForProviderHttpError(classified, "anthropic", `workflow.retry_node ${node.id}`)
            };
          }
          // As above, do not fabricate usage for this non-OK response; record only usage
          // accumulated by preceding attempts in this dispatch.
          await recordAccruedUsage("model_error", attempt);
          return { ok: false, code: "model_error", message: `anthropic_http_${response.status}: ${detail.slice(0, 300)}`, retryable: response.status >= 500 || response.status === 429 };
        }
        const data = await response.json() as AnthropicMessagesResponse;
        cumulativeUsage.inputTokens += data.usage?.input_tokens ?? 0;
        cumulativeUsage.outputTokens += data.usage?.output_tokens ?? 0;
        if (data.stop_reason === "refusal") {
          await recordAccruedUsage("model_error", attempt);
          return { ok: false, code: "model_error", message: "anthropic_refusal: the request was declined by the model's safety classifiers." };
        }

        // W12 truncation classification. PRIMARY signal: the Messages API's own stop_reason — "the
        // request must be prefilled with a maximally verbose completion" is never why stop_reason is
        // "max_tokens"; that value means exactly one thing, hitting the token cap mid-generation, so
        // it is checked regardless of whether a tool_use block happened to come back at all.
        // FALLBACK: unlike the OpenAI Responses/Chat Completions APIs, Anthropic parses tool arguments
        // server-side, so a cutoff here does not surface as a client-side JSON.parse failure — the
        // nearest equivalent evidence is "no emit_output call came back AND the response spent
        // near-cap output tokens getting there" (the same near-cap safety gate as the OpenAI runner's
        // parse-failure fallback, applied to the closest signal this API actually exposes).
        const toolUse = (data.content ?? []).find((block) => block.type === "tool_use" && block.name === "emit_output");
        const observedOutputTokens = numberFrom(data.usage?.output_tokens);
        const providerTruncated = data.stop_reason === "max_tokens";
        const capUsedThisAttempt = body.max_tokens;
        const fallbackTruncated = !providerTruncated && !toolUse &&
          observedOutputTokens !== undefined && observedOutputTokens >= capUsedThisAttempt * NEAR_CAP_TRUNCATION_RATIO;
        if (providerTruncated || fallbackTruncated) {
          const ceiling = anthropicMaxOutputTokensCeiling();
          const doubledCap = Math.min(capUsedThisAttempt * 2, ceiling);
          if (!truncationRetryUsed && doubledCap > capUsedThisAttempt) {
            truncationRetryUsed = true;
            body.max_tokens = doubledCap;
            continue;
          }
          const signal = providerTruncated
            ? "the provider reported stop_reason=max_tokens"
            : `no emit_output call was returned and its output (~${observedOutputTokens} tokens) was at or near the ${capUsedThisAttempt}-token cap sent`;
          const remedy = truncationRetryUsed
            ? `This dispatch already retried once at double the cap (${capUsedThisAttempt} tokens) and was still truncated. Raise modelConfig.maxOutputTokens above ${capUsedThisAttempt} for this node and retry via workflow_retry_node.`
            : `Raise modelConfig.maxOutputTokens above ${capUsedThisAttempt} for this node — it is already at or above this runner's ${ceiling}-token retry ceiling, so no automatic retry was attempted — and retry via workflow_retry_node.`;
          const details = { nodeId: node.id, attempt: attempt + 1, initialMaxOutputTokens, cap: capUsedThisAttempt, outputTokens: observedOutputTokens, retriedAtDoubledCap: truncationRetryUsed, providerSignal: providerTruncated };
          await recordAccruedUsage("truncated", attempt, { cap: capUsedThisAttempt, initialMaxOutputTokens, retriedAtDoubledCap: truncationRetryUsed, providerSignal: providerTruncated });
          return {
            ok: false,
            code: "truncated",
            message: `Node "${node.id}" produced structured output truncated at its output-token cap (attempt ${attempt + 1}): ${signal}. ${remedy}`,
            details
          };
        }

        if (!toolUse) {
          if (attempt < maxRetries) continue;
          await recordAccruedUsage("output_validation_failed", attempt);
          return { ok: false, code: "output_validation_failed", message: "Anthropic response contained no emit_output tool call." };
        }
        const validated = validateOutput(toolUse.input, node.outputSchema);
        if (!validated.ok) {
          if (attempt < maxRetries) continue;
          await recordAccruedUsage("output_validation_failed", attempt);
          return { ok: false, code: "output_validation_failed", message: "Anthropic output did not match node.outputSchema.", details: validated.errors };
        }
        const usageFields = { inputTokens: cumulativeUsage.inputTokens, outputTokens: cumulativeUsage.outputTokens, totalTokens: cumulativeUsage.inputTokens + cumulativeUsage.outputTokens };
        await recordModelUsage({ runId: context.run.runId, requestId: context.run.requestId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: "anthropic", ...usageFields, status: "actual", metadata: { executionMode: "anthropic", attempt: attempt + 1, attemptsTotal: attempt + 1 } }).catch(() => undefined);
        // outputValidated: true — see NodeRunner.ts and executor.ts's executeRunnableNode: this runner
        // already validated `output` against `node.outputSchema` immediately above (to decide whether
        // to retry), so the executor's own generic output-schema gate can skip re-running the identical
        // check against the identical (output, schema) pair.
        return {
          ok: true,
          output: validated.value,
          usage: { ...usageFields, actual: true },
          model,
          trace: {
            responseId: data.id,
            provider: "anthropic",
            ...(rawImageRefs ? { imageRefs: { included: resolvedImageRefs.length, dropped: imageRefWarnings.length, warnings: imageRefWarnings } } : {})
          },
          outputValidated: true
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (context.signal?.aborted) { await recordAccruedUsage("cancelled", attempt); return { ok: false, code: "cancelled", message: "Anthropic node execution was cancelled." }; }
        if (/abort/i.test(message)) { await recordAccruedUsage("model_timeout", attempt); return { ok: false, code: "model_timeout", message: "Anthropic node execution timed out." }; }
        if (attempt >= maxRetries) { await recordAccruedUsage("model_error", attempt); return { ok: false, code: "model_error", message }; }
      } finally {
        clearTimeout(timer);
        releaseReservation?.();
      }
    }
    return { ok: false, code: "model_error", message: "Anthropic node execution failed." };
  }
}
