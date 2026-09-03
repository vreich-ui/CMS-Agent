// R-1 (data-loss guard) and R-4 (typed failure envelopes), driven through the real Netlify adapter
// so the assertions cover what a client actually receives on the wire — the layer where both
// defects were invisible.
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { toolError, toolErrorSummary, MissingPatchFieldError, WorkspaceVersionConflictError, WorkspaceToolError } from "../../../src/agent/mcp/workspace/toolKit.js";
import { ConverseError } from "../../../src/agent/conversations/conversationContract.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  process.env.MCP_API_TOKEN = "test-token";
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const parsed = JSON.parse(response.body);
  return { rpcError: parsed.error, structured: parsed.result?.structuredContent };
};

const NODE = "topic_opportunity";

beforeEach(() => {
  process.env.MCP_API_TOKEN = "test-token";
  resetRepositoryManager();
});

describe("R-1 — single-field writers refuse a patch missing their target field", () => {
  // The original defect, stated as a test: this call used to return ok:true while wiping
  // allowedTools to []. The node's tools surviving the call is the actual assertion.
  it("does not wipe allowedTools when the patch omits it", async () => {
    const before = await repositoryManager.getWorkspaceRepository().getNode(NODE);
    expect(before?.allowedTools.length).toBeGreaterThan(0);

    const { rpcError } = await call("workspace_update_node_tools", { id: NODE, patch: {} });

    expect(rpcError).toBeDefined();
    expect(rpcError.data.error.code).toBe("missing_patch_field");
    const after = await repositoryManager.getWorkspaceRepository().getNode(NODE);
    expect(after?.allowedTools).toEqual(before?.allowedTools);
  });

  it("names the tool and the field it required", async () => {
    const { rpcError } = await call("workspace_update_node_tools", { id: NODE, patch: {} });

    expect(rpcError.data.error).toMatchObject({ code: "missing_patch_field", tool: "workspace.update_node_tools", field: "allowedTools" });
    expect(rpcError.message).toContain("missing_patch_field");
  });

  it("refuses an explicit undefined the same way as an omitted field", async () => {
    const { rpcError } = await call("workspace_update_node_tools", { id: NODE, patch: { allowedTools: undefined } });

    expect(rpcError.data.error.code).toBe("missing_patch_field");
  });

  it.each([
    ["workspace_update_node_tools", "allowedTools"],
    ["workspace_update_node_skills", "assignedSkills"],
    ["workspace_update_node_dependencies", "dependsOn"],
    ["workspace_update_node_metadata", "metadata"],
    ["workspace_update_node_model_config", "modelConfig"]
  ])("guards %s on %s", async (toolName, field) => {
    const { rpcError } = await call(toolName, { id: NODE, patch: {} });

    expect(rpcError.data.error).toMatchObject({ code: "missing_patch_field", field });
  });

  // The guard must not become a wall: a patch that DOES carry the field still writes.
  it("still writes when the field is present", async () => {
    const { structured } = await call("workspace_update_node_tools", { id: NODE, patch: { allowedTools: ["stage.get_output"] } });

    expect(structured.ok).toBe(true);
    expect(structured.data.node.allowedTools).toEqual(["stage.get_output"]);
  });

  it("accepts an empty array as a deliberate clear, since the field is present", async () => {
    const { structured } = await call("workspace_update_node_tools", { id: NODE, patch: { allowedTools: [] } });

    expect(structured.ok).toBe(true);
    expect(structured.data.node.allowedTools).toEqual([]);
  });
});

// W6.4 (docs/plan/WORK-ORDER-2026-08-12-determinism.md): workspace.update_node_model_config used to
// build its store patch as `{ modelConfig: data.patch.modelConfig }`, and updateNode's own merge is a
// SHALLOW `{ ...existing, ...patch }` — so a caller who wanted to change just one knob and sent
// `{ maxTurns: 8 }` had every other key (toolCallLimit, timeout, budgetUsd, maxOutputTokens, ...)
// silently wiped. requirePatchField (R-1, above) does not catch this: the field IS present, it just
// carries an incomplete object. Fixed by deep-merging the patch onto the node's existing modelConfig
// before the write.
describe("W6.4 — workspace.update_node_model_config merges recursively; omitted keys are preserved", () => {
  it("does not drop sibling keys when the patch names only one (the original defect, reproduced)", async () => {
    const before = await repositoryManager.getWorkspaceRepository().getNode(NODE);
    expect(before?.modelConfig).toMatchObject({ maxTurns: 3, toolCallLimit: 2, timeout: 90000, budgetUsd: 0.1, maxOutputTokens: 2500 });

    const { structured } = await call("workspace_update_node_model_config", { id: NODE, patch: { modelConfig: { maxTurns: 8 } } });

    expect(structured.ok).toBe(true);
    expect(structured.data.node.modelConfig).toEqual({ maxTurns: 8, toolCallLimit: 2, timeout: 90000, budgetUsd: 0.1, maxOutputTokens: 2500 });

    const after = await repositoryManager.getWorkspaceRepository().getNode(NODE);
    expect(after?.modelConfig).toEqual({ maxTurns: 8, toolCallLimit: 2, timeout: 90000, budgetUsd: 0.1, maxOutputTokens: 2500 });
  });

  it("a key present in the patch overwrites the existing value for that key", async () => {
    const { structured } = await call("workspace_update_node_model_config", { id: NODE, patch: { modelConfig: { budgetUsd: 0.75 } } });

    expect(structured.data.node.modelConfig.budgetUsd).toBe(0.75);
    expect(structured.data.node.modelConfig.maxTurns).toBe(3); // untouched by this call
  });

  it("still refuses an omitted or undefined modelConfig field (R-1 guard unchanged)", async () => {
    const { rpcError } = await call("workspace_update_node_model_config", { id: NODE, patch: {} });

    expect(rpcError.data.error).toMatchObject({ code: "missing_patch_field", field: "modelConfig" });
  });

  it("refuses a non-object modelConfig rather than silently coercing it", async () => {
    const { rpcError } = await call("workspace_update_node_model_config", { id: NODE, patch: { modelConfig: "not-an-object" } });

    expect(rpcError).toBeDefined();
  });
});

describe("R-4 — typed failure envelopes on the wire", () => {
  it("returns a recoverable version_conflict carrying the current version", async () => {
    const current = await repositoryManager.getWorkspaceRepository().getWorkspaceVersion();
    const { rpcError } = await call("workspace_update_node_prompt", { id: NODE, prompt: "x", expectedWorkspaceVersion: current + 99 });

    expect(rpcError.data.error).toMatchObject({ code: "version_conflict", expectedVersion: current + 99, currentVersion: current });
    // The whole point: a client can reload to exactly this state instead of guessing.
    expect(rpcError.data.error.currentVersion).toBe(current);
  });

  it("leads the JSON-RPC message with the code instead of a constant sentence", async () => {
    const current = await repositoryManager.getWorkspaceRepository().getWorkspaceVersion();
    const { rpcError } = await call("workspace_update_node_prompt", { id: NODE, prompt: "x", expectedWorkspaceVersion: current + 99 });

    expect(rpcError.message).toContain("version_conflict");
    expect(rpcError.message).not.toBe("Tool execution failed");
  });

  // The failure that made a correct refusal look like a crash.
  it("surfaces a project refusal by its own code", async () => {
    const { rpcError } = await call("project_delete", { projectId: "dr-lurie" });

    expect(rpcError.data.error.code).toBe("default_project_protected");
    expect(rpcError.message).toContain("default_project_protected");
  });

  it("still reports an unknown tool distinctly", async () => {
    const { rpcError } = await call("workspace_not_a_tool", {});

    expect(rpcError.code).toBe(-32602);
    expect(rpcError.message).toContain("Unknown tool");
  });

  it("classifies a schema violation as validation_error with issues", async () => {
    const { rpcError } = await call("workspace_update_node_tools", { patch: { allowedTools: [] } });

    expect(rpcError.data.error.code).toBe("validation_error");
    expect(Array.isArray(rpcError.data.error.issues)).toBe(true);
  });
});

describe("toolError classification", () => {
  it("renders a WorkspaceToolError with its code and details", () => {
    expect(toolError(new WorkspaceToolError("some_code", "why", { extra: 1 }))).toEqual({
      ok: false,
      error: { code: "some_code", message: "why", extra: 1 }
    });
  });

  it("renders a revision conflict with both revision ids", () => {
    const envelope = toolError(new WorkspaceVersionConflictError({ conflict: "revision", expectedRevisionId: "rev_a", currentRevisionId: "rev_b", currentVersion: 7 }));

    expect(envelope.error).toMatchObject({ code: "revision_conflict", expectedRevisionId: "rev_a", currentRevisionId: "rev_b", currentVersion: 7 });
  });

  it("falls back to tool_error for an untyped throw, so nothing is misreported as typed", () => {
    expect(toolError(new Error("boom")).error).toEqual({ code: "tool_error", message: "boom" });
  });

  it("summarizes an envelope as code plus message", () => {
    expect(toolErrorSummary(toolError(new MissingPatchFieldError("t", "f")))).toContain("missing_patch_field:");
  });

  // The conflict messages keep their historical machine-readable prefix, so the summary must not
  // stutter it back: "version_conflict: workspace_version_conflict: ..." reads like a bug.
  it("does not double a prefix a self-labelling message already carries", () => {
    const summary = toolErrorSummary(toolError(new WorkspaceVersionConflictError({ conflict: "workspace_version", expectedVersion: 1, currentVersion: 2 })));

    expect(summary).toBe("workspace_version_conflict: expected 1, current 2. Reload and re-apply.");
    expect(summary).not.toContain("version_conflict: workspace_version_conflict");
  });

  // Provider-error-details: agent_converse's thrown ConverseError carries providerStatus/
  // providerMessage/operatorAction as own properties (never nested under `details`), and toolError's
  // generic codedError() branch must pick them up by duck-typing, the same way it already picks up
  // `code` — so the chat sees the provider's real error, not a bare code + message.
  it("surfaces a ConverseError's providerStatus/providerMessage/operatorAction, not just its code", () => {
    const error = new ConverseError("provider_quota", "Your credit balance is too low", {
      providerStatus: 429,
      providerMessage: "Your credit balance is too low",
      operatorAction: "Top up openai credit for this project's key, then retrying the turn."
    });

    expect(toolError(error)).toEqual({
      ok: false,
      error: {
        code: "provider_quota",
        message: "provider_quota: Your credit balance is too low",
        providerStatus: 429,
        providerMessage: "Your credit balance is too low",
        operatorAction: "Top up openai credit for this project's key, then retrying the turn."
      }
    });
  });

  // Chat-recovery (2026-09-03 admin-chat incident): the point of the new code is that the caller
  // can ACT on it. The envelope must name the outcome (start a new chat) rather than handing back
  // another model_error the chat would just retry into the same permanent 400.
  it("gives a conversation_needs_reset failure an envelope the chat can act on", () => {
    const error = new ConverseError("conversation_needs_reset", "This conversation's saved history is in a state this model will not accept.", {
      providerStatus: 400,
      providerMessage: "`tool_use` ids were found without `tool_result` blocks immediately after: toolu_b",
      operatorAction: "Start a new conversation; this transcript cannot be replayed to the model."
    });

    expect(toolError(error).error).toMatchObject({
      code: "conversation_needs_reset",
      providerStatus: 400,
      operatorAction: expect.stringContaining("Start a new conversation")
    });
    expect(toolErrorSummary(toolError(error))).toContain("conversation_needs_reset");
  });
});
