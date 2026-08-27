/**
 * Static file server for the built Conductor Workbench SPA (Track A, A1.1).
 *
 * The broker is now the single origin: it serves `workbench/dist` (copied
 * into the image at `STATIC_ROOT`, see Dockerfile.workbench) for every
 * GET/HEAD request that isn't `/api/*`, with SPA fallback to `index.html`
 * for any path that doesn't resolve to a real file — that's what lets the
 * SPA's own client-side router handle deep links (`/runs/abc123`, etc.)
 * without every one of them needing its own file on disk.
 *
 * Node built-ins only, matching the rest of this broker.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export interface StaticHandler {
  /** True once a root directory containing an index.html was found at construction time. */
  readonly available: boolean;
  /** Serves one GET/HEAD request. Always writes a response (200, or 404 when unavailable). */
  serve(reqPath: string, res: ServerResponse): void;
}

export function createStaticHandler(root: string | undefined): StaticHandler {
  const rootAbs = root ? resolve(root) : null;
  const indexPath = rootAbs ? join(rootAbs, "index.html") : null;
  const available = Boolean(rootAbs && indexPath && existsSync(rootAbs) && existsSync(indexPath));
  const rootWithSep = rootAbs ? (rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep) : null;

  return {
    available,
    serve(reqPath: string, res: ServerResponse): void {
      if (!available || !rootAbs || !rootWithSep || !indexPath) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found. (The Conductor Workbench SPA was not built into this image — STATIC_ROOT is unset or empty.)");
        return;
      }

      let decoded: string;
      try {
        decoded = decodeURIComponent(reqPath.split("?")[0] ?? "/");
      } catch {
        decoded = "/";
      }

      let filePath = resolve(join(rootAbs, decoded));
      // Path traversal guard: the resolved path must stay inside rootAbs.
      if (filePath !== rootAbs && !filePath.startsWith(rootWithSep)) {
        filePath = indexPath;
      }

      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        stat = null;
      }
      if (!stat || stat.isDirectory()) {
        // No real file at this path (or it's a directory) — SPA client-side route, fall back.
        filePath = indexPath;
      }

      const ext = extname(filePath).toLowerCase();
      const contentType = MIME[ext] ?? "application/octet-stream";
      const isIndex = filePath === indexPath;
      // index.html must always be revalidated (it references the current hashed asset URLs);
      // every other static asset Vite emits is content-hashed and safe to cache forever.
      const cacheControl = isIndex ? "no-cache" : "public, max-age=31536000, immutable";

      res.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
      createReadStream(filePath).pipe(res);
    },
  };
}
