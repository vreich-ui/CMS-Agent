import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/tokens.css';
import './styles/base.css';
import { AuthError, IS_MOCK, IS_READ_ONLY } from './api/client';
import { setConfirmHandler } from './api/confirmAction';
import { IconSprite } from './components/Icons';
import { TopBar } from './components/TopBar';
import { Toasts } from './components/Toasts';
import { ConfirmDialog, requestConfirm, useConfirmPending } from './components/ConfirmDialog';
import { StartRunModal } from './components/StartRunModal';
import { CommandPalette } from './components/CommandPalette';
import { GraphOverlay } from './components/GraphOverlay';
import { LoginGate, reportAuthExpired } from './components/LoginGate';
import { Workbench } from './screens/Workbench';
import { Runs } from './screens/Runs';
import { Library } from './screens/Library';
import { Learning } from './screens/Learning';
import { Registry } from './screens/Registry';
import { useStore } from './store';

// WP-21 — replace confirmAction's window.confirm() stub with the real
// ConfirmDialog, once, at module load (not inside a component body, so
// React StrictMode's double-invoked render can't register it twice with
// different closures). See api/confirmAction.ts's doc comment.
setConfirmHandler(requestConfirm);

// WP-44 — every failed query/mutation flows through these two caches in
// TanStack Query v5, so this is the one place that needs to know about
// AuthError at all: a 401 from *any* verb call, anywhere in the app,
// reports through to LoginGate.tsx's little external store, which brings
// the login screen back with the broker's own explanation instead of
// leaving the operator on a stale or broken screen. Never fires in fixture
// mode — nothing there ever throws AuthError.
function handleQueryError(error: unknown): void {
  if (error instanceof AuthError) reportAuthExpired(error.message);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleQueryError }),
  mutationCache: new MutationCache({ onError: handleQueryError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function ActiveScreen() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case 'library': return <Library />;
    case 'bench': return <Workbench />;
    case 'runs': return <Runs />;
    case 'learning': return <Learning />;
    case 'registry': return <Registry />;
  }
}

// a11y C4 — none of the five overlays made the rest of the app `inert`
// while open, so a screen-reader user in browse mode could navigate into
// (and "read") background nav/rail controls that were visually covered and
// non-functional. One native `inert` toggle on the page's only non-overlay
// content, driven by one derived boolean, fixes all five at once:
// paletteOpen/startModalOpen/graphOverlayOpen/registryPickerOpen live in
// the zustand store; ConfirmDialog's own pending state is module-external
// (see useConfirmPending's doc comment) and folds in the same way.
function BackgroundArea() {
  const paletteOpen = useStore((s) => s.paletteOpen);
  const startModalOpen = useStore((s) => s.startModalOpen);
  const graphOverlayOpen = useStore((s) => s.graphOverlayOpen);
  const registryPickerOpen = useStore((s) => s.registryPickerOpen);
  const confirmPending = useConfirmPending();
  const anyOverlayOpen = paletteOpen || startModalOpen || graphOverlayOpen || registryPickerOpen || confirmPending;
  return (
    <div inert={anyOverlayOpen}>
      <TopBar />
      <ActiveScreen />
    </div>
  );
}

// WP-21 requirement §3: "make that distinction visible in the UI: a small
// persistent indicator when running against fixtures, so nobody mistakes a
// mock success for a real one" — and the mirror case, a real broker running
// read-only. Fixed-position `.chip` reuses existing CSS; no new stylesheet
// rules.
function ModeBadge() {
  if (!IS_MOCK && !IS_READ_ONLY) return null;
  return (
    <div style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 90, display: 'flex', gap: 6 }}>
      {IS_MOCK && (
        <span
          className="chip"
          title="This build talks to local fixtures, not the live broker. Every mutation here only changes an in-memory mock store and is lost on reload — a mock success is not a real one."
          style={{ background: 'var(--acc-soft)', borderColor: 'var(--acc-dim)', color: 'var(--acc)' }}
        >
          fixture data · mutations are local only
        </span>
      )}
      {IS_READ_ONLY && (
        <span
          className="chip"
          title="Mutations are disabled. The broker's READ_ONLY env flag must be set to 0 to enable them."
        >
          read-only
        </span>
      )}
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <IconSprite />
      {/* WP-44 — gates everything below: in fixture mode this renders
          children immediately (the app must stay demonstrable with no
          broker running); otherwise it's the login screen until
          getSession()/login() says authenticated, and a 401 from anywhere
          (via handleQueryError above) brings it back. */}
      <LoginGate>
        <BackgroundArea />
        {/* a11y C4/C5 — RegistryPicker (Tools/Skills "+ add from registry")
            is owned by whichever tab opened it, deep inside BackgroundArea's
            subtree, but it portals its actual markup here via
            createPortal(..., document.getElementById('registry-picker-root'))
            so it (a) sits outside the `inert`-toggled wrapper above — an
            inert ancestor would inert the dialog along with the background
            it's supposed to stay usable over — and (b) is a real DOM
            sibling of the other four overlays, matching their pattern
            instead of inventing a new one. Placed before them in source
            order so they still stack visually on top of it, same as today
            (RegistryPicker always closes itself before a confirm/other
            overlay can open from inside it — see Shared.tsx). */}
        <div id="registry-picker-root" />
        <Toasts />
        <StartRunModal />
        {/* Mounted after StartRunModal: same .scrim z-index, so when a
            mutating verb (e.g. workflow_start_dry_run) confirms from inside
            an already-open modal, the confirm dialog stacks visually on top
            of it rather than underneath. CommandPalette/GraphOverlay follow
            the same stacking convention — each is a no-op scrim when closed. */}
        <ConfirmDialog />
        <CommandPalette />
        <GraphOverlay />
        <ModeBadge />
      </LoginGate>
    </QueryClientProvider>
  );
}

export default App;
