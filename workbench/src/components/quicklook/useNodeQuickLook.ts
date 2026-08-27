// U5 — the popover/modal split: hovering (mouse) or long-pressing (touch) a
// rail row or a runs-grid cell opens a glanceable, commit-nothing read.
// Below `NARROW_BREAKPOINT` there is no room for a floating popover to sit
// next to its anchor without covering the thing it's describing, so the
// same content is promoted to the addressable `quicklook` modal instead —
// still a read, just full-width. This hook owns exactly that decision plus
// the hover-delay/long-press timing; the two trigger components
// (NodeQuickLookPopover for the rail, and the runs grid's own cell) both
// use it so the delay/promotion rule only lives in one place.

import { useCallback, useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react';
import { useStore } from '../../store';

export const NARROW_BREAKPOINT = 760;
const HOVER_DELAY_MS = 320;
const LONGPRESS_MS = 450;

export interface QuickLookAnchor {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function useNodeQuickLook(nodeId: string | null | undefined, workflowId?: string) {
  const openModal = useStore((s) => s.openModal);
  const [anchor, setAnchor] = useState<QuickLookAnchor | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const pressTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const openAt = useCallback(
    (rect: DOMRect) => {
      if (!nodeId) return;
      if (window.innerWidth < NARROW_BREAKPOINT) {
        openModal('quicklook', workflowId ? { node: nodeId, wf: workflowId } : { node: nodeId });
        return;
      }
      setAnchor({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    },
    [nodeId, openModal, workflowId],
  );

  const onMouseEnter = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      clearTimers();
      hoverTimer.current = window.setTimeout(() => openAt(rect), HOVER_DELAY_MS);
    },
    [clearTimers, openAt],
  );

  const onMouseLeave = useCallback(() => {
    clearTimers();
    setAnchor(null);
  }, [clearTimers]);

  const onTouchStart = useCallback(
    (e: TouchEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      clearTimers();
      pressTimer.current = window.setTimeout(() => openAt(rect), LONGPRESS_MS);
    },
    [clearTimers, openAt],
  );

  const onTouchEnd = useCallback(() => clearTimers(), [clearTimers]);

  return {
    anchor,
    close: () => setAnchor(null),
    triggerProps: {
      onMouseEnter,
      onMouseLeave,
      onTouchStart,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
    },
  };
}
