import type { SkillDefinition, SkillResolvedPolicy, WorkspaceNode } from "../types/workspace";

type Props = {
  skills: SkillDefinition[];
  nodes: WorkspaceNode[];
  selectedSkillId: string | null;
  selectedNodeId: string | null;
  resolvedPolicy: SkillResolvedPolicy | null;
  onSelectSkill: (skillId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onRefresh: () => void;
  onAssign: () => void;
  onUnassign: () => void;
  onResolve: () => void;
};

export function SkillsPanel({ skills, nodes, selectedSkillId, selectedNodeId, resolvedPolicy, onSelectSkill, onSelectNode, onRefresh, onAssign, onUnassign, onResolve }: Props) {
  const skill = skills.find((candidate) => candidate.skillId === selectedSkillId) ?? null;
  const node = nodes.find((candidate) => candidate.id === selectedNodeId) ?? null;
  return <section className="panel skills-panel">
    <div className="panel-heading"><div><h2>Skills</h2><p className="muted">Reusable versioned behavior assigned to nodes by id. Skill text is resolved at execution time.</p></div><button onClick={onRefresh}>Load skills</button></div>
    <div className="skills-layout">
      <div><h3>Registry</h3><select aria-label="Select skill" value={selectedSkillId ?? ""} onChange={(event) => onSelectSkill(event.target.value)}><option value="">Select a skill</option>{skills.map((item) => <option key={item.skillId} value={item.skillId}>{item.name} ({item.status})</option>)}</select>{skill ? <div className="skill-card"><strong>{skill.skillId}</strong><p>{skill.description}</p><small>v{skill.version} • risk {skill.riskLevel}</small><pre>{skill.instructions}</pre><details><summary>Schemas and examples</summary><pre>{JSON.stringify({ inputSchema: skill.inputSchema, outputSchema: skill.outputSchema, examples: skill.examples }, null, 2)}</pre></details></div> : <p className="empty-state">Load and select a skill to inspect instructions, schemas, versions, and examples.</p>}</div>
      <div><h3>Assignment</h3><select aria-label="Select node for skill assignment" value={selectedNodeId ?? ""} onChange={(event) => onSelectNode(event.target.value)}><option value="">Select a node</option>{nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><div className="auth-actions"><button onClick={onAssign} disabled={!skill || !node}>Assign</button><button onClick={onUnassign} disabled={!skill || !node}>Unassign</button><button onClick={onResolve} disabled={!node}>Resolve policy</button></div><p className="muted">Assigned skills: {(node?.assignedSkills ?? []).join(", ") || "none"}</p>{resolvedPolicy && <div><h3>Resolved instructions/tools/conflicts</h3><p><strong>Effective tools:</strong> {resolvedPolicy.effectiveTools.join(", ") || "none"}</p><p><strong>Denied tools:</strong> {resolvedPolicy.deniedTools.join(", ") || "none"}</p>{resolvedPolicy.conflicts.length ? <ul>{resolvedPolicy.conflicts.map((conflict, index) => <li key={`${conflict.source}-${index}`}><strong>{conflict.severity}</strong> {conflict.source}: {conflict.message}</li>)}</ul> : <p>No conflicts.</p>}<pre>{resolvedPolicy.instructions}</pre></div>}</div>
    </div>
  </section>;
}
