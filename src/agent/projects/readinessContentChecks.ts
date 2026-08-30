// S3 item 7 — the CONTENT half of publish readiness, shared by every project's readiness hook.
//
// Why this exists. The per-project hooks (drLurie/, platform/) own their client's policy — hard
// constraints, artifact protocol, taxonomy source — and must stay separate so one client's rule change
// can never move another's gate. But three questions are the same for every client and were asked by
// none of them, which is how a run reached "go" with an empty body:
//
//   1. Is there any reader-visible content at all? (`article_has_content`) — a body whose `nodes` is
//      `[]`, or whose visible text is a stub, validated fine against the envelope schema and sailed
//      through as publishable.
//   2. Did article_body itself declare blockers? (`article_body_blockers`) — the node's own
//      `blockers[]` was carried into the artifact and read by nobody on the readiness path.
//   3. Did an upstream node raise a blocker the controller must not waive? (`upstream_blockers`) —
//      `aggression_ceiling_missing` on contract_intelligence/brief_architect (Wolf's ruling: an absent
//      ceiling is a blocker, never a default) reached publication_controller only through prompt text.
//   4. Was media requested and none delivered? (`media_requested_vs_delivered`) — brief_architect asked
//      for N media slots; the body carries zero verified media; nothing compared the two.
//
// And one rule is tightened for every client: `media_artifacts_verified` walks EVERY media reference
// in the body (image src AND pdf refs), and a reference the caller has not confirmed as materialized
// for this request is unverified — regardless of whether it "looks" like a blob key or a public path.
// The previous rule only checked blob-shaped keys, so a public `/img/<req>/<sha>.png` that pointed at
// nothing passed the gate.

export type ReadinessCheckStatus = "pass" | "fail" | "accepted_empty";
export type ReadinessCheck = { key: string; label: string; status: ReadinessCheckStatus; detail?: string };

// Reader-visible text below this is a stub, not an article. Deliberately low: it catches the empty
// and near-empty bodies that reached "go" without treating a short, legitimate note as a failure.
export const MIN_VISIBLE_CONTENT_CHARS = 200;

// Blocker codes that upstream nodes may raise which a controller must never waive on the readiness path.
export const UNWAIVABLE_UPSTREAM_BLOCKERS: readonly string[] = ["aggression_ceiling_missing"];

type ClientNode = { public?: Record<string, unknown>; [key: string]: unknown };
// The body root is client-shaped and open: a client may root its rendered media here (Dr. Lurie's
// content_item declares `image {src, alt}` at the root and no media field on any node), so the
// index signature is what lets mediaRefsOf read those fields without pinning one client's names.
type ClientObject = { nodes?: ClientNode[] } & Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const clientObjectOf = (envelope: unknown): ClientObject =>
  (isObject(envelope) ? (envelope.body as ClientObject | undefined) : undefined) ?? {};

const nodesOf = (body: ClientObject): ClientNode[] => (Array.isArray(body.nodes) ? body.nodes : []).filter(isObject) as ClientNode[];

// Every string that reads as reader-visible text on a node: title, body, text, prose blocks, rich-text
// runs — whether the client roots them under `public` (Dr. Lurie's content_item) or on the node itself.
// Private/strategy annotations, rendering metadata, identifiers and media descriptors are not content.
const NON_CONTENT_KEYS = new Set(["id", "kind", "type", "visibility", "private", "commercial", "rendering", "chat", "media", "alt", "src", "href", "featuredImage", "slug", "schema_version"]);
const visibleTextOf = (value: unknown, key?: string): string => {
  if (key !== undefined && NON_CONTENT_KEYS.has(key)) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => visibleTextOf(entry)).join(" ");
  if (isObject(value)) return Object.entries(value).map(([childKey, child]) => visibleTextOf(child, childKey)).join(" ");
  return "";
};

export const visibleContentCharsOf = (envelope: unknown): { nodes: number; chars: number } => {
  const nodes = nodesOf(clientObjectOf(envelope));
  const text = nodes.map((node) => visibleTextOf(node)).join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { nodes: nodes.length, chars: text.length };
};

const PDF_REF = /\.pdf(?:$|[?#])/i;

// Every media reference the body carries. TWO places, because clients root media in two different
// ways and this scan used to know only one of them:
//
//   PER NODE — `media.src` (image) under `public` or on the node itself, plus any string under
//   `media` that references a pdf (`pdf`, `href`, `file` — client field naming varies), a pdf `href`
//   on the public block, and a `featuredImage` key.
//
//   ON THE BODY ROOT — the contract's own rendered image field. Dr. Lurie's content_item declares
//   exactly this: one `image {src, alt}` at the root, and NO media field on any node. Scanning only
//   nodes therefore found nothing on a body whose hero was bound perfectly, and reported it two ways
//   at once — "no media artifacts" (a pass, on a body that has one) and "the body carries 0 verified
//   media reference(s)" (a fail, on a body that carries one). run_1787919896283_yybhg0 sat at the
//   publish gate on that second one with its hero image bound, verified, and in the right field.
export const mediaRefsOf = (envelope: unknown): string[] => {
  const refs: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) refs.push(value.trim()); };
  const addMediaObject = (media: unknown) => {
    if (!isObject(media)) return;
    add(media.src);
    for (const [key, value] of Object.entries(media)) if (key !== "src" && typeof value === "string" && PDF_REF.test(value)) add(value);
  };
  const root = clientObjectOf(envelope);
  addMediaObject(root.image);
  addMediaObject(root.media);
  add(root.featuredImage);
  for (const node of nodesOf(clientObjectOf(envelope))) {
    const scopes = [isObject(node.public) ? node.public : undefined, node as Record<string, unknown>].filter(isObject);
    for (const scope of scopes) {
      const media = scope.media;
      if (isObject(media)) {
        add(media.src);
        for (const [key, value] of Object.entries(media)) if (key !== "src" && typeof value === "string" && PDF_REF.test(value)) add(value);
      }
      if (typeof scope.href === "string" && PDF_REF.test(scope.href)) add(scope.href);
      add(scope.featuredImage);
    }
  }
  return [...new Set(refs)];
};

// The verification evidence the ENVELOPE itself carries. artifact_plan materializes and verifies each
// slot, and article_body carries that record forward as `artifactReferences[]`, every entry holding
// both forms of the same artifact plus the `verified` flag artifact_plan set. That record is the
// system's own evidence, so a caller that does not separately pass verifiedMediaRefs (project.get's
// readiness call, the publication controller, an operator asking "is this ready?") should not be told
// the body's media is unverified. Only entries explicitly marked verified count — an unverified or
// in-flight slot contributes nothing, which keeps "a pattern-valid key is never proof of
// materialization" intact: this trusts a recorded verification, never a key's shape.
export const envelopeVerifiedMediaRefsOf = (envelope: unknown): string[] => {
  if (!isObject(envelope) || !Array.isArray(envelope.artifactReferences)) return [];
  const refs: string[] = [];
  for (const entry of envelope.artifactReferences) {
    if (!isObject(entry) || entry.verified !== true) continue;
    collectArtifactEntryRefs(entry, refs);
  }
  return [...new Set(refs)];
};

// Both forms of one verified artifact, whatever the carrier called its raw-reference field. The
// artifact bridge has emitted the raw key under `artifactReference.blobKey` and (verified live,
// run_1788023523567_qdv9et) under `rawReference.blobKey`; a bare `blobKey` shows up on flattened
// entries. Reading all three is shape tolerance, not trust widening — the caller has already
// checked the entry's own verification evidence before asking for its refs.
const collectArtifactEntryRefs = (entry: Record<string, unknown>, refs: string[]): void => {
  if (typeof entry.publicPath === "string" && entry.publicPath.trim()) refs.push(entry.publicPath.trim());
  for (const key of ["artifactReference", "rawReference"]) {
    const reference = entry[key];
    if (isObject(reference) && typeof reference.blobKey === "string" && reference.blobKey.trim()) refs.push(reference.blobKey.trim());
  }
  if (typeof entry.blobKey === "string" && entry.blobKey.trim()) refs.push(entry.blobKey.trim());
};

// W6 — the verification evidence the RUN's own artifact_plan stage output carries: its top-level
// artifactReferences (entries explicitly marked verified) plus every media slot whose status is
// has_trusted_artifact — the status artifact_plan may only set on an adoption response or a
// terminal-success job status (its prompt's materialization policy), never on a pattern-valid key.
// This is the same system-evidence principle as envelopeVerifiedMediaRefsOf: article_body normally
// carries the plan's record forward as artifactReferences[], but a run whose envelope dropped that
// array still HOLDS the evidence in the plan output, and a publisher that holds the run should not
// report the body's media unverified because one copy of the same record went missing.
export const artifactPlanVerifiedMediaRefsOf = (stageOutputs: Record<string, unknown> | undefined): string[] => {
  const plan = stageOutputs?.artifact_plan;
  if (!isObject(plan)) return [];
  const refs: string[] = [...envelopeVerifiedMediaRefsOf(plan)];
  const slots = Array.isArray(plan.media_slots) ? plan.media_slots : [];
  for (const slot of slots) {
    if (!isObject(slot) || slot.status !== "has_trusted_artifact") continue;
    collectArtifactEntryRefs(slot, refs);
  }
  return [...new Set(refs)];
};

// A verified ref matches a body reference exactly, or by its trailing `<request>/<file>` path — the
// caller usually holds the RAW artifact key (`image/req_x/abc.png`) while the body carries the client's
// rendered public path (`/img/req_x/abc.png`); both name the same materialized artifact.
const tail = (ref: string): string => ref.replace(/^\/+/, "").split(/[?#]/)[0]!.split("/").slice(-2).join("/").toLowerCase();
export const isVerifiedMediaRef = (ref: string, verifiedMediaRefs: readonly string[] | undefined): boolean => {
  const verified = (verifiedMediaRefs ?? []).map(String);
  if (verified.includes(ref)) return true;
  const wanted = tail(ref);
  return wanted.includes("/") && verified.some((candidate) => tail(candidate) === wanted);
};

export type ContentReadinessInput = {
  articleBody?: unknown;
  articleBodyValid: boolean;
  verifiedMediaRefs?: string[];
  // The run's stage outputs (brief_architect / contract_intelligence / …) when the caller holds them.
  // Absent → the upstream and requested-vs-delivered checks are reported as accepted_empty, never
  // silently passed as if they had been evaluated.
  stageOutputs?: Record<string, unknown>;
};

const blockersOf = (value: unknown): string[] => {
  if (!isObject(value) || !Array.isArray(value.blockers)) return [];
  return value.blockers.map((entry) => (typeof entry === "string" ? entry : isObject(entry) ? String(entry.code ?? entry.message ?? JSON.stringify(entry)) : String(entry)));
};

/**
 * The client-neutral content checks. Returns the checks in the order they should render; a `fail`
 * status is a blocker the caller must add to its own blockers list (every hook does this the same
 * way through its `push` helpers).
 */
export function evaluateContentReadiness(input: ContentReadinessInput): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const pass = (key: string, label: string, detail?: string) => checks.push({ key, label, status: "pass", detail });
  const acceptedEmpty = (key: string, label: string, detail?: string) => checks.push({ key, label, status: "accepted_empty", detail });
  const fail = (key: string, label: string, detail: string) => checks.push({ key, label, status: "fail", detail });

  // media_artifacts_verified — every reference in the body, confirmed by the caller OR by the
  // envelope's own artifactReferences record (see envelopeVerifiedMediaRefsOf) OR by the run's own
  // artifact_plan output (W6, artifactPlanVerifiedMediaRefsOf) when the caller supplied stageOutputs.
  const mediaRefs = input.articleBodyValid ? mediaRefsOf(input.articleBody) : [];
  const verifiedRefs = [
    ...(input.verifiedMediaRefs ?? []),
    ...(input.articleBodyValid ? envelopeVerifiedMediaRefsOf(input.articleBody) : []),
    ...artifactPlanVerifiedMediaRefsOf(input.stageOutputs)
  ];
  const unverified = mediaRefs.filter((ref) => !isVerifiedMediaRef(ref, verifiedRefs));
  if (mediaRefs.length === 0) pass("media_artifacts_verified", "Blob artifacts verified", "no media artifacts");
  else if (unverified.length === 0) pass("media_artifacts_verified", "Blob artifacts verified", `${mediaRefs.length} media reference(s) confirmed`);
  else fail("media_artifacts_verified", "Blob artifacts verified", `unverified media (pdf-tool materialization for this request not confirmed): ${unverified.join(", ")}`);

  // article_has_content
  const content = visibleContentCharsOf(input.articleBody);
  if (!input.articleBodyValid) fail("article_has_content", "Article has reader-visible content", "no valid article body");
  else if (content.nodes === 0) fail("article_has_content", "Article has reader-visible content", "body.nodes is empty — nothing would render");
  else if (content.chars < MIN_VISIBLE_CONTENT_CHARS) fail("article_has_content", "Article has reader-visible content", `${content.chars} visible character(s) across ${content.nodes} node(s); at least ${MIN_VISIBLE_CONTENT_CHARS} required`);
  else pass("article_has_content", "Article has reader-visible content", `${content.chars} visible characters across ${content.nodes} node(s)`);

  // article_body_blockers
  const ownBlockers = blockersOf(input.articleBody);
  if (ownBlockers.length) fail("article_body_blockers", "article_body declared no blockers", ownBlockers.join("; "));
  else pass("article_body_blockers", "article_body declared no blockers");

  // upstream_blockers + media_requested_vs_delivered — need the run's stage outputs.
  const stages = input.stageOutputs;
  if (!stages) {
    acceptedEmpty("upstream_blockers", "No unwaivable upstream blockers", "run stage outputs not supplied; not evaluated");
    acceptedEmpty("media_requested_vs_delivered", "Requested media was delivered", "run stage outputs not supplied; not evaluated");
    return checks;
  }
  const upstream = (["contract_intelligence", "brief_architect"] as const)
    .flatMap((nodeId) => blockersOf(stages[nodeId]).filter((code) => UNWAIVABLE_UPSTREAM_BLOCKERS.some((unwaivable) => code.includes(unwaivable))).map((code) => `${nodeId}: ${code}`));
  if (upstream.length) fail("upstream_blockers", "No unwaivable upstream blockers", upstream.join("; "));
  else pass("upstream_blockers", "No unwaivable upstream blockers");

  const brief = stages.brief_architect;
  const requested = isObject(brief) && Array.isArray(brief.mediaSlots) ? brief.mediaSlots.length : undefined;
  const delivered = mediaRefs.filter((ref) => isVerifiedMediaRef(ref, verifiedRefs)).length;
  if (requested === undefined) acceptedEmpty("media_requested_vs_delivered", "Requested media was delivered", "brief_architect declared no mediaSlots array; not evaluated");
  else if (requested > 0 && delivered === 0) fail("media_requested_vs_delivered", "Requested media was delivered", `brief_architect requested ${requested} media slot(s); the body carries 0 verified media reference(s)`);
  else pass("media_requested_vs_delivered", "Requested media was delivered", `${requested} requested, ${delivered} verified in body`);
  return checks;
}
