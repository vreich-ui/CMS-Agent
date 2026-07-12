import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no matchMedia; useTheme needs it. Tests can flip `matchMediaState.matches` and call
// `matchMediaState.dispatch()` to simulate a system color-scheme change.
type MediaListener = (event: { matches: boolean }) => void;
export const matchMediaState = {
  matches: false,
  listeners: new Set<MediaListener>(),
  dispatch() {
    for (const listener of this.listeners) listener({ matches: this.matches });
  }
};

// React Flow v12 needs ResizeObserver and DOMMatrixReadOnly to mount under jsdom. The no-op
// observer means node measurement never completes, so canvas tests stay at smoke level; graph
// interaction depth lives in the framework-free model tests and the live Playwright drive.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

class DOMMatrixReadOnlyStub {
  m22 = 1;
  constructor(transform?: string) {
    const match = transform?.match(/scale\(([0-9.]+)\)/);
    if (match) this.m22 = Number(match[1]);
  }
}
(globalThis as unknown as { DOMMatrixReadOnly: typeof DOMMatrixReadOnlyStub }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;

window.matchMedia = (query: string) => ({
  matches: matchMediaState.matches,
  media: query,
  onchange: null,
  addEventListener: (_type: string, listener: MediaListener) => { matchMediaState.listeners.add(listener); },
  removeEventListener: (_type: string, listener: MediaListener) => { matchMediaState.listeners.delete(listener); },
  addListener: (listener: MediaListener) => { matchMediaState.listeners.add(listener); },
  removeListener: (listener: MediaListener) => { matchMediaState.listeners.delete(listener); },
  dispatchEvent: () => false
}) as MediaQueryList;

afterEach(() => {
  cleanup();
  localStorage.clear();
  matchMediaState.matches = false;
  matchMediaState.listeners.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  window.history.replaceState(null, "", "/");
});
