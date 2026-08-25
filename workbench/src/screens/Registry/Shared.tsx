// Local loading/error helpers for the Registry screen. Mirrors the pattern in
// screens/Workbench/tabs/Shared.tsx (HANDOFF §7.10: every network-backed
// panel needs both a loading and an error state, and errors show the
// backend's own message) without importing across an owned-screen boundary —
// we own screens/Registry/** only.

import type { ReactNode } from 'react';

export function LoadingCard({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div className="projcard">
      <p style={{ margin: 0, color: 'var(--muted)' }}>{children}</p>
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
