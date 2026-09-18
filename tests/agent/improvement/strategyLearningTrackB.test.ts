/**
 * Track B — evidence-replay and isolation completion for strategy-level learning
 * (src/agent/improvement/strategyLearning.ts). #386 closed four gaps (quarantine, dedup,
 * direction, recipients) with a "listObservations() snapshot, then decide, then write" dedup and
 * an unconditional `savePlaybook` overwrite. Neither survives concurrency or a retried pass. This
 * file pins the four remaining boundaries named in the track-B brief:
 *
 *   1. Repeated ingestion/promotion and concurrent identical attempts do not double-apply.
 *   2. A retry after a failure between observation-writing and promotion finishes the missing
 *      effect exactly once, without replaying an effect already applied.
 *   3. Overlapping windows cannot satisfy the multiple-independent-window promotion threshold.
 *   4. Distinct tenants stay distinct: promoting one tenant's evidence never reaches another
 *      tenant's playbook or the fleet's.
 *
 * These tests use the REAL BlobLearningRepository / BlobImprovementRepository against the
 * project's own CAS-honouring in-memory BlobStoreClient double
 * (`resolveDefaultClientMemoryBackend`, from src/agent/memory/clientMemoryBackend.ts — the same
 * double the client-memory suite exercises against real onlyIfMatch/onlyIfNew semantics), not a
 * permissive Map fake: a fake that always reports `modified: true` cannot fail a compare-and-set,
 * so it cannot tell a real race-safe implementation apart from a "last write wins" one. The
 * pure-aggregation tests (window overlap) need no repository at all.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  contradictingStrategySightings,
  ingestStrategyRollups,
  promoteStrategySignals,
  stableStrategySignals,
  strategyWindowsOverlap,
  STRATEGY_OBSERVATION_SOURCE,
  STRATEGY_PLAYBOOK_TARGET_NODES,
  type StrategySignalSighting
} from "../../../src/agent/improvement/strategyLearning.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import { BlobLearningRepository } from "../../../src/agent/repository/blobs/BlobLearningRepository.js";
import { BlobImprovementRepository } from "../../../src/agent/repository/blobs/BlobImprovementRepository.js";
import { resetClientMemoryStore, resolveDefaultClientMemoryBackend } from "../../../src/agent/memory/clientMemoryBackend.js";
import type { LearningObservation } from "../../../src/agent/mcp/workspace/store.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import type { ImprovementRepository } from "../../../src/agent/repository/interfaces/ImprovementRepository.js";

const CONFIGURED_ENV = { [TRACKING_SINK_URL_ENV]: "https://sink.example/track", [TRACKING_SINK_TOKEN_ENV]: "test-token" } as unknown as NodeJS.ProcessEnv;

const jsonFetch = (body: unknown): typeof fetch =>
  (async (input: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

const strategyRow = (overrides: Record<string, unknown> = {}) => ({
  strategy: "objection_first",
  intent: "objection_handling",
  day: "2026-08-30",
  sessions: 260,
  completion_rate: 0.58,
  cta_ctr: 0.09,
  buy_click_rate: 0.04,
  purchase_rate: 0.012,
  p75_dwell_ms: 42000,
  n: 412,
  ...overrides
});
// A large-n row whose OWN numbers never change across a test's calls. With n=2000 against
// strategyRow's n=412 it dominates the window's n-weighted median (see strategySiteBaseline),
// so the site baseline tracks THIS row's values, not strategyRow's -- otherwise, with only two
// rows in the window, the higher-n row IS the median and always shows ratio=1 (no finding)
// against itself, and it is the OTHER row whose finding/direction moves when either row's
// numbers change. Anchoring the baseline here keeps every finding in these tests attached to
// strategyRow, where the test's own comments say it is.
const ordinaryRow = () => ({ strategy: "listicle", intent: "awareness", day: "2026-08-30", completion_rate: 0.3, cta_ctr: 0.03, buy_click_rate: 0.01, purchase_rate: 0.003, p75_dwell_ms: 15000, n: 2000 });
const page = (rows: unknown[]) => ({ rows });

const WINDOW_1 = { from: "2026-08-29", to: "2026-08-30" };
const WINDOW_2 = { from: "2026-08-30", to: "2026-08-31" };

// A minimal, faithful WorkspaceRepository double for the observation half of
// BlobLearningRepository (recordObservation/listObservations delegate straight to it). This is
// NOT the piece under test — the ingestion-claim ledger is — so it needs to store and list
// correctly, not arbitrate a race.
const workspaceDouble = (): WorkspaceRepository => {
  const observations: LearningObservation[] = [];
  let sequence = 0;
  return {
    async recordObservation(observation: string, metadata?: Record<string, unknown>) {
      const record: LearningObservation = { id: `learning_${++sequence}`, observation, metadata, createdAt: new Date(Date.UTC(2026, 7, 30, 0, 0, sequence)).toISOString() };
      observations.push(record);
      return structuredClone(record);
    },
    async listObservations() { return observations.map((record) => structuredClone(record)); },
    async archiveObservation(id: string) {
      const record = observations.find((entry) => entry.id === id)!;
      return structuredClone(record);
    },
    async archiveObservationsByPredicate() { return { archived: 0, ids: [] }; }
  } as unknown as WorkspaceRepository;
};

describe("Track B — ingestion is claim-safe under concurrency and retry", () => {
  let store: ReturnType<typeof resolveDefaultClientMemoryBackend>;
  let learningRepository: BlobLearningRepository;

  beforeEach(() => {
    resetClientMemoryStore();
    store = resolveDefaultClientMemoryBackend({} as NodeJS.ProcessEnv);
    learningRepository = new BlobLearningRepository(workspaceDouble(), store);
  });

  it("two SIMULTANEOUS identical ingest passes record the observation exactly once", async () => {
    const rows = [strategyRow(), ordinaryRow()];
    const improvementRepository = new BlobImprovementRepository(store);
    const params = { projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to };
    const deps = () => ({ learningRepository, improvementRepository, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV });

    // Both calls build their candidate list from independent listObservations() reads before
    // either claims anything — exactly the interleaving a read-then-blind-write race needs. The
    // claim ledger, not call ordering, is what has to make this safe.
    const [first, second] = await Promise.all([ingestStrategyRollups(params, deps()), ingestStrategyRollups(params, deps())]);

    const written = (await learningRepository.listObservations()).filter((entry) => entry.metadata?.source === STRATEGY_OBSERVATION_SOURCE);
    expect(written).toHaveLength(1);
    // Exactly one of the two calls won the claim; the other sees its candidate as a duplicate.
    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.observations.length === 1)).toHaveLength(1);
    expect(outcomes.filter((result) => result.duplicates.length === 1)).toHaveLength(1);
  });

  it("retrying the identical window after the first call already succeeded stays a no-op", async () => {
    const rows = [strategyRow(), ordinaryRow()];
    const improvementRepository = new BlobImprovementRepository(store);
    const params = { projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to };
    await ingestStrategyRollups(params, { learningRepository, improvementRepository, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV });
    const retry = await ingestStrategyRollups(params, { learningRepository, improvementRepository, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV });

    expect(retry.observations).toEqual([]);
    expect(retry.duplicates).toHaveLength(1);
    const written = (await learningRepository.listObservations()).filter((entry) => entry.metadata?.source === STRATEGY_OBSERVATION_SOURCE);
    expect(written).toHaveLength(1);
  });

  it("a genuinely revised source window is reported as a conflict, and the stored observation is left untouched", async () => {
    // Track B — the change is not the "hundredth of a point" strategyIngestionKey is built to
    // absorb: the SAME window/tenant/group now reports the opposite direction on replay (as if the
    // upstream rollup had been corrected after the fact). The key is identical (by design — it does
    // not hash the findings), so this is a duplicate by key, but not an honest no-op.
    const improvementRepository = new BlobImprovementRepository(store);
    const params = { projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to };
    const original = [strategyRow(), ordinaryRow()];
    const first = await ingestStrategyRollups(params, { learningRepository, improvementRepository, fetchImpl: jsonFetch(page(original)), env: CONFIGURED_ENV });
    expect(first.observations).toHaveLength(1);

    const revised = [strategyRow({ completion_rate: 0.1, cta_ctr: 0.01, buy_click_rate: 0.001, purchase_rate: 0.0005, p75_dwell_ms: 5000 }), ordinaryRow()];
    const replay = await ingestStrategyRollups(params, { learningRepository, improvementRepository, fetchImpl: jsonFetch(page(revised)), env: CONFIGURED_ENV });

    expect(replay.observations).toEqual([]);
    expect(replay.duplicates).toHaveLength(1);
    expect(replay.revisionConflicts).toHaveLength(1);
    expect(replay.revisionConflicts[0]).toMatchObject({ strategy: "objection_first", intent: "objection_handling" });

    // The original evidence is exactly as it was — no destructive migration, no silent acceptance
    // of the new numbers as independent support.
    const stored = (await learningRepository.listObservations()).filter((entry) => entry.metadata?.source === STRATEGY_OBSERVATION_SOURCE);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.observation).toBe(first.observations[0]!.observation);
  });

  it("does not report a conflict for a harmless re-fetch that leaves every finding's direction unchanged", async () => {
    const improvementRepository = new BlobImprovementRepository(store);
    const params = { projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to };
    const rows = [strategyRow(), ordinaryRow()];
    await ingestStrategyRollups(params, { learningRepository, improvementRepository, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV });
    // A late-arriving row nudges the rate by a hundredth of a point — same directions throughout.
    const nudged = [strategyRow({ completion_rate: 0.585 }), ordinaryRow()];
    const replay = await ingestStrategyRollups(params, { learningRepository, improvementRepository, fetchImpl: jsonFetch(page(nudged)), env: CONFIGURED_ENV });
    expect(replay.duplicates).toHaveLength(1);
    expect(replay.revisionConflicts).toEqual([]);
  });

  it("a pass that fails during PROMOTION still leaves its observations on file, and a retry finishes the missing promotion exactly once", async () => {
    const rows = [strategyRow(), ordinaryRow()];
    const workingImprovement = new BlobImprovementRepository(store);
    const brokenImprovement = {
      claimPromotionEffects: async () => { throw new Error("blob_unavailable"); }
    } as unknown as ImprovementRepository;

    // Window 1: ingests and promotes cleanly (one window is never enough to promote on its own).
    const w1 = await ingestStrategyRollups(
      { projectId: "trk_demo", cmsAgentProjectId: "dr-lurie", from: WINDOW_1.from, to: WINDOW_1.to },
      { learningRepository, improvementRepository: workingImprovement, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV }
    );
    expect(w1.errors).toEqual([]);

    // Window 2: the observation write succeeds, but promotion — reached unconditionally at the end
    // of ingestStrategyRollups — is interrupted (simulating a crash or an outage in the promotion
    // store only). The evidence for window 2 is on file; the promotion effect it would complete is
    // not.
    const w2First = await ingestStrategyRollups(
      { projectId: "trk_demo", cmsAgentProjectId: "dr-lurie", from: WINDOW_2.from, to: WINDOW_2.to },
      { learningRepository, improvementRepository: brokenImprovement, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV }
    );
    expect(w2First.observations).toHaveLength(1);
    expect(w2First.errors.some((error) => error.scope === "promotion")).toBe(true);
    expect(await workingImprovement.getPlaybook("draft_writer", { site: "dr-lurie" })).toBeUndefined();

    // Retry window 2 with the store healthy again. The observation is now a duplicate (correctly —
    // it was already recorded) but promotion, reading the FULL stored history fresh, finishes the
    // missing effect this time.
    const w2Retry = await ingestStrategyRollups(
      { projectId: "trk_demo", cmsAgentProjectId: "dr-lurie", from: WINDOW_2.from, to: WINDOW_2.to },
      { learningRepository, improvementRepository: workingImprovement, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV }
    );
    expect(w2Retry.observations).toEqual([]);
    expect(w2Retry.duplicates).toHaveLength(1);
    expect(w2Retry.promotion.promoted.some((entry) => entry.nodeId === "draft_writer")).toBe(true);

    const writer = (await workingImprovement.getPlaybook("draft_writer", { site: "dr-lurie" }))!;
    const dwellItems = writer.items.filter((item) => item.text.includes("stay past the first screen"));
    expect(dwellItems).toHaveLength(1);
    // Promoted exactly once — a THIRD identical retry must not mark it helpful again.
    expect(dwellItems[0]!.helpfulCount).toBe(1);

    const w2SecondRetry = await ingestStrategyRollups(
      { projectId: "trk_demo", cmsAgentProjectId: "dr-lurie", from: WINDOW_2.from, to: WINDOW_2.to },
      { learningRepository, improvementRepository: workingImprovement, fetchImpl: jsonFetch(page(rows)), env: CONFIGURED_ENV }
    );
    expect(w2SecondRetry.promotion.promoted).toEqual([]);
    expect(w2SecondRetry.promotion.reinforced).toEqual([]);
    const writerAfter = (await workingImprovement.getPlaybook("draft_writer", { site: "dr-lurie" }))!;
    expect(writerAfter.items.find((item) => item.text.includes("stay past the first screen"))!.helpfulCount).toBe(1);
  });
});

describe("Track B — promotion effects are claim-safe under concurrency", () => {
  let store: ReturnType<typeof resolveDefaultClientMemoryBackend>;
  let improvementRepository: BlobImprovementRepository;

  const twoWindowSightings = (): StrategySignalSighting[] =>
    [WINDOW_1, WINDOW_2].map((window) => ({
      strategy: "objection_first", intent: "objection_handling", metric: "p75_dwell_ms" as const, direction: "above" as const, n: 400, window,
      finding: { metric: "p75_dwell_ms" as const, direction: "above" as const, value: 42000, siteFigure: 20000, ratio: 2.1 }
    }));

  beforeEach(() => {
    resetClientMemoryStore();
    store = resolveDefaultClientMemoryBackend({} as NodeJS.ProcessEnv);
    improvementRepository = new BlobImprovementRepository(store);
  });

  it("two SIMULTANEOUS identical promotion passes apply the effect exactly once", async () => {
    const sightings = twoWindowSightings();
    const scope = { site: "dr-lurie" };
    const [first, second] = await Promise.all([
      promoteStrategySignals(sightings, { improvementRepository }, { scope }),
      promoteStrategySignals(sightings, { improvementRepository }, { scope })
    ]);

    const totalPromoted = first.promoted.length + second.promoted.length;
    // Exactly one caller's claim wins per (node, signal) effect — six target nodes, one add each,
    // split across the two concurrent outcomes, never both.
    expect(totalPromoted).toBe(STRATEGY_PLAYBOOK_TARGET_NODES.length);

    const writer = (await improvementRepository.getPlaybook("draft_writer", scope))!;
    const dwellItems = writer.items.filter((item) => item.text.includes("stay past the first screen"));
    expect(dwellItems).toHaveLength(1);
    expect(dwellItems[0]!.helpfulCount).toBe(1);
  });

  it("a repeated promotion pass over unchanged evidence never re-marks a lesson helpful", async () => {
    const sightings = twoWindowSightings();
    const scope = { site: "dr-lurie" };
    const first = await promoteStrategySignals(sightings, { improvementRepository }, { scope });
    expect(first.promoted.length).toBe(STRATEGY_PLAYBOOK_TARGET_NODES.length);

    // Same sightings, same scope, called again — a retried job or a duplicate scheduler fire, with
    // no new window having arrived.
    const second = await promoteStrategySignals(sightings, { improvementRepository }, { scope });
    expect(second.promoted).toEqual([]);
    expect(second.reinforced).toEqual([]);

    const writer = (await improvementRepository.getPlaybook("draft_writer", scope))!;
    expect(writer.items.find((item) => item.text.includes("stay past the first screen"))!.helpfulCount).toBe(1);
  });
});

describe("Track B — distinct tenants stay distinct under promotion", () => {
  let store: ReturnType<typeof resolveDefaultClientMemoryBackend>;
  let improvementRepository: BlobImprovementRepository;

  beforeEach(() => {
    resetClientMemoryStore();
    store = resolveDefaultClientMemoryBackend({} as NodeJS.ProcessEnv);
    improvementRepository = new BlobImprovementRepository(store);
  });

  it("promoting tenant A's evidence never reaches tenant B's playbook or the fleet's", async () => {
    const sightingsFor = (direction: "above" | "below"): StrategySignalSighting[] =>
      [WINDOW_1, WINDOW_2].map((window) => ({
        strategy: "objection_first", intent: "objection_handling", metric: "p75_dwell_ms" as const, direction, n: 400, window,
        finding: { metric: "p75_dwell_ms" as const, direction, value: direction === "above" ? 42000 : 9000, siteFigure: 20000, ratio: direction === "above" ? 2.1 : 0.45 }
      }));

    await promoteStrategySignals(sightingsFor("above"), { improvementRepository }, { scope: { site: "tenant-a" }, nodeIds: ["draft_writer"] });
    await promoteStrategySignals(sightingsFor("below"), { improvementRepository }, { scope: { site: "tenant-b" }, nodeIds: ["draft_writer"] });

    const a = (await improvementRepository.getPlaybook("draft_writer", { site: "tenant-a" }))!;
    const b = (await improvementRepository.getPlaybook("draft_writer", { site: "tenant-b" }))!;
    expect(a.items.some((item) => item.text.startsWith("Reach for"))).toBe(true);
    expect(a.items.some((item) => item.text.startsWith("Do not default to"))).toBe(false);
    expect(b.items.some((item) => item.text.startsWith("Do not default to"))).toBe(true);
    expect(b.items.some((item) => item.text.startsWith("Reach for"))).toBe(false);

    // Neither tenant's promotion ever touches the fleet playbook (no scope).
    expect(await improvementRepository.getPlaybook("draft_writer")).toBeUndefined();
  });
});

describe("Track B — overlapping windows cannot manufacture the promotion threshold", () => {
  const sighting = (window: { from: string; to: string }, n = 400) => ({
    strategy: "objection_first", intent: "objection_handling", metric: "p75_dwell_ms" as const, direction: "above" as const, n, window,
    finding: { metric: "p75_dwell_ms" as const, direction: "above" as const, value: 42000, siteFigure: 20000, ratio: 2.1 }
  });

  it("strategyWindowsOverlap treats ordinary adjacent day windows (sharing only a boundary) as non-overlapping", () => {
    expect(strategyWindowsOverlap(WINDOW_1, WINDOW_2)).toBe(false);
  });

  it("strategyWindowsOverlap flags a rolling window that shares most of its span with the last one", () => {
    // A 6-day rolling window advanced by 3 days: half of it is the same days as before.
    const a = { from: "2026-08-24", to: "2026-08-30" };
    const b = { from: "2026-08-27", to: "2026-09-02" };
    expect(strategyWindowsOverlap(a, b)).toBe(true);
  });

  it("two overlapping windows in the same direction do not stabilize into a lesson", () => {
    const a = { from: "2026-08-24", to: "2026-08-30" };
    const b = { from: "2026-08-27", to: "2026-09-02" };
    expect(stableStrategySignals([sighting(a), sighting(b)])).toEqual([]);
  });

  it("the same evidence stabilizes once the second window genuinely does not overlap the first", () => {
    const a = { from: "2026-08-24", to: "2026-08-30" };
    const c = { from: "2026-08-30", to: "2026-09-05" };
    expect(stableStrategySignals([sighting(a), sighting(c)])).toHaveLength(1);
  });

  it("an overlapping window is still eligible as a CONTRADICTION — countering stays cheap even when the streak logic would refuse it as confirmation", () => {
    // Countering has never required a streak (see contradictingStrategySignals's own contract: one
    // qualifying sighting in the newest window is enough) — overlap only guards the STREAK a
    // promotion needs, not the single-window check a counter uses.
    const a = { from: "2026-08-24", to: "2026-08-30" };
    const b = { from: "2026-08-27", to: "2026-09-02" };
    const reversed = { ...sighting(b), direction: "below" as const };
    expect(contradictingStrategySightings([sighting(a), reversed])).toHaveLength(1);
  });
});
