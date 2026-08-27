// U6 — the single mount point for every addressable modal.
//
// One place decides which overlay is on screen, so: exactly one can be open
// at a time; each is reachable by URL; and a new one is added by writing a
// component and adding a line here, not by threading another boolean
// through five screens. The URL sync runs here too, so the address bar and
// the store can never drift apart.

import { useStore } from '../../store';
import { useOverlayUrl } from '../../overlay/useOverlayUrl';
import { DiffStudio } from '../diff/DiffStudio';
import { OverrideOutputModal } from '../drive/OverrideOutputModal';
import { TraceWaterfallModal } from '../trace/TraceWaterfallModal';
import { NodeQuickLookModal } from '../quicklook/NodeQuickLookModal';

export function OverlayHost() {
  useOverlayUrl();
  const overlay = useStore((s) => s.overlay);
  const closeModal = useStore((s) => s.closeModal);

  if (!overlay) return null;

  switch (overlay.kind) {
    case 'diff':
      return <DiffStudio params={overlay.params} onClose={closeModal} />;
    case 'override':
      return <OverrideOutputModal params={overlay.params} onClose={closeModal} />;
    case 'waterfall':
      return <TraceWaterfallModal params={overlay.params} onClose={closeModal} />;
    case 'quicklook':
      return <NodeQuickLookModal params={overlay.params} onClose={closeModal} />;
  }
}
