// W3 part 1 (determinism program, 2026-08-12) — the ENGINE-owned validate→fix→revalidate loop for
// article_body.
//
// WHY THIS EXISTS. On run_1786468126136_ev9goe article_body spent its entire toolCallLimit (3) inside
// its own agent loop trying to validate the object it had just built, ran out mid-validation, and
// deferred with `final_revalidation_not_completed_tool_call_limit_exceeded`. The verdict it never
// reached is the one thing downstream needed, so publish_payload had to redo the same validation —
// at 5× the cost, because it re-derived the whole envelope to get there (W0's $2.73 finding). The
// model was made responsible for a control-flow problem: "call a validator, read the errors, fix the
// object, call it again" is a loop, and a loop belongs to the engine.
//
// WHAT THIS DOES. After the model returns article_body's envelope, the ENGINE runs the loop:
//   validate → (mechanical fix | ONE bounded model revision) → revalidate,
// with at most MAX_ENGINE_REVALIDATION_CYCLES revalidations (so at most three validator calls in
// total) and at most one model revision turn. The revision turn is a fresh runner dispatch, so it is
// engine-controlled and does NOT consume the node's toolCallLimit — the exact budget the model
// exhausted before. Every outcome is recorded structurally on the output's clientValidation:
// `valid` (the validated true/false), `issues` (the last errors), and an `engineLoop` record naming
// how the loop terminated, so downstream deterministic publish_payload can consume the verdict
// instead of re-earning it (publishPayload.readRecordedValidation).
//
// WHAT THIS DOES NOT DO. It does not decide validity itself: the only verdict is the client's own
// validator's, and an unreachable validator is never a pass. It does not "improve" the body — the
// only engine-side edits are mechanical fixes the validator's own issues asked for, applied to id-ish
// fields only, and each one is named in the record. It does not retry a client that could not be
// reached (a transport failure is not something a second identical call inside the same dispatch
// fixes) and it does not retry a `requires_existing_object` deferral, which is the NORMAL outcome for
// a dry-run candidate and is named as such by article_body's own prompt.
import { stableHash } from "../improvement/improvementTypes.js";
import type { PublishPayloadValidation } from "./publishPayload.js";

// Two revalidations: enough for the two ways a failure can be answered (a mechanical fix, then one
// model revision), and no more — an engine loop that can spin is a worse defect than the one it
// replaces, because it spends silently.
export const MAX_ENGINE_REVALIDATION_CYCLES = 2;
export const MAX_ENGINE_REVISION_TURNS = 1;
export const ENGINE_VALIDATION_SOURCE = "engine_validation_loop";

// The node whose prompt still tells it to validate through the client itself must be TOLD that the
// engine has taken that job over, or it will keep spending the tool calls that caused the defect.
// Delivered as run context (runContext.enginePolicies), not as a seed prompt edit: the live workspace
// is store-sourced, so a nodes.ts prompt change reaches a real run only after a re-seed, whereas this
// text ships with the code that actually performs the loop — the instruction and the behaviour cannot
// drift apart.
export const ENGINE_VALIDATION_POLICY =
  "Client-object validation is run BY THE ENGINE after you return: do not call the client's validator yourself and do not fill clientValidation — spending your tool calls on validation is what exhausted this node's budget mid-validation on a previous live run. Emit your best object and let the engine earn the verdict; if the client rejects it you may be dispatched once more, with each of its problems as a separate string in your input's validationFeedback.issues and the exact paths and node ids they name in validationFeedback.revisionTarget. Your previous envelope is deliberately not resent — build it again from the same inputs and change only what those issues name.";

// Which nodes the loop owns. Keyed on the node's own declared product (client_object.v1) rather than
// on a seed metadata flag alone, for a blunt operational reason: the live workspace is store-sourced,
// so a flag that exists only in nodes.ts would leave the defect in place on real runs until a re-seed.
// `articleBodyValidationLoop: false` in node metadata is still an explicit, auditable off switch, and
// `true` still opts a node in that does not declare the product.
export const ownsValidationLoop = (node: { produces?: string[]; metadata?: Record<string, unknown> }): boolean => {
  const declared = node.metadata?.articleBodyValidationLoop;
  if (typeof declared === "boolean") return declared;
  return (node.produces ?? []).includes("client_object.v1");
};

export type ArticleBodyLoopOutcome = "valid" | "deferred" | "invalid" | "unavailable";

export type ArticleBodyValidationRecord = PublishPayloadValidation & {
  source: typeof ENGINE_VALIDATION_SOURCE;
  // Identity of the body the verdict was earned against. publish_payload reuses the verdict only when
  // the body it is about to publish hashes to this — a verdict is about an object, not about a node.
  bodyFingerprint: string;
  engineLoop: {
    revalidations: number;
    revisionTurns: number;
    mechanicalFixes: string[];
    outcome: ArticleBodyLoopOutcome;
    // True when the loop stopped because it hit its own bound with the object still invalid — the
    // honest name for "we tried everything we are allowed to try", as distinct from "the client said
    // no and there was nothing mechanical to do about it".
    boundedExhaustion: boolean;
    // W1.3 (run_1788769566432_5qnafb) — did the model's revision turn change the body AT ALL?
    //
    // That run recorded exactly one body: the post-revision one. So when the revision came back with
    // both flagged defects still present, and a summary confidently claiming it had fixed one of
    // them, there was no way to tell whether it had edited something else, edited nothing, or edited
    // and lost it — the single most useful fact about a repair turn was the one fact not kept.
    // Fingerprinted with the same stableHash that produces bodyFingerprint, on either side of the
    // revision only, so a mechanical fix before or after it cannot be mistaken for the model's work.
    //
    // Read it WITH revisionTurns: {revisionTurns:0, revisionChangedBody:false} is "no revision ran";
    // {revisionTurns:1, revisionChangedBody:false} is a revision that ran and did nothing, which is
    // the alarm.
    revisionChangedBody: boolean;
  };
};

export type ArticleBodyRevisionRequest = { output: Record<string, unknown>; body: Record<string, unknown>; issues: unknown[]; attempt: number };
export type ArticleBodyRevisionResult = { ok: true; output: unknown } | { ok: false; code: string; message: string };

// W1.2 (run_1788769566432_5qnafb) — the shape of the correction handed to the ONE revision turn.
//
// What it replaced, and why. The live client validator answers with a SINGLE issue object whose
// `message` field concatenates every problem it found with "; " —
//   {id:"schema_zod", label:"Per-type schema", status:"missing",
//    message:"nodes.24.private.strategy: Invalid option: …; nodes.28.public.items.0: Invalid input: …; nodes.28.public.items.1: …"}
// — and that object was forwarded to the revision dispatch untouched, beside `previousOutput`: the
// model's whole ~29-30K-character prior envelope, the one part of the revision's `input` that nothing
// bounds (boundDependencyOutput applies to dependencyOutputs only). So the model was asked to repair
// three unrelated violations, in two different nodes, from one dense string labelled `status:
// "missing"` (which describes none of them), while the bulk of its prompt was a copy of the very
// output that had just been rejected and an instruction to reproduce it. It re-emitted a body with
// neither defect fixed and a summary claiming it had fixed one of them.
//
// The replacement carries the same information in the shape the turn actually has to act on: one
// plain string per real problem, the exact paths those problems name with the values currently at
// them, and the client's untransformed answer kept alongside so the flattening can never be a lossy
// rewrite of what the client said.
export type ArticleBodyRevisionTarget = {
  // The body's own ids for the nodes the issues name (`nodes.24…` → `n_p14`), in issue order. A model
  // that edits by id cannot mis-count an array index.
  nodeIds: string[];
  // Every path the client named, in issue order, verbatim as the client wrote it.
  paths: string[];
  // path → the value sitting at it right now. Only resolvable, compact values: this field exists to
  // let the turn see what it is replacing, not to smuggle the envelope back in under another name.
  currentValues: Record<string, unknown>;
};

export type ArticleBodyValidationFeedback = {
  source: "client_object_validate";
  attempt: number;
  // One string per real problem — what the model reads and acts on.
  issues: string[];
  // The client's answer exactly as it arrived, whatever shape that was. Nothing about the flattening
  // above is allowed to lose evidence: if the split ever mangles a message, this is what proves it.
  rawIssues: unknown[];
  revisionTarget: ArticleBodyRevisionTarget;
  instruction: string;
};

export type ArticleBodyLoopDeps = {
  validate: (body: Record<string, unknown>) => Promise<PublishPayloadValidation>;
  // Omitted by callers that want the mechanical half only (a mock run, or a node whose runner is
  // unavailable). Without it the loop still validates and still records its verdict.
  revise?: (request: ArticleBodyRevisionRequest) => Promise<ArticleBodyRevisionResult>;
};

export type ArticleBodyLoopResult = {
  output: Record<string, unknown>;
  validation: ArticleBodyValidationRecord;
  // Run-visible facts, in the executor's existing `state.warnings` convention (code:detail).
  warnings: string[];
  // T2: set only when the client rejected this driver's CREDENTIAL (401/403) rather than the body.
  // The loop deliberately does not fold this into `warnings`: a warning — even one promoted to a
  // blocker — still leaves the node `completed`, and "completed with an empty-but-schema-valid
  // artifact carrying blockers[]" is the exact shape that let three doomed runs spend their whole
  // budget after the very first client call had already made publication impossible. The executor
  // reads this field to fail the node and abort the run instead.
  authFailure?: { error: string; httpStatus?: number };
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const issueText = (issues: unknown[]): string => issues.map((issue) => (typeof issue === "string" ? issue : JSON.stringify(issue))).join(" | ");

// The body under validation. article_body's own schema requires a non-empty `body` object, so an
// absent one is not a case this loop invents a policy for — it hands the output back untouched and
// lets R-16 fail the node on its own terms.
export const readBodyForValidation = (output: unknown): Record<string, unknown> | undefined => {
  if (!isObject(output)) return undefined;
  const body = output.body;
  return isObject(body) && Object.keys(body).length > 0 ? body : undefined;
};

// The one class of failure a program can fix without judgment: the client complained about an
// id/slug, and the complaint is about its FORM (casing/whitespace/pattern), not its meaning. Both
// halves must be present in the client's own words — a fixer that lowercases ids because some
// unrelated field failed is a fixer that silently rewrites content.
const ID_COMPLAINT = /\b(id|ids|_id|object_id|objectid|slug|slugs)\b/i;
const FORM_COMPLAINT = /lower[ -]?case|upper[ -]?case|casing|whitespace|leading or trailing|does not match|must match|pattern/i;
const ID_FIELD = /^(id|_id|object_id|objectId|slug)$/;

const mechanicalValue = (value: string): string => value.trim().toLowerCase();

// The second mechanical class (run_1786549907145_hf4wgb): the client's strict per-type schema names
// an undeclared BODY-ROOT key in its own words — `(root): Unrecognized key: "object_type"` — and
// removing exactly that key is a program's job, not a model revision's. Root-scoped on purpose: a
// nested "Unrecognized key" describes a key inside a node/field this fixer has no business rewriting.
const UNRECOGNIZED_ROOT_KEY = /\(root\):\s*Unrecognized key:?\s*"([^"]+)"/i;

const unrecognizedRootKeys = (text: string): string[] => {
  const keys = new Set<string>();
  // A fresh g-flagged copy per call: matchAll requires the flag, and a module-level g-regex is
  // stateful across calls (lastIndex), which is exactly the class of silent bug this file exists to
  // keep out of the publish path.
  for (const match of text.matchAll(new RegExp(UNRECOGNIZED_ROOT_KEY.source, "gi"))) keys.add(match[1]);
  return [...keys];
};

// W3a.1 (run_1788769566432_5qnafb): the client's own client_object contract declares a closed
// `private.strategy` enum per node (12 values on dr-lurie's content_item) and a SEPARATE `intent`
// enum next to it. The model conflated the two and wrote "reassurance" (a value that belongs to
// neither) into `strategy`. The path and the allowed list are both read OUT OF THE ISSUE TEXT ITSELF
// — never hardcoded — because the 12 values are the contract's, not this file's, to own; matched
// against both dot (`nodes.24.private.strategy`) and bracket (`nodes[24].private.strategy`) path
// styles since the two mechanical fixers already in this file were written against bracket-style
// fixtures while the live client emits dot-style paths (zod's own path join).
const STRATEGY_ENUM_ISSUE = /nodes[.[](\d+)\]?\.private\.strategy:\s*Invalid option:\s*expected one of\s*(.+)/i;

// A tiny, named map from a plausible-but-wrong word to the contract value it was probably reaching
// for. Deliberately NOT an attempt to cover every synonym a model might invent — an unmapped miss is
// not a failure of this fixer, it is the fixer correctly declining to guess, per the drop path below.
const STRATEGY_SYNONYMS: Record<string, string> = {
  reassurance: "resolution",
  reassure: "resolution",
  conclusion: "summary",
  cta: "recommendation",
  call_to_action: "recommendation"
};

// W3a.2 (run_1788769566432_5qnafb): the client's `public.items` is contractually `array of string`;
// node `n_box` (kind `action`) emitted `[label, text]` pairs — each element of `items` an array, not
// a string — so the client rejects every element individually (`items.0`, `items.1`, one issue each).
const ITEMS_ARRAY_ISSUE = /nodes[.[](\d+)\]?\.public\.items[.[](\d+)\]?:\s*Invalid input:\s*expected string,\s*received array/i;

const issueStrings = (issues: unknown[]): string[] => issues.map((issue) => (typeof issue === "string" ? issue : JSON.stringify(issue)));

// Only the OPTIONAL, never-rendered `private.strategy` annotation is touched, and only via a mapped
// synonym or an outright removal — never a guess dressed up as a value the contract did not offer.
function applyStrategyEnumFixes(body: Record<string, unknown>, issues: unknown[]): { body: Record<string, unknown>; fixes: string[] } {
  const nodes = body.nodes;
  if (!Array.isArray(nodes)) return { body, fixes: [] };

  const fixes: string[] = [];
  let nextNodes: unknown[] | undefined;
  for (const issueString of issueStrings(issues)) {
    const match = STRATEGY_ENUM_ISSUE.exec(issueString);
    if (!match) continue;
    const index = Number(match[1]);
    const node = (nextNodes ?? nodes)[index];
    if (!isObject(node)) continue;
    const currentPrivate = node.private;
    if (!isObject(currentPrivate) || typeof currentPrivate.strategy !== "string") continue;
    const currentValue = currentPrivate.strategy;

    // The allowed list as the client just stated it, this issue, this call — never assumed stale.
    const allowed = [...match[2].matchAll(/"([^"]*)"/g)].map((allowedMatch) => allowedMatch[1]);
    if (allowed.includes(currentValue)) continue; // already valid by the client's own words; not ours to touch.
    const mapped = STRATEGY_SYNONYMS[currentValue.trim().toLowerCase()];
    const resolved = mapped && (allowed.length === 0 || allowed.includes(mapped)) ? mapped : undefined;

    const nextPrivate = { ...currentPrivate };
    if (resolved) {
      nextPrivate.strategy = resolved;
      fixes.push(`strategy_enum:nodes[${index}]:${currentValue}→${resolved}`);
    } else {
      delete nextPrivate.strategy;
      fixes.push(`strategy_enum_dropped:nodes[${index}]`);
    }
    nextNodes = nextNodes ?? [...nodes];
    nextNodes[index] = { ...node, private: nextPrivate };
  }
  return nextNodes ? { body: { ...body, nodes: nextNodes }, fixes } : { body, fixes: [] };
}

// Only when EVERY element of the offending array is a string does this join it into the single
// string the contract wants — a `[label, non_string]` pair (or anything else mixed-typed) is left
// exactly as the model wrote it, for the one remaining revision turn to judge, not for this program to
// guess at.
function applyItemsJoinFixes(body: Record<string, unknown>, issues: unknown[]): { body: Record<string, unknown>; fixes: string[] } {
  const nodes = body.nodes;
  if (!Array.isArray(nodes)) return { body, fixes: [] };

  const fixes: string[] = [];
  let nextNodes: unknown[] | undefined;
  for (const issueString of issueStrings(issues)) {
    const match = ITEMS_ARRAY_ISSUE.exec(issueString);
    if (!match) continue;
    const nodeIndex = Number(match[1]);
    const itemIndex = Number(match[2]);
    const node = (nextNodes ?? nodes)[nodeIndex];
    if (!isObject(node)) continue;
    const currentPublic = node.public;
    if (!isObject(currentPublic) || !Array.isArray(currentPublic.items)) continue;
    const items = currentPublic.items;
    const element = items[itemIndex];
    if (!Array.isArray(element) || element.length === 0 || !element.every((part): part is string => typeof part === "string")) continue;

    const nextItems = [...items];
    nextItems[itemIndex] = element.join(" — ");
    nextNodes = nextNodes ?? [...nodes];
    nextNodes[nodeIndex] = { ...node, public: { ...currentPublic, items: nextItems } };
    fixes.push(`items_join:nodes[${nodeIndex}].items[${itemIndex}]`);
  }
  return nextNodes ? { body: { ...body, nodes: nextNodes }, fixes } : { body, fixes: [] };
}

// Copy-on-write: the body travels BY REFERENCE all the way to publish_payload (W0), so a fix that
// mutated it in place would silently rewrite an artifact already recorded upstream. A fixed body is a
// new object; an unfixed body is the same object, identity intact.
export function applyMechanicalFixes(body: Record<string, unknown>, issues: unknown[]): { body: Record<string, unknown>; fixes: string[] } {
  const text = issueText(issues);
  const rootKeysToStrip = unrecognizedRootKeys(text).filter((key) => key in body);
  if (rootKeysToStrip.length) {
    const stripped: Record<string, unknown> = { ...body };
    for (const key of rootKeysToStrip) delete stripped[key];
    const rest = applyMechanicalFixes(stripped, issues.filter((issue) => !UNRECOGNIZED_ROOT_KEY.test(typeof issue === "string" ? issue : JSON.stringify(issue))));
    return { body: rest.body, fixes: [...rootKeysToStrip.map((key) => `unrecognized_root_key:${key}`), ...rest.fixes] };
  }

  // W3a: each of these two classes is gated on its OWN issue pattern, not on the shared id/form gate
  // below (a strategy-enum or items-shape complaint mentions neither "id" nor a casing/pattern word),
  // so both run unconditionally and are no-ops — original `body` reference and all — whenever their
  // own pattern is absent. `current` threads any change forward into the id-casing pass so a body
  // carrying more than one failure class gets all of them applied in one call.
  let current = body;
  const fixes: string[] = [];

  const strategyFixed = applyStrategyEnumFixes(current, issues);
  if (strategyFixed.fixes.length) {
    current = strategyFixed.body;
    fixes.push(...strategyFixed.fixes);
  }

  const itemsFixed = applyItemsJoinFixes(current, issues);
  if (itemsFixed.fixes.length) {
    current = itemsFixed.body;
    fixes.push(...itemsFixed.fixes);
  }

  if (!ID_COMPLAINT.test(text) || !FORM_COMPLAINT.test(text)) return { body: current, fixes };

  let next: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(current)) {
    if (!ID_FIELD.test(key) || typeof value !== "string") continue;
    const fixed = mechanicalValue(value);
    if (fixed === value || fixed.length === 0) continue;
    next = next ?? { ...current };
    next[key] = fixed;
    fixes.push(`id_casing:${key}`);
  }

  // The client's body grammar nests its content under `nodes[]` (the same array publishPayload's
  // candidate patch walks), and each node carries its own id — the id a deep search would wrongly
  // hand a validator, and the id a client most often rejects for form.
  const nodes = (next ?? current).nodes;
  if (Array.isArray(nodes)) {
    let nextNodes: unknown[] | undefined;
    nodes.forEach((node, index) => {
      if (!isObject(node)) return;
      let fixedNode: Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(node)) {
        if (!ID_FIELD.test(key) || typeof value !== "string") continue;
        const fixed = mechanicalValue(value);
        if (fixed === value || fixed.length === 0) continue;
        fixedNode = fixedNode ?? { ...node };
        fixedNode[key] = fixed;
        fixes.push(`id_casing:nodes[${index}].${key}`);
      }
      if (!fixedNode) return;
      nextNodes = nextNodes ?? [...nodes];
      nextNodes[index] = fixedNode;
    });
    if (nextNodes) {
      next = next ?? { ...current };
      next.nodes = nextNodes;
    }
  }
  return { body: next ?? current, fixes };
}

// The joiner the client's own validator uses inside a single `message`. Splitting on it is the whole
// of the flattening: no re-wording, no re-labelling, no re-ordering — each piece reaches the model as
// the client wrote it, which is what makes `issues[n]` quotable back at the client.
const CLIENT_ISSUE_JOINER = "; ";

// A leading `<path>:` as zod (and therefore the client) emits it — `nodes.24.private.strategy: …`.
// Anchored, and requiring the colon-space, so ordinary prose ("field `excerpt` is required…") and a
// path-less root complaint ("(root): Unrecognized key…") simply do not match rather than producing a
// path that points at nothing. Both the dot and bracket styles are accepted, for the same reason the
// mechanical fixers accept both: fixtures in this repo were written bracket-style, the live client
// emits dot-style.
const ISSUE_PATH = /^([A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d+\])*)\s*:\s/;

// A `currentValues` entry is a hint, not a payload. A client is free to name a path that resolves to
// something large (`nodes`, or a whole node), and re-attaching that would rebuild — under a new key —
// exactly the bulk this change removes. Over-cap values are OMITTED, never truncated into a
// half-value the model might copy: the path still travels, so the turn still knows what to fix.
const REVISION_TARGET_VALUE_MAX_CHARS = 500;

// One plain string per real problem. Accepts whatever the client actually sent: a string issue, an
// object issue with a `message` (the live shape), or anything else, which is preserved as its own
// JSON rather than dropped. Duplicates collapse — the same sentence twice is one problem, not two.
export const flattenValidationIssues = (issues: readonly unknown[]): string[] => {
  const flattened: string[] = [];
  for (const issue of issues) {
    const text =
      typeof issue === "string" ? issue
        : isObject(issue) && typeof issue.message === "string" ? issue.message
          : JSON.stringify(issue) ?? String(issue);
    for (const part of text.split(CLIENT_ISSUE_JOINER)) {
      const trimmed = part.trim();
      if (trimmed && !flattened.includes(trimmed)) flattened.push(trimmed);
    }
  }
  return flattened;
};

const pathSegments = (path: string): string[] => path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);

const readAtPath = (body: Record<string, unknown>, path: string): unknown => {
  let cursor: unknown = body;
  for (const segment of pathSegments(path)) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
    } else if (isObject(cursor)) cursor = cursor[segment];
    else return undefined;
  }
  return cursor;
};

// `nodes.24.…` → the id the body itself gives node 24. Reading the id off the body rather than out of
// the issue text is deliberate: the client names positions, the model edits by name, and this is the
// only place that translation can be made without either of them guessing.
const nodeIdAtPath = (body: Record<string, unknown>, path: string): string | undefined => {
  const [first, second] = pathSegments(path);
  if (first !== "nodes" || second === undefined) return undefined;
  const nodes = body.nodes;
  const index = Number(second);
  if (!Array.isArray(nodes) || !Number.isInteger(index)) return undefined;
  const node = nodes[index];
  return isObject(node) && typeof node.id === "string" ? node.id : undefined;
};

export const buildRevisionTarget = (body: Record<string, unknown>, issues: readonly string[]): ArticleBodyRevisionTarget => {
  const nodeIds: string[] = [];
  const paths: string[] = [];
  const currentValues: Record<string, unknown> = {};
  for (const issue of issues) {
    const path = ISSUE_PATH.exec(issue)?.[1];
    if (!path || paths.includes(path)) continue;
    paths.push(path);
    const nodeId = nodeIdAtPath(body, path);
    if (nodeId && !nodeIds.includes(nodeId)) nodeIds.push(nodeId);
    const value = readAtPath(body, path);
    if (value === undefined) continue; // a path with nothing at it (a missing required field) is still worth naming.
    if ((JSON.stringify(value) ?? "").length <= REVISION_TARGET_VALUE_MAX_CHARS) currentValues[path] = value;
  }
  return { nodeIds, paths, currentValues };
};

// The instruction says what is actually in the input. The previous envelope is NOT attached any more,
// so an instruction to "emit the SAME output envelope again" would be asking the model to copy
// something it cannot see — the surest way to get an invented copy back.
export const REVISION_INSTRUCTION =
  "The client's own validator REJECTED the body you emitted. Each entry in `issues` is ONE separate problem in the client's own words — fix every one of them, not the first. `revisionTarget` names the node ids and exact paths those problems refer to, with the value currently sitting at each. Emit your full output envelope again, built from the same inputs you were given: change exactly the fields these issues name, keep everything else as you built it, invent no new content, and do not call the validator yourself — the engine validates for you and will report the result. Your previous envelope is deliberately not attached: it is the object the client just rejected, and re-sending it in full is what this turn replaced.";

export const buildValidationFeedback = (request: { issues: readonly unknown[]; body: Record<string, unknown>; attempt: number }): ArticleBodyValidationFeedback => {
  const issues = flattenValidationIssues(request.issues);
  return {
    source: "client_object_validate",
    attempt: request.attempt,
    issues,
    rawIssues: [...request.issues],
    revisionTarget: buildRevisionTarget(request.body, issues),
    instruction: REVISION_INSTRUCTION
  };
};

const outcomeOf = (validation: PublishPayloadValidation): ArticleBodyLoopOutcome =>
  !validation.attempted ? "unavailable" : validation.valid ? "valid" : validation.deferred ? "deferred" : "invalid";

// A verdict the loop must not argue with. `valid` is done; `deferred` is the client correctly
// refusing to validate an object that does not exist yet (article_body's prompt names it as a NORMAL
// outcome); `unavailable` means the call never landed, and a second identical call inside the same
// dispatch is spend, not information.
const isTerminal = (validation: PublishPayloadValidation): boolean => outcomeOf(validation) !== "invalid";

export async function runArticleBodyValidationLoop(output: Record<string, unknown>, deps: ArticleBodyLoopDeps): Promise<ArticleBodyLoopResult | undefined> {
  let currentOutput = output;
  let body = readBodyForValidation(currentOutput);
  if (!body) return undefined;

  const warnings: string[] = [];
  const mechanicalFixes: string[] = [];
  let revalidations = 0;
  let revisionTurns = 0;
  let revisionChangedBody = false;
  let validation = await deps.validate(body);

  while (!isTerminal(validation) && revalidations < MAX_ENGINE_REVALIDATION_CYCLES) {
    const fixed = applyMechanicalFixes(body, validation.issues);
    if (fixed.fixes.length) {
      body = fixed.body;
      currentOutput = { ...currentOutput, body };
      mechanicalFixes.push(...fixed.fixes);
      revalidations += 1;
      validation = await deps.validate(body);
      continue;
    }
    if (!deps.revise || revisionTurns >= MAX_ENGINE_REVISION_TURNS) break;
    // Taken BEFORE the dispatch, against the exact body the turn is being asked to repair, so the
    // comparison below measures the model's edit and nothing else.
    const fingerprintBeforeRevision = stableHash(body);
    const revision = await deps.revise({ output: currentOutput, body, issues: validation.issues, attempt: revisionTurns + 1 });
    revisionTurns += 1;
    if (!revision.ok) {
      warnings.push(`article_body_revision_failed:${revision.code}`);
      break;
    }
    const revisedBody = readBodyForValidation(revision.output);
    if (!revisedBody || !isObject(revision.output)) {
      // A revision turn that came back without a usable body has told us nothing; the pre-revision
      // envelope is still the best thing this node produced, so it is what survives.
      warnings.push("article_body_revision_unusable:no_body");
      break;
    }
    currentOutput = revision.output;
    body = revisedBody;
    if (stableHash(body) !== fingerprintBeforeRevision) revisionChangedBody = true;
    revalidations += 1;
    validation = await deps.validate(body);
  }

  const outcome = outcomeOf(validation);
  // "We stopped because we ran out of what we are ALLOWED to try", as distinct from "we stopped
  // because there was nothing to try" (an invalid verdict with no mechanical fix available and no
  // revision path configured leaves both counters at zero and reports boundedExhaustion false).
  const boundedExhaustion = outcome === "invalid" && (revalidations >= MAX_ENGINE_REVALIDATION_CYCLES || revisionTurns >= MAX_ENGINE_REVISION_TURNS);
  if (outcome === "invalid") warnings.push(boundedExhaustion ? "article_body_validation_loop_exhausted" : "article_body_validation_invalid");
  if (outcome === "unavailable") warnings.push(`article_body_validation_unavailable:${validation.error ?? "unknown"}`);
  // An auth failure is reported alongside the ordinary "unavailable" warning, not instead of it: the
  // run log should still read the same as any other validation outage, and the caller gets the one
  // extra fact that changes what it must do about it.
  const authFailure = validation.authFailed ? { error: validation.error ?? "client rejected this driver's credential", ...(validation.httpStatus !== undefined ? { httpStatus: validation.httpStatus } : {}) } : undefined;

  const record: ArticleBodyValidationRecord = {
    ...validation,
    source: ENGINE_VALIDATION_SOURCE,
    bodyFingerprint: stableHash(body),
    engineLoop: { revalidations, revisionTurns, mechanicalFixes, outcome, boundedExhaustion, revisionChangedBody }
  };
  return { output: { ...currentOutput, body, clientValidation: record }, validation: record, warnings, ...(authFailure ? { authFailure } : {}) };
}

// S3 item 9: "the client's validator could not be reached / refused the request" is not a warning a
// publish gate may read past — it becomes a BLOCKER on article_body's own output, which readiness
// (article_body_blockers) then refuses. The warning stays for the run log; the blocker is what stops
// an unjudged body from being published as if it had been judged. Copy-on-write, deduplicated.
export const VALIDATION_UNAVAILABLE_PREFIX = "article_body_validation_unavailable";

// W2.5 (2026-09-07, run_1788769566432_5qnafb) — CLOSING G3, and the reason this function is no longer
// named for one of the two cases it handles.
//
// "The client REJECTED the body" was, until now, only a warning. `article_body` completed with
// `blockers: []` on a verdict of `valid:false`, so readiness's `article_body_blockers` check passed
// on a body the client had explicitly refused, and the earliest node in the run that KNEW the object
// was invalid was the one node that said nothing about it. That was survivable only because
// publish_payload raises its own `client_validation_failed` blocker a step later — one gate, on one
// path, with a model fallback beside it (G2). Under dr-lurie's autonomous publishing policy that is
// not enough separation between an invalid body and a live site.
//
// So both classes of loop warning are promoted now, on the same principle S3 item 9 already
// established for the unavailable case: a fact a publish gate must not read past belongs in
// `blockers[]`, not only in the run log. `article_body_validation_loop_exhausted` (the loop spent
// everything it was allowed to spend and the object is still invalid) and
// `article_body_validation_invalid` (invalid with nothing left to try) both mean the client said no.
// Promoting them makes the earliest honest signal an actual signal, and readiness's EXISTING
// `article_body_blockers` check then refuses it for free — no new gate, no new policy.
//
// Deliberately NOT promoted: `article_body_revision_failed:*` / `article_body_revision_unusable:*`.
// Those describe a repair ATTEMPT that went wrong, not a verdict about the object; whatever the
// object's real verdict is, it is already carried by one of the three warnings above.
export const VALIDATION_BLOCKING_WARNING_PREFIXES: readonly string[] = [
  VALIDATION_UNAVAILABLE_PREFIX,
  "article_body_validation_loop_exhausted",
  "article_body_validation_invalid"
];
export function promoteValidationWarningsToBlockers(output: unknown, warnings: readonly string[]): unknown {
  const blocking = warnings.filter((warning) => VALIDATION_BLOCKING_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix)));
  if (!blocking.length || !isObject(output)) return output;
  const existing = Array.isArray(output.blockers) ? output.blockers : [];
  const added = blocking.filter((warning) => !existing.includes(warning));
  return added.length ? { ...output, blockers: [...existing, ...added] } : output;
}
