import { create } from 'zustand';
import type { ModalKind, OverlayState } from './overlay/types';
import type {
  BenchMode,
  LearnTab,
  NodeTab,
  RegTab,
  RunTab,
  ScreenId,
  ThemePref,
} from './types';

const THEME_KEY = 'cw-theme';

function readStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'auto' || v === 'light' || v === 'dark') return v;
  } catch {
    // ignore — storage unavailable
  }
  return 'auto';
}

function persistTheme(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // ignore — storage unavailable
  }
}

/** Applies the theme preference to <html data-theme>. Mirrors the mockup's applyTheme(). */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

interface WorkbenchState {
  screen: ScreenId;
  wf: string;
  mode: BenchMode;
  runId: string | null;
  node: string;
  tab: NodeTab;
  runtab: RunTab;
  reg: RegTab;
  lrn: LearnTab;
  showUneng: boolean;
  theme: ThemePref;
  pairsDone: number;
  cmpIdx: number;
  blind: boolean;
  /** WP-22 — start-run modal open/closed. Lives here (not local component
   * state) so any surface (dock's "▸ Start run…", the Library card's "Start
   * run", ⌘K) can open it without prop-drilling. */
  startModalOpen: boolean;
  /** WP-42 — command palette open/closed. ⌘K/Ctrl+K from anywhere sets this;
   * CommandPalette.tsx is the only reader. */
  paletteOpen: boolean;
  /** WP-42b — graph overlay open/closed. The rail's "⌗ graph overlay" ghost
   * button and the global "G" key both set this; GraphOverlay.tsx is the
   * only reader. An overlay, not a screen — deliberately has no ScreenId. */
  graphOverlayOpen: boolean;
  /** a11y C4 — true while any RegistryPicker instance (Tools/Skills "+ add
   * from registry") is mounted. RegistryPicker sets this on mount/unmount
   * via a plain effect; App.tsx folds it into the same "something modal is
   * open" boolean that drives `inert` on the rest of the page, alongside
   * paletteOpen/startModalOpen/graphOverlayOpen and ConfirmDialog's own
   * (module-external) pending state. */
  registryPickerOpen: boolean;
  /** U6 — the one addressable modal, if any. Every focused task with its
   * own commit routes through here so it can be deep-linked
   * (`?modal=diff&m.node=…`), reopened, and dismissed by one rule. The four
   * booleans above predate this and stay as they are: they are not
   * addressable surfaces and rewriting them would churn working code and
   * its tests for no operator-visible gain. */
  overlay: OverlayState | null;

  setScreen: (screen: ScreenId) => void;
  setWf: (wf: string) => void;
  setMode: (mode: BenchMode) => void;
  setNode: (node: string) => void;
  setTab: (tab: NodeTab) => void;
  setRunTab: (runtab: RunTab) => void;
  setReg: (reg: RegTab) => void;
  setLearn: (lrn: LearnTab) => void;
  setShowUneng: (v: boolean) => void;
  adoptNode: (node: string) => void;
  bindRun: (runId: string, wf: string, node: string) => void;
  /** U3 — bind a run and land straight in drive mode, in one atomic update
   * (rather than bindRun's always-'run' + a separate setMode('drive'),
   * which would flash through 'run' first). Used by drive mode's own
   * empty-state "bind an existing run" list. */
  bindRunForDrive: (runId: string, wf: string, node: string) => void;
  unbindRun: () => void;
  cycleTheme: () => void;
  setTheme: (pref: ThemePref) => void;
  recordVerdict: () => void;
  openStartModal: () => void;
  closeStartModal: () => void;
  openPalette: () => void;
  closePalette: () => void;
  openGraphOverlay: () => void;
  closeGraphOverlay: () => void;
  setRegistryPickerOpen: (open: boolean) => void;
  openModal: (kind: ModalKind, params?: Record<string, string>) => void;
  closeModal: () => void;
  /** Used by the URL sync only — sets overlay state WITHOUT writing history. */
  syncModalFromUrl: (overlay: OverlayState | null) => void;
}

export const useStore = create<WorkbenchState>((set) => ({
  screen: 'bench',
  wf: 'publishing_conductor',
  // P2-01 — boot into a state that is true before any data arrives. The
  // old initial state named a fixture run id that does not exist upstream,
  // so every cold load fired a `workflow_get_run` that failed (×4, with
  // backoff) while Rail/Center/Dock/TopBar all sat on that query. Nothing
  // here may reference an id the workspace has not confirmed exists:
  // `node` is empty until the loaded workflow's nodes arrive (Rail's
  // adoptFirstNode), and `runId` is null until a run is deliberately bound.
  mode: 'build',
  runId: null,
  node: '',
  tab: 'prompt',
  runtab: 'live',
  reg: 'projects',
  lrn: 'fly',
  showUneng: true,
  theme: readStoredTheme(),
  pairsDone: 0,
  cmpIdx: 0,
  blind: true,
  startModalOpen: false,
  paletteOpen: false,
  graphOverlayOpen: false,
  registryPickerOpen: false,
  overlay: null,

  setScreen: (screen) => set({ screen }),
  setWf: (wf) => set({ wf }),
  setMode: (mode) => set({ mode }),
  setNode: (node) => set({ node }),
  setTab: (tab) => set({ tab }),
  setRunTab: (runtab) => set({ runtab }),
  setReg: (reg) => set({ reg }),
  setLearn: (lrn) => set({ lrn }),
  setShowUneng: (showUneng) => set({ showUneng }),

  /** P2-01 — first-node adoption. Called by Rail once the active workflow's
   * nodes have actually loaded; only fills an empty selection, so it can
   * never stomp a node the operator (or a run binding) already chose. */
  adoptNode: (node) => set((s) => (s.node ? {} : { node })),

  bindRun: (runId, wf, node) =>
    set({ wf, runId, mode: 'run', node, tab: 'thisrun', screen: 'bench' }),

  bindRunForDrive: (runId, wf, node) =>
    set({ wf, runId, mode: 'drive', node, tab: 'thisrun', screen: 'bench' }),

  unbindRun: () => set({ runId: null, mode: 'build', tab: 'prompt' }),

  cycleTheme: () =>
    set((s) => {
      const next: ThemePref =
        s.theme === 'auto' ? 'light' : s.theme === 'light' ? 'dark' : 'auto';
      persistTheme(next);
      applyTheme(next);
      return { theme: next };
    }),

  setTheme: (pref) => {
    persistTheme(pref);
    applyTheme(pref);
    set({ theme: pref });
  },

  // Preference-pair verdict counter (Learning → Compare feeds finetune readiness).
  // Wired fully by a later WP; the increment lives here so the shared contract is stable now.
  recordVerdict: () => set((s) => ({ pairsDone: s.pairsDone + 1, cmpIdx: s.cmpIdx + 1 })),

  openStartModal: () => set({ startModalOpen: true }),
  closeStartModal: () => set({ startModalOpen: false }),

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openGraphOverlay: () => set({ graphOverlayOpen: true }),
  closeGraphOverlay: () => set({ graphOverlayOpen: false }),
  setRegistryPickerOpen: (registryPickerOpen) => set({ registryPickerOpen }),

  openModal: (kind, params = {}) => set({ overlay: { kind, params } }),
  closeModal: () => set({ overlay: null }),
  syncModalFromUrl: (overlay) => set({ overlay }),
}));
