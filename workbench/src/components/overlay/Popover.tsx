// U6 — the glanceable-read layer. A popover never commits anything: it
// shows what is already known about a thing you are pointing at, and it
// goes away the moment you point somewhere else. If a surface needs a
// button that changes state, it is a modal, not this.

import { useEffect, useRef, type ReactNode } from 'react';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Viewport coordinates of the anchor — usually `el.getBoundingClientRect()`. */
  anchor: { top: number; left: number; width: number; height: number } | null;
  children: ReactNode;
  /** Accessible label; the popover is a `dialog` with no modal semantics. */
  label: string;
}

const GAP = 8;
const WIDTH = 320;

export function Popover({ open, onClose, anchor, children, label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !anchor) return null;

  // Flip to the left of the anchor when the right edge would overflow.
  const wantLeft = anchor.left + anchor.width + GAP;
  const overflows = wantLeft + WIDTH > window.innerWidth - 12;
  const left = overflows ? Math.max(12, anchor.left - WIDTH - GAP) : wantLeft;
  const top = Math.min(Math.max(12, anchor.top), Math.max(12, window.innerHeight - 220));

  return (
    <div
      ref={ref}
      className="ovl-pop"
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', top, left, width: WIDTH }}
    >
      {children}
    </div>
  );
}
