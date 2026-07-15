// Framework-free route model for the app shell. History-based (never hash: the Netlify Identity
// widget owns location.hash for invite/recovery/confirmation tokens). Parsing is lenient —
// unknown paths render Overview WITHOUT rewriting the URL, so an identity token in the hash is
// never destroyed by a canonicalizing redirect at load.

export type AppPage = "overview" | "constellation" | "runs" | "changes" | "access" | "settings";
export type LegacyPanel = "builder" | "nodes";
export type ConstellationMode = "design" | "operate" | "history";

export type AppRoute =
  | { page: "overview" | "runs" | "changes" | "access" | "settings" }
  | { page: "constellation"; legacy?: LegacyPanel; mode?: ConstellationMode };

export const defaultRoute: AppRoute = { page: "overview" };

export const navPages: ReadonlyArray<{ page: AppPage; label: string }> = [
  { page: "overview", label: "Overview" },
  { page: "constellation", label: "Constellation" },
  { page: "runs", label: "Runs" },
  { page: "changes", label: "Changes" },
  { page: "access", label: "Access" },
  { page: "settings", label: "Settings" }
];

const pages = new Set<AppPage>(["overview", "constellation", "runs", "changes", "access", "settings"]);
const legacyPanels = new Set<LegacyPanel>(["builder", "nodes"]);
const constellationModes = new Set<ConstellationMode>(["design", "operate", "history"]);

export function parseRoute(pathname: string, search: string): AppRoute {
  const segment = pathname.replace(/\/+$/, "").replace(/^\/+/, "").split("/")[0] ?? "";
  const page = pages.has(segment as AppPage) ? (segment as AppPage) : "overview";
  if (page !== "constellation") return { page };
  const params = new URLSearchParams(search);
  const legacy = params.get("legacy");
  const mode = params.get("mode");
  return {
    page,
    ...(legacy && legacyPanels.has(legacy as LegacyPanel) ? { legacy: legacy as LegacyPanel } : {}),
    // mode is parsed and preserved for S3 deep links; nothing renders it yet.
    ...(mode && constellationModes.has(mode as ConstellationMode) ? { mode: mode as ConstellationMode } : {})
  };
}

export function formatRoute(route: AppRoute): string {
  if (route.page !== "constellation") return `/${route.page}`;
  const params = new URLSearchParams();
  if (route.legacy) params.set("legacy", route.legacy);
  if (route.mode) params.set("mode", route.mode);
  const query = params.toString();
  return `/constellation${query ? `?${query}` : ""}`;
}

export function routesEqual(a: AppRoute, b: AppRoute): boolean {
  return formatRoute(a) === formatRoute(b);
}

export function routeLabel(route: AppRoute): string {
  if (route.page === "constellation") {
    if (route.legacy === "builder") return "Open builder";
    if (route.legacy === "nodes") return "Open nodes";
    return "Open constellation";
  }
  return `Open ${route.page}`;
}
