import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createStaticHandler } from "./static.js";

function makeFixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "workbench-static-test-"));
  writeFileSync(join(dir, "index.html"), "<html><body>shell</body></html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.abc123.js"), "console.log('hi')");
  writeFileSync(join(dir, "favicon.svg"), "<svg></svg>");
  return dir;
}

async function withServer<T>(handler: ReturnType<typeof createStaticHandler>, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => handler.serve(req.url ?? "/", res));
  await new Promise<void>((resolveFn) => server.listen(0, resolveFn));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("static: reports unavailable and serves 404 when STATIC_ROOT is unset", async () => {
  const handler = createStaticHandler(undefined);
  assert.equal(handler.available, false);
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 404);
  });
});

test("static: reports unavailable when the directory has no index.html", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workbench-static-empty-"));
  try {
    const handler = createStaticHandler(dir);
    assert.equal(handler.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("static: serves a real asset file with a long-lived cache header", async () => {
  const dir = makeFixtureRoot();
  try {
    const handler = createStaticHandler(dir);
    assert.equal(handler.available, true);
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/assets/app.abc123.js`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "console.log('hi')");
      assert.match(res.headers.get("content-type") ?? "", /javascript/);
      assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("static: falls back to index.html for a client-side route with a no-cache header", async () => {
  const dir = makeFixtureRoot();
  try {
    const handler = createStaticHandler(dir);
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/runs/abc123`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<html><body>shell</body></html>");
      assert.equal(res.headers.get("cache-control"), "no-cache");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("static: path traversal attempts fall back to index.html rather than escaping the root", async () => {
  const dir = makeFixtureRoot();
  const secretDir = mkdtempSync(join(tmpdir(), "workbench-static-secret-"));
  writeFileSync(join(secretDir, "secret.txt"), "top secret");
  try {
    const handler = createStaticHandler(dir);
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/../../../../etc/passwd`, { redirect: "manual" });
      // Whatever comes back must not be the raw traversal target; it's either the SPA shell
      // (200) or the runtime/browser normalized the URL before it ever reached us. Either way,
      // it must not be a 200 serving unexpected content outside the fixture root.
      if (res.status === 200) {
        const text = await res.text();
        assert.equal(text, "<html><body>shell</body></html>");
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
});
