// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
//
// T14.5 — the publish tail. This is the ONE vendored module where `object_publish` and
// `release_to_production` are reachable; emit.mjs's forbidden-verb set is unchanged and still bans
// both, because an emission walks crawled third-party content and must not reach production
// mid-write. `trigger_netlify_build` and `deploy` are unreachable from here too.
export class PublishError extends Error {}

/** Never reachable, from this stage or any other. A build is `release_to_production`'s decision. */
export const PUBLISH_FORBIDDEN_VERBS: ReadonlySet<string>;
/** The two verbs this stage — and only this stage — may use. */
export const PUBLISH_VERBS: ReadonlySet<string>;

export type PublishCandidate = {
  objectId: string;
  objectType: string | null;
  phase: string | null;
};

export type PublishWithheld = PublishCandidate & {
  /** Why it is not going live. Every WRITTEN object is either published or named here. */
  reason:
    | "validation_failed"
    | "quarantined_by_emission"
    | "type_not_publishable_from_capture"
    | "object_type_unknown";
  detail?: string | null;
};

export type PublishPlan = {
  schemaVersion: "capture-publish-plan.v1";
  target: string;
  publish: PublishCandidate[];
  withheld: PublishWithheld[];
  /** False when nothing is publishable — production is not asked to rebuild for zero commits. */
  release: boolean;
  forbiddenVerbs: string[];
};

export type PublishRelease = {
  released: boolean;
  status: string | null;
  deployId?: string | null;
  commit?: string | null;
  productionConfirmed?: boolean;
  productionUrl?: string | null;
  /** Set when the objects published but the deploy failed: the state is retryable, not lost. */
  recoverable?: boolean;
  detail?: string;
};

export type PublishRun = {
  schemaVersion: "capture-publish-run.v1";
  target: string;
  published: Array<{ objectId: string; objectType: string; publishedTime: string | null; commit: string | null }>;
  failed: Array<{ objectId?: string; objectType?: string | null; reason: string; detail?: string }>;
  withheld: PublishWithheld[];
  release: PublishRelease;
  trace: Array<Record<string, unknown>>;
};

export type PublishTransport = { call(verb: string, args: Record<string, unknown>): Promise<unknown> };

/** PURE. Decides what goes live from the emission report alone — no transport, no clock, no I/O. */
export function buildPublishPlan(input: { report: Record<string, unknown>; target?: string }): PublishPlan;

/** Publishes each object through checkout -> publish -> checkin, then releases ONCE for the plan. */
export function executePublish(input: { plan: PublishPlan; transport: PublishTransport }): Promise<PublishRun>;
