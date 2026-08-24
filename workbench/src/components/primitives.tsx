import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

// Thin, dumb wrappers over the existing CSS class vocabulary (styles/base.css).
// No new CSS is introduced here — every visual comes from a class or a
// var(--token) inline style, exactly as the mockup does.

export function Dot({ status }: { status?: string | null }) {
  // a11y M1 — used bare (no adjacent status word) in the rail, Dock's
  // recent-runs list, and TopBar's run chip; status was color-only there.
  // StatusChip already pairs the same dot with visible text, so this is
  // redundant (harmless) wherever it's used through StatusChip instead.
  return <span className={`dot ${status ?? ''}`} title={status ?? undefined} />;
}

export function Chip({
  status,
  children,
}: {
  status?: string | null;
  children?: ReactNode;
}) {
  return <span className={`chip ${status ?? ''}`}>{children}</span>;
}

export function StatusChip({ status }: { status: string }) {
  return (
    <Chip status={status}>
      <Dot status={status} />
      {status}
    </Chip>
  );
}

export function RiskBadge({ risk }: { risk: string }) {
  return <span className={`risk ${risk}`}>{risk}</span>;
}

export function Lbl({ children }: { children: ReactNode }) {
  return <span className="lbl">{children}</span>;
}

export function Card({
  label,
  children,
  style,
}: {
  label?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      {label !== undefined && <span className="lbl">{label}</span>}
      {children}
    </div>
  );
}

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'pri' | 'danger';
}

export function Btn({ variant, className, ...rest }: BtnProps) {
  const cls = ['btn', variant, className].filter(Boolean).join(' ');
  return <button className={cls} {...rest} />;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="note">{children}</p>;
}

export function KV({ children }: { children: ReactNode }) {
  return <div className="kv">{children}</div>;
}

export function Meter({ pct }: { pct: number }) {
  return (
    <div className="meter">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function Prog({ pct }: { pct: number }) {
  return (
    <div className="prog">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/**
 * a11y S6 — every tab-like button row in the app (Center's inspector,
 * Learning's/Runs' subtabs, Registry's sections) was a plain `<button>`
 * group with only a CSS `.on` class marking the active one: no
 * `aria-selected`, no confirmation a screen reader can pick up when the
 * panel underneath changes. One shared primitive over the existing
 * `.tabs`/`.subtabs` CSS (no new classes) fixes every one of them at once.
 * Real tab-panel-swap usages only — see NavBar below for the click-through
 * navigation rows (TopBar, Registry's section nav) that read as navigation,
 * not tabs, and get `aria-current` instead.
 */
export function TabBar<T extends string>({
  id,
  className = 'tabs',
  tabs,
  active,
  onSelect,
  idPrefix,
}: {
  id?: string;
  className?: string;
  tabs: Array<{ id: T; label: ReactNode }>;
  active: T;
  onSelect: (id: T) => void;
  idPrefix: string;
}) {
  return (
    <div id={id} className={className} role="tablist">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          id={`${idPrefix}-${id}`}
          data-t={id}
          role="tab"
          aria-selected={active === id}
          className={active === id ? 'on' : ''}
          onClick={() => onSelect(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
