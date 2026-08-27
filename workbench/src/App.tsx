import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
} from '@tanstack/react-query';
import './styles/tokens.css';
import './styles/base.css';
import { AuthError, IS_MOCK } from './api/client';
import { setConfirmHandler } from './api/confirmAction';
import { IconSprite } from './components/Icons';
import { TopBar } from './components/TopBar';
import { Toasts } from './components/Toasts';
import { ConfirmDialog, requestConfirm, useConfirmPending } from './components/ConfirmDialog';
import { StartRunModal } from './components/StartRunModal';
import { CommandPalette } from './components/CommandPalette';
import { GraphOverlay } from './components/GraphOverlay';
import { LoginGate, reportAuthExpired } from './components/LoginGate';
import { OverlayHost } from './components/overlay/OverlayHost';
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

// P2-02 — query policy. TanStack v5's defaults (retry: 3 + exponential
// backoff) turned every failing verb into 4 requests and a 7-10s
// `isLoading`, which is most of what "very slow, some parts never load"
// actually was. The budget this policy has to hit: a failing verb shows
// its error inside 1.5s, and switching screens refetches nothing warm.
//
//   retry: 1 + retryDelay 1000 -> worst case 2 requests, error visible in
//     ~1s + one round trip, instead of ~7-10s.
//   staleTime 5min             -> screen switches read cache, no refetch.
//   gcTime 30min               -> cache survives a detour to another screen
//                                 and back for a whole working session.
//   placeholderData: keepPreviousData -> changing a query key (workflow,
//     node, run) keeps the last good data on screen while the next loads,
//     so a panel never flashes back to a skeleton it already filled.
//   mutations retry 0          -> a mutation is a decision the operator
//     made once; silently repeating it is never the right default.
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleQueryError }),
  mutationCache: new MutationCache({ onError: handleQueryError }),
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: 1000,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      placeholderData: keepPreviousData,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
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
// P2-06 — one status, one home. The read-only state is already reported by
// TopBar's own read-only/read-write pill; a second floating copy of it
// bottom-right was the same fact told twice in two places. Only the
// fixture-mode badge survives here, because that one has no other home and
// says something TopBar does not: the data on screen is not real.
function ModeBadge() {
  if (!IS_MOCK) return null;
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
    </div>
  );
}

// U6 — one host for every addressable modal. Kinds are registered in
// components/overlay/OverlayHost.tsx; the URL sync lives in
// overlay/useOverlayUrl.ts. Mounted inside LoginGate for the same reason
// the other overlays are: nothing should be deep-linkable past the gate.
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
        <OverlayHost />
        <ModeBadge />
      </LoginGate>
    </QueryClientProvider>
  );
}

export default App;
