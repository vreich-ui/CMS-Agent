import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import { TemplateLibraryRefusal } from "../../../src/agent/library/templateLibraryTypes.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { buildCaptureEngineHashes, STANDARDS_PACK_VERSION } from "../../../src/agent/library/templateProvenance.js";

beforeEach(() => resetTemplateLibraryMemoryStore());
afterEach(() => resetTemplateLibraryMemoryStore());

const depositInput = (overrides: Partial<Parameters<TemplateLibraryStore["publish"]>[0]> = {}) => ({
  templateId: "zilberman::section_template::req_hero",
  objectType: "section_template" as const,
  name: "Hero",
  recipe: { name: "Hero", blueprint: { type: "hero", data: { headline: "Welcome" } } },
  sourceProjectId: "zilberman",
  provenance: { sourceUrl: "https://zilberman.example/", captureRunId: "run_capture_1", driven: "clone" as const },
  ...overrides
});

describe("TemplateLibraryStore.publish", () => {
  it("mints version 1 for a templateId never seen before", async () => {
    const store = new TemplateLibraryStore();
    const result = await store.publish(depositInput());
    expect(result.outcome).toBe("minted");
    expect(result.record.version).toBe(1);
    expect(result.record.templateId).toBe("zilberman::section_template::req_hero");
    expect(result.record.sectionTypesUsed).toEqual(["hero"]);
    expect(result.record.provenance).toEqual({
      sourceUrl: "https://zilberman.example/",
      captureRunId: "run_capture_1",
      engineHashes: buildCaptureEngineHashes(),
      standardsPack: STANDARDS_PACK_VERSION
    });
    expect(typeof result.record.publishedAt).toBe("string");
  });

  it("publishing a CHANGE mints version 2 and leaves version 1 byte-identical", async () => {
    const store = new TemplateLibraryStore();
    const v1 = await store.publish(depositInput());
    const v2 = await store.publish(depositInput({ recipe: { name: "Hero", blueprint: { type: "hero", data: { headline: "Welcome, changed" } } } }));

    expect(v2.outcome).toBe("minted");
    expect(v2.record.version).toBe(2);

    const rereadV1 = await store.getVersion("zilberman::section_template::req_hero", 1);
    expect(rereadV1).toEqual(v1.record);

    const rereadV2 = await store.getVersion("zilberman::section_template::req_hero", 2);
    expect(rereadV2).toEqual(v2.record);
    expect(rereadV1).not.toEqual(rereadV2);
  });

  it("two identical deposits produce identical library records — no new version, no publishedAt drift", async () => {
    const store = new TemplateLibraryStore();
    const first = await store.publish(depositInput());
    const second = await store.publish(depositInput());
    expect(second.outcome).toBe("unchanged");
    expect(second.record).toEqual(first.record);
    expect(second.record.version).toBe(1);
  });

  it("a tenant pinned to v1 stays on v1 after a later version is minted", async () => {
    const store = new TemplateLibraryStore();
    const v1 = await store.publish(depositInput());
    await store.publish(depositInput({ recipe: { name: "Hero", blueprint: { type: "hero", data: { headline: "v2" } } } }));

    const pinned = await store.getVersion("zilberman::section_template::req_hero", 1);
    expect(pinned).toEqual(v1.record);

    const latest = await store.getLatest("zilberman::section_template::req_hero");
    expect(latest?.version).toBe(2);
    expect(latest).not.toEqual(pinned);
  });

  it("refuses a deposit with unstateable provenance, named, without minting anything", async () => {
    const store = new TemplateLibraryStore();
    await expect(store.publish(depositInput({ provenance: { sourceUrl: undefined, captureRunId: "run_capture_1", driven: "clone" } }))).rejects.toMatchObject({
      code: "template_provenance_unstateable"
    });
    expect(await store.getLatest("zilberman::section_template::req_hero")).toBeUndefined();
  });

  it("refuses a clone-driven deposit missing captureRunId, named", async () => {
    const store = new TemplateLibraryStore();
    await expect(store.publish(depositInput({ provenance: { sourceUrl: "https://zilberman.example/", captureRunId: undefined, driven: "clone" } })))
      .rejects.toBeInstanceOf(TemplateLibraryRefusal);
  });

  it("two independently-constructed stores against the default (memory) backend see each other's writes", async () => {
    await new TemplateLibraryStore().publish(depositInput());
    const reread = await new TemplateLibraryStore().getLatest("zilberman::section_template::req_hero");
    expect(reread?.version).toBe(1);
  });
});

describe("TemplateLibraryStore.list", () => {
  it("lists every version across templates, filterable by objectType and sectionType", async () => {
    const store = new TemplateLibraryStore();
    await store.publish(depositInput());
    await store.publish(depositInput({ recipe: { name: "Hero", blueprint: { type: "hero", data: { headline: "v2" } } } }));
    await store.publish(depositInput({
      templateId: "zilberman::template::req_landing",
      objectType: "template",
      name: "Landing",
      recipe: { name: "Landing", slots: [{ slotId: "s1", allowed: ["faq"] }] }
    }));

    const all = await store.list();
    expect(all).toHaveLength(3);

    const heroOnly = await store.list({ templateId: "zilberman::section_template::req_hero" });
    expect(heroOnly.map((r) => r.version).sort()).toEqual([1, 2]);

    const byObjectType = await store.list({ objectType: "template" });
    expect(byObjectType).toHaveLength(1);
    expect(byObjectType[0].name).toBe("Landing");

    const bySectionType = await store.list({ sectionType: "faq" });
    expect(bySectionType.map((r) => r.templateId)).toEqual(["zilberman::template::req_landing"]);

    const noMatch = await store.list({ sectionType: "nonexistent" });
    expect(noMatch).toEqual([]);
  });
});
