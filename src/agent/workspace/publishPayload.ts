// W0 (determinism program, 2026-08-12) — the deterministic half of publish_payload.
//
// WHY THIS EXISTS. On the last live run (run_1786468126136_ev9goe) publish_payload cost $2.73 of a
// $5.56 run — 49% of the run — across five attempts (two node-budget stops, one 429, one
// toolCallLimit timeout, one success). What it produced for that money was a `clientObject` that was
// BYTE-IDENTICAL to `article_body.body`. It paid $2.73 to copy JSON. Everything else in its output is
// an envelope carry-through (clientProjectId / clientObjectType / contractSource), a reference set
// copied from upstream, a blocker union, and ONE call to the client's own validator. None of that
// requires judgment a program cannot make.
//
// WHAT THIS DOES NOT DO. It does not reshape, re-key, prune, or "improve" the client object — the
// client's contract is the only authority on that shape and article_body already built to it, so the
// object travels BY REFERENCE (identity-preserving, deliberately not a clone: a copy is an
// opportunity to differ). It does not upgrade unverified media to trusted media, does not invent a
// requestId or an artifactProtocol the upstream plan never named, and does not assert validity the
// client did not state — an unreadable validator verdict is INVALID, never a pass (the rule
// objectDialect.parseValidateResult already encodes for the publish path).
//
// SAFETY. This is a fast path, not the only path. runDeterministicPublishPayload's caller
// (executor.ts) validates the result against the node's own outputSchema before using it and falls
// back to the normal model dispatch on any failure — exactly the deterministicContractIntelligence
// contract. A bug here degrades to "spend the $2.73", never to a failed run or a malformed publish
// candidate reaching the publication controller.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import { stableHash } from "../improvement/improvementTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import {
  JUDGEMENT_SUBSTRATE_KEYS,
  buildArticleCandidatePatch,
  describeCandidatePatch,
  parseValidateResult
} from "../projects/objectDialect.js";

export type PublishPayloadValidation = {
  attempted: boolean;
  tool: string;
  valid: boolean;
  issues: unknown[];
  candidate_patch_summary?: string;
  deferred?: string;
  error?: string;
  // T2: the client answered 401/403 — this driver's credential for the project is not accepted. Kept
  // distinct from every other `error` because the two demand opposite responses: an ordinary
  // validation outage is a blocker on this body (the run may still be salvageable, and the operator
  // may publish later), while an auth failure means no node in this run can reach the client at all,
  // so the run must stop rather than spend the rest of its budget producing an unpublishable
  // artifact. Never set for a `deferred` verdict — a client refusing to validate an object that does
  // not exist yet has spoken, and is answering correctly.
  authFailed?: true;
  httpStatus?: number;
};

export type PublishPayloadOutput = {
  artifact: "dry_run_publish_payload.v1";
  summary: string;
  clientProjectId: string;
  clientObjectType: string;
  contractSource: unknown;
  dryRun: true;
  clientObject: Record<string, unknown>;
  requestId?: string;
  clientValidation: PublishPayloadValidation;
  artifactProtocol?: string;
  artifactReferences?: unknown[];
  artifactHandling: { legacyFallbacksUsed: false; notes: string[] };
  validationAssumptions: string[];
  blockers: string[];
  notes: string[];
};

export type PublishPayloadSources = { articleBody: unknown; artifactPlan?: unknown; clientProjectId: string; requestId?: string };
export type PublishPayloadBuildResult = { ok: true; payload: PublishPayloadOutput } | { ok: false; code: string; error: string };
export type PublishPayloadDeps = { projectRepository: ProjectRepository };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter(nonEmptyString) : []);

// Same reasoning (and the same 15s) as contractPrefetch.ts: this is deterministic conductor code that
// bypasses executeTool's gateway entirely, so it inherits none of that path's timeout/abort wiring
// and would otherwise hang a node dispatch forever on a wedged remote. One read call, not a write.
const OBJECT_VALIDATE_TIMEOUT_MS = 15_000;

// The client refusing to validate an object that does not exist yet is the NORMAL outcome for a
// dry-run candidate, not a defect — article_body's own prompt names it verbatim ("Record
// clientValidation {attempted: true, ..., deferred: "requires_existing_object"} ... and treat that as
// a NORMAL outcome, not a blocker"). Detected over the stringified result because the refusal shape
// is the client's, not ours, and varies by tenant.
const REQUIRES_EXISTING_OBJECT = /requires[_ ]existing[_ ]object|object[_ ]not[_ ]found|no such object|does not exist|unknown[_ ]object[_ ]id/i;

// Blocker identity for the union/subtraction below. Whitespace and case are presentation, not
// meaning: two upstream nodes stating the same blocker differently-cased is ONE blocker, and the
// first-seen wording is the one carried (never a re-worded merge, which would rewrite an upstream
// node's own words).
const blockerKey = (blocker: string): string => blocker.trim().toLowerCase().replace(/\s+/g, " ");

// An upstream blocker this node's OWN evidence closes. The only evidence this node produces is the
// client validator's verdict, so the only resolvable class is a client-validation blocker, and it is
// only resolved by an explicit `valid: true`. Deliberately narrow: a deterministic path that talks
// itself out of upstream blockers is strictly worse than one that carries them forward, and the
// publication controller's whole job is to see them.
const CLIENT_VALIDATION_BLOCKER = /client[ _-]?validation|client'?s own validator|object_validate|not (?:yet )?validated|validation (?:is )?(?:deferred|pending|incomplete)|final_revalidation/i;

export const collectUpstreamBlockers = (...upstreamOutputs: unknown[]): string[] => {
  const seen = new Set<string>();
  const blockers: string[] = [];
  for (const output of upstreamOutputs) {
    if (!isObject(output)) continue;
    for (const blocker of stringArray(output.blockers)) {
      const key = blockerKey(blocker);
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push(blocker);
    }
  }
  return blockers;
};

export const resolveBlockers = (upstream: string[], validation: PublishPayloadValidation): { blockers: string[]; resolved: string[] } => {
  const validatorPassed = validation.attempted && validation.valid;
  const resolved = validatorPassed ? upstream.filter((blocker) => CLIENT_VALIDATION_BLOCKER.test(blocker)) : [];
  const resolvedKeys = new Set(resolved.map(blockerKey));
  return { blockers: upstream.filter((blocker) => !resolvedKeys.has(blockerKey(blocker))), resolved };
};

// The client object the candidate patch is validated against, taken BY REFERENCE from article_body's
// output — the identity check in the tests is the point, not a nicety: the $2.73 finding was that a
// model was paid to reproduce this object, and the only way to guarantee it is reproduced exactly is
// to not reproduce it at all.
export const readArticleBody = (articleBody: unknown): { ok: true; body: Record<string, unknown>; envelope: Record<string, unknown> } | { ok: false; code: string; error: string } => {
  if (!isObject(articleBody)) return { ok: false, code: "article_body_absent", error: "publish_payload's article_body dependency output is missing or is not an object; nothing to build a publish candidate from." };
  const body = articleBody.body;
  if (!isObject(body) || Object.keys(body).length === 0) return { ok: false, code: "client_object_absent", error: "article_body produced no non-empty `body` object; a publish candidate cannot be assembled deterministically from an absent client object." };
  if (!nonEmptyString(articleBody.clientObjectType)) return { ok: false, code: "client_object_type_absent", error: "article_body carries no clientObjectType; the publish candidate's envelope cannot be carried through without inventing one." };
  if (!isObject(articleBody.contractSource)) return { ok: false, code: "contract_source_absent", error: "article_body carries no contractSource provenance object; an unprovenanced candidate is a blocker by this node's own criteria, not something to assemble around." };
  return { ok: true, body, envelope: articleBody };
};

// Deliberately NOT objectDialect.findObjectId: that helper searches DEEP for `object_id` or `id`, and
// a client body's `nodes[]` entries carry their own `id` — a deep search would hand the validator a
// child node's id as the object under validation. A dry-run candidate for an object that does not
// exist yet has no id at all, and no id is the correct, honest argument in that case.
export const readTopLevelObjectId = (body: Record<string, unknown>): string | number | undefined => {
  for (const key of ["object_id", "objectId", "id"]) {
    const value = body[key];
    if (typeof value === "number" || nonEmptyString(value)) return value;
  }
  return undefined;
};

// S3 item 9: one warn line per process for a request-shape 400 (see below).
let validateRequestShapeLogged = false;
export const __resetValidateRequestShapeLog = (): void => { validateRequestShapeLogged = false; };

export async function validateClientObjectOnce(params: { projectId: string; body: Record<string, unknown>; objectId?: string | number; objectType?: string }, deps: PublishPayloadDeps): Promise<PublishPayloadValidation> {
  const { patch, nodeCount } = buildArticleCandidatePatch(params.body, JUDGEMENT_SUBSTRATE_KEYS);
  const summary = describeCandidatePatch(patch, nodeCount);
  const config = await deps.projectRepository.get(params.projectId);
  if (!config) return { attempted: false, tool: "object_validate", valid: false, issues: [], candidate_patch_summary: summary, error: `Unknown projectId: ${params.projectId}` };

  // The regression on run_1786549907145_hf4wgb, in one line: this call carried NO `object_type`, and
  // the client's request schema requires it (a 12-value enum), so every engine validation 400'd with
  // `invalid_value at ["object_type"]` before the body was ever judged. The value was always in hand —
  // article_body's envelope carries clientObjectType — it just was never threaded through. Reproduced
  // and counterfactual-proven 2026-08-12: the same body with object_type supplied validates "ready".
  //
  // Calling convention, confirmed against the client itself: an EXISTING object is validated as
  // {object_type, object_id, candidate_patch}; a dry-run candidate that has no object_id yet is
  // validated as {object_type, body} — the client rejects candidate_patch without object_id outright
  // ("validate requires either object_id ... or body ...").
  // S3 item 9: a candidate body goes to the client WITHOUT the workspace-only `schema_version` marker
  // — the client's strict content_item body (additionalProperties:false) rejects it with a request
  // 400, exactly as the publisher already learned (it drops the key before object_patch). The output
  // envelope keeps the marker; only the validate REQUEST is stripped.
  const { schema_version: _schemaVersion, ...candidateBody } = params.body;
  const arguments_ = {
    ...(nonEmptyString(params.objectType) ? { object_type: params.objectType } : {}),
    ...(params.objectId === undefined ? { body: candidateBody } : { object_id: params.objectId, candidate_patch: patch })
  };
  // Mirrors project.call_read_tool's own handler ordering (toolRegistry.ts) exactly as contractPrefetch
  // does: the project's executable policy runs before any transport, so a client-specific block still
  // applies even though this call never reaches the model-facing controlled-tool gate.
  const policyFindings = getProjectHooks(params.projectId)?.enforceCallToolPolicy?.({ tool: "object_validate", arguments: arguments_ }) ?? [];
  const blocking = policyFindings.filter((finding) => finding.severity === "error");
  if (blocking.length) return { attempted: false, tool: "object_validate", valid: false, issues: [], candidate_patch_summary: summary, error: `Blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}` };

  const adapter = new ProjectMcpAdapter(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OBJECT_VALIDATE_TIMEOUT_MS);
  let call: Awaited<ReturnType<typeof adapter.callReadTool>>;
  try {
    call = await adapter.callReadTool("object_validate", arguments_, controller.signal);
  } catch (error) {
    return { attempted: false, tool: "object_validate", valid: false, issues: [], candidate_patch_summary: summary, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  if (!call.ok) {
    const message = call.error ?? "object_validate failed";
    // A refusal because the object does not exist yet is the client answering correctly about a
    // candidate for an object nobody has created — a deferral, and attempted:true, because the call
    // was made and the client did speak.
    if (REQUIRES_EXISTING_OBJECT.test(message)) return { attempted: true, tool: "object_validate", valid: false, issues: [message], candidate_patch_summary: summary, deferred: "requires_existing_object" };
    // Checked AFTER the deferral above, deliberately: a requires-existing-object refusal is a real
    // answer from an authenticated client and keeps its precedence. A 401/403 cannot produce that
    // message, so the ordering costs nothing and removes any chance of shadowing a normal outcome.
    if (call.authFailed) return { attempted: false, tool: "object_validate", valid: false, issues: [], candidate_patch_summary: summary, error: message, authFailed: true, ...(call.httpStatus !== undefined ? { httpStatus: call.httpStatus } : {}) };
    return { attempted: false, tool: "object_validate", valid: false, issues: [], candidate_patch_summary: summary, error: message };
  }
  const rawText = JSON.stringify(call.result ?? null);
  // A request-shape rejection (HTTP 400) is the client refusing to LOOK at the object because the
  // REQUEST was malformed — an engine defect, not a verdict about the body. Recording it as
  // valid:false was how the missing-object_type bug cascaded on run_1786549907145_hf4wgb: the engine
  // loop handed its own 400 to the model as "the client rejected your body" and the model dutifully
  // "fixed" a body that was never judged. attempted:false is the honest record (the client never
  // spoke about the object), and the loop's "unavailable" outcome correctly spends no revision turn
  // on it. A requires-existing-object refusal keeps its precedence as a NORMAL deferral.
  const requestShape = readRequestShapeRejection(call.result);
  if (requestShape && !REQUIRES_EXISTING_OBJECT.test(rawText)) {
    // S3 item 9: name the request the client refused, ONCE per process, so a 400 is diagnosable from
    // the log rather than from a re-run. Argument keys plus a bounded, secret-free preview only.
    if (!validateRequestShapeLogged) {
      validateRequestShapeLogged = true;
      console.warn("article_body.object_validate_request_rejected", JSON.stringify({ projectId: params.projectId, rejection: requestShape.slice(0, 300), argumentKeys: Object.keys(arguments_), request: JSON.stringify(arguments_).slice(0, 2_000) }));
    }
    return { attempted: false, tool: "object_validate", valid: false, issues: [], candidate_patch_summary: summary, error: `client rejected the validate REQUEST itself (HTTP 400, engine-side defect — the object was never judged): ${requestShape}` };
  }
  const parsed = parseValidateResult(call.result, summary);
  if (!parsed.valid && REQUIRES_EXISTING_OBJECT.test(rawText)) {
    return { attempted: true, tool: "object_validate", valid: false, issues: parsed.issues, candidate_patch_summary: summary, deferred: "requires_existing_object" };
  }
  return { attempted: true, tool: "object_validate", valid: parsed.valid, issues: parsed.issues, candidate_patch_summary: summary };
}

// The client's request-shape rejection, wherever the transport put it: a 400 statusCode next to an
// error/message string (the platform returns {isError, content, structuredContent:{error, statusCode,
// issues}}). Deliberately 400 ONLY — 404/409/422/423 are statements about the OBJECT or its lifecycle
// and must keep flowing into parseValidateResult / the deferral check unchanged.
export const readRequestShapeRejection = (result: unknown): string | undefined => {
  const found: { statusCode?: number; message?: string } = {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isObject(value)) return;
    if (found.statusCode === undefined && typeof value.statusCode === "number") found.statusCode = value.statusCode;
    if (found.message === undefined && nonEmptyString(value.error)) found.message = value.error;
    if (found.message === undefined && nonEmptyString(value.message)) found.message = value.message;
    Object.values(value).forEach(walk);
  };
  walk(result);
  return found.statusCode === 400 ? (found.message ?? "Invalid request fields.") : undefined;
};

export function buildDeterministicPublishPayload(sources: PublishPayloadSources, validation: PublishPayloadValidation): PublishPayloadBuildResult {
  const read = readArticleBody(sources.articleBody);
  if (!read.ok) return read;
  const { body, envelope } = read;
  const plan = isObject(sources.artifactPlan) ? sources.artifactPlan : undefined;

  const upstream = collectUpstreamBlockers(envelope, plan);
  const { blockers: carried, resolved } = resolveBlockers(upstream, validation);

  // Blockers this node itself owns, per its own blocker criteria ("client unreachable ... raise a
  // blocker; do not assert validity"). A deferral is explicitly NOT one of them.
  const ownBlockers: string[] = [];
  if (!validation.attempted) ownBlockers.push(`client_validation_unavailable: the client's own read-only validator could not be reached for this candidate (${validation.error ?? "no reason reported"}); validity is not asserted.`);
  else if (!validation.valid && !validation.deferred) ownBlockers.push(`client_validation_failed: the client's own validator rejected the candidate patch (${validation.issues.slice(0, 3).map((issue) => (typeof issue === "string" ? issue : JSON.stringify(issue))).join("; ") || "no issues reported"}).`);

  const blockers = [...carried, ...ownBlockers.filter((blocker) => !carried.some((existing) => blockerKey(existing) === blockerKey(blocker)))];

  const artifactReferences = Array.isArray(envelope.artifactReferences)
    ? (envelope.artifactReferences as unknown[])
    : Array.isArray(plan?.artifactReferences)
      ? (plan!.artifactReferences as unknown[])
      : undefined;
  const artifactProtocol = nonEmptyString(plan?.artifactProtocol) ? (plan!.artifactProtocol as string) : undefined;
  // W3 part 2: the publish request id travels as RUN CONTEXT (runContext.requestId, lifted once from
  // artifact_plan by the conductor), so this node no longer depends on finding it in the exact
  // upstream output it happens to read. artifact_plan's own value still wins where it is present —
  // this is a fallback for the read that did not carry one, never an override of an upstream statement.
  const requestId = nonEmptyString(plan?.requestId) ? (plan!.requestId as string) : nonEmptyString(sources.requestId) ? sources.requestId.trim() : undefined;

  const notes: string[] = [
    "Assembled deterministically by the conductor (publishPayload.ts): clientObject is article_body's own `body` carried by reference, not a re-derivation, so the candidate cannot differ from what was built and reviewed.",
    ...(artifactProtocol ? [] : ["No artifactProtocol was named by artifact_plan; none is asserted here rather than inventing one (a zero-media plan legitimately omits it)."]),
    ...(resolved.length ? [`Upstream blocker(s) resolved by this node's own client-validator pass: ${resolved.join(" | ")}`] : [])
  ];

  const engineLoop = (validation as { source?: unknown; engineLoop?: unknown }).source === "engine_validation_loop" ? (validation as { engineLoop?: { revalidations?: number; revisionTurns?: number; mechanicalFixes?: string[] } }).engineLoop : undefined;

  const validationAssumptions: string[] = [
    "The client's own validator (object_validate, read-only via project.call_read_tool) is the only verdict recorded here; no workspace-local verdict was substituted, and an unreadable verdict is treated as invalid rather than as a pass.",
    ...(engineLoop
      ? [`This verdict was earned by the engine's own validate→fix→revalidate loop at article_body, against this exact body (fingerprint-matched), and is reused here rather than re-earned: ${engineLoop.revalidations ?? 0} revalidation(s), ${engineLoop.revisionTurns ?? 0} model revision turn(s), mechanical fixes [${(engineLoop.mechanicalFixes ?? []).join(", ") || "none"}].`]
      : []),
    ...(validation.deferred === "requires_existing_object"
      ? ["The client refused to validate a candidate for an object that does not exist yet. Per the object lifecycle this is a NORMAL deferral, not a blocker: the authoritative validation runs in the publish executor after object_create and before any patch."]
      : []),
    ...(Array.isArray(envelope.artifactReferences) ? [] : ["article_body carried no artifactReferences array; the reference set here is whatever artifact_plan carried, or absent."])
  ];

  const artifactNotes = [
    "No legacy fallback path exists in this code path: no repo asset paths, remote URLs, data URIs, or hand-authored keys can be introduced, because references are carried verbatim from upstream and never synthesized."
  ];

  const summary =
    `Deterministic dry-run publish candidate for ${sources.clientProjectId}/${envelope.clientObjectType as string}: clientObject carried by reference from article_body ` +
    `(${Object.keys(body).length} top-level field(s)), ${artifactReferences?.length ?? 0} artifact reference(s), client validator ` +
    `${validation.attempted ? (validation.valid ? "valid" : validation.deferred ? `deferred (${validation.deferred})` : "invalid") : "unreachable"}, ` +
    `${blockers.length} blocker(s). No model call.`;

  const payload: PublishPayloadOutput = {
    artifact: "dry_run_publish_payload.v1",
    summary,
    clientProjectId: sources.clientProjectId,
    clientObjectType: envelope.clientObjectType as string,
    contractSource: envelope.contractSource,
    dryRun: true,
    clientObject: body,
    ...(requestId ? { requestId } : {}),
    clientValidation: validation,
    ...(artifactProtocol ? { artifactProtocol } : {}),
    ...(artifactReferences ? { artifactReferences } : {}),
    artifactHandling: { legacyFallbacksUsed: false, notes: artifactNotes },
    validationAssumptions,
    blockers,
    notes
  };
  return { ok: true, payload };
}

// W3 part 1 (determinism program, 2026-08-12): article_body's ENGINE-owned validate→fix→revalidate
// loop (articleBodyValidation.ts) already earned a verdict from the client's own validator, against
// this exact body, in this exact run. Re-earning it here is the duplicated spend W3 exists to remove —
// so publish_payload reuses it, but only under conditions that make reuse indistinguishable from
// re-validating:
//   - the record was written by the engine loop (source), not typed by a model into clientValidation;
//   - the call ACTUALLY LANDED (attempted) — an unreachable client at article_body time is a reason
//     to try again here, not a verdict to inherit;
//   - the body about to be published hashes to the body the verdict was earned against. A verdict is
//     about an object. If anything touched the object since, the verdict is void and the validator is
//     called again.
export const readRecordedValidation = (articleBody: unknown, body: Record<string, unknown>): PublishPayloadValidation | undefined => {
  if (!isObject(articleBody)) return undefined;
  const record = articleBody.clientValidation;
  if (!isObject(record)) return undefined;
  if (record.source !== "engine_validation_loop" || record.attempted !== true) return undefined;
  if (typeof record.tool !== "string" || typeof record.valid !== "boolean") return undefined;
  if (record.bodyFingerprint !== stableHash(body)) return undefined;
  return record as unknown as PublishPayloadValidation;
};

// The one entry point executor.ts calls: read upstream, reuse article_body's engine-earned verdict or
// make exactly ONE object_validate call, build. Every failure mode is returned as {ok:false} so the
// caller's single decision stays "use it, or fall through to the model path".
export async function runDeterministicPublishPayload(params: { projectId: string; clientProjectId: string; articleBody: unknown; artifactPlan?: unknown; requestId?: string }, deps: PublishPayloadDeps): Promise<PublishPayloadBuildResult> {
  const read = readArticleBody(params.articleBody);
  if (!read.ok) return read;
  const objectId = readTopLevelObjectId(read.body);
  const recorded = readRecordedValidation(params.articleBody, read.body);
  const validation = recorded ?? await validateClientObjectOnce({ projectId: params.projectId, body: read.body, objectId, objectType: read.envelope.clientObjectType as string }, deps);
  return buildDeterministicPublishPayload({ articleBody: params.articleBody, artifactPlan: params.artifactPlan, clientProjectId: params.clientProjectId, requestId: params.requestId }, validation);
}
