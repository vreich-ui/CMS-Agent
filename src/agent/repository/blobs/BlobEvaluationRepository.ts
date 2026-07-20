import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { RecordEnvelope } from "../RecordEnvelope.js";
import type { WorkspaceMutationMeta } from "../../mcp/workspace/store.js";
import type { EvalResultFilters, EvaluationRepository, FeedbackFilters } from "../interfaces/EvaluationRepository.js";
import { makeImprovementId, validateRubric, type EvalResult, type EvalRubric, type EvalRubricVersionSnapshot, type FeedbackRecord, type PairwiseResult, type RubricStatus } from "../../improvement/improvementTypes.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const now = () => new Date().toISOString();
const rubricKey = (rubricId: string) => `evaluation/rubrics/${rubricId}.json`;
const rubricVersionKey = (rubricId: string, versionId: string) => `evaluation/rubric-versions/${rubricId}/${versionId}.json`;
const resultKey = (evalId: string) => `evaluation/results/${evalId}.json`;
const pairwiseKey = (comparisonId: string) => `evaluation/pairwise/${comparisonId}.json`;
const feedbackKey = (feedbackId: string) => `evaluation/feedback/${feedbackId}.json`;

const envelope = <T>(id: string, recordType: string, createdAt: string, data: T): RecordEnvelope<T> =>
  ({ id, record_type: recordType, schema_version: `${recordType}.v1`, created_at: createdAt, updated_at: createdAt, data });

const newestFirst = <T extends { createdAt: string }>(records: T[], limit?: number) =>
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit ?? 100);

// Blob/GCS-backed evaluation substrate. Rubrics follow the skills current/versions layout;
// results, pairwise comparisons, and feedback are append-only RecordEnvelope blobs (one immutable
// JSON per record — the BlobChangeRepository convention).
export class BlobEvaluationRepository implements EvaluationRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }

  private async loadEnvelopes<T>(prefix: string): Promise<T[]> {
    const { blobs } = await this.store.list({ prefix });
    const records = await Promise.all(blobs.map((blob) => getBlobJson<RecordEnvelope<T>>(this.store, blob.key)));
    return records.filter((record): record is RecordEnvelope<T> => Boolean(record)).map((record) => record.data);
  }

  private async writeVersion(rubric: EvalRubric, meta?: WorkspaceMutationMeta): Promise<void> {
    const versionId = makeImprovementId("rubricv");
    const snapshot: EvalRubricVersionSnapshot = { rubricId: rubric.rubricId, versionId, evalVersion: Date.now(), createdAt: now(), summary: meta?.summary, rubric };
    await this.store.setJSON(rubricVersionKey(rubric.rubricId, versionId), snapshot);
  }

  async createRubric(rubric: EvalRubric, meta?: WorkspaceMutationMeta): Promise<EvalRubric> {
    const errors = validateRubric(rubric);
    if (errors.length) throw new Error(`invalid_rubric: ${errors.join("; ")}`);
    if (await this.getRubric(rubric.rubricId)) throw new Error(`Duplicate rubric id: ${rubric.rubricId}`);
    const stored = { ...rubric, createdAt: rubric.createdAt || now(), updatedAt: now() };
    await this.store.setJSON(rubricKey(stored.rubricId), stored);
    await this.writeVersion(stored, meta);
    return stored;
  }

  async updateRubric(rubricId: string, patch: Partial<EvalRubric>, meta?: WorkspaceMutationMeta): Promise<EvalRubric> {
    const existing = await this.getRubric(rubricId);
    if (!existing) throw new Error(`Unknown rubric: ${rubricId}`);
    const next = { ...existing, ...patch, rubricId, updatedAt: now() };
    const errors = validateRubric(next);
    if (errors.length) throw new Error(`invalid_rubric: ${errors.join("; ")}`);
    await this.store.setJSON(rubricKey(rubricId), next);
    await this.writeVersion(next, meta);
    return next;
  }

  async getRubric(rubricId: string) { return (await getBlobJson<EvalRubric>(this.store, rubricKey(rubricId))) ?? undefined; }
  async listRubrics(filters: { nodeId?: string; status?: RubricStatus } = {}) {
    const { blobs } = await this.store.list({ prefix: "evaluation/rubrics/" });
    const rubrics = (await Promise.all(blobs.map((blob) => getBlobJson<EvalRubric>(this.store, blob.key)))).filter((rubric): rubric is EvalRubric => Boolean(rubric));
    return rubrics.filter((rubric) => (!filters.nodeId || rubric.nodeId === filters.nodeId) && (!filters.status || rubric.status === filters.status));
  }
  async listRubricVersions(rubricId: string) {
    const { blobs } = await this.store.list({ prefix: `evaluation/rubric-versions/${rubricId}/` });
    const versions = (await Promise.all(blobs.map((blob) => getBlobJson<EvalRubricVersionSnapshot>(this.store, blob.key)))).filter((version): version is EvalRubricVersionSnapshot => Boolean(version));
    return versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async restoreRubricVersion(rubricId: string, versionId: string, meta?: WorkspaceMutationMeta) {
    const version = (await this.listRubricVersions(rubricId)).find((candidate) => candidate.versionId === versionId);
    if (!version) throw new Error(`Unknown rubric version: ${rubricId}/${versionId}`);
    return this.updateRubric(rubricId, { ...version.rubric, rubricId }, meta);
  }

  async recordResult(result: EvalResult) { await this.store.setJSON(resultKey(result.evalId), envelope(result.evalId, "eval_result", result.createdAt, result)); return result; }
  async listResults(filters: EvalResultFilters = {}) {
    const results = await this.loadEnvelopes<EvalResult>("evaluation/results/");
    return newestFirst(results.filter((result) =>
      (!filters.nodeId || result.nodeId === filters.nodeId) && (!filters.runId || result.runId === filters.runId) &&
      (!filters.rubricId || result.rubricId === filters.rubricId) && (!filters.trialId || result.trialId === filters.trialId) &&
      (!filters.from || result.createdAt >= filters.from) && (!filters.to || result.createdAt <= filters.to)), filters.limit);
  }
  async getResult(evalId: string) { return (await getBlobJson<RecordEnvelope<EvalResult>>(this.store, resultKey(evalId)))?.data; }

  async recordPairwise(result: PairwiseResult) { await this.store.setJSON(pairwiseKey(result.comparisonId), envelope(result.comparisonId, "pairwise_result", result.createdAt, result)); return result; }
  async listPairwise(filters: { nodeId?: string; trialId?: string; limit?: number } = {}) {
    const results = await this.loadEnvelopes<PairwiseResult>("evaluation/pairwise/");
    return newestFirst(results.filter((result) => (!filters.nodeId || result.nodeId === filters.nodeId) && (!filters.trialId || result.trialId === filters.trialId)), filters.limit);
  }

  async recordFeedback(record: FeedbackRecord) { await this.store.setJSON(feedbackKey(record.feedbackId), envelope(record.feedbackId, "feedback_record", record.createdAt, record)); return record; }
  async listFeedback(filters: FeedbackFilters = {}) {
    const records = await this.loadEnvelopes<FeedbackRecord>("evaluation/feedback/");
    return newestFirst(records.filter((record) => (!filters.nodeId || record.nodeId === filters.nodeId) && (!filters.runId || record.runId === filters.runId) && (!filters.kind || record.kind === filters.kind)), filters.limit);
  }
}
