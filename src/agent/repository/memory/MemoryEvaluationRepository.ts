import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceMutationMeta } from "../../mcp/workspace/store.js";
import type { EvalResultFilters, EvaluationRepository, FeedbackFilters } from "../interfaces/EvaluationRepository.js";
import { makeImprovementId, validateRubric, type EvalResult, type EvalRubric, type EvalRubricVersionSnapshot, type FeedbackRecord, type PairwiseResult, type RubricStatus } from "../../improvement/improvementTypes.js";

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const newestFirst = <T extends { createdAt: string }>(records: T[], limit?: number) =>
  [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit ?? 100).map(clone);

type EvaluationState = { evalVersion: number; rubrics: Map<string, EvalRubric>; versions: EvalRubricVersionSnapshot[]; results: EvalResult[]; pairwise: PairwiseResult[]; feedback: FeedbackRecord[] };
const createState = (): EvaluationState => ({ evalVersion: 0, rubrics: new Map(), versions: [], results: [], pairwise: [], feedback: [] });

export class MemoryEvaluationRepository implements EvaluationRepository {
  private static states = new Map<string, EvaluationState>();
  constructor(private readonly backend: string = "memory") { if (!MemoryEvaluationRepository.states.has(backend)) MemoryEvaluationRepository.states.set(backend, createState()); }
  protected state(): EvaluationState { return MemoryEvaluationRepository.states.get(this.backend)!; }

  async health(): Promise<RepositoryHealth> { return healthyRepositoryStatus("memory"); }

  private snapshot(rubric: EvalRubric, meta?: WorkspaceMutationMeta) {
    const state = this.state();
    state.evalVersion += 1;
    state.versions.push({ rubricId: rubric.rubricId, versionId: makeImprovementId("rubricv"), evalVersion: state.evalVersion, createdAt: now(), summary: meta?.summary, rubric: clone(rubric) });
  }

  async createRubric(rubric: EvalRubric, meta?: WorkspaceMutationMeta): Promise<EvalRubric> {
    const errors = validateRubric(rubric);
    if (errors.length) throw new Error(`invalid_rubric: ${errors.join("; ")}`);
    const state = this.state();
    if (state.rubrics.has(rubric.rubricId)) throw new Error(`Duplicate rubric id: ${rubric.rubricId}`);
    const stored = clone({ ...rubric, createdAt: rubric.createdAt || now(), updatedAt: now() });
    state.rubrics.set(stored.rubricId, stored);
    this.snapshot(stored, meta);
    return clone(stored);
  }

  async updateRubric(rubricId: string, patch: Partial<EvalRubric>, meta?: WorkspaceMutationMeta): Promise<EvalRubric> {
    const state = this.state();
    const existing = state.rubrics.get(rubricId);
    if (!existing) throw new Error(`Unknown rubric: ${rubricId}`);
    const next = clone({ ...existing, ...patch, rubricId, updatedAt: now() });
    const errors = validateRubric(next);
    if (errors.length) throw new Error(`invalid_rubric: ${errors.join("; ")}`);
    state.rubrics.set(rubricId, next);
    this.snapshot(next, meta);
    return clone(next);
  }

  async getRubric(rubricId: string) { const rubric = this.state().rubrics.get(rubricId); return rubric ? clone(rubric) : undefined; }
  async listRubrics(filters: { nodeId?: string; status?: RubricStatus } = {}) {
    return [...this.state().rubrics.values()].filter((rubric) => (!filters.nodeId || rubric.nodeId === filters.nodeId) && (!filters.status || rubric.status === filters.status)).map(clone);
  }
  async listRubricVersions(rubricId: string) { return this.state().versions.filter((version) => version.rubricId === rubricId).map(clone); }
  async restoreRubricVersion(rubricId: string, versionId: string, meta?: WorkspaceMutationMeta) {
    const version = this.state().versions.find((candidate) => candidate.rubricId === rubricId && candidate.versionId === versionId);
    if (!version) throw new Error(`Unknown rubric version: ${rubricId}/${versionId}`);
    return this.updateRubric(rubricId, { ...clone(version.rubric), rubricId }, meta);
  }

  async recordResult(result: EvalResult) { this.state().results.push(clone(result)); return clone(result); }
  async listResults(filters: EvalResultFilters = {}) {
    return newestFirst(this.state().results.filter((result) =>
      (!filters.nodeId || result.nodeId === filters.nodeId) && (!filters.runId || result.runId === filters.runId) &&
      (!filters.rubricId || result.rubricId === filters.rubricId) && (!filters.trialId || result.trialId === filters.trialId) &&
      (!filters.from || result.createdAt >= filters.from) && (!filters.to || result.createdAt <= filters.to)), filters.limit);
  }
  async getResult(evalId: string) { const result = this.state().results.find((candidate) => candidate.evalId === evalId); return result ? clone(result) : undefined; }

  async recordPairwise(result: PairwiseResult) { this.state().pairwise.push(clone(result)); return clone(result); }
  async listPairwise(filters: { nodeId?: string; trialId?: string; limit?: number } = {}) {
    return newestFirst(this.state().pairwise.filter((result) => (!filters.nodeId || result.nodeId === filters.nodeId) && (!filters.trialId || result.trialId === filters.trialId)), filters.limit);
  }

  async recordFeedback(record: FeedbackRecord) { this.state().feedback.push(clone(record)); return clone(record); }
  async listFeedback(filters: FeedbackFilters = {}) {
    return newestFirst(this.state().feedback.filter((record) => (!filters.nodeId || record.nodeId === filters.nodeId) && (!filters.runId || record.runId === filters.runId) && (!filters.kind || record.kind === filters.kind)), filters.limit);
  }
}
