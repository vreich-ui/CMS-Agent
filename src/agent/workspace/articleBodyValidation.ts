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
  "Client-object validation is run BY THE ENGINE after you return: do not call the client's validator yourself and do not fill clientValidation — spending your tool calls on validation is what exhausted this node's budget mid-validation on a previous live run. Emit your best object and let the engine earn the verdict; if the client rejects it you may be dispatched once more with those exact issues in your input as validationFeedback, and should then re-emit the same envelope with only the changes those issues require.";

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
  };
};

export type ArticleBodyRevisionRequest = { output: Record<string, unknown>; body: Record<string, unknown>; issues: unknown[]; attempt: number };
export type ArticleBodyRevisionResult = { ok: true; output: unknown } | { ok: false; code: string; message: string };

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
  if (!ID_COMPLAINT.test(text) || !FORM_COMPLAINT.test(text)) return { body, fixes: [] };

  const fixes: string[] = [];
  let next: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(body)) {
    if (!ID_FIELD.test(key) || typeof value !== "string") continue;
    const fixed = mechanicalValue(value);
    if (fixed === value || fixed.length === 0) continue;
    next = next ?? { ...body };
    next[key] = fixed;
    fixes.push(`id_casing:${key}`);
  }

  // The client's body grammar nests its content under `nodes[]` (the same array publishPayload's
  // candidate patch walks), and each node carries its own id — the id a deep search would wrongly
  // hand a validator, and the id a client most often rejects for form.
  const nodes = (next ?? body).nodes;
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
      next = next ?? { ...body };
      next.nodes = nextNodes;
    }
  }
  return { body: next ?? body, fixes };
}

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

  const record: ArticleBodyValidationRecord = {
    ...validation,
    source: ENGINE_VALIDATION_SOURCE,
    bodyFingerprint: stableHash(body),
    engineLoop: { revalidations, revisionTurns, mechanicalFixes, outcome, boundedExhaustion }
  };
  return { output: { ...currentOutput, body, clientValidation: record }, validation: record, warnings };
}

// S3 item 9: "the client's validator could not be reached / refused the request" is not a warning a
// publish gate may read past — it becomes a BLOCKER on article_body's own output, which readiness
// (article_body_blockers) then refuses. The warning stays for the run log; the blocker is what stops
// an unjudged body from being published as if it had been judged. Copy-on-write, deduplicated.
export const VALIDATION_UNAVAILABLE_PREFIX = "article_body_validation_unavailable";
export function promoteValidationUnavailableToBlocker(output: unknown, warnings: readonly string[]): unknown {
  const unavailable = warnings.filter((warning) => warning.startsWith(VALIDATION_UNAVAILABLE_PREFIX));
  if (!unavailable.length || !isObject(output)) return output;
  const existing = Array.isArray(output.blockers) ? output.blockers : [];
  const added = unavailable.filter((warning) => !existing.includes(warning));
  return added.length ? { ...output, blockers: [...existing, ...added] } : output;
}
