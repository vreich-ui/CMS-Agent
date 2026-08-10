import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsPage } from "../src/components/pages/AgentsPage";
import type { McpClient } from "../src/mcp/client";

type Call = { name: string; args: Record<string, unknown> };

const canonicalAgent = {
  id: "agt_client_manager",
  role: "client_manager",
  name: "Client Manager",
  prompt: "House rules as shipped.",
  promptState: "canonical" as const,
  modelConfig: { provider: "openai", model: "gpt-4.1", timeoutMs: 90_000, maxOutputTokens: 16_000 },
  skills: [],
  status: "active" as const,
  rev: 2,
  updatedAt: "2026-08-10T00:00:00.000Z"
};

function makeClient(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const client: McpClient = {
    method: async () => { throw new Error("unused"); },
    call: async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });
      const override = overrides[name];
      if (override) return override(args) as T;
      if (name === "agent.list") return { agents: [canonicalAgent], workspaceVersion: 7 } as T;
      if (name === "agent.update") {
        return { agent: { ...canonicalAgent, ...(args.patch as object), promptState: "diverged", rev: 3 }, workspaceVersion: 8 } as T;
      }
      throw new Error(`unexpected tool call: ${name}`);
    }
  };
  return { client, calls };
}

const noop = () => {};

describe("AgentsPage", () => {
  it("shows the prompt, its revision, and that it is the shipped default", async () => {
    const { client } = makeClient();
    render(<AgentsPage client={client} onStatus={noop} onError={noop} />);

    expect(await screen.findByDisplayValue("House rules as shipped.")).toBeInTheDocument();
    expect(screen.getByText(/Shipped default/i)).toBeInTheDocument();
    expect(screen.getByText("r2")).toBeInTheDocument();
  });

  it("blocks a save until something changed and a reason is given, then writes a minimal guarded patch", async () => {
    const user = userEvent.setup();
    const { client, calls } = makeClient();
    render(<AgentsPage client={client} onStatus={noop} onError={noop} />);

    const prompt = await screen.findByDisplayValue("House rules as shipped.");
    expect(screen.getByRole("button", { name: /review and save/i })).toBeDisabled();

    await user.clear(prompt);
    await user.type(prompt, "House rules, revised.");
    // Changed but still unexplained — the reason floor holds the save shut.
    expect(screen.getByRole("button", { name: /review and save/i })).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /why are you changing this/i }), "Tighten the lifecycle wording");
    await user.click(screen.getByRole("button", { name: /review and save/i }));
    await user.click(screen.getByRole("button", { name: /confirm save/i }));

    await waitFor(() => expect(calls.some((call) => call.name === "agent.update")).toBe(true));
    const write = calls.find((call) => call.name === "agent.update")!;
    expect(write.args).toMatchObject({
      id: "agt_client_manager",
      patch: { prompt: "House rules, revised." },
      expectedWorkspaceVersion: 7,
      source: "ui",
      reason: "Tighten the lifecycle wording"
    });
    // The name was untouched, so it must not travel; actor is the server's to stamp.
    expect(Object.keys(write.args.patch as object)).toEqual(["prompt"]);
    expect(write.args).not.toHaveProperty("actor");
  });

  it("requires an explicit confirmation step before writing", async () => {
    const user = userEvent.setup();
    const { client, calls } = makeClient();
    render(<AgentsPage client={client} onStatus={noop} onError={noop} />);

    const prompt = await screen.findByDisplayValue("House rules as shipped.");
    await user.clear(prompt);
    await user.type(prompt, "Changed.");
    await user.type(screen.getByRole("textbox", { name: /why are you changing this/i }), "A sufficient reason");
    await user.click(screen.getByRole("button", { name: /review and save/i }));

    expect(calls.some((call) => call.name === "agent.update")).toBe(false);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(calls.some((call) => call.name === "agent.update")).toBe(false);
  });

  it("surfaces a version conflict with a reload affordance instead of retrying silently", async () => {
    const user = userEvent.setup();
    const conflict = Object.assign(new Error("version_conflict: expected 7, current 9"), {
      details: { error: { code: "version_conflict", message: "expected 7, current 9", currentVersion: 9 } }
    });
    const { client, calls } = makeClient({ "agent.update": () => { throw conflict; } });
    render(<AgentsPage client={client} onStatus={noop} onError={noop} />);

    const prompt = await screen.findByDisplayValue("House rules as shipped.");
    await user.clear(prompt);
    await user.type(prompt, "Changed.");
    await user.type(screen.getByRole("textbox", { name: /why are you changing this/i }), "A sufficient reason");
    await user.click(screen.getByRole("button", { name: /review and save/i }));
    await user.click(screen.getByRole("button", { name: /confirm save/i }));

    expect(await screen.findByText(/version_conflict/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload workspace/i })).toBeInTheDocument();
    const writes = calls.filter((call) => call.name === "agent.update");
    expect(writes).toHaveLength(1); // never retried on its own
  });

  it("warns when the workspace holds an older shipped prompt", async () => {
    const { client } = makeClient({
      "agent.list": () => ({ agents: [{ ...canonicalAgent, promptState: "superseded" }], workspaceVersion: 7 })
    });
    render(<AgentsPage client={client} onStatus={noop} onError={noop} />);
    expect(await screen.findByText(/Older shipped default/i)).toBeInTheDocument();
  });

  it("explains a missing agent tool rather than rendering an empty editor", async () => {
    const { client } = makeClient({
      "agent.list": () => { throw new Error("Unknown tool: agent.list"); }
    });
    render(<AgentsPage client={client} onStatus={noop} onError={noop} />);
    expect(await screen.findByText(/scoped token/i)).toBeInTheDocument();
  });
});
