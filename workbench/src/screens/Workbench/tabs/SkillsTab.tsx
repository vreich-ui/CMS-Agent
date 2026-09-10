// Skills tab — WP-32. Assigned skills for the node, assign/unassign wired to
// workspace_update_node_skills, plus the effective-resolution view
// (skill_resolve_for_node) showing what actually applies at run time. The
// registry picker surfaces the 5 skills assigned to zero live nodes
// (article_body_builder, artifact_handling, editorial_review,
// publication_readiness, learning_observation — fixtures/README.md) up
// front, sorted ahead of already-used skills, rather than burying them in a
// flat alphabetical list an operator has to already know to look for.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSkills } from '../../../api/hooks';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import {
  workspacePrepareNodeEdit,
  workspaceSaveSkillsWithReadback,
  WorkspaceEditConflictError,
} from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card, Chip } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { useStore } from '../../../store';
import type { Skill, WorkflowNode } from '../../../types';
import { useEffectiveSkills } from '../queries';
import { Disclosure, ErrorNote, LoadingNote, READONLY_REASON, RegistryPicker, recordChange } from './Shared';

export function SkillsTab({ node, nodeId }: { node: WorkflowNode; nodeId: string }) {
  const skillsQ = useSkills();
  const effectiveQ = useEffectiveSkills(nodeId);
  const setScreen = useStore((s) => s.setScreen);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [readbackUncertain, setReadbackUncertain] = useState(false);

  async function commit(nextSkills: string[], triggerEl: HTMLElement | null, label: string) {
    if (busy) return;
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      const before = node.skills;
      const prepared = await workspacePrepareNodeEdit(nodeId);
      const result = await workspaceSaveSkillsWithReadback({ nodeId, skills: nextSkills, prepared });
      if (result.state !== 'confirmed') {
        setReadbackUncertain(true);
        await qc.invalidateQueries({ queryKey: ['node', nodeId] });
        toast('Skill save needs verification', result.message);
        return;
      }
      setReadbackUncertain(false);
      recordChange({ nodeId, kind: 'skills', label, before, after: nextSkills });
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      await qc.invalidateQueries({ queryKey: ['effectiveSkills', nodeId] });
      toast('Skills updated and verified', `workspace_update_node_skills → ${nextSkills.length} skill${nextSkills.length === 1 ? '' : 's'} confirmed by readback`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      if (err instanceof WorkspaceEditConflictError) {
        setReadbackUncertain(true);
        await qc.invalidateQueries({ queryKey: ['node', nodeId] });
        toast('Skill save conflict', `${err.message} Reloaded state is required before retrying.`);
        return;
      }
      toast('Update failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function handleUnassign(e: React.MouseEvent<HTMLButtonElement>, skillId: string) {
    commit(node.skills.filter((s) => s !== skillId), e.currentTarget, `unassigned ${skillId}`);
  }

  function handleAssign(skill: Skill, triggerEl: HTMLElement | null) {
    setPickerOpen(false);
    commit([...node.skills, skill.id], triggerEl, `assigned ${skill.id}`);
  }

  const candidates = (skillsQ.data ?? [])
    .filter((s) => !node.skills.includes(s.id))
    .sort((a, b) => {
      const unusedA = a.assignedTo.length === 0 ? 0 : 1;
      const unusedB = b.assignedTo.length === 0 ? 0 : 1;
      if (unusedA !== unusedB) return unusedA - unusedB;
      return a.id.localeCompare(b.id);
    });

  return (
    <Card
      label={
        <>
          assigned skills <span className={`pin ${readbackUncertain ? '' : 'live'}`}>{readbackUncertain ? 'readback uncertain' : 'live'}</span>
        </>
      }
    >
      {node.skills.length === 0 ? (
        <p style={{ color: 'var(--faint)', margin: 0 }}>none assigned</p>
      ) : (
        node.skills.map((s) => {
          const reg = skillsQ.data?.find((x) => x.id === s);
          return (
            <div className="toolrow" key={s}>
              <span className="tn">{s}</span>
              <span className="td">{reg ? `v${reg.version} · assigned to ${reg.assignedTo.length} node${reg.assignedTo.length === 1 ? '' : 's'}` : 'assigned'}</span>
              <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setScreen('registry')}>
                open
              </Btn>
              <Btn
                variant="danger"
                style={{ padding: '2px 9px', fontSize: 11 }}
                disabled={busy || IS_READ_ONLY}
                title={IS_READ_ONLY ? READONLY_REASON : undefined}
                onClick={(e) => handleUnassign(e, s)}
              >
                unassign
              </Btn>
            </div>
          );
        })
      )}
      <div className="editnote">
        <Btn
          disabled={busy || IS_READ_ONLY || skillsQ.isLoading}
          title={IS_READ_ONLY ? READONLY_REASON : undefined}
          onClick={() => setPickerOpen(true)}
        >
          + assign from registry
        </Btn>
        <Disclosure openLabel="view effective resolution" closeLabel="hide effective resolution">
          {effectiveQ.isLoading ? (
            <LoadingNote>resolving effective skill policy…</LoadingNote>
          ) : effectiveQ.isError ? (
            <ErrorNote message={effectiveQ.error?.message} />
          ) : effectiveQ.data && effectiveQ.data.skillIds.length > 0 ? (
            <div className="schemabox" style={{ whiteSpace: 'normal' }}>
              {effectiveQ.data.skillIds.join('\n')}
            </div>
          ) : (
            <p style={{ color: 'var(--faint)', fontSize: 12, margin: 0 }}>
              No skills resolve at run time for this node.
            </p>
          )}
          {effectiveQ.data?.conflicts.map((conflict, index) => (
            <p key={index} style={{ color: 'var(--bad)', fontSize: 12, margin: '6px 0 0' }}>
              {conflict.message ?? 'Effective skill policy reported a conflict.'}
            </p>
          ))}
        </Disclosure>
      </div>
      {readbackUncertain && (
        <p style={{ color: 'var(--bad)', fontSize: 12.5, margin: '10px 0 0' }}>
          The last skill save was accepted but is not verified by committed readback. Reload before changing assignments again.
        </p>
      )}

      <RegistryPicker<Skill>
          open={pickerOpen}
          title="Assign a skill from the registry"
          hint="Skills used by zero live nodes are listed first — easy to lose track of otherwise."
          items={candidates}
          getId={(s) => s.id}
          emptyText="Every registered skill is already assigned to this node."
          onAdd={handleAssign}
          onClose={() => setPickerOpen(false)}
          renderMeta={(s) => (
            <>
              <span className="tn">{s.id}</span>
              <span className="td">
                v{s.version} ·{' '}
                {s.assignedTo.length === 0 ? 'assigned to no live nodes' : `used by ${s.assignedTo.join(', ')}`}
              </span>
              {s.assignedTo.length === 0 && <Chip>unused</Chip>}
            </>
          )}
        />
    </Card>
  );
}
