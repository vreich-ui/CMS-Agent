// WP-11/WP-12 — the workbench screen: node rail, mode bar, center
// inspector/editor (read-only tabs), and the read-only run dock. Markup
// mirrors spec/mockup.html's `<div class="bench">` (inside `#s-bench`,
// ~line 310) — App.tsx already renders only the active screen, so no
// `<section class="screen">` wrapper is needed here.

import { Center } from './Center';
import { Dock } from './Dock';
import { Rail } from './Rail';

export function Workbench() {
  return (
    <div className="bench">
      {/* a11y M4 — unlike Library/Runs/Learning/Registry, this screen had
          no static page-level heading; Center.tsx's <h2>{node.name}</h2>
          is the only one and it changes per selected node. */}
      <h1 className="sr-only">Workbench</h1>
      <Rail />
      <Center />
      <Dock />
    </div>
  );
}
