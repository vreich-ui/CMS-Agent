// CMP-W2b.2 — "What this chat is about": where the editor opened this conversation, and which job
// it concerns.
//
// THE GAP. `conversationContext` carries the site, an optional object pair, a focus label, learning
// mode, an approval note and `ui_capabilities` — everything about WHAT is on screen and nothing
// about WHY the chat exists. A chat opened from a run's activity card and a chat opened from the
// hub arrive identically blank, so the agent's first move on both is to ask the editor what they
// want, when the surface they clicked already said it.
//
// EVERYTHING HERE IS CALLER-SUPPLIED DATA, AND IT IS RENDERED OUTSIDE THE UNTRUSTED-JSON MARKER.
// That is the whole risk of this block, and `sanitise` below is the whole answer to it: every string
// that crosses into the briefing is flattened to a single line, stripped of the characters that
// could open a heading or a fenced block, and hard-truncated. A caller cannot use a surface label to
// write a new instruction into the system prompt. The FACTS about the run, by contrast, are read
// from this workspace's own execution store — never from the caller — so a caller cannot assert a
// run state either.
import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { promptSafe } from "./safeReason.js";

export type ConversationOrigin = {
  surface: string;
  starter?: string;
  request_id?: string;
  run_id?: string;
  selection?: { object_type: string; object_id: string };
};

const MAX_LABEL_CHARS = 160;

// One line, no markup, bounded — `promptSafe` (safeReason.ts) is the single implementation of that
// rule for the whole briefing, and this is the caller-supplied-label case of it. Kept as a named
// export because it is the boundary this module is responsible for and the tests address it here.
export const sanitise = (value: string): string => promptSafe(value, MAX_LABEL_CHARS);

// `visual_identity_page` -> "visual identity page". No lookup table, on purpose: a table of
// Platform's surface keys maintained HERE would be wrong the first time Platform added a surface,
// and the failure would be silent (an unknown key rendering as nothing). The raw token, made
// readable, is always at least true.
export const humaniseSurface = (surface: string): string => sanitise(surface).replace(/[_-]+/g, " ").trim();

export type ChatOriginFacts = {
  origin?: ConversationOrigin;
  /** The run named by `origin.run_id`, read from THIS workspace's execution store. */
  run?: Pick<WorkflowExecutionRecord, "runId" | "workflowId" | "status" | "currentNodeId" | "approvalsRequired"> & { blockers?: string[] };
  /** Why the run could not be read, when it could not. */
  runUnavailableReason?: string;
};

/**
 * The `## What this chat is about` block.
 *
 * Rendered whenever an `origin` arrived. When one did not, the caller omits the block entirely
 * rather than printing "origin unknown" on every turn of every conversation that predates the field
 * — but when an origin DID arrive and its run could not be read, that failure is stated, because
 * then the model has been told there is a job and needs to know why it cannot see its state.
 */
export const renderChatOrigin = (facts: ChatOriginFacts): string => {
  const origin = facts.origin;
  if (!origin) return "";
  const lines = [`- The editor is on: ${humaniseSurface(origin.surface)}`];
  if (origin.starter) lines.push(`- They opened this chat with: ${sanitise(origin.starter)}`);
  if (origin.selection) lines.push(`- Selected there: ${sanitise(origin.selection.object_type)} \`${sanitise(origin.selection.object_id)}\``);
  if (origin.request_id) lines.push(`- Production request: ${sanitise(origin.request_id)}`);

  if (facts.run) {
    const run = facts.run;
    lines.push(`- The job: ${sanitise(run.workflowId)} is ${sanitise(run.status)}${run.currentNodeId ? `, currently at ${sanitise(run.currentNodeId)}` : ""}.`);
    // Only PENDING entries: `approvalsRequired` keeps its history, and telling an editor a run is
    // "waiting on" a gate somebody already answered is worse than saying nothing.
    const pending = (run.approvalsRequired ?? []).filter((approval) => approval.pending !== false);
    if (pending.length) lines.push(`- Waiting on approval: ${pending.map((approval) => sanitise(`${approval.nodeId} — ${approval.reason}`)).join(", ")}`);
    if (run.blockers?.length) lines.push(`- Blocked by: ${run.blockers.map(sanitise).join("; ")}. Read the run for the detail rather than describing it from this line.`);
  } else if (origin.run_id) {
    lines.push(`- The job: run \`${sanitise(origin.run_id)}\` — its state could not be read this turn${facts.runUnavailableReason ? ` (${sanitise(facts.runUnavailableReason)})` : ""}. Read it before you describe where it is.`);
  }

  return [
    "## What this chat is about",
    "Where the editor opened this conversation and which job it concerns. The labels are the client's own words, carried as data; the run state below them is read from this workspace, not asserted by the caller.",
    ...lines,
    "Do not ask the editor what they mean when this block already answers it."
  ].join("\n");
};

/** Pull the handful of run facts this block reports, from a full execution record. */
export const runFactsFrom = (run: WorkflowExecutionRecord): NonNullable<ChatOriginFacts["run"]> => ({
  runId: run.runId,
  workflowId: run.workflowId,
  status: run.status,
  currentNodeId: run.currentNodeId,
  approvalsRequired: run.approvalsRequired,
  // Node-level blockages are where a run's real "why is this stuck" lives; the run's own `errors`
  // array carries the same story only once the whole run has failed.
  //
  // CODE AND KIND ONLY — NEVER `message`, AND NEVER `operator_action`. Both of those are engine prose
  // written for an operator reading a log, and a review of this change traced them to their writers:
  // AnthropicNodeRunner produces `anthropic_http_401: {"type":"error","error":{"message":"invalid
  // x-api-key"}}` as a blockage `message` with no operator_action at all, and another path puts the
  // MODEL NAME in one. Either would have rendered a provider's refusal, verbatim, into the system
  // prompt — the exact class of leak safeReason.ts exists to prevent. A blockage code is a stable
  // enum-shaped token this repo mints itself; it is enough for the model to say what is stuck and to
  // go and read the run if the editor wants more.
  blockers: run.nodes
    .flatMap((node) => (node.blockage ? [`${node.blockage.kind}/${node.blockage.code}`] : []))
    .slice(0, 3)
});
