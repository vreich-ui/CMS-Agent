import type { graphListEntries } from "../../designGraph";

// Screen-reader/list view of the constellation: the graph must be fully understandable without
// the visual canvas. Also doubles as a stable test surface that does not depend on React Flow
// measuring itself in jsdom.
export function GraphListView({ entries }: { entries: ReturnType<typeof graphListEntries> }) {
  return <details className="design-list">
    <summary>Nodes and dependencies as text</summary>
    <ul>
      {entries.map((entry) => <li key={entry.id}>{entry.text}</li>)}
    </ul>
  </details>;
}
