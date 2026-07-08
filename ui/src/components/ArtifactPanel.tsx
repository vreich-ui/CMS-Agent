import { useMemo, useState } from "react";
import type { WorkflowExecutionRecord } from "../types/workspace";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function ArtifactPanel({ run }: { run: WorkflowExecutionRecord | null }) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const selectedArtifact = useMemo(() => run?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? run?.artifacts[0] ?? null, [run, selectedArtifactId]);

  return <section className="panel artifact-panel">
    <h2>Content blocks and outputs</h2>
    {!run ? <p className="empty-state">No dry-run selected yet. Outputs appear after a Builder run creates them.</p> : <div className="split">
      <div>
        <h3>Content blocks</h3>
        {run.artifacts.length ? <ul className="artifact-list">{run.artifacts.map((artifact) => <li key={artifact.id}><button className="link-button" onClick={() => setSelectedArtifactId(artifact.id)}>{artifact.type}</button><span>{artifact.nodeId}</span></li>)}</ul> : <p>No content blocks yet. Run the next node to generate deterministic dry-run outputs.</p>}
        <h3>Selected block JSON</h3>
        <pre>{selectedArtifact ? pretty(selectedArtifact) : "No block selected."}</pre>
      </div>
      <div>
        <h3>Stage outputs JSON</h3>
        <pre>{pretty(run.stageOutputs)}</pre>
      </div>
    </div>}
  </section>;
}
