// WP-22 — the start-run modal, as a real component. Markup mirrors
// spec/mockup.html's `#startmodal` (~line 395) and openStart()/
// startRunFromModal() (~line 1014); `.scrim .modal .field .seg .valnote`
// are all pre-existing CSS (styles/base.css) — no new CSS. Opened from the
// dock's build-mode "▸ Start run…" and the Library card's "Start run"
// (store.startModalOpen — see store.ts's doc comment); later ⌘K is Phase 4.
//
// The workflow/project/execution/dry-live/budget/brief fields, the inline
// project connection health, and the node_validate_input gate on Start are
// all WP-22's stated done-criteria. The dry vs live choice gets the extra
// treatment HANDOFF calls out explicitly: "the most consequential button in
// this application" — dry is the default, live requires a deliberate click,
// and Start itself renders as `.btn.danger` + relabels once live is chosen.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProjects, useStartDryRun, useWorkflows } from '../api/hooks';
import { ActionCancelledError } from '../api/confirmAction';
import { IS_READ_ONLY } from '../api/client';
import { setNextConfirmTrigger } from './ConfirmDialog';
import { nodeGetInputSchema, nodeValidateInput } from '../api/verbs';
import type * as verbs from '../api/verbs';
import { useStore } from '../store';
import type { Project, Workflow } from '../types';
import { toast } from './Toasts';
import { Btn } from './primitives';

const DEFAULT_BRIEF = 'Draft a DTC science explainer on retinol alternatives for sensitive skin.';
const VALIDATE_DEBOUNCE_MS = 350;

function genRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function entryNodeId(wf: Workflow | undefined): string | undefined {
  return wf?.phases[0]?.[1]?.[0];
}

type ValidationState =
  | { status: 'checking' }
  // W7 — the Workbench has no phase config for this workflow, so it cannot name an entry node to
  // validate the brief against. Startable, with the gap stated.
  | { status: 'unvalidated' }
  | { status: 'valid' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'error'; message: string };

export function StartRunModal() {
  const open = useStore((s) => s.startModalOpen);
  const close = useStore((s) => s.closeStartModal);
  const bindRun = useStore((s) => s.bindRun);

  const workflowsQ = useWorkflows();
  const projectsQ = useProjects();
  const startMut = useStartDryRun();

  const workflows = workflowsQ.data ?? [];
  const projects = (projectsQ.data ?? []).filter((p) => !p.disabled);

  const [wfId, setWfId] = useState('');
  const [projId, setProjId] = useState<string>('');
  const [execMode, setExecMode] = useState<'mock' | 'openai'>('mock');
  const [dry, setDry] = useState(true);
  // W4 — how this run treats stored node defaults. 'live' is the default and is what every run did
  // before defaults existed; the other two are opt-in and are described in full below, because
  // "defaults only" in particular changes what the run IS, not just how fast it goes.
  const [outputMode, setOutputMode] = useState<verbs.RunOutputMode>('live');
  const [budget, setBudget] = useState('10');
  const [requestId, setRequestId] = useState(genRequestId);
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [validation, setValidation] = useState<ValidationState>({ status: 'checking' });
  const [starting, setStarting] = useState(false);

  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // Re-seed every field to a clean state whenever the modal opens — never
  // carry a stale validation result or a half-typed brief from a previous
  // open into a new one.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    // Read once via getState() (not a subscription) — the modal seeds from
    // whichever workflow was active *when it was opened*, and won't reset
    // its fields if that store value happens to change while it's still up.
    setWfId(useStore.getState().wf);
    setExecMode('mock');
    setDry(true);
    setBudget('10');
    setRequestId(genRequestId());
    setBrief(DEFAULT_BRIEF);
    setValidation({ status: 'checking' });
    setStarting(false);
    // REVIEW FIX — outputMode was the one field this "re-seed every field to a clean state" effect did
    // not re-seed, so "defaults only" was STICKY: start one fixtures run, come back later for a normal
    // one, and every node completes from a fixture with no model called and the run permanently
    // unpublishable. A mode that changes what a run IS must never carry over silently.
    setOutputMode('live');
  }, [open]);

  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
    else triggerRef.current?.focus?.();
  }, [open]);

  const workflow = workflows.find((w) => w.id === wfId);

  // Default the project picker to the first launchable project once
  // projects load, rather than landing on a disabled/unhealthy one.
  useEffect(() => {
    if (!open || projId || projects.length === 0) return;
    const firstOk = projects.find((p) => p.ok) ?? projects[0];
    if (firstOk) setProjId(firstOk.id);
  }, [open, projId, projects]);

  const project = projects.find((p) => p.id === projId);
  const nodeId = entryNodeId(workflow);

  const schemaQ = useQuery({
    queryKey: ['startmodal-input-schema', nodeId],
    queryFn: () => nodeGetInputSchema({ nodeId: nodeId as string }),
    enabled: open && Boolean(nodeId),
  });

  // Debounced node_validate_input against the entry node's schema — WP-22's
  // stated done-criterion: "Invalid input blocks the button *and states the
  // reason*." Re-runs whenever the brief or the target workflow changes.
  useEffect(() => {
    if (!open) return;
    // REVIEW FIX (W7) — no entry node means nothing to validate the brief against, which is the case
    // for every workflow the presentation catalog has no phase config for (W7 made three such
    // workflows selectable). The effect used to return early leaving validation at 'checking' forever,
    // so canStart stayed false and the modal showed "checking input…" with no way forward — three
    // workflows selectable everywhere and startable nowhere. Unvalidatable is not invalid: allow the
    // start and say the brief was not checked.
    if (!nodeId) {
      setValidation({ status: 'unvalidated' });
      return;
    }
    setValidation({ status: 'checking' });
    const trimmed = brief.trim();
    const timer = window.setTimeout(() => {
      nodeValidateInput({ nodeId, input: trimmed ? { brief: trimmed } : null })
        .then((result) => {
          setValidation(result.valid ? { status: 'valid' } : { status: 'invalid', errors: result.errors });
        })
        .catch((err: unknown) => {
          setValidation({ status: 'error', message: err instanceof Error ? err.message : 'Validation failed.' });
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, nodeId, brief]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  const projectBlocked = !project || !project.ok;
  // Deliberately does NOT include `!starting`: this button stays clickable
  // (just relabelled "Starting…") while the confirm dialog is open and the
  // mutation is in flight. Disabling it would auto-blur it in every
  // browser, breaking focus-return once the dialog closes — and it isn't
  // needed for safety, since the confirm dialog's own scrim already blocks
  // a second click. The in-function re-entrancy guard below covers it.
  const canStart =
    !IS_READ_ONLY &&
    Boolean(workflow) &&
    Boolean(project) &&
    !projectBlocked &&
    (validation.status === 'valid' || validation.status === 'unvalidated');

  async function handleStart(triggerEl: HTMLElement | null) {
    if (!workflow || !project || starting) return; // re-entrancy guard — see canStart's comment above
    setNextConfirmTrigger(triggerEl);
    setStarting(true);
    try {
      const run = await startMut.mutateAsync({
        workflowId: workflow.id,
        projectId: project.id,
        brief: brief.trim(),
        budgetUsd: budget.trim() ? Number(budget) : undefined,
        dry,
        executionMode: execMode,
        outputMode,
        requestId,
      });
      if (run) {
        toast(dry ? 'Run started' : 'LIVE run started', `workflow_start_dry_run → ${run.id.slice(-10)}`);
        bindRun(run.id, run.wf, run.cur ?? nodeId ?? workflow.id);
        close();
      }
    } catch (err) {
      if (err instanceof ActionCancelledError) return; // operator declined the confirm dialog — stay on the modal
      toast('Start failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      className="scrim open"
      ref={scrimRef}
      onMouseDown={(e) => {
        if (e.target === scrimRef.current) close();
      }}
    >
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="startmodal-title" onKeyDown={onKeyDown}>
        <h3 id="startmodal-title">Start run</h3>
        <div className="sub">The only place a client enters the picture. Every knob, no hidden defaults.</div>

        {IS_READ_ONLY && (
          // U7 polish — operator copy, not developer copy (same fix as
          // tabs/Shared.tsx's READONLY_REASON).
          <p className="note" style={{ color: 'var(--acc)' }}>
            This workbench is connected read-only right now, so a run can&rsquo;t be started. Ask whoever administers
            this deployment to switch it to read-write.
          </p>
        )}

        <div className="field">
          <label className="lbl" htmlFor="sm-wf">
            workflow
          </label>
          <select id="sm-wf" ref={firstFieldRef} value={wfId} onChange={(e) => setWfId(e.target.value)}>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="lbl" htmlFor="sm-proj">
            project (client)
          </label>
          <select id="sm-proj" value={projId} onChange={(e) => setProjId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.ok}>
                {p.name}
                {p.ok ? '' : ' — endpoint unset ⚠'}
              </option>
            ))}
          </select>
          <ProjectHealthNote project={project} />
        </div>

        <div className="field">
          <span className="lbl">execution</span>
          <div className="seg">
            <button type="button" aria-pressed={execMode === 'mock'} className={execMode === 'mock' ? 'on' : ''} onClick={() => setExecMode('mock')}>
              mock (free, shape test)
            </button>
            <button type="button" aria-pressed={execMode === 'openai'} className={execMode === 'openai' ? 'on' : ''} onClick={() => setExecMode('openai')}>
              openai (live model)
            </button>
          </div>
        </div>

        <div className="field">
          <span className="lbl">mode</span>
          <div className="seg">
            <button type="button" aria-pressed={dry} className={dry ? 'on' : ''} onClick={() => setDry(true)}>
              dry run
            </button>
            <button type="button" aria-pressed={!dry} className={!dry ? 'on' : ''} onClick={() => setDry(false)}>
              live
            </button>
          </div>
        </div>

        <div className="field">
          <span className="lbl">output mode</span>
          <div className="seg">
            {/* "run every node", NOT "live". The mode control directly above already has a button
                labelled "live" meaning something entirely different (a live run vs a dry run), and two
                adjacent segmented controls both offering "live" is a genuine trap for an operator, not
                just an ambiguous selector. The wire value is still 'live'. */}
            <button type="button" aria-pressed={outputMode === 'live'} className={outputMode === 'live' ? 'on' : ''} onClick={() => setOutputMode('live')}>
              run every node
            </button>
            <button
              type="button"
              aria-pressed={outputMode === 'defaults_where_set'}
              className={outputMode === 'defaults_where_set' ? 'on' : ''}
              onClick={() => setOutputMode('defaults_where_set')}
            >
              defaults where set
            </button>
            <button
              type="button"
              aria-pressed={outputMode === 'defaults_only'}
              className={outputMode === 'defaults_only' ? 'on' : ''}
              onClick={() => setOutputMode('defaults_only')}
            >
              defaults only
            </button>
          </div>
          <p className="note" style={{ margin: '6px 0 0' }}>
            {outputMode === 'live' && 'Every node runs. Stored node defaults are never applied on their own.'}
            {outputMode === 'defaults_where_set' &&
              'A node with a stored default is completed from it — no model call, no cost. Every other node runs for real.'}
            {outputMode === 'defaults_only' &&
              'Every node must have a stored default; one that does not FAILS rather than running. Exercises the whole pipeline’s topology and contracts in seconds, with no model called at all.'}
          </p>
        </div>

        {outputMode !== 'live' && (
          <div className="card" style={{ marginBottom: 13 }}>
            <span className="lbl">this run will use fixtures</span>
            <p style={{ margin: 0, fontSize: 12.5 }}>
              Any node completed from a default did not run. The run is marked permanently: it can never publish on a
              live run, and those nodes are excluded from its learning record.
            </p>
          </div>
        )}

        {!dry && (
          <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 13 }}>
            <span className="lbl" style={{ color: 'var(--bad)' }}>
              live — not a drill
            </span>
            <p style={{ margin: 0, fontSize: 12.5 }}>
              This run may take real, potentially irreversible actions against{' '}
              <strong>{project?.name ?? 'the selected project'}</strong> — a theme write, a publish, or a draft
              emission, depending on where it stops. It stays a dry run until you choose live yourself; nothing
              defaults you here.
            </p>
          </div>
        )}

        <div className="field">
          <label className="lbl" htmlFor="sm-budget">
            budget usd
          </label>
          <input id="sm-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>

        <div className="field">
          <label className="lbl" htmlFor="sm-reqid">
            request id
          </label>
          <input id="sm-reqid" className="mono" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
        </div>

        <div className="field">
          <label className="lbl" htmlFor="sm-brief">
            brief / input
          </label>
          <textarea id="sm-brief" value={brief} onChange={(e) => setBrief(e.target.value)} />
        </div>

        {/* a11y S8 — these two update live as the operator types the brief
            (350ms debounce) but sat in no aria-live region, so a
            screen-reader user typing got no spoken notice that Start just
            became blocked, or why. Two stable regions (not one, to avoid
            reshuffling .foot's layout) rather than letting the elements
            themselves mount/unmount — a live region's contents changing is
            what gets announced; the region disappearing and reappearing is
            not reliably announced the same way. */}
        <div aria-live="polite">
          <ValidationNote validation={validation} schemaLoaded={!schemaQ.isLoading} nodeId={nodeId} />
        </div>

        <div className="foot">
          <div aria-live="polite">
            <ValidationLabel validation={validation} />
          </div>
          <span>
            <Btn onClick={close}>Cancel</Btn>
            <Btn variant={dry ? 'pri' : 'danger'} style={{ marginLeft: 8 }} disabled={!canStart} onClick={(e) => handleStart(e.currentTarget)}>
              {starting ? 'Starting…' : dry ? 'Start run' : 'Start LIVE run'}
            </Btn>
          </span>
        </div>
      </div>
    </div>
  );
}

function ProjectHealthNote({ project }: { project: Project | undefined }) {
  if (!project) {
    return <p className="note">No launchable project available.</p>;
  }
  if (!project.ok) {
    return (
      <p className="note" style={{ color: 'var(--bad)' }}>
        {project.name}&rsquo;s endpoint/token is unset ({project.endpointSource ?? 'unset'}) — this project cannot be
        launched until it&rsquo;s configured. Pick another project to enable Start.
      </p>
    );
  }
  return <p className="note" style={{ color: 'var(--ok)' }}>connection healthy — {project.endpoint ?? project.id}</p>;
}

function ValidationLabel({ validation }: { validation: ValidationState }) {
  if (validation.status === 'valid') {
    return <span className="valnote">✓ input validates against the entry node&rsquo;s input schema</span>;
  }
  if (validation.status === 'checking') {
    return <span className="valnote" style={{ color: 'var(--muted)' }}>checking input…</span>;
  }
  if (validation.status === 'unvalidated') {
    // Stated, not hidden: the brief is going to the run unchecked, and the operator should know which
    // of the two it is before they press Start.
    return (
      <span className="valnote" style={{ color: 'var(--muted)' }}>
        input not checked — the Workbench has no entry node configured for this workflow
      </span>
    );
  }
  return <span className="valnote" style={{ color: 'var(--bad)' }}>✗ input does not validate — see reason above</span>;
}

function ValidationNote({
  validation,
  schemaLoaded,
  nodeId,
}: {
  validation: ValidationState;
  schemaLoaded: boolean;
  nodeId: string | undefined;
}) {
  if (!schemaLoaded) {
    return <p className="note">checking {nodeId ?? 'the entry node'}&rsquo;s declared input schema…</p>;
  }
  if (validation.status === 'invalid') {
    return (
      <p className="note" style={{ color: 'var(--bad)' }}>
        blocked: {validation.errors.join('; ')}
      </p>
    );
  }
  if (validation.status === 'error') {
    return (
      <p className="note" style={{ color: 'var(--bad)' }}>
        blocked: {validation.message}
      </p>
    );
  }
  return null;
}
