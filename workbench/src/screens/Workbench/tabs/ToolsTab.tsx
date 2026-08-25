// Tools tab — WP-32. Allowed tools for the node, resolved against the live
// 42-tool registry, add/remove wired to workspace_update_node_tools. The
// registry picker shows risk badge + side-effect for every candidate tool
// inline, in the very row its "add" button lives in — so an operator
// granting a write/publish-risk or externally-acting tool sees that at the
// moment of granting, not after the confirm dialog has already come and gone.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTools } from '../../../api/hooks';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { workspaceUpdateNodeTools } from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card, RiskBadge } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import type { ToolDef, WorkflowNode } from '../../../types';
import { ErrorNote, LoadingNote, READONLY_REASON, RegistryPicker, recordChange } from './Shared';

/** Tools whose grant genuinely deserves a second look — not just read access. */
function isElevated(tool: ToolDef): boolean {
  return tool.risk !== 'read' || tool.sideEffect === 'external_write' || tool.sideEffect === 'external_read';
}

export function ToolsTab({ node }: { node: WorkflowNode }) {
  const nodeId = node.id;
  const toolsQ = useTools();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function commit(nextTools: string[], triggerEl: HTMLElement | null, label: string) {
    if (busy) return;
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      const before = node.tools;
      await workspaceUpdateNodeTools({ nodeId, tools: nextTools });
      recordChange({ nodeId, kind: 'tools', label, before, after: nextTools });
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      toast('Tools updated', `workspace_update_node_tools → ${nextTools.length} tool${nextTools.length === 1 ? '' : 's'} allowed`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Update failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function handleRemove(e: React.MouseEvent<HTMLButtonElement>, toolId: string) {
    commit(node.tools.filter((t) => t !== toolId), e.currentTarget, `removed tool ${toolId}`);
  }

  function handleAdd(tool: ToolDef, triggerEl: HTMLElement | null) {
    setPickerOpen(false);
    commit([...node.tools, tool.id], triggerEl, `added tool ${tool.id} (${tool.risk}/${tool.sideEffect})`);
  }

  const candidates = (toolsQ.data ?? []).filter((t) => !node.tools.includes(t.id));

  return (
    <Card
      label={
        <>
          allowed tools <span className="pin live">live</span> · {node.tools.length} of {toolsQ.data?.length ?? '…'} in the registry
        </>
      }
    >
      {toolsQ.isLoading ? (
        <LoadingNote>Loading tool registry…</LoadingNote>
      ) : toolsQ.isError ? (
        <ErrorNote message={toolsQ.error?.message} />
      ) : node.tools.length === 0 ? (
        <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>No tools assigned to this node.</p>
      ) : (
        node.tools.map((t) => {
          const reg = toolsQ.data?.find((x) => x.id === t);
          const risk = reg?.risk ?? 'read';
          return (
            <div className="toolrow" key={t}>
              <span className="tn">{t}</span>
              <span className="td">
                {reg?.desc ?? 'Not found in the tool registry.'}
                {reg && reg.sideEffect !== 'none' && (
                  <span className="mono" style={{ color: 'var(--faint)', marginLeft: 8 }}>
                    {reg.sideEffect}
                  </span>
                )}
                {risk !== 'read' && (
                  <strong style={{ color: 'var(--acc)', marginLeft: 8 }}>· needs approval</strong>
                )}
              </span>
              <RiskBadge risk={risk} />
              <Btn
                variant="danger"
                style={{ padding: '2px 9px', fontSize: 11 }}
                disabled={busy || IS_READ_ONLY}
                title={IS_READ_ONLY ? READONLY_REASON : undefined}
                onClick={(e) => handleRemove(e, t)}
              >
                remove
              </Btn>
            </div>
          );
        })
      )}
      <div className="editnote">
        <Btn
          disabled={busy || IS_READ_ONLY || toolsQ.isLoading}
          title={IS_READ_ONLY ? READONLY_REASON : undefined}
          onClick={() => setPickerOpen(true)}
        >
          + add from registry
        </Btn>
      </div>

      <RegistryPicker<ToolDef>
        open={pickerOpen}
        title="Add a tool from the registry"
        hint="Risk and side-effect are shown on every row — review them before you add, not after."
        items={candidates}
        getId={(t) => t.id}
        emptyText="No more tools to add — every registered tool is already allowed here."
        onAdd={handleAdd}
        onClose={() => setPickerOpen(false)}
        renderMeta={(t) => (
          <>
            <span className="tn">{t.id}</span>
            <span className="td">
              {t.desc}
              {t.sideEffect !== 'none' && (
                <span className="mono" style={{ color: 'var(--faint)', marginLeft: 8 }}>
                  {t.sideEffect}
                </span>
              )}
              {isElevated(t) && (
                <strong style={{ color: 'var(--acc)', marginLeft: 8 }}>
                  · {t.risk !== 'read' ? 'needs approval' : 'reaches outside the workspace'}
                </strong>
              )}
            </span>
            <RiskBadge risk={t.risk} />
          </>
        )}
      />
    </Card>
  );
}
