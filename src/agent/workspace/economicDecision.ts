import type { ToolExecutionRecord } from "../tools/toolTypes.js";
import { MIN_RUN_COST_HISTORY_SAMPLES, type RunCostEstimate } from "./runCostHistory.js";
import type { TrafficEstimate } from "./trafficHistory.js";
import { computeEvFloor, type EvFloorResult } from "./evFloor.js";

export const ECONOMIC_DECISION_ARTIFACT = "economic_decision.v1" as const;
export const ECONOMIC_DECISION_AUTHORITY = "cms_agent_engine" as const;
export const ECONOMIC_DECISION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type EconomicDecisionOutcome = "verified_stop" | "verified_proceed" | "advisory" | "unavailable" | "pass_via_cluster" | "overridden";
export type EconomicMargin = { kind: "multiplier" | "absolute"; value: number; source: "default" | "run_policy" };
export type EconomicDecision = {
  artifact: typeof ECONOMIC_DECISION_ARTIFACT;
  authority: typeof ECONOMIC_DECISION_AUTHORITY;
  decisionId: string;
  runId: string;
  workflowId: string;
  projectId: string;
  evaluatedAt: string;
  outcome: EconomicDecisionOutcome;
  stop: boolean;
  reasonCode: string;
  currency: string;
  margin: EconomicMargin;
  clusterRole: "money_page" | "supporting_asset" | "unattached";
  supportingFor: string | null;
  offerSource?: { toolExecutionId: string; sourceProjectId: string; tool: string; offerReference: string };
  costEvidence?: RunCostEstimate;
  trafficEvidence?: TrafficEstimate & { projectId?: string; windowStart?: string; windowEnd?: string };
  calculation: EvFloorResult;
  notes: string[];
};

export type BuildEconomicDecisionInput = {
  runId: string;
  workflowId: string;
  projectId: string;
  evaluatedAt?: string;
  output: unknown;
  costEstimate?: unknown;
  trafficEstimate?: unknown;
  toolExecutions?: readonly ToolExecutionRecord[];
  initialInput?: unknown;
};

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0;
const token = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const normalizedCurrency = (value: unknown): string | undefined => token(value)?.toUpperCase();

const containsScalar = (value: unknown, expected: string | number, depth = 0): boolean => {
  if (depth > 8) return false;
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => containsScalar(entry, expected, depth + 1));
  if (isObject(value)) return Object.values(value).some((entry) => containsScalar(entry, expected, depth + 1));
  return false;
};

const offerReference = (offer: JsonObject): string | undefined =>
  token(offer.offerId) ?? token(offer.id) ?? token(offer.slug) ?? token(offer.name);

const amountAndCurrency = (offer: JsonObject, modelFloor: JsonObject | undefined): { payout?: number; currency?: string } => {
  const nested = [offer.payout, offer.commission, offer.expectedCommission].find(isObject);
  const payout = [offer.payoutUsd, offer.expectedCommission, offer.commission, offer.payout, nested?.amount, nested?.value].find(positive);
  const currency = normalizedCurrency(offer.currency) ?? normalizedCurrency(offer.currencyCode) ?? normalizedCurrency(nested?.currency) ?? normalizedCurrency(modelFloor?.currency);
  return { payout, currency };
};

const modelFloorFrom = (output: unknown): JsonObject | undefined => isObject(output) && isObject(output.evFloor) ? output.evFloor : undefined;

const clusterFrom = (output: unknown): Pick<EconomicDecision, "clusterRole" | "supportingFor"> => {
  const floor = modelFloorFrom(output);
  const role = floor?.clusterRole;
  const clusterRole = role === "money_page" || role === "supporting_asset" || role === "unattached" ? role : "unattached";
  return { clusterRole, supportingFor: clusterRole === "supporting_asset" ? token(floor?.supportingFor) ?? null : null };
};

const marginFrom = (initialInput: unknown): EconomicMargin => {
  const policy = isObject(initialInput) && isObject(initialInput.economicPolicy) ? initialInput.economicPolicy : undefined;
  const margin = policy && isObject(policy.margin) ? policy.margin : undefined;
  if (margin?.kind === "multiplier" && positive(margin.value)) return { kind: "multiplier", value: margin.value, source: "run_policy" };
  if (margin?.kind === "absolute" && nonNegative(margin.value)) return { kind: "absolute", value: margin.value, source: "run_policy" };
  return { kind: "multiplier", value: 1, source: "default" };
};

const explicitProceedOverride = (initialInput: unknown): { id: string; reason: string } | undefined => {
  const value = isObject(initialInput) && isObject(initialInput.economicOverride) ? initialInput.economicOverride : undefined;
  if (value?.decision !== "proceed") return undefined;
  const id = token(value.overrideId) ?? token(value.id);
  const reason = token(value.reason);
  return id && reason ? { id, reason } : undefined;
};

const parentDecision = (initialInput: unknown, projectId: string, supportingFor: string | null, at: number): EconomicDecision | undefined => {
  const value = isObject(initialInput) ? initialInput.parentEconomicDecision : undefined;
  if (!isObject(value) || value.artifact !== ECONOMIC_DECISION_ARTIFACT || value.authority !== ECONOMIC_DECISION_AUTHORITY) return undefined;
  const evaluated = Date.parse(String(value.evaluatedAt ?? ""));
  if (value.projectId !== projectId
    || value.decisionId !== supportingFor
    || !Number.isFinite(evaluated)
    || evaluated > at
    || at - evaluated > ECONOMIC_DECISION_MAX_AGE_MS) return undefined;
  const verifiedPass = value.outcome === "verified_proceed" && validatesAuthoritativeDecision(value, "proceed");
  const configuredOverride = value.outcome === "overridden"
    && value.stop === false
    && value.decisionId === `economic:${String(value.runId ?? "")}`
    && typeof value.reasonCode === "string"
    && value.reasonCode.startsWith("explicit_proceed_override:");
  if (!verifiedPass && !configuredOverride) return undefined;
  return value as EconomicDecision;
};

const verifiedOfferSource = (input: BuildEconomicDecisionInput, offer: JsonObject, payout: number, currency: string): EconomicDecision["offerSource"] | undefined => {
  const reference = offerReference(offer);
  if (!reference) return undefined;
  for (const record of input.toolExecutions ?? []) {
    if (record.status !== "success" || record.runId !== input.runId || record.nodeId !== "monetization_strategy" || record.toolId !== "project.call_read_tool") continue;
    if (!isObject(record.inputSummary)) continue;
    const sourceProjectId = token(record.inputSummary.projectId);
    const tool = token(record.inputSummary.tool);
    const args = record.inputSummary.arguments;
    // The source read must be explicitly scoped to the target tenant. A broad, cross-tenant offer
    // list can inform the model, but it cannot earn authority to stop this tenant's run.
    if (!sourceProjectId || !tool || !containsScalar(args, input.projectId)) continue;
    if (!containsScalar(record.outputSummary, reference) || !containsScalar(record.outputSummary, payout) || !containsScalar(record.outputSummary, currency)) continue;
    return { toolExecutionId: record.toolExecutionId, sourceProjectId, tool, offerReference: reference };
  }
  return undefined;
};

const qualifiedCost = (value: unknown, input: BuildEconomicDecisionInput, at: number): RunCostEstimate | undefined => {
  if (!isObject(value) || value.artifact !== "run_cost_estimate.v1" || value.basis !== "workflow_history" || value.scope !== "project") return undefined;
  if (value.projectId !== input.projectId
    || value.workflowId !== input.workflowId
    || !finite(value.sampleRuns)
    || value.sampleRuns < MIN_RUN_COST_HISTORY_SAMPLES
    || !positive(value.coverageRuns)
    || !nonNegative(value.estimatedRunCostUsd)) return undefined;
  if (!Array.isArray(value.observedRunCostsUsd) || value.observedRunCostsUsd.length !== value.sampleRuns || !value.observedRunCostsUsd.every(nonNegative)) return undefined;
  const costs = [...value.observedRunCostsUsd].sort((left, right) => left - right);
  const p50 = costs[Math.max(0, Math.ceil(0.5 * costs.length) - 1)];
  if (Math.round((p50 ?? -1) * 100) / 100 !== value.estimatedRunCostUsd || (value.coverageRuns as number) < (value.sampleRuns as number)) return undefined;
  const evaluated = Date.parse(String(value.evaluatedAt ?? ""));
  if (!Number.isFinite(evaluated) || evaluated > at || at - evaluated > ECONOMIC_DECISION_MAX_AGE_MS) return undefined;
  return value as unknown as RunCostEstimate;
};

const qualifiedTraffic = (value: unknown, input: BuildEconomicDecisionInput, at: number): (TrafficEstimate & { projectId: string; windowStart: string; windowEnd: string }) | undefined => {
  if (!isObject(value) || value.artifact !== "traffic_estimate.v1" || value.basis !== "tracking_engagement" || value.projectId !== input.projectId) return undefined;
  if (!nonNegative(value.expectedMonthlyTraffic) || !nonNegative(value.observedConversionRate) || value.observedConversionRate > 1) return undefined;
  const start = Date.parse(String(value.windowStart ?? ""));
  const end = Date.parse(String(value.windowEnd ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > at || at - end > ECONOMIC_DECISION_MAX_AGE_MS) return undefined;
  return value as unknown as TrafficEstimate & { projectId: string; windowStart: string; windowEnd: string };
};

export function buildAuthoritativeEconomicDecision(input: BuildEconomicDecisionInput): EconomicDecision {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const at = Date.parse(evaluatedAt);
  const output = isObject(input.output) ? input.output : {};
  const modelFloor = modelFloorFrom(output);
  const offer = isObject(output.selectedOffer) ? output.selectedOffer : undefined;
  const { payout, currency } = offer ? amountAndCurrency(offer, modelFloor) : {};
  const margin = marginFrom(input.initialInput);
  const cluster = clusterFrom(output);
  const cost = qualifiedCost(input.costEstimate, input, at);
  const traffic = qualifiedTraffic(input.trafficEstimate, input, at);
  const source = offer && payout && currency ? verifiedOfferSource(input, offer, payout, currency) : undefined;
  const floorMultiplier = margin.kind === "multiplier" ? margin.value : 1;
  const calculation = computeEvFloor({
    runCostUsd: cost?.estimatedRunCostUsd ?? 0,
    payoutUsd: payout,
    conversionRate: traffic?.observedConversionRate ?? undefined,
    estimatedVolume: traffic?.expectedMonthlyTraffic,
    floorMultiplier,
    runCostBasis: cost ? "workflow_history" : "no_history",
    revenueBasis: source ? "monetizer_data" : "stated_assumption",
    volumeBasis: traffic ? "tracking_engagement" : "stated_assumption"
  });
  if (margin.kind === "absolute" && cost) {
    calculation.floorUsd = Math.round((cost.estimatedRunCostUsd + margin.value) * 100) / 100;
    calculation.meetsFloor = calculation.expectedValueUsd === null ? null : calculation.expectedValueUsd >= calculation.floorUsd;
    calculation.verdict = calculation.meetsFloor === null ? "unknown" : calculation.meetsFloor ? "proceed" : "block";
  }

  const base = {
    artifact: ECONOMIC_DECISION_ARTIFACT,
    authority: ECONOMIC_DECISION_AUTHORITY,
    decisionId: `economic:${input.runId}`,
    runId: input.runId,
    workflowId: input.workflowId,
    projectId: input.projectId,
    evaluatedAt,
    currency: currency ?? "USD",
    margin,
    ...cluster,
    ...(source ? { offerSource: source } : {}),
    ...(cost ? { costEvidence: cost } : {}),
    ...(traffic ? { trafficEvidence: traffic } : {}),
    calculation,
    notes: [
      "The model-selected offer and cluster explanation are inputs; only this engine-owned record can halt the run.",
      ...(modelFloor ? ["The model-authored evFloor verdict, arithmetic and provenance labels were ignored."] : [])
    ]
  };

  const override = explicitProceedOverride(input.initialInput);
  if (override) return { ...base, outcome: "overridden", stop: false, reasonCode: `explicit_proceed_override:${override.id}`, notes: [...base.notes, override.reason] };

  if (cluster.clusterRole === "supporting_asset") {
    const parent = parentDecision(input.initialInput, input.projectId, cluster.supportingFor, at);
    if (parent) return { ...base, outcome: "pass_via_cluster", stop: false, reasonCode: "verified_passing_parent_decision", notes: [...base.notes, `Parent decision ${parent.decisionId} is current, same-tenant and non-blocking.`] };
    return { ...base, outcome: "advisory", stop: false, reasonCode: "cluster_parent_unverified", notes: [...base.notes, "A supporting-asset pass requires a current same-tenant parent economic decision whose decisionId matches supportingFor."] };
  }
  if (!offer) return { ...base, outcome: "unavailable", stop: false, reasonCode: "offer_unavailable", notes: [...base.notes, "No selected offer was available to verify."] };
  if (!source) return { ...base, outcome: "advisory", stop: false, reasonCode: "offer_source_unverified", notes: [...base.notes, "No same-run tenant-scoped successful source receipt reproduced the selected offer, payout and currency."] };
  if (currency !== "USD") return { ...base, outcome: "advisory", stop: false, reasonCode: "currency_incompatible", notes: [...base.notes, `Run cost is measured in USD but the offer is denominated in ${currency}; no conversion source was supplied.`] };
  if (!cost) return { ...base, outcome: "advisory", stop: false, reasonCode: "cost_evidence_unqualified", notes: [...base.notes, "Cost evidence was missing, stale, foreign, pooled, or not qualified against the current route."] };
  if (!traffic) return { ...base, outcome: "advisory", stop: false, reasonCode: "traffic_evidence_unqualified", notes: [...base.notes, "Traffic evidence was missing, stale, foreign, incomplete, or assumed."] };
  if (calculation.meetsFloor === null) return { ...base, outcome: "unavailable", stop: false, reasonCode: "economic_inputs_incomplete" };
  if (calculation.meetsFloor) return { ...base, outcome: "verified_proceed", stop: false, reasonCode: "verified_ev_meets_floor" };
  return { ...base, outcome: "verified_stop", stop: true, reasonCode: "verified_ev_below_floor" };
}

const validatesAuthoritativeDecision = (value: unknown, expectedVerdict: "block" | "proceed", checkedAt?: number): boolean => {
  if (!isObject(value)
    || value.artifact !== ECONOMIC_DECISION_ARTIFACT
    || value.authority !== ECONOMIC_DECISION_AUTHORITY
    || typeof value.runId !== "string"
    || typeof value.workflowId !== "string"
    || typeof value.projectId !== "string"
    || value.decisionId !== `economic:${value.runId}`
    || value.outcome !== (expectedVerdict === "block" ? "verified_stop" : "verified_proceed")
    || value.stop !== (expectedVerdict === "block")
    || value.reasonCode !== (expectedVerdict === "block" ? "verified_ev_below_floor" : "verified_ev_meets_floor")
    || value.currency !== "USD"
    || !isObject(value.offerSource)
    || !token(value.offerSource.toolExecutionId)
    || !token(value.offerSource.sourceProjectId)
    || !token(value.offerSource.tool)
    || !token(value.offerSource.offerReference)
    || !isObject(value.costEvidence)
    || !isObject(value.trafficEvidence)
    || !isObject(value.calculation)
    || !isObject(value.margin)) return false;
  const evaluatedAt = Date.parse(String(value.evaluatedAt ?? ""));
  if (!Number.isFinite(evaluatedAt)) return false;
  if (checkedAt !== undefined && (!Number.isFinite(checkedAt) || evaluatedAt > checkedAt || checkedAt - evaluatedAt > ECONOMIC_DECISION_MAX_AGE_MS)) return false;
  const cost = qualifiedCost(value.costEvidence, { runId: value.runId, workflowId: value.workflowId, projectId: value.projectId, output: {} }, evaluatedAt);
  const traffic = qualifiedTraffic(value.trafficEvidence, { runId: value.runId, workflowId: value.workflowId, projectId: value.projectId, output: {} }, evaluatedAt);
  if (!cost || !traffic || value.clusterRole === "supporting_asset") return false;
  const payout = value.calculation.payoutUsd;
  if (!positive(payout)) return false;
  const margin = value.margin;
  if ((margin.kind !== "multiplier" && margin.kind !== "absolute")
    || (margin.source !== "default" && margin.source !== "run_policy")
    || (margin.kind === "multiplier" ? !positive(margin.value) : !nonNegative(margin.value))) return false;
  const multiplier = margin.kind === "multiplier" ? Number(margin.value) : 1;
  const recomputed = computeEvFloor({
    runCostUsd: cost.estimatedRunCostUsd,
    payoutUsd: payout,
    conversionRate: traffic.observedConversionRate ?? undefined,
    estimatedVolume: traffic.expectedMonthlyTraffic,
    floorMultiplier: multiplier,
    runCostBasis: "workflow_history",
    revenueBasis: "monetizer_data",
    volumeBasis: "tracking_engagement"
  });
  if (margin.kind === "absolute" && nonNegative(margin.value)) {
    recomputed.floorUsd = Math.round((cost.estimatedRunCostUsd + margin.value) * 100) / 100;
    recomputed.meetsFloor = recomputed.expectedValueUsd === null ? null : recomputed.expectedValueUsd >= recomputed.floorUsd;
    recomputed.verdict = recomputed.meetsFloor === null ? "unknown" : recomputed.meetsFloor ? "proceed" : "block";
  }
  return recomputed.verdict === expectedVerdict
    && value.calculation.artifact === "ev_floor.v1"
    && value.calculation.verdict === expectedVerdict
    && value.calculation.meetsFloor === (expectedVerdict === "proceed")
    && recomputed.floorUsd === value.calculation.floorUsd
    && recomputed.expectedValueUsd === value.calculation.expectedValueUsd
    && recomputed.breakEvenConversions === value.calculation.breakEvenConversions
    && recomputed.payoutUsd === value.calculation.payoutUsd
    && value.calculation.runCostUsd === cost.estimatedRunCostUsd
    && value.calculation.conversionRate === traffic.observedConversionRate
    && value.calculation.estimatedVolume === traffic.expectedMonthlyTraffic
    && value.calculation.runCostBasis === "workflow_history"
    && value.calculation.revenueBasis === "monetizer_data"
    && value.calculation.volumeBasis === "tracking_engagement"
    && value.calculation.estimateBasis === "monetizer_data";
};

export const isAuthoritativeEconomicStop = (value: unknown, checkedAt = new Date()): boolean =>
  validatesAuthoritativeDecision(value, "block", checkedAt.getTime());
