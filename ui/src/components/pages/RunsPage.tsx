import type { AppRoute } from "../../route";

// Honest placeholder: the Runs ledger ships in S5 (after workflow.list_runs grows
// pagination/filtering server-side). No fake controls.
export function RunsPage({ selectedProjectId, onNavigate }: { selectedProjectId: string | null; onNavigate: (route: AppRoute) => void }) {
  return <section className="tab-panel" aria-label="Runs">
    <section className="panel page-placeholder">
      <h2>Runs</h2>
      <p className="muted">The run ledger — paginated history, run detail with per-node timings, artifacts, and usage — arrives in session S5.</p>
      <p>Until then, run controls and run state live in the legacy Builder workspace{selectedProjectId ? <> (scoped to <code>{selectedProjectId}</code> when starting runs)</> : null}.</p>
      <p className="muted">Backend note: <code>workflow.list_runs</code> exists today and the Overview already summarizes it; server-side pagination and status/time filters are the remaining backend work.</p>
      <button type="button" onClick={() => onNavigate({ page: "constellation", legacy: "builder" })}>Open legacy builder</button>
    </section>
  </section>;
}
