import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangesPage } from "../src/components/pages/ChangesPage";
import type { McpClient } from "../src/mcp/client";
import type { RevisionDiff, WorkspaceChangeEvent } from "../src/types/workspace";

const event = (overrides: Partial<WorkspaceChangeEvent> = {}): WorkspaceChangeEvent => ({
  eventId: "evt_1",
  type: "node.prompt_updated",
  operation: "update",
  target: { type: "node", id: "research" },
  actor: { kind: "agent", id: "optimizer-1" },
  source: "mcp",
  reason: "Sharpen research instructions",
  parentRevisionId: "rev_a",
  resultingRevisionId: "rev_b",
  workspaceVersion: 7,
  after: { id: "research", name: "Research Agent" },
  createdAt: "2026-07-12T09:30:12.000Z",
  ...overrides
});

const diff: RevisionDiff = {
  fromRevisionId: "rev_a",
  toRevisionId: "rev_b",
  nodes: {
    added: [],
    removed: [],
    changed: [{ nodeId: "research", changedFields: ["prompt", "updatedAt"], before: { id: "research", name: "r", prompt: "a" }, after: { id: "research", name: "r", prompt: "b" } }]
  },
  relationships: { added: [], removed: [], changedIds: [] }
};

type Call = { name: string; args: Record<string, unknown> };

// Stub client with a scriptable ledger; records every call for wiring assertions.
function makeClient(pages: Record<string, { events: WorkspaceChangeEvent[]; nextCursor?: string }>) {
  const calls: Call[] = [];
  const client: McpClient = {
    method: async () => { throw new Error("unused"); },
    call: async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });
      if (name === "changes.list") {
        const key = `${args.actorKind ?? ""}|${args.cursor ?? ""}`;
        return (pages[key] ?? pages[""] ?? { events: [] }) as T;
      }
      if (name === "changes.compare") return { diff } as T;
      if (name === "changes.restore") return { node: {}, workspaceVersion: 9, restoredFromRevisionId: args.revisionId } as T;
      throw new Error(`unexpected tool call: ${name}`);
    }
  };
  return { client, calls };
}

const defaultPages = { "|": { events: [event(), event({ eventId: "evt_2", actor: { kind: "human", id: "vr@example.com" }, type: "node.created", operation: "create" as const })] } };

describe("ChangesPage", () => {
  it("renders attributed rows and refetches with the actor filter", async () => {
    const u = userEvent.setup();
    const { client, calls } = makeClient({
      "|": defaultPages["|"],
      "human|": { events: [event({ eventId: "evt_2", actor: { kind: "human", id: "vr@example.com" } })] }
    });
    render(<ChangesPage client={client} selectedProjectId={null} onStatus={() => {}} onError={() => {}} />);

    expect(await screen.findByText("Updated prompt · Research Agent")).toBeInTheDocument();
    expect(screen.getAllByText("agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("human").length).toBeGreaterThan(0);

    await u.selectOptions(screen.getByLabelText("Actor"), "human");
    await waitFor(() => {
      const listCalls = calls.filter((call) => call.name === "changes.list");
      expect(listCalls[listCalls.length - 1].args).toMatchObject({ actorKind: "human" });
    });
  });

  it("expands in place, lazily loads the diff once, and hides timestamp noise", async () => {
    const u = userEvent.setup();
    const { client, calls } = makeClient(defaultPages);
    render(<ChangesPage client={client} selectedProjectId={null} onStatus={() => {}} onError={() => {}} />);

    await u.click(await screen.findByText("Updated prompt · Research Agent"));
    expect(await screen.findByText("prompt")).toBeInTheDocument();
    expect(screen.getByText("(plus timestamps)")).toBeInTheDocument();
    expect(screen.queryByText("updatedAt")).not.toBeInTheDocument();
    // The reason appears in the row summary and again in the expanded facts.
    expect(screen.getAllByText("Sharpen research instructions").length).toBeGreaterThanOrEqual(2);

    // Collapse and re-expand: the diff is cached, no second compare call.
    await u.click(screen.getByText("Updated prompt · Research Agent"));
    await u.click(screen.getByText("Updated prompt · Research Agent"));
    expect(calls.filter((call) => call.name === "changes.compare")).toHaveLength(1);
  });

  it("restores through an explicit confirmation and reports the append-only outcome", async () => {
    const u = userEvent.setup();
    const statuses: string[] = [];
    const { client, calls } = makeClient(defaultPages);
    render(<ChangesPage client={client} selectedProjectId={null} onStatus={(status) => statuses.push(status.message)} onError={() => {}} />);

    await u.click(await screen.findByText("Updated prompt · Research Agent"));
    await u.click(screen.getByRole("button", { name: "Restore this state…" }));
    expect(screen.getByText(/history is never rewritten or deleted/)).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Confirm restore" }));
    await waitFor(() => {
      const restoreCall = calls.find((call) => call.name === "changes.restore");
      expect(restoreCall?.args).toMatchObject({ revisionId: "rev_b", nodeId: "research", source: "ui" });
    });
    // The ledger reloads so the new restore event would appear at the top.
    expect(calls.filter((call) => call.name === "changes.list").length).toBeGreaterThanOrEqual(2);
    expect(statuses.some((message) => message.includes("new change event"))).toBe(true);
  });

  it("pages older history via the cursor", async () => {
    const u = userEvent.setup();
    const { client, calls } = makeClient({
      "|": { events: [event()], nextCursor: "cur_2" },
      "|cur_2": { events: [event({ eventId: "evt_older", type: "node.created", operation: "create" as const })] }
    });
    render(<ChangesPage client={client} selectedProjectId={null} onStatus={() => {}} onError={() => {}} />);

    await u.click(await screen.findByRole("button", { name: "Load older changes" }));
    expect(await screen.findByText("Created node · Research Agent")).toBeInTheDocument();
    const listCalls = calls.filter((call) => call.name === "changes.list");
    expect(listCalls[listCalls.length - 1].args).toMatchObject({ cursor: "cur_2" });
    // Older events append; the first page stays visible.
    expect(screen.getByText("Updated prompt · Research Agent")).toBeInTheDocument();
  });
});
