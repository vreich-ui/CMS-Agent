// The mockup's hidden <svg> defs block, verbatim (spec/mockup.html lines 283-290).
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <g id="ic-pub">
          <path d="M13.5 2.5c-4 0-8 3-9.5 8l-1.5 3 3-1.5c5-1.5 8-5.5 8-9.5z" />
          <path d="M4.5 11.5l5-5" />
        </g>
        <g id="ic-clone">
          <rect x="2.5" y="2.5" width="8" height="8" rx="1.2" />
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
        </g>
        <g id="ic-capture">
          <path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11" />
          <circle cx="8" cy="8" r="2.4" />
        </g>
        <g id="ic-charity">
          <path d="M8 13.2C4.2 10.4 2.7 8.5 2.7 6.4 2.7 4.7 4 3.4 5.7 3.4c1 0 1.8.5 2.3 1.2.5-.7 1.3-1.2 2.3-1.2 1.7 0 3 1.3 3 3 0 2.1-1.5 4-5.3 6.8z" />
        </g>
      </defs>
    </svg>
  );
}

export function Ic({ id }: { id: string }) {
  return (
    <svg className="ic" aria-hidden="true">
      <use href={`#${id}`} />
    </svg>
  );
}
