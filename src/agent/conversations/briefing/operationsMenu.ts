// CMP-W1.1 — the operations MENU, rendered from the registered descriptors.
//
// WHY THIS EXISTS. Client Manager's rev 8 prompt tells it to "resolve the request against the
// operation catalog — list the operations, get the matching descriptor, and preflight it". That is
// three round trips before the first useful sentence reaches the editor, every turn, to learn a set
// of six descriptors that is fixed at build time (registerOperations.ts) and identical for every
// tenant. Discovery of a static list is not intelligence, it is latency. This module renders that
// list once, into the prompt, so the model arrives knowing what the house can do.
//
// PREFLIGHT IS NOT REMOVED, AND THIS IS NOT A GATE. The menu answers "what exists and what does it
// need"; `operation_preflight` still answers "can THIS request run, with THESE inputs, on THIS
// tenant" — the only one of the three reads whose answer is not knowable ahead of the turn. Nothing
// rendered here authorizes anything, and nothing here even DESCRIBES what is gated — see the note
// above `requiredInputsFor` for why the per-operation approval sentence was removed. Authority stays
// where AGENTS.md invariants 4/5 put it: resolvePublishAuthority(run), node grants, and tool policy.
import { listOperations } from "../../operations/operationCatalog.js";
// Side-effect import: the catalog is empty until the six built-ins register themselves. Mirrors how
// operationTools.ts (the MCP surface) and the operations test suite each reach the same catalog.
import "../../operations/registerOperations.js";
import type { OperationDescriptor } from "../../operations/operationTypes.js";
import type { ProjectPublishingPolicy } from "../../projects/projectTypes.js";

export type AutonomyMode = NonNullable<ProjectPublishingPolicy["autonomyMode"]>;

// ABSENT autonomyMode resolves to "operator-gated" — the same reading ProjectPublishingPolicy's own
// doc comment gives it, and genesisParity.ts's `?? "operator-gated"`. Never defaulted to the
// permissive value here: a tenant nobody has decided about must read as the cautious one.
export const resolveAutonomyMode = (policy?: Pick<ProjectPublishingPolicy, "autonomyMode">): AutonomyMode =>
  policy?.autonomyMode ?? "operator-gated";

// THE MENU MAKES NO CLAIM ABOUT APPROVAL, AND THAT IS A CORRECTION.
//
// An earlier cut of this file derived a per-operation sentence ("starts without asking") from the
// peak `effects[].riskLevel` on the descriptor. A review of this change showed it was already wrong
// for one of the six: `image_template_revision` declares its effects at riskLevel "write", but the
// workflow it binds to runs `image_revision_apply` at riskLevel "publish" behind a registered gate.
// The menu would have told the model that operation starts freely on an autonomous tenant, which the
// code would then refuse — a false statement to the model, and precisely what operationTypes.ts's
// own header forbids ("do not read any type or value in this module as an authorization").
//
// A descriptor's declared effects describe what running it WOULD do. They are not the gate. Where a
// gate applies is resolved at execution time from the run's own policy snapshot, the node's risk
// level and any operator decision — none of which this file can see. So the menu says what each
// operation IS and what it NEEDS, the house's autonomy is stated ONCE in the block's header (a fact
// off the project record, not an inference), and how a given step is gated is left to the thing that
// actually gates it.

// `required` off the descriptor's own input schema, minus anything `defaults` already answers — an
// input with a default is not something to ask an editor for. Order is the schema's own, not sorted:
// a descriptor author ordered these, and reordering them loses that.
export const requiredInputsFor = (descriptor: OperationDescriptor): string[] => {
  const required = (descriptor.inputSchema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((name): name is string => typeof name === "string" && !(name in descriptor.defaults));
};

// First sentence of the summary, so the menu stays one line per operation even when a descriptor's
// summary grows. Falls back to the whole summary when it carries no sentence break.
const firstSentence = (text: string): string => {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return (match ? match[0] : text.trim()).trim();
};

export const renderOperationLine = (descriptor: OperationDescriptor): string => {
  const inputs = requiredInputsFor(descriptor);
  return [
    `- ${descriptor.title} (\`${descriptor.operationId}\`) — ${firstSentence(descriptor.summary)}`,
    `Needs: ${inputs.length ? inputs.join(", ") : "nothing the editor has to supply"}.`
  ].join(" ");
};

/**
 * The whole menu block. One line per registered operation, alphabetical by operation id (the
 * catalog's own `listOperations` ordering), plus the two sentences that tell the model what to do
 * with it — which is the half that actually removes the round trips.
 *
 * `descriptors` is injectable for tests only; production always passes the live catalog.
 */
export const renderOperationsMenu = (autonomyMode: AutonomyMode, descriptors: OperationDescriptor[] = listOperations()): string => {
  const lines = descriptors.map(renderOperationLine);
  return [
    "### What this house can do",
    "These are every registered operation, with what each needs from the editor. This list is complete: do not call the catalog to discover it, and never invent an operation that is not on it.",
    ...lines,
    autonomyMode === "autonomous"
      ? "This house runs autonomously, so start these rather than proposing them. Where a step inside one meets an approval floor, a guardrail or a budget wall, that is a blockage to report — not a question to ask."
      : "This house is operator-gated, so propose the work once, covering the whole chain, and start it on one yes.",
    "Preflight is still the gate — it answers whether THIS request can run with THESE inputs on THIS tenant, which the menu cannot. Call it when you are about to start one, not to find out what exists."
  ].join("\n");
};
