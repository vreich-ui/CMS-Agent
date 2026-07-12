import { describe, expect, it } from "vitest";
import {
  describeChangeEvent,
  diffRange,
  formatChangeTime,
  listChangesArgs,
  restoreTarget,
  summarizeDiff,
  summarizeRecentChanges
} from "../../ui/src/changes.js";
import type { RevisionDiff, WorkspaceChangeEvent, WorkspaceNode } from "../../ui/src/types/workspace.js";

const event = (overrides: Partial<WorkspaceChangeEvent> = {}): WorkspaceChangeEvent => ({
  eventId: "evt_1",
  type: "node.prompt_updated",
  operation: "update",
  target: { type: "node", id: "research" },
  actor: { kind: "agent", id: "optimizer-1" },
  source: "mcp",
  parentRevisionId: "rev_a",
  resultingRevisionId: "rev_b",
  workspaceVersion: 7,
  after: { id: "research", name: "Research Agent" },
  createdAt: "2026-07-12T09:30:12.000Z",
  ...overrides
});

describe("describeChangeEvent", () => {
  it("answers who/what/when with friendly titles and never assumes a human actor", () => {
    const view = describeChangeEvent(event());
    expect(view.title).toBe("Updated prompt");
    expect(view.entityLabel).toBe("Research Agent");
    expect(view.actorKind).toBe("agent");
    expect(view.actorLabel).toBe("optimizer-1");
    expect(view.when).toBe("2026-07-12 09:30 UTC");
    expect(view.structural).toBe(true);
  });

  it("humanizes unknown event types instead of hiding them", () => {
    const view = describeChangeEvent(event({ type: "node.budget_reallocated" }));
    expect(view.title).toBe("Budget reallocated");
  });

  it("omits the entity label for id-less non-node targets, and marks non-structural events", () => {
    const view = describeChangeEvent(event({
      after: undefined,
      target: { type: "workspace" },
      type: "workspace.stage_output_recorded",
      resultingRevisionId: "rev_a"
    }));
    // The title already names the target ("Updated graph · graph" would be noise).
    expect(view.entityLabel).toBe("");
    expect(view.structural).toBe(false);
  });

  it("formats timestamps deterministically in UTC", () => {
    expect(formatChangeTime("2026-01-03T23:59:59.123Z")).toBe("2026-01-03 23:59 UTC");
    expect(formatChangeTime("not-a-date")).toBe("not-a-date");
  });
});

describe("listChangesArgs", () => {
  it("sends only chosen filters", () => {
    expect(listChangesArgs({}, 30)).toEqual({ limit: 30 });
    expect(listChangesArgs({ actorKind: "human", operation: "restore" }, 30, "cur_2")).toEqual({
      limit: 30, cursor: "cur_2", actorKind: "human", operation: "restore"
    });
  });
});

describe("diffRange", () => {
  it("is available only for structural events with a parent", () => {
    expect(diffRange(event())).toEqual({ fromRevisionId: "rev_a", toRevisionId: "rev_b" });
    expect(diffRange(event({ resultingRevisionId: "rev_a" }))).toBeNull();
    expect(diffRange(event({ parentRevisionId: undefined }))).toBeNull();
  });
});

describe("summarizeDiff", () => {
  const node = (id: string): WorkspaceNode => ({ id, name: id, prompt: "p" });
  const diff: RevisionDiff = {
    fromRevisionId: "rev_a",
    toRevisionId: "rev_b",
    nodes: {
      added: [node("newcomer")],
      removed: [],
      changed: [
        { nodeId: "research", changedFields: ["prompt", "updatedAt"], before: node("research"), after: node("research") },
        { nodeId: "brief_architect", changedFields: ["updatedAt"], before: node("brief_architect"), after: node("brief_architect") },
        { nodeId: "draft_writer", changedFields: ["position", "updatedAt"], before: node("draft_writer"), after: node("draft_writer") }
      ]
    },
    relationships: { added: [], removed: [], changedIds: ["rel_1"] }
  };

  it("filters timestamp noise and counts real changes elsewhere", () => {
    const summary = summarizeDiff(diff, "research");
    expect(summary.targetFields).toEqual(["prompt"]);
    // brief_architect changed only updatedAt → not a real change; draft_writer changed position.
    expect(summary.otherChangedNodes).toBe(1);
    expect(summary.addedNodes).toEqual(["newcomer"]);
    expect(summary.relationshipChanges).toBe(1);
  });
});

describe("restoreTarget", () => {
  it("targets the resulting revision for node updates", () => {
    expect(restoreTarget(event())).toEqual({ revisionId: "rev_b", nodeId: "research" });
  });

  it("targets the parent revision for deletions (the node is gone from the resulting one)", () => {
    expect(restoreTarget(event({ operation: "delete", type: "node.deleted" }))).toEqual({ revisionId: "rev_a", nodeId: "research" });
  });

  it("refuses non-node and non-structural events", () => {
    expect(restoreTarget(event({ target: { type: "graph" } }))).toBeNull();
    expect(restoreTarget(event({ resultingRevisionId: "rev_a" }))).toBeNull();
    expect(restoreTarget(event({ target: { type: "node" } }))).toBeNull();
  });
});

describe("summarizeRecentChanges", () => {
  it("attributes activity by actor kind and cites the latest event", () => {
    const summary = summarizeRecentChanges([
      event({ eventId: "e3", actor: { kind: "agent" } }),
      event({ eventId: "e2", actor: { kind: "human", id: "vr@example.com" } }),
      event({ eventId: "e1", actor: { kind: "system" } })
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byActor).toEqual({ human: 1, agent: 1, system: 1 });
    expect(summary.latest?.eventId).toBe("e3");
  });

  it("is honest about an empty ledger", () => {
    const summary = summarizeRecentChanges([]);
    expect(summary.total).toBe(0);
    expect(summary.latest).toBeUndefined();
  });
});
