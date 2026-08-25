// What a CLIENT said when it REFUSED — the one place this workspace turns an MCP error result into
// a named, quotable failure.
//
// THE ANTI-PATTERN THIS CLOSES. An MCP tool result signals failure with `isError: true` and carries
// the reason in content[].text / structuredContent.error; the transport that delivered it succeeded,
// so every `ok`-checking layer above waves it through. Code that then reads a field out of that
// result finds nothing and reports the ABSENCE — "could not resolve the object id" — which is a
// statement about our parser, not about the client's refusal. The client's own sentence, the one
// that would have ended the investigation, is discarded on the floor.
//
// Live, 2026-08-25: publish run run_1787656120374_18bobg (dr-lurie) reported
// `create_missing_object_id: could not resolve the object id (object_id/id) from the object_create
// result.` with `steps: [{ tool: "object_create", ok: true }]`. object_inventory then proved NO
// object had been created: the client had refused object_create outright and said why. The hook
// never looked at `isError`, so a refusal was filed as an unfamiliar response SHAPE.
//
// It was the third instance of the same shape in one day — every non-2xx from Netlify collapsed
// into `netlify_api_failed` with the HTTP status thrown away (PR #174), and publish_executor
// reporting a cross-tenant mismatch instead of the real cause. Hence a shared home: the vocabulary
// for "the client refused, and here is its sentence" is written once and reused, so the next
// failure names itself.
//
// QUOTED, BUT NEVER TRUSTED (the T12.18 ruling, restated here because this module now depends on
// it). The capture subsystem reached the same conclusion first and its reader,
// ../capture/captureEngine.ts's describeMcpErrorResult, is this one's twin — the two were written
// against the same standard and should eventually be one function. Collapsing them means editing
// the capture path, which a publish-path fix deliberately does not touch; whoever next works on
// capture should fold that copy onto this one. The ruling itself: an earlier standard said "the
// remote's own error text is untrusted, so the remedy is NAMED, not quoted", and every isError
// result collapsed to the constant string "returned an MCP error result". On 2026-08-19 that cost
// a full diagnosis cycle: run run_1787060978987_06v19b quarantined 29 assets
// with 29 byte-identical messages carrying no fact about any of them, and the cause was only found
// by hand-replaying the call — where the client answered, immediately and precisely,
// {statusCode: 400, error: "request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn> ..."}. A
// refusal a machine cannot act on and a human cannot read is not safety, it is a blind spot.
//
// What the original ruling was protecting survives intact. The danger is remote text becoming an
// INSTRUCTION, and that danger belongs to crawled third-party content — the open internet. This
// string is not that: it is a first-party governed service's own structured refusal, reached over
// an authenticated endpoint from the project registry. So it is quoted, but never trusted:
// STRUCTURED fields are preferred over prose, the result is length-capped so no remote party can
// flood run state, newlines are flattened so nothing can forge log or prompt structure, and
// credential-shaped runs are redacted — the same discipline stripCredentialShapedFields applies to
// bridge payloads. Publish hooks handle bearer tokens and storage grants; the client's error text
// is safe to carry, the request that produced it is not, so NOTHING from the arguments is echoed
// here.
//
// Hex digests are deliberately NOT redacted: a sha256 mismatch is one of the failures this exists
// to explain, and blanking the digest would recreate the blind spot in the exact case that most
// needs it.

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const MCP_ERROR_DETAIL_MAX = 300;
const CREDENTIAL_SHAPED_TEXT_RE =
  // The labelled branch must swallow an optional `bearer ` PREFIX as part of its value. Without
  // that, `Authorization: Bearer <secret>` matches the label branch, whose `\S+` stops at the
  // space after "Bearer" — consuming the trigger word and leaving the secret itself in the clear,
  // while the standalone bearer branch never gets to re-scan the text already consumed.
  /\b(?:bearer\s+[\w.\-~+/]+=*|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|(?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*(?:bearer\s+)?\S+)/gi;

const scrubAndBound = (text: string): string => {
  const scrubbed = text.replace(CREDENTIAL_SHAPED_TEXT_RE, "[redacted]").replace(/\s+/g, " ");
  return scrubbed.length > MCP_ERROR_DETAIL_MAX ? `${scrubbed.slice(0, MCP_ERROR_DETAIL_MAX)}…` : scrubbed;
};

/** True when an MCP tool result signals failure. The transport succeeded; the CLIENT refused. */
export const isMcpErrorResult = (result: unknown): boolean => isRecord(result) && Boolean(result.isError);

/** Bounded, scrubbed, single-line rendering of a client's MCP error result. Exported for tests. */
export function describeMcpErrorResult(raw: Record<string, unknown>): string {
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : undefined;
  const nested = structured && isRecord(structured.error) ? structured.error : undefined;
  const firstString = (...values: unknown[]): string | undefined =>
    values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();

  // A typed code is worth more than prose and is listed first; statusCode is a number, so it can
  // never carry text at all.
  // Both spellings are in the wild: the site MCP's own catalog uses `error_code` (the vendored
  // engine's errorCode() reader agrees), while the capture bridge answers with `errorCode`.
  const code = firstString(structured?.error_code, structured?.errorCode, nested?.code, structured?.code);
  const status = typeof structured?.statusCode === "number" ? structured.statusCode : undefined;
  const message =
    firstString(nested?.message, structured?.message, typeof structured?.error === "string" ? structured.error : undefined) ??
    (Array.isArray(raw.content)
      ? firstString(
          raw.content
            .filter(isRecord)
            .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
            .join(" ")
        )
      : undefined);

  const prefix = [status !== undefined ? `status ${status}` : undefined, code].filter(Boolean).join(" ");
  if (!message) return prefix || "the client returned no error detail";

  const bounded = scrubAndBound(message);
  return prefix ? `${prefix}: ${bounded}` : bounded;
}

/** The HTTP status the client attached to its refusal, wherever the transport put it. */
export const readClientStatusCode = (raw: Record<string, unknown>): number | undefined => {
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : undefined;
  return typeof structured?.statusCode === "number" ? structured.statusCode : undefined;
};

/** The client's own per-field rejection list (this substrate answers 400s with a Zod `issues[]`). */
export const readClientIssues = (raw: Record<string, unknown>): unknown[] => {
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : undefined;
  const nested = structured && isRecord(structured.error) ? structured.error : undefined;
  const issues = [structured?.issues, nested?.issues].find((value) => Array.isArray(value) && value.length > 0);
  return Array.isArray(issues) ? issues : [];
};

// One issue rendered the way the client wrote it: `object_type: Invalid option: expected one of ...`.
// A shape this reader does not recognise is stringified rather than dropped — an unread issue is the
// same blind spot as an unread error.
const describeIssue = (issue: unknown): string => {
  if (!isRecord(issue)) return typeof issue === "string" ? issue : String(JSON.stringify(issue) ?? issue);
  const path = Array.isArray(issue.path) ? issue.path.map((part) => String(part)).join(".") : typeof issue.path === "string" ? issue.path : "";
  const message = typeof issue.message === "string" ? issue.message : JSON.stringify(issue);
  return path ? `${path}: ${message}` : message;
};

/** Bounded, scrubbed rendering of an `issues[]` array. Empty string when the client sent none. */
export const describeClientIssues = (issues: unknown[]): string =>
  issues.length ? scrubAndBound(issues.map(describeIssue).join("; ")) : "";

/**
 * A client REFUSAL, typed. `clientError` is the client's own sentence carried VERBATIM (prefixed
 * with the structured facts it supplied, never re-worded or summarised) — the exact field
 * PublishExecutionBlocker.clientError exists to carry. `tool` is the client tool that refused, so
 * the blocker downstream can name the failing step instead of guessing it from a message prefix.
 */
export class ClientToolRefusalError extends Error {
  readonly code = "client_refused";
  readonly tool: string;
  readonly clientError: string;
  readonly statusCode: number | undefined;
  readonly issues: unknown[];

  constructor(tool: string, raw: Record<string, unknown>) {
    const detail = describeMcpErrorResult(raw);
    const issues = readClientIssues(raw);
    const renderedIssues = describeClientIssues(issues);
    const clientError = renderedIssues ? `${detail} (issues: ${renderedIssues})` : detail;
    // `${tool}_refused:` mirrors publisher.ts's own `${tool}_failed:` convention for a transport
    // failure, so a reader can tell the two apart at a glance: _failed never reached the client,
    // _refused did and was turned down.
    super(`${tool}_refused: ${clientError}`);
    this.name = "ClientToolRefusalError";
    this.tool = tool;
    this.clientError = clientError;
    this.statusCode = readClientStatusCode(raw);
    this.issues = issues;
  }
}

/**
 * Pass a client tool result through, or throw the client's own refusal. The ONLY thing that makes a
 * result a refusal is `isError`; a result whose shape we cannot read is NOT one, and must keep
 * reaching the caller's own "the response carried no <field>" check — that error still has a real,
 * narrow meaning, and this exists so it stops being a catch-all for everything else.
 */
export const requireClientToolOk = <T>(tool: string, result: T): T => {
  if (!isMcpErrorResult(result)) return result;
  throw new ClientToolRefusalError(tool, result as Record<string, unknown>);
};

export type ClientToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Wrap a publish context's `call` so EVERY call site is checked. The generic publisher's `call`
 * records the step and throws when the TRANSPORT fails (adapter ok:false); it cannot throw for a
 * refusal, because as far as the transport is concerned the call succeeded. Hooks therefore build
 * their `call` from this rather than using ctx.call directly — a bare ctx.call in a hook is the bug
 * this module exists to prevent, and it is meant to look wrong.
 */
export const checkedClientCall = (call: ClientToolCall): ClientToolCall => async (tool, args) => requireClientToolOk(tool, await call(tool, args));

/** What to name in a log line for a call that failed, refusal or transport. Never echoes arguments. */
export const describeClientCallFailure = (error: unknown): string =>
  error instanceof ClientToolRefusalError ? error.clientError : error instanceof Error ? error.message : String(error);
