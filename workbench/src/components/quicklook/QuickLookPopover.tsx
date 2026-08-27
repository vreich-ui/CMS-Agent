// U5 — pairs useNodeQuickLook's anchor state with the shared Popover
// primitive and QuickLookFacts content. One line to drop into any hover/
// long-press trigger (Rail row, runs-grid cell) — see useNodeQuickLook.ts's
// doc comment for the popover/modal split this depends on.

import { Popover } from '../overlay/Popover';
import { QuickLookFacts } from './QuickLookFacts';
import type { QuickLookAnchor } from './useNodeQuickLook';

export function QuickLookPopover({
  nodeId,
  workflowId,
  anchor,
  onClose,
}: {
  nodeId: string;
  workflowId?: string;
  anchor: QuickLookAnchor | null;
  onClose: () => void;
}) {
  return (
    <Popover open={Boolean(anchor)} onClose={onClose} anchor={anchor} label={`Quick look — ${nodeId}`}>
      <span className="lbl">quick look</span>
      <QuickLookFacts nodeId={nodeId} workflowId={workflowId} />
    </Popover>
  );
}
