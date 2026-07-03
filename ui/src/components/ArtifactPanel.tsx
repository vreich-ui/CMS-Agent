import { useMemo, useState } from "react";
import type { WorkflowExecutionRecord } from "../types/workspace";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function ArtifactPanel({ run }: { run: WorkflowExecutionRecord | null }) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const selectedArtifact = useMemo(() => run?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? run?.artifacts[0] ?? null, [run, selectedArtifactId]);

  return <section className="panel artifact-panel">
    <h2>Artifacts</h2>
    {!run ? <p>No dry-run selected yet.</p> : <div className="split">
      <div>
        <h3>Artifact list</h3>
        {run.artifacts.length ? <ul className="artifact-list">{run.artifacts.map((artifact) => <li key={artifact.id}><button className="link-button" onClick={() => setSelectedArtifactId(artifact.id)}>{artifact.type}</button><span>{artifact.nodeId}</span></li>)}</ul> : <p>No artifacts yet. Click Run Next Node to generate deterministic dry-run outputs.</p>}
        <h3>Selected artifact JSON</h3>
        <pre>{selectedArtifact ? pretty(selectedArtifact) : "No artifact selected."}</pre>
      </div>
      <div>
        <h3>stageOutputs JSON</h3>
        <pre>{pretty(run.stageOutputs)}</pre>
      </div>
    </div>}
  </section>;
}
