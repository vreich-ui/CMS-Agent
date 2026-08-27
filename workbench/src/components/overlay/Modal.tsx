// U6 — the one modal primitive. Every focused task with its own commit
// renders through this: the diff & merge studio, override output, the trace
// waterfall. It owns the behaviour that was previously re-implemented (and
// re-forgotten) per overlay:
//
//   - Escape closes, always, and never loses typed work — the owner hands
//     us a `draft` and we hold it (see overlay/drafts.ts).
//   - Focus is trapped while open and returned to the trigger on close.
//   - The rest of the page goes `inert`, so a screen-reader user in browse
//     mode can't wander into the covered background (same rule App.tsx
//     already applies to the older overlays).
//   - Size is a layout decision, not a style: `read` caps at measure
//     because prose past ~75 characters a line is harder to read;
//     `work` and `full` take the viewport, because a side-by-side diff or a
//     schema editor needs every pixel. This is the rule that fixes the
//     "workbench center is width-capped while the diff needs the room"
//     complaint — the cap lives on reading panes and stops at the modal
//     boundary.

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';

export type ModalSize = 'read' | 'work' | 'full';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Sub-line under the title. Keep it to one sentence. */
  sub?: ReactNode;
  size?: ModalSize;
  /** Rendered right-aligned in the footer. The commit lives here. */
  actions?: ReactNode;
  /** Rendered left-aligned in the footer — status, counts, a warning. */
  footNote?: ReactNode;
  children: ReactNode;
  /** Extra class on the modal box. */
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, sub, size = 'work', actions, footNote, children, className }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Remember what had focus before we opened, so we can give it back.
  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    const first = boxRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? boxRef.current)?.focus();
    return () => {
      returnFocusTo.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="scrim open ovl-scrim"
      onMouseDown={(e) => {
        // Only a click that both starts and ends on the scrim dismisses —
        // otherwise a text selection dragged out of the modal closes it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        className={['modal', `ovl-${size}`, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ovl-head">
          <div>
            <h3 id={titleId}>{title}</h3>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            esc
          </button>
        </div>

        <div className="ovl-body">{children}</div>

        {(actions || footNote) && (
          <div className="foot ovl-foot">
            <span className="note" style={{ margin: 0 }}>
              {footNote}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>{actions}</span>
          </div>
        )}
      </div>
    </div>
  );
}
