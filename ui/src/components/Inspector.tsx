import type { RJSFSchema } from "@rjsf/utils";
import type { WorkspaceNode } from "../types/workspace";
import { SchemaViewer } from "./SchemaViewer";

type InspectorProps = {
  selectedNode: WorkspaceNode | null;
  promptDraft: string;
  workspaceVersion?: number;
  selectedSchema?: RJSFSchema;
  onPromptDraftChange: (prompt: string) => void;
  onSavePrompt: () => void;
};

export function Inspector({ selectedNode, promptDraft, workspaceVersion, selectedSchema, onPromptDraftChange, onSavePrompt }: InspectorProps) {
  return <aside className="panel inspector">
    <h2>Node inspector</h2>
    {selectedNode ? <>
      <dl><dt>Node ID</dt><dd>{selectedNode.id}</dd><dt>Name</dt><dd>{selectedNode.name}</dd><dt>Workspace version</dt><dd>{workspaceVersion ?? "Not returned yet"}</dd></dl>
      <label>Prompt<textarea rows={8} value={promptDraft} onChange={(event) => onPromptDraftChange(event.target.value)} /></label>
      <button onClick={onSavePrompt}>Save Prompt</button>
      <h3>Schema preview</h3><SchemaViewer schema={selectedSchema} emptyMessage="No schema for this node." />
    </> : <p>Select a node to inspect it.</p>}
  </aside>;
}
