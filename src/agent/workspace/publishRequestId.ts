// T4 (autonomous-publish) — AUTHORING A PUBLISH REQUEST ID FOR A RUN THAT HAS NO ARTIFACT PLAN.
//
// The publish request id (req_<flow>_<topic>_<yyyymmdd>_<nn>) is authored by exactly one node,
// artifact_plan, and lifted into run context from its stage output. Everything downstream reads it
// from there. That works for every run in which artifact_plan actually runs.
//
// It does not work for a TEXT-ONLY run. artifact_plan carries the skip predicate {when:
// "no_media_slots"}, so a run that asks for no media skips it before dispatch — correctly: there is
// no plan to make. But a skipped node writes no stage output by construction ("a skipped node
// asserted nothing"), so the id is never authored, and the run reaches a passed controller, a
// recorded operator approval and five green publisher gates only to be refused with
// `publish_request_id_absent`. The run was structurally incapable of publishing from the moment the
// predicate fired, and nothing said so until the very end.
//
// S3/#180 added the operator-supplied `run.publishRequestId` for the analogous seeded-run case. This
// module closes the remaining hole: when artifact_plan skips for no_media_slots and no id exists yet,
// the conductor authors one at skip time — the same moment the run loses its only other source.
//
// THREE RULES THIS KEEPS.
//   1. An id an artifact_plan actually authored always wins. That precedence lives in buildRunContext
//      and is untouched; this only ever fills `run.publishRequestId`, which is read behind it.
//   2. An operator-supplied id is never overwritten. The caller checks first; this module is only
//      asked for an id when the run has none.
//   3. `run.requestId` is never a source. It is the platform/workspace join key, and stamping it on a
//      live client object would be worse than not publishing.
//
// The minted id is deliberately self-identifying: the flow segment is `conductor`, so an id this
// engine authored is distinguishable at a glance from one a human wrote, in the client's records as
// well as in ours.
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";

// The publisher's shared contract shape, used when a project declares no pattern of its own. Kept as
// its own literal rather than imported from publisher.ts to avoid a cycle; publisher.ts holds the
// authoritative copy and both are asserted against each other in the tests.
const DEFAULT_REQUEST_ID_PATTERN = /^req_[a-z0-9_]+_\d{8}_\d{2}$/;

export const AUTHORED_PUBLISH_REQUEST_ID_FLOW = "conductor";

export type MintedPublishRequestId =
  | { ok: true; requestId: string }
  | { ok: false; reason: string };

const compilePattern = (declared: string | undefined): RegExp => {
  if (!declared) return DEFAULT_REQUEST_ID_PATTERN;
  try {
    return new RegExp(declared);
  } catch {
    return DEFAULT_REQUEST_ID_PATTERN;
  }
};

const yyyymmdd = (at: Date): string =>
  `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}${String(at.getUTCDate()).padStart(2, "0")}`;

// The `topic` segment must survive `[a-z0-9_]`. Everything else is dropped rather than transliterated:
// a lossy-but-legible slug is the point, and a topic that reduces to nothing falls back to the run's
// own identity below rather than producing `req__20260825_01`.
export const slugifyTopic = (value: string, maxLength = 32): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
    .replace(/_+$/g, "");

// A short, stable discriminator from the run id, so two text-only runs started for the same topic on
// the same day cannot mint the same publish id. Publish ids reach the client's own records; a
// collision there is not a cosmetic problem.
const runDiscriminator = (runId: string): string => {
  const slug = slugifyTopic(runId, 64);
  const tail = slug.split("_").filter(Boolean).pop() ?? "";
  return tail.slice(-6) || "run";
};

const readTopic = (initialInput: unknown): string => {
  if (typeof initialInput === "string") return slugifyTopic(initialInput);
  if (initialInput && typeof initialInput === "object") {
    const record = initialInput as Record<string, unknown>;
    for (const key of ["topic", "title", "slug", "brief", "input"]) {
      const value = record[key];
      if (typeof value === "string" && slugifyTopic(value)) return slugifyTopic(value);
    }
  }
  return "";
};

// Mints an id and PROVES it against the project's own declared pattern before returning it. A
// project whose pattern this cannot satisfy gets `ok:false` and no id, so the pre-existing
// `publish_request_id_absent` refusal stands — refusing to publish is always better than publishing
// under an identifier the client's contract does not recognise.
export function mintPublishRequestId(params: {
  runId: string;
  initialInput?: unknown;
  config?: Pick<ProjectConnectionConfig, "objectDialect"> | undefined;
  now?: Date;
}): MintedPublishRequestId {
  const pattern = compilePattern(params.config?.objectDialect?.requestIdPattern);
  const discriminator = runDiscriminator(params.runId);
  const topic = readTopic(params.initialInput);
  const segment = [topic, discriminator].filter(Boolean).join("_");
  const requestId = `req_${AUTHORED_PUBLISH_REQUEST_ID_FLOW}_${segment}_${yyyymmdd(params.now ?? new Date())}_01`;
  if (!pattern.test(requestId)) {
    return { ok: false, reason: `minted id "${requestId}" does not match project pattern ${pattern.source}` };
  }
  return { ok: true, requestId };
}
