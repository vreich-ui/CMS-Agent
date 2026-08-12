// The vocabulary registry — every coded value the UI puts in front of a human, with the plain
// sentence that makes it legible.
//
// WHY THIS IS DATA, and not copy sprinkled through components:
//
//  1. PRODUCT_VISION's explainability rule — "when something is highlighted the interface should also
//     explain why … never invent hidden reasoning" — cannot be met by a colour. `risk`, `execution`,
//     `actor`, `permission` and the tool denial reasons are all colour-coded families that had no
//     legend anywhere in the product, and information-architecture.md states outright that "colour
//     never carries status alone".
//  2. Several of these were explained ONLY in `title=` attributes. Per MDN, `title` fails touch-only
//     users, keyboard users, screen readers, users with fine motor control difficulty and users with
//     cognitive load — and this project's own accessibility spec already rules out colour or hover as
//     a sole channel. Explanation has to live somewhere it can be read.
//  3. These same definitions are what client 0 (`platform`) must eventually publish as the engine's
//     self-README (CHANGE-PLAN P-1 / R-12). One registry can feed the UI and the generated docs; two
//     copies would drift, and the drift would be invisible precisely because nobody re-reads a
//     glossary. `vocabularies` is exported whole for that reason.
//
// HOW IT IS PRESENTED (the research, so the next person does not relitigate it):
//
//  - Definitions are secondary information: needed once, then learned. They belong at progressive
//    disclosure LEVEL 2, behind a `<details>` with a descriptive summary — NN/g's rule is at most two
//    levels and a clear progression mechanism, and the U.S. Web Design System's disclosure guidance is
//    not to condense content "if users need to see most or all of the information on a page".
//  - Which is exactly why a per-row DENIAL REASON is NOT collapsed. When a specific tool is refused,
//    the reason is the primary content of that row, so it renders inline and visible. The glossary
//    behind it explains the vocabulary; the row explains this case.
//  - The raw code is always kept next to the sentence. Operators grep for it, agents emit it, and the
//    runbooks quote it — replacing it with prose would break the link between the UI and the docs.
//
// House voice, matched deliberately (see any panel's `muted` line): declarative, no second person,
// each definition paired with its limit or consequence, identifiers inline.

export type VocabularyId = "risk" | "execution" | "actor" | "denial" | "permission" | "layer" | "severity";

export type Term = {
  /** The raw coded value exactly as it appears on the wire and in the DOM. */
  term: string;
  /** Human-facing name. */
  label: string;
  /** One sentence: what it means. */
  summary: string;
  /** For failure and refusal vocabularies: what can actually be done about it. */
  remedy?: string;
};

export type Vocabulary = {
  id: VocabularyId;
  /** The disclosure's summary line. Descriptive, so the reader can tell whether opening it is worth it. */
  title: string;
  /** One sentence framing the whole family — often the part that is genuinely load-bearing. */
  blurb: string;
  terms: Term[];
};

const RISK: Vocabulary = {
  id: "risk",
  title: "What do read, write, publish and admin mean?",
  // The ceiling relationship is the load-bearing fact, and it appears nowhere in the product today.
  blurb: "A rung on the risk ladder. A node's own risk level is the CEILING for the tools it may call: a read node cannot call a write tool, however the tool is granted.",
  terms: [
    { term: "read", label: "Read", summary: "Reads state and returns it. Nothing anywhere changes." },
    { term: "write", label: "Write", summary: "Changes workspace state — prompts, schemas, tools, stage outputs. Every change is attributed in the ledger and can be restored." },
    { term: "publish", label: "Publish", summary: "Sends content out to a client's live site. This workspace cannot take it back, so publish nodes stay behind an explicit human approval." },
    { term: "admin", label: "Admin", summary: "Reconfigures the engine itself — connections, policy, protected records. The top rung, granted deliberately and never by default." }
  ]
};

const EXECUTION: Vocabulary = {
  id: "execution",
  title: "What do the run states mean?",
  blurb: "Where a node or run currently stands. The distinction that matters is blocked versus failed: one is the safety design working, the other is something wrong. Paused is a third thing again — a person pressed stop.",
  terms: [
    { term: "queued", label: "Queued", summary: "Waiting to start — either for its turn or for a dependency to finish." },
    { term: "running", label: "Running", summary: "Executing now — calling its model and any tools it is granted." },
    { term: "completed", label: "Completed", summary: "Finished and produced output that satisfied its schema." },
    { term: "paused", label: "Paused", summary: "Stopped because someone pressed pause. Nothing is wrong and nothing is waiting on a decision — the run simply stays where it is until it is resumed.", remedy: "Resume the run when you are ready; no node state was changed." },
    { term: "blocked", label: "Blocked", summary: "Stopped on purpose, waiting on a human decision — either an approval before a publish-risk node, or a run that reached its cost ceiling. This is a safety hold, not an error, and it is resumable.", remedy: "Review what it is asking for — the approval list or the budget ceiling — and resume the run." },
    { term: "failed", label: "Failed", summary: "Stopped because something went wrong — a tool error, a schema violation, an unreachable client.", remedy: "Read the node's error, fix the cause, then retry that node rather than the whole run." },
    { term: "cancelled", label: "Cancelled", summary: "Called off by a human or by the system before it finished." },
    { term: "skipped", label: "Skipped", summary: "The conductor decided this node had nothing to contribute to this run — a rule on the node matched the run's own facts — so it was never started and cost nothing. Nothing is wrong: the run carries the rule that fired and what it fired on, and the nodes that depend on this one treat its output as deliberately absent.", remedy: "If it should have run, retry that node — an explicit retry overrides the skip for this run." }
  ]
};

const ACTOR: Vocabulary = {
  id: "actor",
  title: "Who made a change — human, agent or system?",
  blurb: "Every change in the ledger records its origin, because most configuration here is eventually edited by agents rather than people. The interface never assumes a human authored a change.",
  terms: [
    { term: "human", label: "Human", summary: "A person, acting through the UI or an authenticated MCP session." },
    { term: "agent", label: "Agent", summary: "An AI agent acting through MCP. The reason field is the only account of intent a reviewer gets, which is why it is mandatory." },
    { term: "system", label: "System", summary: "The engine itself — migrations, seeded defaults, automatic bookkeeping. No one chose it in the moment." }
  ]
};

// One entry per code in `toolDenialReasons` (src/agent/tools/toolTypes.ts). A root test enforces the
// correspondence in both directions, so this list cannot silently fall behind the resolver.
const DENIAL: Vocabulary = {
  id: "denial",
  title: "Why can a tool be denied?",
  blurb: "The resolver's verdict on one tool for one node. Several reasons can apply at once, and all of them have to clear before a call goes through.",
  terms: [
    { term: "tool_disabled", label: "Switched off in the registry", summary: "The tool is disabled for everyone, not just this node, so no grant anywhere will enable it.", remedy: "Enable it in the tool registry, or use a different tool." },
    { term: "node_tool_not_allowed", label: "Not granted to this node", summary: "The node's own allowedTools list does not include this tool.", remedy: "Tick it in the Own column and save — that is the grant." },
    { term: "skill_tool_not_allowed", label: "Not granted to the assigned skill", summary: "A skill assigned to this node does not list the tool in its own allowedTools, so the skill's instructions assume a capability it cannot use.", remedy: "Widen the skill's allow-list, or unassign the skill." },
    { term: "platform_tool_not_allowed", label: "Excluded platform-wide", summary: "The platform-wide allow-list for this run does not include the tool." },
    { term: "run_tool_not_authorized", label: "Not authorized for this run", summary: "This particular run was started without authorization for the tool, whatever the node allows." },
    { term: "risk_level_exceeds_authorization", label: "Above the node's risk ceiling", summary: "The tool's risk level sits higher than the ceiling this node runs under, so granting it alone changes nothing.", remedy: "Raise the node's own risk level deliberately, or achieve the step with a lower-risk tool." },
    { term: "approval_required", label: "Approval required", summary: "The tool needs an approval and none is present for this call. Note that a resolved view carries no approval context, so every approval-gated tool reads this way when inspected — it is not evidence of a fault.", remedy: "Approve the call at run time; nothing needs changing on the node." },
    { term: "project_has_no_allowed_tools", label: "Client connection has an empty allow-list", summary: "project.call_tool is granted, but the target client connection permits no tools, so there is nothing it could call.", remedy: "Allow-list the client tools this node needs on the Access page." }
  ]
};

// Synthesized by the UI rather than the resolver: the node lists a tool the registry has never heard
// of, so no verdict exists to report. Kept out of DENIAL's terms so the backend correspondence test
// stays exact, and merged in for lookup below.
export const UNKNOWN_TOOL_REASON: Term = {
  term: "tool_not_in_registry",
  label: "Not in the registry",
  summary: "The node lists a tool the registry does not know about, so it can never resolve — the config looks populated while granting nothing.",
  remedy: "Remove it from the node, or check the name against the registry."
};

const PERMISSION: Vocabulary = {
  id: "permission",
  title: "What do allow, ask and block mean?",
  blurb: "Per-tool permission on a client's own MCP server, enforced by project.call_tool before anything leaves this workspace.",
  terms: [
    { term: "allowed", label: "Allowed", summary: "Agents may call this tool directly, with no human in the loop." },
    { term: "needs_approval", label: "Needs approval", summary: "Calls are held until a human approves. The tool never runs on its own." },
    { term: "blocked", label: "Blocked", summary: "Calls are refused here, before any request reaches the client's server." }
  ]
};

const LAYER: Vocabulary = {
  id: "layer",
  title: "What are the Method, Effective and Identity layers?",
  blurb: "The same value can differ between what is stored, what actually runs, and what the client says — so the inspector never blends the three into one number.",
  terms: [
    { term: "method", label: "Method · stored", summary: "What is saved on the node: its prompt, granted tools, assigned skills, schemas. Always available, and the only layer that is editable." },
    { term: "effective", label: "Effective · resolved", summary: "What the workspace resolves at run time, including instructions a skill appends to the prompt and the resolver's verdict per tool. Always available; it needs no client connection." },
    { term: "identity", label: "Identity · live contract", summary: "What the client's own live contract says, fetched now. Needs a configured, reachable connection; when it is down the layer greys out and names the environment variable that would fix it, rather than showing a stale value as current." }
  ]
};

const SEVERITY: Vocabulary = {
  id: "severity",
  title: "What is the difference between a blocker and a warning?",
  blurb: "How seriously to take a conflict the resolver reported.",
  terms: [
    { term: "blocker", label: "Blocker", summary: "The configuration contradicts itself in a way that stops the node from working as written." },
    { term: "warning", label: "Warning", summary: "Worth knowing and often deliberate — a publish gate holding, for instance — but nothing is broken." }
  ]
};

export const vocabularies: Record<VocabularyId, Vocabulary> = {
  risk: RISK,
  execution: EXECUTION,
  actor: ACTOR,
  denial: DENIAL,
  permission: PERMISSION,
  layer: LAYER,
  severity: SEVERITY
};

export const vocabularyList = (): Vocabulary[] => Object.values(vocabularies);

export const vocabulary = (id: VocabularyId): Vocabulary => vocabularies[id];

/** A single definition, or null when the code is not in the registry. Callers render the raw code. */
export function defineTerm(id: VocabularyId, term: string): Term | null {
  return vocabularies[id].terms.find((entry) => entry.term === term) ?? null;
}

/**
 * Plain-language reading of one resolver denial code, including the UI-synthesized
 * `tool_not_in_registry`. Returns null for an unrecognized code so the caller shows it verbatim —
 * an invented definition would be worse than an untranslated one.
 */
export function explainDenialReason(code: string): Term | null {
  if (code === UNKNOWN_TOOL_REASON.term) return UNKNOWN_TOOL_REASON;
  return defineTerm("denial", code);
}

/**
 * The denial codes for one tool row, each paired with its definition where one exists. Ordered as the
 * resolver reported them: the first reason is the one to act on.
 */
export function explainDenialReasons(codes: string[]): Array<{ code: string; term: Term | null }> {
  return codes.map((code) => ({ code, term: explainDenialReason(code) }));
}
