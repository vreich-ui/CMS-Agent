// U7 — one shared loading-skeleton treatment for every panel that's
// waiting on a query. Before this pass, panels mixed bare "Loading…" text,
// a couple of ad hoc spinners, and — in a few places — nothing at all
// while a query settled. This is deliberately tiny: a handful of
// shimmering bars (styles/base.css's `.skel`/`.skel-line`, the U7 block),
// no image or extra request, so it's on screen within the ~200ms budget
// (HANDOFF's loading budget) rather than waiting on anything itself.
//
// Usage: drop `<Skeleton lines={n} />` wherever a panel used to render
// "Loading…"/`<LoadingNote>`/`<LoadingCard>` while `query.isLoading` is
// true. Every consumer still owns its OWN error branch and copy — this
// only replaces the loading placeholder, and only when `isError` has
// already been checked and is false (see each screen's own P2-02-style
// "error before loading" branch order).

export function Skeleton({
  lines = 3,
  width,
}: {
  /** Number of shimmering bars to stack. Default 3 reads as "a paragraph's worth" without being a wall. */
  lines?: number;
  /** Optional fixed width (CSS value) for every bar. Left unset, the last of 2+ bars is naturally shorter, mimicking a ragged text block instead of a rigid grid. */
  width?: string;
}) {
  return (
    <div className="skel" aria-hidden="true">
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <div
          key={i}
          className="skel-line"
          style={{ width: width ?? (lines > 1 && i === lines - 1 ? '60%' : '100%') }}
        />
      ))}
    </div>
  );
}
