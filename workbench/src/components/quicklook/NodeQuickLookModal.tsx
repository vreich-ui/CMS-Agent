// U5 — the `quicklook` modal: the same glanceable, commit-nothing facts as
// the popover (QuickLookFacts), promoted to a full addressable modal on a
// narrow viewport (see useNodeQuickLook.ts) or reached directly via
// `?modal=quicklook&m.node=…&m.wf=…`. Deep-linkable, but still never a
// task — no footer actions, nothing here writes anything.

import { Modal } from '../overlay/Modal';
import { QuickLookFacts } from './QuickLookFacts';

export function NodeQuickLookModal({ params, onClose }: { params: Record<string, string>; onClose: () => void }) {
  const nodeId = params.node ?? '';
  const workflowId = params.wf || undefined;

  return (
    <Modal open onClose={onClose} title="Node quick look" size="read" sub={nodeId ? <span className="mono">{nodeId}</span> : undefined}>
      {nodeId ? (
        <QuickLookFacts nodeId={nodeId} workflowId={workflowId} />
      ) : (
        <p className="note">No node specified — open this from a rail row or a runs-grid cell.</p>
      )}
    </Modal>
  );
}
