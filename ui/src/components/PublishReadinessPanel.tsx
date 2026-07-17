import { useState } from "react";
import type { PublishReadinessInput, PublishReadinessResponse, PublishResult, WorkflowExecutionRecord } from "../types/workspace";

// Explicit PUBLISH gate surface. It renders the project's publish-readiness checklist (GO/NO-GO) and,
// crucially, treats a NO-GO / blocked_for_publish_execution result as an EXPECTED, resumable safety
// state — an amber hold with the request id, the node awaiting approval, the artifact/media slot, the
// required action, and a resume affordance — never a red generic failure.

const RELEASE_BEHAVIORS = ["publish_now", "schedule", "build_only", "unpublish"] as const;

const CHECK_MARK: Record<string, string> = { pass: "✓", fail: "✕", accepted_empty: "○" };
const CHECK_LABEL: Record<string, string> = { pass: "pass", fail: "action needed", accepted_empty: "accepted empty" };

type Props = {
  run: WorkflowExecutionRecord | null;
  readiness: PublishReadinessResponse | null;
  publishResult: PublishResult | null;
  loading: boolean;
  error: string | null;
  onCheckReadiness: (readiness: PublishReadinessInput) => void;
  onPublish: (params: { requestId: string; approved: boolean; live: boolean; readiness: PublishReadinessInput }) => void;
};

const splitList = (text: string) => text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);

export function PublishReadinessPanel({ run, readiness, publishResult, loading, error, onCheckReadiness, onPublish }: Props) {
  const [requestId, setRequestId] = useState("");
  const [releaseBehavior, setReleaseBehavior] = useState("");
  const [approver, setApprover] = useState("");
  const [pinApproval, setPinApproval] = useState(false);
  const [tagsText, setTagsText] = useState("");
  const [acceptEmptyTaxonomy, setAcceptEmptyTaxonomy] = useState(false);
  const [affirmHardConstraints, setAffirmHardConstraints] = useState(false);
  const [verifiedRefsText, setVerifiedRefsText] = useState("");
  const [approved, setApproved] = useState(false);
  const [live, setLive] = useState(false);

  if (!run) {
    return <section className="panel publish-readiness-panel" aria-label="Publish readiness">
      <h2>Publish readiness</h2>
      <p className="empty-state">No dry-run selected yet. Start or load a run before checking publish readiness.</p>
    </section>;
  }

  const buildReadinessInput = (): PublishReadinessInput => {
    const tags = splitList(tagsText);
    const verifiedMediaRefs = splitList(verifiedRefsText);
    return {
      ...(releaseBehavior ? { releaseBehavior } : {}),
      taxonomy: { ...(tags.length ? { tags } : {}), ...(acceptEmptyTaxonomy ? { acceptedEmpty: true } : {}) },
      approval: { pinned: pinApproval, ...(approver.trim() ? { approvedBy: approver.trim() } : {}) },
      ...(affirmHardConstraints ? { hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false } } : {}),
      ...(verifiedMediaRefs.length ? { verifiedMediaRefs } : {})
    };
  };

  const submitCheck = (event: React.FormEvent) => { event.preventDefault(); onCheckReadiness(buildReadinessInput()); };
  const submitPublish = () => onPublish({ requestId: requestId.trim(), approved, live, readiness: buildReadinessInput() });

  // A blocked publish carries the full resumable descriptor; a bare readiness NO-GO (no publish attempt
  // yet) still surfaces as a safety hold from the readiness result.
  const blocked = publishResult?.mode === "blocked_for_publish_execution" ? publishResult.blocked : null;
  const readinessResult = readiness?.readiness ?? null;
  const noGo = readinessResult?.status === "no_go";

  return <section className="panel publish-readiness-panel" aria-label="Publish readiness">
    <h2>Publish readiness</h2>
    <p className="muted">Explicit publish gate for <code>{run.projectId}</code> · run <code>{run.runId}</code>. Publishing is irreversible — a NO-GO is a safety hold, not a failure.</p>

    <form className="publish-form" onSubmit={submitCheck}>
      <label className="publish-field">Request id
        <input type="text" value={requestId} onChange={(event) => setRequestId(event.target.value)} placeholder="req_flow_topic_20260717_01" />
      </label>
      <label className="publish-field">Release / build behavior
        <select value={releaseBehavior} onChange={(event) => setReleaseBehavior(event.target.value)}>
          <option value="">— select —</option>
          {RELEASE_BEHAVIORS.map((behavior) => <option key={behavior} value={behavior}>{behavior}</option>)}
        </select>
      </label>
      <label className="publish-field">Approver
        <input type="text" value={approver} onChange={(event) => setApprover(event.target.value)} placeholder="editor" />
      </label>
      <label className="publish-check"><input type="checkbox" checked={pinApproval} onChange={(event) => setPinApproval(event.target.checked)} /> Pin approval</label>
      <label className="publish-field">Tags (comma separated)
        <input type="text" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="science, health" />
      </label>
      <label className="publish-check"><input type="checkbox" checked={acceptEmptyTaxonomy} onChange={(event) => setAcceptEmptyTaxonomy(event.target.checked)} /> Accept empty taxonomy</label>
      <label className="publish-check"><input type="checkbox" checked={affirmHardConstraints} onChange={(event) => setAffirmHardConstraints(event.target.checked)} /> Affirm hard constraints (<code>pdf_tool_dr_lurie_blob.v1</code>, no legacy fallbacks)</label>
      <label className="publish-field">Verified media refs (pdf-tool materialized, one per line)
        <textarea value={verifiedRefsText} onChange={(event) => setVerifiedRefsText(event.target.value)} rows={2} placeholder="image/req_x/abc.png" />
      </label>
      <fieldset className="publish-gates">
        <legend>Live publish gates</legend>
        <label className="publish-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /> approved</label>
        <label className="publish-check"><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> live <span className="warning-text">(irreversible)</span></label>
      </fieldset>
      <div className="publish-actions">
        <button type="submit" disabled={loading}>Check readiness</button>
        <button type="button" disabled={loading || !requestId.trim()} onClick={submitPublish}>{live && approved ? "Publish live" : "Attempt publish (plan)"}</button>
      </div>
    </form>

    {error && <div className="status error" role="alert">{error}</div>}

    {blocked && <div className="status safety publish-blocked" role="status">
      <strong>Publish paused — safety hold</strong>
      <p>This is an expected, resumable safety state. No publication was performed.</p>
      <dl>
        <dt>Request id</dt><dd><code>{blocked.requestId}</code></dd>
        <dt>Node awaiting approval</dt><dd><code>{blocked.nodeAwaitingApproval}</code></dd>
        <dt>Artifact / media slot</dt><dd>{blocked.artifactSlot ? <code>{blocked.artifactSlot}</code> : "—"}</dd>
        <dt>Required action</dt><dd>{blocked.requiredAction}</dd>
      </dl>
      {blocked.resumable && <button type="button" disabled={loading} onClick={submitPublish}>Retry / resume</button>}
    </div>}

    {readiness && !readiness.available && <div className="status info" role="status">
      This project has no publish-readiness policy — only the generic publish gate applies.
    </div>}

    {readinessResult && <div className="publish-readiness-result">
      <div className={`status ${noGo ? "safety" : "success"}`} role="status">
        <strong>{noGo ? "NO-GO — safety hold" : "GO — ready for publish execution"}</strong>
        {readinessResult.requiredAction && <p>{readinessResult.requiredAction}</p>}
      </div>
      <h3>Readiness checklist</h3>
      <ul className="checklist" aria-label="Publish readiness checklist">
        {readinessResult.checklist.map((check) => <li key={check.key} className={`checklist-item checklist-${check.status}`}>
          <span className="checklist-mark" aria-hidden="true">{CHECK_MARK[check.status] ?? "•"}</span>
          <span className="checklist-body"><strong>{check.label}</strong> <span className="checklist-status">({CHECK_LABEL[check.status] ?? check.status})</span>{check.detail && <><br /><span className="muted">{check.detail}</span></>}</span>
        </li>)}
      </ul>
      <dl className="hard-constraints">
        <dt>contentPath</dt><dd><code>{readinessResult.hardConstraints.contentPath}</code></dd>
        <dt>artifactProtocol</dt><dd><code>{readinessResult.hardConstraints.artifactProtocol}</code></dd>
        <dt>legacyFallbacksUsed</dt><dd><code>{String(readinessResult.hardConstraints.legacyFallbacksUsed)}</code></dd>
      </dl>
    </div>}

    {publishResult && <PublishResultSummary result={publishResult} />}
  </section>;
}

function PublishResultSummary({ result }: { result: PublishResult }) {
  const modeTone = result.mode === "live" ? "success" : result.mode === "error" ? "error" : result.mode === "blocked_for_publish_execution" ? "safety" : "info";
  return <div className="publish-result">
    <h3>Publish result</h3>
    <div className={`status ${modeTone}`} role="status">
      <strong>{result.mode}</strong>{result.published ? " — published" : ""}
      {result.mode === "dry_run" && <p>{result.reason}</p>}
      {result.mode === "error" && <p>{result.error}</p>}
    </div>
    <h4>Gates</h4>
    <ul className="checklist" aria-label="Publish gates">
      {result.gates.gates.map((gate) => <li key={gate.name} className={`checklist-item checklist-${gate.passed ? "pass" : "fail"}`}>
        <span className="checklist-mark" aria-hidden="true">{gate.passed ? "✓" : "✕"}</span>
        <span className="checklist-body"><strong>{gate.name}</strong>{gate.reason && <><br /><span className="muted">{gate.reason}</span></>}</span>
      </li>)}
    </ul>
    {result.plan && <p className="muted">Plan: <code>{result.plan.toolSequence.join(" → ")}</code></p>}
  </div>;
}
