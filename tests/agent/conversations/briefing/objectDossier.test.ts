import { describe, expect, it } from "vitest";
import {
  DOSSIER_UNAVAILABLE,
  dossierBudgetMs,
  extractObjectRecord,
  factsFromRecord,
  renderObjectDossier
} from "../../../../src/agent/conversations/briefing/objectDossier.js";

describe("objectDossier — the bound-object read budget", () => {
  // Floored at 1,500ms so even a caller passing the contract's own 1,000ms minimum turn timeout gets
  // a survivable window for the read.
  it("floors the budget at 1500ms for a small turn timeout", () => {
    expect(dossierBudgetMs(1_000)).toBe(1_500);
    expect(dossierBudgetMs(4_000)).toBe(1_500);
  });

  // Ceilinged at 8,000ms so a generous turn timeout never turns into a long hang on a dead tenant.
  it("ceilings the budget at 8000ms for a large turn timeout", () => {
    expect(dossierBudgetMs(60_000)).toBe(8_000);
  });

  // The ordinary case: a quarter of the turn's own timeout, floor and ceiling both clear.
  it("is a quarter of the turn timeout between the floor and the ceiling", () => {
    expect(dossierBudgetMs(20_000)).toBe(5_000);
  });
});

describe("objectDossier — extractObjectRecord's tolerant envelope descent", () => {
  it("reads structuredContent.record when present", () => {
    expect(extractObjectRecord({ structuredContent: { record: { title: "Hero" } } })).toEqual({ title: "Hero" });
  });

  it("reads structuredContent.object when record is absent", () => {
    expect(extractObjectRecord({ structuredContent: { object: { title: "Hero" } } })).toEqual({ title: "Hero" });
  });

  it("reads structuredContent itself when neither record nor object is nested inside it", () => {
    expect(extractObjectRecord({ structuredContent: { title: "Hero" } })).toEqual({ title: "Hero" });
  });

  it("parses a content[] text block's JSON when structuredContent is absent entirely", () => {
    const result = extractObjectRecord({ content: [{ type: "text", text: JSON.stringify({ title: "Hero" }) }] });
    expect(result).toEqual({ title: "Hero" });
  });

  it("returns undefined for a result that is not an object", () => {
    expect(extractObjectRecord("not an object")).toBeUndefined();
    expect(extractObjectRecord(null)).toBeUndefined();
  });
});

describe("objectDossier — rendering", () => {
  // FAILURE IS NEVER SILENCE: an omitted block would be read by the model as "there is nothing to
  // know about this object", the one interpretation that is never true. A failure must render the
  // DOSSIER_UNAVAILABLE sentence — rev 8's read-before-you-write behaviour, restored as the fallback.
  it("renders the DOSSIER_UNAVAILABLE sentence on a failure, never an omitted block", () => {
    const rendered = renderObjectDossier({
      objectType: "content_item",
      objectId: "req_x_1",
      unavailableReason: "the house did not answer"
    });
    expect(rendered).toContain(DOSSIER_UNAVAILABLE);
    expect(rendered).toContain("(the house did not answer)");
    expect(rendered).toContain("## Bound object");
  });

  // The lifecycle vocabulary (Draft/Approved/Published/Live) is a decision made from evidence
  // elsewhere in the prompt; this module must report the tenant's own word for its status literally,
  // never translate it into one of those four terms.
  it("reports the tenant's own status word literally, without normalising it", () => {
    const record = { title: "Hero", status: "borrador" };
    const facts = factsFromRecord("content_item", "req_x_1", record);
    expect(facts.status).toBe("borrador");
    const rendered = renderObjectDossier(facts);
    expect(rendered).toContain("Status, in the tenant's own word: borrador");
    expect(rendered).not.toContain("Draft");
    expect(rendered).not.toContain("Approved");
    expect(rendered).not.toContain("Published");
    expect(rendered).not.toContain("Live");
  });

  it("still reports a tenant status word that happens to spell one of the four lifecycle terms, unchanged", () => {
    const facts = factsFromRecord("content_item", "req_x_1", { status: "Approved" });
    const rendered = renderObjectDossier(facts);
    expect(rendered).toContain("Status, in the tenant's own word: Approved");
  });

  it("reads title, status, lifecycle state and open review off a record with candidate field names", () => {
    const facts = factsFromRecord("content_item", "req_x_1", {
      title: "Hero copy",
      status: "in_review",
      lifecycle_state: "draft",
      review: { state: "pending", note: "awaiting legal" }
    });
    expect(facts.title).toBe("Hero copy");
    expect(facts.lifecycleState).toBe("draft");
    expect(facts.openReview).toBe("pending — awaiting legal");
  });

  it("renders a named 'no fields' line rather than an empty body when the record answers nothing this block reads", () => {
    const facts = factsFromRecord("content_item", "req_x_1", { unrelated_field: 1 });
    const rendered = renderObjectDossier(facts);
    expect(rendered).toContain("The read returned a record with none of the fields this block renders.");
  });

  it("renders the STALE marker when a write landed this turn", () => {
    const rendered = renderObjectDossier({ objectType: "content_item", objectId: "req_x_1", title: "Hero", stale: true });
    expect(rendered).toContain("STALE: a write landed in this turn. Re-read this object before the next write.");
  });
});
