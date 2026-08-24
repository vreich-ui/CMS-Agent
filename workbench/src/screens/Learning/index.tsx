// Learning screen (WP-51/52/53) — the improvement flywheel: visibility
// above, capture below. Mirrors spec/mockup.html's `<section id="s-learning">`
// and renderLearning()'s seven S.lrn tabs exactly. Every tab is its own file
// here; this shell just owns the subtab bar and routing (store's `lrn`).

import { TabBar } from '../../components/primitives';
import { useStore } from '../../store';
import type { LearnTab } from '../../types';
import { Flywheel } from './Flywheel';
import { Observations } from './Observations';
import { Playbooks } from './Playbooks';
import { Compare } from './Compare';
import { Evaluate } from './Evaluate';
import { Optimizer } from './Optimizer';
import { Datasets } from './Datasets';

const SUBTABS: Array<[LearnTab, string]> = [
  ['fly', 'Flywheel'],
  ['obs', 'Observations'],
  ['pb', 'Playbooks'],
  ['cmp', 'Compare'],
  ['eval', 'Evaluate'],
  ['opt', 'Optimizer'],
  ['ds', 'Datasets'],
];

export function Learning() {
  const lrn = useStore((s) => s.lrn);
  const setLearn = useStore((s) => s.setLearn);

  return (
    <main className="pagewrap">
      <div className="pagehead">
        <h1>Learning</h1>
        <span className="sub">the improvement flywheel — visibility above, capture below</span>
      </div>
      <TabBar
        id="lrntabs"
        className="subtabs"
        idPrefix="lrn-tab"
        active={lrn}
        onSelect={setLearn}
        tabs={SUBTABS.map(([id, label]) => ({ id, label }))}
      />
      <div id="lrnbody">
        {lrn === 'fly' && <Flywheel />}
        {lrn === 'obs' && <Observations />}
        {lrn === 'pb' && <Playbooks />}
        {lrn === 'cmp' && <Compare />}
        {lrn === 'eval' && <Evaluate />}
        {lrn === 'opt' && <Optimizer />}
        {lrn === 'ds' && <Datasets />}
      </div>
    </main>
  );
}
