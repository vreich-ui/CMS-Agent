// P2 v2 acceptance -- applying a ONE-WRITE page materialization plan, and the two cases the compiler
// could not cover: a failure on that write, and a duplicate retry.
//
// The writer and journal here are in-memory doubles. NOTHING in this suite reaches a tenant; see
// platformSiteObjectWriter.test.ts for the real writer, exercised against a mocked ClientToolCall.
import { describe, expect, it } from "vitest";

import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import type { SiteContextObject, SiteObjectFieldContract } from "../../../src/agent/operations/siteContext.js";
import { compileSiteContentObjects } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import type { DraftedSectionInput, PageMaterializationPlan } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { applySiteContentPlan } from "../../../src/agent/operations/siteContentObjectApplier.js";
import type { ApplyJournal, ApplyJournalRecord, SiteObjectWriter } from "../../../src/agent/operations/siteContentObjectApplier.js";
import { createInMemorySiteContextSource, DEFAULT_REGISTRIES } from "./fixtures/inMemorySiteContextSource.js";

const TENANT = "kugel-platform";

const SECTION_CONTRACT: SiteObjectFieldContract = {
  objectType: "section",
  required: ["sectionType", "data"],
  schema: { type: "object", additionalProperties: true, required: ["sectionType", "data"], properties: { sectionType: { type: "string", enum: ["prose", "bio", "faq", "steps"] }, data: { type: "object", additionalProperties: true } } }
};
const PAGE_CONTRACT: SiteObjectFieldContract = {
  objectType: "page",
  required: ["pageType", "slug", "title", "sections"],
  schema: { type: "object", additionalProperties: true, required: ["pageType", "slug", "title", "sections"], properties: { pageType: { type: "string" }, slug: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, sections: { type: "array" } } }
};

const drafted = (order: number, kind: "organization" | "people" = "organization"): DraftedSectionInput => ({
  order,
  sectionType: kind === "people" ? "our_team" : "about_overview",
  draft: { narrativeKind: kind, title: `Section ${order}`, body: `<p>Body ${order}.</p>`, groundedIn: ["src"] },
  runId: `run_${order}`,
  executionId: `exec_${order}`
});

type InlineSection = { id: string; type: string; data: Record<string, unknown> };
const pageObject = (objectId: string, sections: InlineSection[] = [], contentRevision = 3): SiteContextObject => ({
  objectId,
  objectType: "page",
  status: "saved",
  version: 5,
  contentRevision,
  publishedTime: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { pageType: "standard", slug: "about", title: "About", sections }
});

const compile = async (
  sections: DraftedSectionInput[],
  objects: { page?: SiteContextObject[] } = {},
  target: { pageObjectId?: string | null; sectionTargets?: Record<number, string> } = {}
): Promise<PageMaterializationPlan> => {
  const { source } = createInMemorySiteContextSource({ tenantId: TENANT, revisionId: "rev_1", objectsByType: { section: [], page: objects.page ?? [] }, contractsByType: { section: SECTION_CONTRACT, page: PAGE_CONTRACT }, registries: DEFAULT_REGISTRIES });
  const snapshot = await captureSiteSnapshot(source, { tenantId: TENANT, objectTypes: ["page", "section"] });
  const result = compileSiteContentObjects({
    projectId: TENANT,
    drafted: sections,
    snapshot,
    target: { pageObjectId: target.pageObjectId ?? null, pageFields: { pageType: "standard", slug: "about", title: "About" }, ...(target.sectionTargets ? { sectionTargets: target.sectionTargets } : {}) }
  });
  if (!result.ok) throw new Error(`fixture plan did not compile: ${JSON.stringify(result.blockers)}`);
  return result.plan;
};

type WriterCall = { method: "create" | "patch" | "read"; objectType: string; objectId?: string; expectedContentRevision?: number; idempotencyKey?: string };

const createWriter = (options: { failOn?: (call: WriterCall, callIndex: number) => string | undefined; skipReadbackFor?: string; dedupes?: boolean } = {}) => {
  const calls: WriterCall[] = [];
  const store = new Map<string, { objectId: string; objectType: string; fields: Record<string, unknown>; contentRevision: number; version: number }>();
  const byIdempotencyKey = new Map<string, string>();
  let minted = 0;

  const writer: SiteObjectWriter = {
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
      // A DELIBERATELY STALE CLAIM -- the store holds revision 1, the write reports 0 -- so the
      // "reports what it read back" guarantee is actually exercised, not assumed.
      return { objectId, contentRevision: 0, version: 0 };
    },
    async patchObject({ objectType, objectId, ops, expectedContentRevision }) {
      const call: WriterCall = { method: "patch", objectType, objectId, expectedContentRevision };
      calls.push(call);
      const failure = options.failOn?.(call, calls.length - 1);
      if (failure) throw new Error(failure);
      const existing = store.get(objectId) ?? { objectId, objectType, fields: { sections: [] }, contentRevision: 0, version: 0 };
      let fields = existing.fields;
      for (const op of ops) {
        if (op.op === "set_page_meta") fields = { ...fields, ...op.fields };
        else if (op.op === "upsert_section") {
          const sections = Array.isArray(fields.sections) ? [...(fields.sections as InlineSection[])] : [];
          const index = sections.findIndex((s) => s.id === op.section.id);
          const entry = op.section as InlineSection;
          if (index >= 0) sections[index] = entry;
          else if (op.position !== undefined) sections.splice(op.position, 0, entry);
          else sections.push(entry);
          fields = { ...fields, sections };
        } else if (op.op === "update_section_data") {
          const sections = (fields.sections as InlineSection[]).map((s) => (s.id === op.sectionId ? { ...s, data: { ...s.data, ...op.fields } } : s));
          fields = { ...fields, sections };
        }
      }
      const next = { ...existing, fields, contentRevision: existing.contentRevision + 1, version: existing.version + 1 };
      store.set(objectId, next);
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
      return found ? (JSON.parse(JSON.stringify(found)) as ApplyJournalRecord) : null;
    },
    async write(record) {
      records.set(`${record.tenantId}:${record.materializationKey}`, JSON.parse(JSON.stringify(record)) as ApplyJournalRecord);
    }
  };
  return { journal, records };
};

describe("applySiteContentPlan — page create (the default, common case)", () => {
  it("writes one create, and reports the revision it read back, not the one the writer claimed", async () => {
    const plan = await compile([drafted(1), drafted(4, "people"), drafted(7)]);
    const { writer, calls, store } = createWriter();
    const { journal } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("applied");
    expect(calls.filter((c) => c.method !== "read")).toHaveLength(1);
    expect(calls[0]!.method).toBe("create");
    expect(result.receipt).toMatchObject({ objectType: "page", action: "create", contentRevision: 1, version: 1 });
    expect(result.receipt!.appliedAt).toMatch(/^\d{4}-/);

    const page = store.get(result.receipt!.objectId)!;
    expect((page.fields.sections as InlineSection[]).map((s) => s.type)).toEqual(["prose", "bio", "prose"]);
    expect(JSON.stringify(page.fields.sections)).not.toContain("pendingSectionIndex");
  });

  it("carries the idempotency key from the materialization key", async () => {
    const plan = await compile([drafted(0)]);
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    await applySiteContentPlan(plan, { writer, journal });

    const key = calls[0]!.idempotencyKey!;
    expect(key).toBe(`${plan.materializationKey}:page`);
  });
});

describe("applySiteContentPlan — page patch (mixed ops)", () => {
  it("passes the plan's frozen page contentRevision through as the guard, and applies the mixed ops", async () => {
    const existing: InlineSection = { id: "s_team", type: "bio", data: { heading: "The team", body: "<p>old</p>", trustNotes: [] } };
    const page = pageObject("page_about", [existing], 3);
    const plan = await compile([drafted(4, "people"), drafted(9)], { page: [page] }, { pageObjectId: "page_about", sectionTargets: { 4: "s_team" } });
    const { writer, calls, store } = createWriter();
    // Seed the fake tenant store with the page's actual starting content -- the fixture's own local
    // `store` map has no notion of "what the tenant already holds" until something writes to it, so
    // a patch test must seed it, exactly as a real tenant already holds the page this plan targets.
    store.set("page_about", { objectId: "page_about", objectType: "page", fields: page.fields, contentRevision: page.contentRevision, version: 5 });
    const { journal } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("applied");
    expect(calls[0]).toMatchObject({ method: "patch", objectId: "page_about", expectedContentRevision: 3 });
    const written = store.get("page_about")!;
    const sections = written.fields.sections as InlineSection[];
    expect(sections).toHaveLength(2);
    expect(sections[0]!.data.body).toBe("<p>Body 4.</p>");
  });
});

describe("applySiteContentPlan — the write fails", () => {
  it("reports not_applied and names exactly what failed", async () => {
    const plan = await compile([drafted(0)]);
    const { writer } = createWriter({ failOn: (call) => (call.method === "create" ? "store refused: quota exceeded" : undefined) });
    const { journal, records } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("not_applied");
    expect(result.failure).toMatchObject({ code: "write_failed", objectType: "page" });
    expect(result.failure!.message).toContain("quota exceeded");
    const record = [...records.values()][0]!;
    expect(record.status).toBe("failed");
    expect(record.entry.status).toBe("failed");
  });

  it("resumes on the next attempt against a dedupe-safe writer and lands on the object the retry replays onto", async () => {
    const plan = await compile([drafted(0)]);
    const { journal } = createJournal();
    let failNext = true;
    const box = createWriter({ dedupes: true, failOn: (call) => (failNext && call.method === "create" ? "transient" : undefined) });

    const first = await applySiteContentPlan(plan, { writer: box.writer, journal });
    expect(first.outcome).toBe("not_applied");

    failNext = false;
    const second = await applySiteContentPlan(plan, { writer: box.writer, journal });
    expect(second.outcome).toBe("applied");
    expect(box.mintedCount()).toBe(1);
  });
});

describe("applySiteContentPlan — duplicate retry", () => {
  it("applies nothing the second time and returns the receipt it recorded the first time", async () => {
    const plan = await compile([drafted(0)]);
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    const first = await applySiteContentPlan(plan, { writer, journal });
    const callsAfterFirst = calls.length;
    const second = await applySiteContentPlan(plan, { writer, journal });

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("already_applied");
    expect(calls.length).toBe(callsAfterFirst);
    expect(second.receipt!.objectId).toBe(first.receipt!.objectId);
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
    const { writer } = createWriter({ skipReadbackFor: "page_1" });
    const { journal, records } = createJournal();

    const result = await applySiteContentPlan(plan, { writer, journal });

    expect(result.outcome).toBe("not_applied");
    expect(result.failure).toMatchObject({ code: "readback_missing", objectId: "page_1" });
    expect([...records.values()][0]!.entry.status).toBe("failed");
  });

  it("does not attempt a write it could not journal first", async () => {
    const plan = await compile([drafted(0)]);
    const { writer, calls } = createWriter();
    const brokenJournal: ApplyJournal = { read: async () => null, write: async () => { throw new Error("journal bucket unreachable"); } };

    await expect(applySiteContentPlan(plan, { writer, journal: brokenJournal })).rejects.toThrow(/journal bucket unreachable/);
    expect(calls).toHaveLength(0);
  });
});

describe("applySiteContentPlan — the window a journal cannot close", () => {
  it("stops rather than retrying an unfinished create when the writer cannot deduplicate", async () => {
    const plan = await compile([drafted(0)]);
    const { journal, records } = createJournal();

    const first = createWriter({ dedupes: false });
    let writes = 0;
    const flakyJournal: ApplyJournal = {
      read: journal.read,
      write: async (record) => {
        writes += 1;
        // 1st write: pending. 2nd: the applied record -- this is the one that is lost.
        if (writes === 2) throw new Error("journal bucket unreachable");
        await journal.write(record);
      }
    };
    await expect(applySiteContentPlan(plan, { writer: first.writer, journal: flakyJournal })).rejects.toThrow(/journal bucket unreachable/);
    expect(first.mintedCount()).toBe(1);
    expect([...records.values()][0]!.entry.status).toBe("pending");

    const second = await applySiteContentPlan(plan, { writer: first.writer, journal });

    expect(second.outcome).toBe("blocked_indeterminate");
    expect(second.failure).toMatchObject({ code: "indeterminate_prior_attempt", objectType: "page" });
    expect(second.failure!.message).toContain("could create a second one");
    expect(first.mintedCount()).toBe(1);
  });

  it("retries the unfinished create when the writer deduplicates, and lands on the same object", async () => {
    const plan = await compile([drafted(0)]);
    const { journal } = createJournal();
    const box = createWriter({ dedupes: true });

    let writes = 0;
    const flakyJournal: ApplyJournal = {
      read: journal.read,
      write: async (record) => {
        writes += 1;
        if (writes === 2) throw new Error("journal bucket unreachable");
        await journal.write(record);
      }
    };
    await expect(applySiteContentPlan(plan, { writer: box.writer, journal: flakyJournal })).rejects.toThrow();
    const mintedFirst = box.mintedCount();

    const second = await applySiteContentPlan(plan, { writer: box.writer, journal });

    expect(second.outcome).toBe("applied");
    expect(box.mintedCount()).toBe(mintedFirst);
  });

  it("refuses a plan from a schema version it does not understand, rather than reinterpreting it", async () => {
    const plan = await compile([drafted(0)]);
    const doctored = { ...plan, schemaVersion: "site-content-object-plan.v1" as unknown as typeof plan.schemaVersion };
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    await expect(applySiteContentPlan(doctored, { writer, journal })).rejects.toThrow(/site-page-materialization\.v2/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed patch op rather than sending it to the writer", async () => {
    const existing: InlineSection = { id: "s_team", type: "bio", data: { heading: "The team", body: "<p>old</p>", trustNotes: [] } };
    const page = pageObject("page_about", [existing], 3);
    const plan = await compile([drafted(4, "people")], { page: [page] }, { pageObjectId: "page_about", sectionTargets: { 4: "s_team" } });
    // A doctored ops array carrying something that is not one of the six named ops.
    const doctored: PageMaterializationPlan = { ...plan, write: { kind: "patch", ops: [{ op: "delete_everything" } as never] } };
    const { writer, calls } = createWriter();
    const { journal } = createJournal();

    const result = await applySiteContentPlan(doctored, { writer, journal });

    expect(result.outcome).toBe("not_applied");
    expect(result.failure).toMatchObject({ code: "malformed_patch_op" });
    expect(calls).toHaveLength(0);
  });
});
