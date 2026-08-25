export function Placeholder({ name, wp }: { name: string; wp?: string }) {
  return (
    <div className="pagewrap">
      <div className="pagehead">
        <h1>{name}</h1>
        <span className="sub">not wired yet — this screen ships in a later work package</span>
      </div>
      <div className="card">
        <span className="lbl">status</span>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          {wp ? `Filled by ${wp}.` : 'Filled by a later work package.'}
        </p>
      </div>
    </div>
  );
}
