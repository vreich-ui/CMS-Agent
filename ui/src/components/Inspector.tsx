import { useEffect, useState } from "react";
import type { RJSFSchema } from "@rjsf/utils";
import type { WorkspaceNode } from "../types/workspace";
import { SchemaViewer } from "./SchemaViewer";

const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);
const parseJson = (value: string) => JSON.parse(value) as unknown;

type InspectorProps = {
  selectedNode: WorkspaceNode | null;
  promptDraft: string;
  workspaceVersion?: number;
  selectedSchema?: RJSFSchema;
  onPromptDraftChange: (prompt: string) => void;
  onSavePrompt: () => void;
  onCreateNode?: () => void;
  onCloneNode?: () => void;
  onDeleteNode?: () => void;
  onUpdateNodePatch?: (patch: Partial<WorkspaceNode>, summary: string) => void;
  onUpdateOutputSchema?: (schema: unknown) => void;
};

export function Inspector({ selectedNode, promptDraft, workspaceVersion, selectedSchema, onPromptDraftChange, onSavePrompt, onCreateNode, onCloneNode, onDeleteNode, onUpdateNodePatch, onUpdateOutputSchema }: InspectorProps) {
  const [dependencies, setDependencies] = useState("");
  const [inputSchema, setInputSchema] = useState("{}");
  const [outputSchema, setOutputSchema] = useState("{}");
  const [metadata, setMetadata] = useState("{}");
  const [modelConfig, setModelConfig] = useState("{}");
  const [tools, setTools] = useState("");
  const [skills, setSkills] = useState("");

  useEffect(() => {
    if (!selectedNode) return;
    setDependencies((selectedNode.dependsOn ?? []).join("\n"));
    setInputSchema(pretty(selectedNode.inputSchema));
    setOutputSchema(pretty(selectedNode.outputSchema ?? selectedNode.schema));
    setMetadata(pretty(selectedNode.metadata));
    setModelConfig(pretty(selectedNode.modelConfig));
    setTools((selectedNode.allowedTools ?? []).join("\n"));
    setSkills((selectedNode.assignedSkills ?? []).join("\n"));
  }, [selectedNode]);

  const lines = (value: string) => value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);

  return <aside className="panel inspector">
    <div className="panel-heading"><h2>Node details</h2><div className="auth-actions"><button onClick={onCreateNode}>Create</button><button disabled={!selectedNode} onClick={onCloneNode}>Clone</button><button disabled={!selectedNode} onClick={onDeleteNode}>Delete</button></div></div>
    {selectedNode ? <>
      <dl><dt>ID</dt><dd>{selectedNode.id}</dd><dt>Name</dt><dd>{selectedNode.name}</dd><dt>Workspace version</dt><dd>{workspaceVersion ?? "Not returned yet"}</dd></dl>
      <label>Node prompt<textarea rows={8} value={promptDraft} onChange={(event) => onPromptDraftChange(event.target.value)} /></label>
      <button onClick={onSavePrompt}>Save Prompt</button>
      <label>Dependencies<textarea rows={3} value={dependencies} onChange={(event) => setDependencies(event.target.value)} /></label><button onClick={() => onUpdateNodePatch?.({ dependsOn: lines(dependencies) }, "UI dependencies update")}>Save dependencies</button>
      <label>Allowed tools<textarea rows={3} value={tools} onChange={(event) => setTools(event.target.value)} /></label><button onClick={() => onUpdateNodePatch?.({ allowedTools: lines(tools) }, "UI tools update")}>Assign tools</button>
      <label>Assigned skills placeholder<textarea rows={3} value={skills} onChange={(event) => setSkills(event.target.value)} /></label><button onClick={() => onUpdateNodePatch?.({ assignedSkills: lines(skills) }, "UI skills update")}>Assign skills</button>
      <label>Input schema<textarea rows={6} value={inputSchema} onChange={(event) => setInputSchema(event.target.value)} /></label><button onClick={() => onUpdateNodePatch?.({ inputSchema: parseJson(inputSchema) }, "UI input schema update")}>Save input schema</button>
      <label>Output schema<textarea rows={6} value={outputSchema} onChange={(event) => setOutputSchema(event.target.value)} /></label><button onClick={() => onUpdateOutputSchema?.(parseJson(outputSchema))}>Save output schema</button>
      <label>Metadata<textarea rows={5} value={metadata} onChange={(event) => setMetadata(event.target.value)} /></label><button onClick={() => onUpdateNodePatch?.({ metadata: parseJson(metadata) as Record<string, unknown> }, "UI metadata update")}>Save metadata</button>
      <label>Model config<textarea rows={5} value={modelConfig} onChange={(event) => setModelConfig(event.target.value)} /></label><button onClick={() => onUpdateNodePatch?.({ modelConfig: parseJson(modelConfig) as Record<string, unknown> }, "UI model config update")}>Save model config</button>
      <h3>Schema preview</h3><SchemaViewer schema={selectedSchema} emptyMessage="No schema is attached to this node." />
    </> : <p className="empty-state">Select a node from the Builder map to review its prompt and schema.</p>}
  </aside>;
}
