// Local loading/error helpers for the Registry screen. Mirrors the pattern in
// screens/Workbench/tabs/Shared.tsx (HANDOFF §7.10: every network-backed
// panel needs both a loading and an error state, and errors show the
// backend's own message) without importing across an owned-screen boundary —
// we own screens/Registry/** only.

import type { ReactNode } from 'react';
import { Skeleton } from '../../components/Skeleton';

/** U7 — the shared skeleton (components/Skeleton.tsx), same treatment as
 * every other panel's loading state, plus this call site's own text. */
export function LoadingCard({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div className="projcard">
      <Skeleton lines={2} />
      <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>{children}</p>
    </div>
  );
}

export function ErrorCard({ message }: { message?: string }) {
  return (
    <div className="projcard">
      <p style={{ margin: 0, color: 'var(--bad)' }}>{message ?? 'Failed to load.'}</p>
    </div>
  );
}
