import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { SkillsPanel } from "../SkillsPanel";
import { Inspector } from "../Inspector";
import { NodeConsole } from "../NodeConsole";
import { ArtifactPanel } from "../ArtifactPanel";
import type { McpClient } from "../../mcp/client";
import type { useWorkspace } from "../../hooks/useWorkspace";
import type { useWorkflowRun } from "../../hooks/useWorkflowRun";
import type { StatusMessage } from "../../status";

// Legacy Nodes tab, embedded under /constellation?legacy=nodes until the S4 node modal replaces
// it. JSX and handlers moved verbatim from App.
type Props = {
  client: McpClient;
  workspace: ReturnType<typeof useWorkspace>;
  workflowRun: ReturnType<typeof useWorkflowRun>;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

export function LegacyNodesPanel({ client, workspace, workflowRun, onStatus, onError }: Props) {
  const createNode = async () => { try { const result = await workspace.createNode(); onStatus({ tone: "success", message: `Created node ${result.node.name}.` }); } catch (error) { onError(error); } };
  const cloneNode = async () => { try { const result = await workspace.cloneNode(); if (result) onStatus({ tone: "success", message: `Cloned node ${result.node.name}.` }); } catch (error) { onError(error); } };
  const deleteNode = async () => { try { await workspace.deleteNode(); onStatus({ tone: "success", message: "Deleted node." }); } catch (error) { onError(error); } };
  const updateNodePatch = async (patch: Parameters<typeof workspace.updateNodePatch>[0], summary: string) => { try { await workspace.updateNodePatch(patch, summary); onStatus({ tone: "success", message: "Saved node configuration." }); } catch (error) { onError(error); } };
  const updateOutputSchema = async (schema: unknown) => { try { await workspace.updateOutputSchema(schema); onStatus({ tone: "success", message: "Saved output schema." }); } catch (error) { onError(error); } };
  const savePrompt = async () => {
    try {
      const result = await workspace.savePrompt();
      if (result) onStatus({ tone: "success", message: `Saved prompt for ${result.node.name}.` });
    } catch (error) {
      onError(error);
    }
  };
  const loadSkills = async () => { try { const skills = await workspace.loadSkills(); onStatus({ tone: "success", message: `Loaded ${skills.length} skills.` }); } catch (error) { onError(error); } };
  const assignSkill = async () => { try { await workspace.assignSkill(); onStatus({ tone: "success", message: "Assigned skill to node." }); } catch (error) { onError(error); } };
  const unassignSkill = async () => { try { await workspace.unassignSkill(); onStatus({ tone: "success", message: "Unassigned skill from node." }); } catch (error) { onError(error); } };
  const resolveSkillPolicy = async () => { try { await workspace.resolveSkillPolicy(); onStatus({ tone: "success", message: "Resolved effective skill policy." }); } catch (error) { onError(error); } };

  return <section className="tab-panel" aria-label="Nodes workspace (legacy)">
    <section className="workspace-grid">
      <SkillsPanel skills={workspace.skills} nodes={workspace.nodes} selectedSkillId={workspace.selectedSkillId} selectedNodeId={workspace.selectedId} resolvedPolicy={workspace.resolvedSkillPolicy} onSelectSkill={workspace.setSelectedSkillId} onSelectNode={workspace.setSelectedId} onRefresh={loadSkills} onAssign={assignSkill} onUnassign={unassignSkill} onResolve={resolveSkillPolicy} />
      <Inspector selectedNode={workspace.selectedNode} promptDraft={workspace.promptDraft} workspaceVersion={workspace.workspaceVersion} selectedSchema={workspace.selectedSchema} onPromptDraftChange={workspace.setPromptDraft} onSavePrompt={savePrompt} onCreateNode={createNode} onCloneNode={cloneNode} onDeleteNode={deleteNode} onUpdateNodePatch={updateNodePatch} onUpdateOutputSchema={updateOutputSchema} />
      <section className="panel"><h2>Selected node form</h2><p className="muted">Preview the selected node schema. Submitting here is visual only.</p>{workspace.selectedSchema ? <Form schema={workspace.selectedSchema} validator={validator} onSubmit={() => onStatus({ tone: "info", message: "Schema form data is visual only and is not saved." })} /> : <p className="empty-state">Select a node with a schema to preview its form.</p>}</section>
    </section>
    <NodeConsole client={client} nodes={workspace.nodes} selectedNodeId={workspace.selectedId} onSelectNode={workspace.setSelectedId} onError={onError} onStatus={(message) => onStatus({ tone: "success", message })} />
    <ArtifactPanel run={workflowRun.currentRun} />
  </section>;
}
