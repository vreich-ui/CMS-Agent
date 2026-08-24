// Section 4 — Skills library. spec/mockup.html renderReg() 'skills' branch
// (~line 996); `.toolrow` copied verbatim. Real finding (api/fixtures/
// README.md): 5 of the 12 registered skills — article_body_builder,
// artifact_handling, editorial_review, publication_readiness,
// learning_observation — are assigned to zero nodes live. That's exactly
// what this screen exists to reveal, so it's shown plainly, not hidden.
// "versions" is Phase 3 (skill_list_versions / skill_restore_version) —
// rendered disabled with a title, never a silent toast no-op.

import { useSkills } from '../../api/hooks';
import { Btn, Chip } from '../../components/primitives';
import { errMessage } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

export function SkillsTab() {
  const skillsQ = useSkills();

  if (skillsQ.isLoading) return <LoadingCard>Loading skills library…</LoadingCard>;
  if (skillsQ.isError) {
    return <ErrorCard message={errMessage(skillsQ.error, 'Failed to load skills.')} />;
  }

  const skills = skillsQ.data ?? [];
  const unused = skills.filter((s) => s.assignedTo.length === 0).length;

  return (
    <div className="projcard">
      <div className="top">
        <h3>Skills library</h3>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>
          {skills.length} registered{unused > 0 ? ` · ${unused} unused` : ''}
        </span>
      </div>
      {skills.map((s) => (
        <div className="toolrow" key={s.id}>
          <span className="tn">{s.id}</span>
          <span className="td">
            v{s.version} ·{' '}
            {s.assignedTo.length > 0 ? `assigned to ${s.assignedTo.join(', ')}` : 'assigned to nobody'}
          </span>
          {s.assignedTo.length === 0 && <Chip>unused</Chip>}
          <Btn style={{ padding: '2px 9px', fontSize: 11 }} disabled title="Phase 3">
            versions
          </Btn>
        </div>
      ))}
    </div>
  );
}
