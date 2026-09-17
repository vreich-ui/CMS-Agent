// P2 wave 2 acceptance — applying a compiled plan, and the two cases the compiler could not cover:
// a failure after one section write, and a duplicate retry.
//
// The writer and journal here are in-memory doubles. NOTHING in this suite reaches a tenant; the
// production writer binding does not exist yet, deliberately (see the applier's header and the
// delivery note).
import { describe, expect, it } from "vitest";

import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import type { SiteContextObject, SiteObjectFieldContract } from "../../../src/agent/operations/siteContext.js";
import { compileSiteContentObjects } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import type { DraftedSectionInput, SiteContentObjectPlan } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { applySiteContentPlan } from "../../../src/agent/operations/siteContentObjectApplier.js";
import type { ApplyJournal, ApplyJournalRecord, SiteObjectWriter } from "../../../src/agent/operations/siteContentObjectApplier.js";
import { createInMemorySiteContextSource, DEFAULT_REGISTRIES } from "./fixtures/inMemorySiteContextSource.js";

const TENANT = "kugel-platform";

const SECTION_CONTRACT: SiteObjectFieldContract = {
  objectType: "section",
  required: ["sectionType", "data"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["sectionType", "data"],
    properties: { sectionType: { type: "string", enum: ["prose", "bio", "faq", "steps"] }, data: { type: "object", additionalProperties: true } }
  }
};
const PAGE_CONTRACT: SiteObjectFieldContract = {
  objectType: "page",
  required: ["pageType", "slug", "title", "sections"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["pageType", "slug", "title", "sections"],
    properties: { pageType: { type: "string" }, slug: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, sections: { type: "array" } }
  }
};

const drafted = (order: number, kind: "organization" | "people" = "organization"): DraftedSectionInput => ({
  order,
  sectionType: kind === "people" ? "our_team" : "about_overview",
  draft: { narrativeKind: kind, title: `Section ${order}`, body: `<p>Body ${order}.</p>`, groundedIn: ["src"] },
  runId: `run_${order}`,
  executionId: `exec_${order}`
});

const compile = async (
  sections: DraftedSectionInput[],
  objects: { section?: SiteContextObject[]; page?: SiteContextObject[] } = {},
  target: { pageObjectId?: string | null; sectionTargets?: Record<number, string> } = {}
): Promise<SiteContentObjectPlan> => {
  const { source } = createInMemorySiteContextSource({
    tenantId: TENANT,
    revisionId: "rev_1",
    objectsByType: { section: objects.section ?? [], page: objects.page ?? [] },
    contractsByType: { section: SECTION_CONTRACT, page: PAGE_CONTRACT },
    registries: DEFAULT_REGISTRIES
  });
  const snapshot = await captureSiteSnapshot(source, { tenantId: TENANT, objectTypes: ["page", "section"] });
  const result = compileSiteContentObjects({
    projectId: TENANT,
    drafted: sections,
    snapshot,
    target: {
      pageObjectId: target.pageObjectId ?? null,
      pageFields: { pageType: "standard", slug: "about", title: "About" },
      ...(target.sectionTargets ? { sectionTargets: target.sectionTargets } : {})
    }
  });
  if (!result.ok) throw new Error(`fixture plan did not compile: ${JSON.stringify(result.blockers)}`);
  return result.plan;
};

type WriterCall = { method: "create" | "patch" | "read"; objectType: string; objectId?: string; expectedContentRevision?: number; idempotencyKey?: string };

// An in-memory store with a real id counter, so a duplicate apply that DID write twice would show
// two different ids rather than quietly looking identical.
const createWriter = (options: { failOn?: (call: WriterCall, callIndex: number) => string | undefined; skipReadbackFor?: string; dedupes?: boolean } = {}) => {
  const calls: WriterCall[] = [];
  const store = new Map<string, { objectId: string; objectType: string; fields: Record<string, unknown>; contentRevision: number; version: number }>();
  const byIdempotencyKey = new Map<string, string>();
  let minted = 0;

  const writer: SiteObjectWriter = {
    // Default true: a real store that takes an idempotency key is the case worth testing most, and
    // the `dedupes: false` writer below proves the other branch.
    dedupesByIdempotencyKey: options.dedupes ?? true,
    async createObject({ objectType, fields, idempotencyKey }) {
      const call: WriterCall = { method: "create", objectType, idempotencyKey };
      calls.push(call);
      const failure = options.failOn?.(call, calls.length - 1);
      if (failure) throw new Error(failure);
      const seen = writer.dedupesByIdempotencyKey ? byIdempotencyKey.get(idempotencyKey) : undefined;
      if (seen) {
        const existing = store.get(seen)!;
        return { objectId: seen, contentRevision: existing.contentRevision, version: existing.version };
      }
      minted += 1;
      const objectId = `${objectType}_${minted}`;
      store.set(objectId, { objectId, objectType, fields, contentRevision: 1, version: 1 });
      byIdempotencyKey.set(idempotencyKey, objectId);
      // A DELIBERATELY STALE CLAIM. The store holds revision 1; what the write reports is 0. A
      // receipt built from the write rather than the readback would say 0, so the "reports what it
      // read back" guarantee is actually exercised rather than assumed.
      return { objectId, contentRevision: 0, version: 0 };
    },
    async patchObject({ objectType, objectId, fields, expectedContentRevision, idempotencyKey }) {
      const call: WriterCall = { method: "patch", objectType, objectId, expectedContentRevision, idempotencyKey };
      calls.push(call);
      const failure = options.failOn?.(call, calls.length - 1);
      if (failure) throw new Error(failure);
      const existing = store.get(objectId) ?? { objectId, objectType, fields: {}, contentRevision: 0, version: 0 };
      const next = { ...existing, fields: { ...existing.fields, ...fields }, contentRevision: existing.contentRevision + 1, version: existing.version + 1 };
      store.set(objectId, next);
      // Stale claim again — see createObject.
      return { objectId, contentRevision: 0, version: 0 };
    },
    async readObject({ objectType, objectId }) {
      calls.push({ method: "read", objectType, objectId });
      if (options.skipReadbackFor === objectId) return null;
      const found = store.get(objectId);
      return found ? { objectId: found.objectId, contentRevision: found.contentRevision, version: found.version } : null;
    }
  };

  return { writer, calls, store, mintedCount: () => minted };
};

const createJournal = () => {
  const records = new Map<string, ApplyJournalRecord>();
  const journal: ApplyJournal = {
    async read({ tenantId, materializationKey }) {
      const found = records.get(`${tenantId}:${materializationKey}`);
      // A copy, as a real store would hand back — so the applier mutating its working record cannot
      // retroactively edit what was journalled.
      return found ? (JSON.parse(JSON.stringify(found)) as ApplyJournalRecord) : null;
    },
    async write(record) {
      records.set(`${record.tenantId}:${record.materializationKey}`, JSON.parse(JSON.stringify(record)) as ApplyJournalRecord);
    }
  };
  return { journal, records };
};

describe("applySiteContentPlan — the happy path", () => {
  it("writes every section before the page, and the page references the ids the writer actually minted", async () => {
    const plan = await compile([drafted(1), drafted(4, "people"), drafted(7)]);
    const { writer, calls, store } = createWriter();
    const { journal } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("applied");
    expect(result.receipts).toHaveLength(4);
    // Sections first, page last — a page written before its sections would reference ids that do
    // not exist.
    const writeOrder = calls.filter((call) => call.method !== "read").map((call) => call.objectType);
    expect(writeOrder).toEqual(["section", "section", "section", "page"]);

    const pageReceipt = result.receipts.at(-1)!;
    const page = store.get(pageReceipt.objectId)!;
    const sectionIds = result.receipts.filter((receipt) => receipt.objectType === "section").map((receipt) => receipt.objectId);
    expect((page.fields.sections as { section: string }[]).map((entry) => entry.section)).toEqual(sectionIds);
    // No pending placeholder survives into the written page.
    expect(JSON.stringify(page.fields.sections)).not.toContain("pendingSectionIndex");
  });

  it("reports the revision it read back, not the one the writer claimed", async () => {
    const plan = await compile([drafted(0)]);
    const { writer } = createWriter();
    const { journal } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("applied");
    for (const receipt of result.receipts) {
      // The writer claims 0 on every write; the store holds 1. A receipt built from the claim would
      // report 0 here.
      expect(receipt.contentRevision).toBe(1);
      expect(receipt.version).toBe(1);
      expect(receipt.appliedAt).toMatch(/^\d{4}-/);
    }
  });

  it("passes the snapshot's revision as the expected revision on a patch, so a moved object is refused by the store", async () => {
    const existingSection: SiteContextObject = {
      objectId: "sec_team",
      objectType: "section",
      status: "saved",
      version: 5,
      contentRevision: 3,
      publishedTime: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
      fields: { sectionType: "bio", data: { heading: "The team", body: "<p>old</p>", trustNotes: [] } }
    };
    const plan = await compile([drafted(4, "people")], { section: [existingSection] }, { sectionTargets: { 4: "sec_team" } });
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    await applySiteContentPlan(plan, { writer, journal });

    const patch = calls.find((call) => call.method === "patch")!;
    expect(patch.expectedContentRevision).toBe(3);
  });
});

describe("applySiteContentPlan — failure after one section write", () => {
  it("stops, never writes the page, and names exactly what landed and what was not reached", async () => {
    const plan = await compile([drafted(1), drafted(4, "people"), drafted(7)]);
    // The SECOND section write fails. The first has already landed.
    let sectionWrites = 0;
    const { writer, calls } = createWriter({
      failOn: (call) => {
        if (call.method !== "create" || call.objectType !== "section") return undefined;
        sectionWrites += 1;
        return sectionWrites === 2 ? "store refused: quota exceeded" : undefined;
      }
    });
    const { journal, records } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("partially_applied");
    expect(result.receipts).toHaveLength(1);
    expect(result.failure).toMatchObject({ code: "write_failed", objectType: "section" });
    expect(result.failure!.message).toContain("quota exceeded");
    // The page was never attempted: it would reference a section that does not exist.
    expect(calls.some((call) => call.objectType === "page" && call.method !== "read")).toBe(false);
    // Two change sets unreached: the third section and the page.
    expect(result.remainingChangeSetIds).toHaveLength(2);

    const record = [...records.values()][0]!;
    expect(record.status).toBe("failed");
    // The failed attempt stays in the journal rather than being erased — a client-side failure may
    // still have landed server-side, and a resume must be able to see it was tried.
    expect(record.entries.map((entry) => entry.status)).toEqual(["applied", "failed"]);
  });

  it("resumes on the next attempt without rewriting what already landed", async () => {
    const plan = await compile([drafted(1), drafted(4, "people"), drafted(7)]);
    const { journal } = createJournal();

    let failNext = true;
    let sectionWrites = 0;
    const first = createWriter({
      failOn: (call) => {
        if (call.method !== "create" || call.objectType !== "section") return undefined;
        sectionWrites += 1;
        return failNext && sectionWrites === 2 ? "store refused: quota exceeded" : undefined;
      }
    });
    const firstResult = await applySiteContentPlan(plan, { writer: first.writer, journal });
    expect(firstResult.outcome).toBe("partially_applied");
    const landed = firstResult.receipts[0]!.objectId;

    // Second attempt against the same store and journal; nothing fails this time.
    failNext = false;
    const secondResult = await applySiteContentPlan(plan, { writer: first.writer, journal });

    expect(secondResult.outcome).toBe("applied");
    // Four objects for four change sets (three sections + the page). A resume that re-created the
    // section which already landed would mint five, and the store would hold a duplicate section.
    expect(first.mintedCount()).toBe(4);
    expect([...first.store.values()].filter((object) => object.objectType === "section")).toHaveLength(3);
    expect(secondResult.receipts).toHaveLength(4);
    expect(secondResult.receipts[0]!.objectId).toBe(landed);
    const page = first.store.get(secondResult.receipts.at(-1)!.objectId)!;
    expect((page.fields.sections as { section: string }[])[0]!.section).toBe(landed);
  });
});

describe("applySiteContentPlan — duplicate retry", () => {
  it("applies nothing the second time and returns the receipts it recorded the first time", async () => {
    const plan = await compile([drafted(1), drafted(4, "people")]);
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    const first = await applySiteContentPlan(plan, { writer, journal });
    const callsAfterFirst = calls.length;
    const second = await applySiteContentPlan(plan, { writer, journal });

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("already_applied");
    // Not one further call of any kind — no write, and no read either.
    expect(calls.length).toBe(callsAfterFirst);
    expect(second.receipts.map((receipt) => receipt.objectId)).toEqual(first.receipts.map((receipt) => receipt.objectId));
  });

  it("recompiling the identical request produces the same materialization key, so the retry is recognised", async () => {
    const planA = await compile([drafted(1)]);
    const planB = await compile([drafted(1)]);
    expect(planB.materializationKey).toBe(planA.materializationKey);

    const { writer } = createWriter();
    const { journal } = createJournal();
    await applySiteContentPlan(planA, { writer, journal });
    const second = await applySiteContentPlan(planB, { writer, journal });

    expect(second.outcome).toBe("already_applied");
  });
});

describe("applySiteContentPlan — evidence discipline", () => {
  it("fails a write whose object cannot be read back, rather than recording a success it cannot show", async () => {
    const plan = await compile([drafted(0)]);
    const { writer } = createWriter({ skipReadbackFor: "section_1" });
    const { journal, records } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("not_applied");
    expect(result.failure).toMatchObject({ code: "readback_missing", objectId: "section_1" });
    expect([...records.values()][0]!.entries[0]!.status).toBe("failed");
  });

  it("does not attempt a write it could not journal first", async () => {
    const plan = await compile([drafted(0)]);
    const { writer, calls } = createWriter();
    const brokenJournal: ApplyJournal = { read: async () => null, write: async () => { throw new Error("journal bucket unreachable"); } };

    await expect(applySiteContentPlan(plan, { writer, journal: brokenJournal })).rejects.toThrow(/journal bucket unreachable/);
    // An unjournalled write is the one state a resume cannot reason about, so none was made.
    expect(calls).toHaveLength(0);
  });

  it("carries each effect's idempotency key from the materialization key and its own change set", async () => {
    const plan = await compile([drafted(0)]);
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    await applySiteContentPlan(plan, { writer, journal });

    const keys = calls.filter((call) => call.idempotencyKey).map((call) => call.idempotencyKey!);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key.startsWith(`${plan.materializationKey}:`)).toBe(true);
  });
});

describe("applySiteContentPlan — the window a journal cannot close", () => {
  it("stops rather than retrying an unfinished create when the writer cannot deduplicate", async () => {
    const plan = await compile([drafted(1), drafted(4, "people")]);
    const { journal, records } = createJournal();

    // First attempt dies AFTER the store accepted the first section but before the journal recorded
    // it — the entry is left `pending`. Simulated by a journal whose second write throws.
    const first = createWriter({ dedupes: false });
    let writes = 0;
    const flakyJournal: ApplyJournal = {
      read: journal.read,
      write: async (record) => {
        writes += 1;
        // 1st: pending for section 0. 2nd: the applied record for it — this is the one that is lost.
        if (writes === 2) throw new Error("journal bucket unreachable");
        await journal.write(record);
      }
    };
    await expect(applySiteContentPlan(plan, { writer: first.writer, journal: flakyJournal })).rejects.toThrow(/journal bucket unreachable/);
    expect(first.mintedCount()).toBe(1);
    expect([...records.values()][0]!.entries[0]!.status).toBe("pending");

    // Second attempt, same non-deduplicating writer: retrying the create could mint a second
    // section, so it stops instead.
    const second = await applySiteContentPlan(plan, { writer: first.writer, journal });

    expect(second.outcome).toBe("blocked_indeterminate");
    expect(second.failure).toMatchObject({ code: "indeterminate_prior_attempt", objectType: "section" });
    expect(second.failure!.message).toContain("could create a second one");
    // Nothing further was written: still the one object from the first attempt.
    expect(first.mintedCount()).toBe(1);
  });

  it("retries the unfinished create when the writer deduplicates, and lands on the same object", async () => {
    const plan = await compile([drafted(1), drafted(4, "people")]);
    const { journal } = createJournal();
    const writerBox = createWriter({ dedupes: true });

    let writes = 0;
    const flakyJournal: ApplyJournal = {
      read: journal.read,
      write: async (record) => {
        writes += 1;
        if (writes === 2) throw new Error("journal bucket unreachable");
        await journal.write(record);
      }
    };
    await expect(applySiteContentPlan(plan, { writer: writerBox.writer, journal: flakyJournal })).rejects.toThrow();
    const mintedFirst = writerBox.mintedCount();

    const second = await applySiteContentPlan(plan, { writer: writerBox.writer, journal });

    expect(second.outcome).toBe("applied");
    // Two sections and a page: the retried create collapsed onto the object the lost attempt made.
    expect(writerBox.mintedCount()).toBe(mintedFirst + 2);
    expect([...writerBox.store.values()].filter((object) => object.objectType === "section")).toHaveLength(2);
  });

  it("refuses a change set that clears a field, because the writer port cannot express a clear", async () => {
    const plan = await compile([drafted(0)]);
    // A remove diff the compiler does not emit today — pinned so it stays refused if it ever does.
    const doctored = {
      ...plan,
      changeSets: plan.changeSets.map((changeSet) =>
        changeSet.objectType === "section"
          ? { ...changeSet, diffs: [...changeSet.diffs, { field: "legacyField", op: "remove" as const, before: "x", after: undefined }] }
          : changeSet
      )
    };
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    const result = await applySiteContentPlan(doctored, { writer, journal });

    expect(result.outcome).toBe("not_applied");
    expect(result.failure).toMatchObject({ code: "unsupported_remove_diff" });
    expect(result.failure!.message).toContain("legacyField");
    expect(calls).toHaveLength(0);
  });

  it("keys journal entries by position, so two identical sections stay two objects", async () => {
    // Byte-identical drafts at two positions compile to the same changeSetId; keying the journal on
    // that alone would collapse them onto one minted section and reference it twice.
    const identical = (order: number): DraftedSectionInput => ({
      order,
      sectionType: "about_overview",
      draft: { narrativeKind: "organization", title: "Same", body: "<p>Same.</p>", groundedIn: ["src"] }
    });
    const plan = await compile([identical(1), identical(2)]);
    expect(plan.sections[0]!.changeSetId).toBe(plan.sections[1]!.changeSetId);

    const { writer, store } = createWriter();
    const { journal } = createJournal();
    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("applied");
    const sectionIds = result.receipts.filter((receipt) => receipt.objectType === "section").map((receipt) => receipt.objectId);
    expect(new Set(sectionIds).size).toBe(2);
    const page = store.get(result.receipts.at(-1)!.objectId)!;
    expect((page.fields.sections as { section: string }[]).map((entry) => entry.section)).toEqual(sectionIds);
  });
});
