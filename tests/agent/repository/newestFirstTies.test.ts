import { describe, expect, it, vi } from "vitest";
import { BlobEvaluationRepository } from "../../../src/agent/repository/blobs/BlobEvaluationRepository.js";
import { MemoryEvaluationRepository } from "../../../src/agent/repository/memory/MemoryEvaluationRepository.js";
import { __test__, sortNewestFirst } from "../../../src/agent/repository/newestFirst.js";
import { feedbackKinds, makeImprovementId, type FeedbackRecord } from "../../../src/agent/improvement/improvementTypes.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";

// T-15. Five records written inside one millisecond share a createdAt to the millisecond, so
// ordering by createdAt alone is not a total order and `limit: 3` was returning three ARBITRARY
// records of the five while presenting itself as the newest three. The original entry called for a
// tiebreak on the id; that alone would not have worked, because ids were Date.now() plus a random
// tail and inside one millisecond only the random part varied. Both halves are asserted here: ids
// increase in creation order within a millisecond, and both repositories sort on them.

const FROZEN = "2026-09-08T09:00:00.000Z";

const feedback = (): FeedbackRecord =>
  ({ feedbackId: makeImprovementId("fb"), kind: feedbackKinds[0]!, nodeId: "writer", createdAt: new Date().toISOString() }) as FeedbackRecord;

/**
 * The blob repositories read whatever order the store lists keys in, and a stable sort over equal
 * createdAt values just preserves it — so the answer depended on the store rather than on the
 * records.
 *
 * This stub lists keys in an order that is NEITHER insertion order NOR its reverse. Reverse is the
 * obvious choice and it is useless here: reverse-insertion already IS newest-first, so a comparator
 * that returned 0 for every pair would land on the right answer by accident and the test would
 * prove nothing. Interleaving does not.
 */
const scramblingStore = (): BlobStoreClient => {
  const blobs = new Map<string, unknown>();
  return {
    async setJSON(key: string, value: unknown) { blobs.set(key, value); },
    async get(key: string, options?: { type?: string }) {
      const value = blobs.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? value : JSON.stringify(value);
    },
    async list({ prefix }: { prefix: string }) {
      const keys = [...blobs.keys()].filter((key) => key.startsWith(prefix));
      const scrambled = [...keys.filter((_, index) => index % 2 === 0), ...keys.filter((_, index) => index % 2 === 1)];
      return { blobs: scrambled.map((key) => ({ key, etag: key })), directories: [] };
    },
    async delete(key: string) { blobs.delete(key); },
  } as unknown as BlobStoreClient;
};

const writeFive = async (record: (r: FeedbackRecord) => Promise<unknown>) => {
  const written: FeedbackRecord[] = [];
  for (let index = 0; index < 5; index++) {
    const entry = feedback();
    written.push(entry);
    await record(entry);
  }
  return written;
};

describe("makeImprovementId", () => {
  it("increases within a frozen millisecond and still resets when the clock advances", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FROZEN));
      const first = [0, 1, 2, 3, 4].map(() => makeImprovementId("fb"));
      expect([...first].sort()).toEqual(first); // already ascending, no sort needed
      expect(new Set(first).size).toBe(5);
      // The sequence is the third segment, zero-padded so it sorts as a string.
      expect(first.map((id) => id.split("_")[2])).toEqual(["0000", "0001", "0002", "0003", "0004"]);

      vi.setSystemTime(new Date("2026-09-08T09:00:00.001Z"));
      expect(makeImprovementId("fb").split("_")[2]).toBe("0000");

      // A wall clock that steps BACKWARDS must not re-issue a prefix already handed out. It stops
      // advancing instead: the ms stays where it was and the sequence keeps climbing.
      vi.setSystemTime(new Date(FROZEN));
      const afterStepBack = makeImprovementId("fb");
      expect(afterStepBack.split("_")[1]).toBe(String(new Date("2026-09-08T09:00:00.001Z").getTime()));
      expect(afterStepBack.split("_")[2]).toBe("0001");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sortNewestFirst", () => {
  it("ties on the record's OWN identity, not on an id it merely references", () => {
    // A FeedbackRecord may carry the evalId of the result it comments on. Tying on that would order
    // feedback by the thing it points at; a TrialRecord would likewise tie on its proposal.
    expect(__test__.identityOf({ feedbackId: "fb_2", evalId: "eval_1" })).toBe("fb_2");
    expect(__test__.identityOf({ trialId: "trial_2", proposalId: "prop_1" })).toBe("trial_2");
    expect(__test__.identityOf({ nodeId: "writer" })).toBe("");
  });

  it("leaves records with different timestamps alone", () => {
    const rows = [{ createdAt: "2026-09-01T00:00:00.000Z", id: "a" }, { createdAt: "2026-09-03T00:00:00.000Z", id: "b" }];
    expect(sortNewestFirst(rows).map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [{ createdAt: "2026-09-01T00:00:00.000Z", id: "a" }, { createdAt: "2026-09-03T00:00:00.000Z", id: "b" }];
    sortNewestFirst(rows);
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("listFeedback with limit, five records in one millisecond", () => {
  it("returns the three newest by insertion — memory repository", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FROZEN));
      const repository = new MemoryEvaluationRepository("t15-memory");
      const written = await writeFive((record) => repository.recordFeedback(record));
      const newest = await repository.listFeedback({ limit: 3 });
      expect(newest.map((record) => record.feedbackId)).toEqual([written[4]!, written[3]!, written[2]!].map((record) => record.feedbackId));
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the three newest by insertion — blob repository, whatever order the store lists keys in", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FROZEN));
      const repository = new BlobEvaluationRepository(scramblingStore());
      const written = await writeFive((record) => repository.recordFeedback(record));
      const newest = await repository.listFeedback({ limit: 3 });
      expect(newest.map((record) => record.feedbackId)).toEqual([written[4]!, written[3]!, written[2]!].map((record) => record.feedbackId));
    } finally {
      vi.useRealTimers();
    }
  });
});
