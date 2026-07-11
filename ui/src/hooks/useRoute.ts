import { useCallback, useEffect, useRef, useState } from "react";
import { formatRoute, parseRoute, routesEqual, type AppRoute } from "../route";

// History-based routing without a router dependency. The initial URL is parsed but NEVER
// rewritten (a canonicalizing replaceState would drop location.hash and could destroy a Netlify
// Identity invite/recovery token mid-flow); clean URLs are only written on explicit navigation.
export function useRoute() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname, window.location.search));
  // Mirrors the latest route so navigate() can dedupe and write history OUTSIDE the state
  // updater — React may invoke updaters more than once (StrictMode), which would push
  // duplicate history entries and break the back button.
  const routeRef = useRef(route);

  useEffect(() => {
    const onPopState = () => {
      const parsed = parseRoute(window.location.pathname, window.location.search);
      routeRef.current = parsed;
      setRoute(parsed);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: AppRoute, options?: { replace?: boolean }) => {
    if (routesEqual(routeRef.current, next)) return;
    routeRef.current = next;
    const url = formatRoute(next);
    if (options?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setRoute(next);
  }, []);

  return { route, navigate };
}
