import type { AppRoute } from "../../route";

// Honest placeholder: the Changes ledger UI ships in S6. The backend shipped in S1, so this page
// names what already exists rather than pretending nothing does.
export function ChangesPage({ onNavigate }: { selectedProjectId: string | null; onNavigate: (route: AppRoute) => void }) {
  return <section className="tab-panel" aria-label="Changes">
    <section className="panel page-placeholder">
      <h2>Changes</h2>
      <p className="muted">The immutable change ledger — who or what changed the constellation, when, why, with diffs and safe restore — arrives in session S6.</p>
      <p>The backend foundation already exists: every workspace mutation records an attributed, immutable change event, and <code>changes.list</code>, <code>changes.get</code>, <code>changes.compare</code>, and <code>changes.restore</code> are live MCP tools (shipped in S1). Agents can use them today.</p>
      <button type="button" onClick={() => onNavigate({ page: "overview" })}>Back to overview</button>
    </section>
  </section>;
}
