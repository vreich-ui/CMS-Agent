import { expect, test } from '@playwright/test';

// WP-44 smoke: the login gate — against fixture data (VITE_MOCK default,
// see playwright.config.ts's single shared `npm run dev` webServer).
//
// IS_MOCK is fixed for the whole life of that dev server, so there is no
// way from a test to make a *real* unauthenticated/expired broker response
// happen — LoginGate.tsx's own doc comment covers this. Two of the three
// scenarios below drive LoginGate's module state directly (dynamic
// `import('/src/components/LoginGate.tsx')`, exactly like
// tests/runcontrol.spec.ts already does against `/src/store.ts`) via the
// test-only `__test_setUnauthenticated`/`__test_reset` exports, which stub
// exactly the state a real broker's 401 or "not logged in" response would
// produce. The first scenario needs no stubbing at all — it's the default,
// unmodified fixture-mode behaviour.

async function forceUnauthenticated(page: import('@playwright/test').Page, notice: string | null = null) {
  await page.evaluate(async (n) => {
    const mod = (await import('/src/components/LoginGate.tsx')) as {
      __test_setUnauthenticated: (notice?: string | null) => void;
    };
    mod.__test_setUnauthenticated(n);
  }, notice);
}

test('fixture mode skips the gate entirely, and fixture mode is visibly indicated', async ({ page }) => {
  await page.goto('/');

  // The app itself, not a login screen.
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('#lg-password')).toHaveCount(0);

  // "Make fixture mode visible rather than silent" — the corner badge
  // App.tsx already carries for this, still present and truthful.
  await expect(page.locator('.chip', { hasText: 'fixture data' })).toBeVisible();

  // TopBar's own identity/read-write chip reads the same (mock) session —
  // fixture mode doesn't hide *that* either, it only skips the gate.
  await expect(page.locator('#accountbtn')).toContainText('mock-operator');
});

test('a stubbed unauthenticated session renders the login screen; the password never reaches the DOM or storage', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();

  await forceUnauthenticated(page);
  await expect(page.locator('#lg-password')).toBeVisible();
  await expect(page.locator('#lg-password')).toHaveAttribute('type', 'password');
  await expect(page.locator('#lg-password')).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.locator('.topbar')).toHaveCount(0); // the app is genuinely gone, not just covered

  const secret = 'correct horse battery staple';
  await page.locator('#lg-password').fill(secret);

  // The field holds it (that's the whole point of a password field) — but
  // nothing else on the page, and nothing in either storage, ever does.
  const leaked = await page.evaluate((s) => {
    const bodyText = document.body.innerText;
    const bodyHtml = document.body.innerHTML;
    const ls = JSON.stringify(Object.entries(localStorage));
    const ss = JSON.stringify(Object.entries(sessionStorage));
    return (
      bodyText.includes(s) ||
      bodyHtml.replace(/value="[^"]*"/g, '').includes(s) || // ignore the input's own value="" attribute reflection
      ls.includes(s) ||
      ss.includes(s)
    );
  }, secret);
  expect(leaked).toBe(false);

  await page.screenshot({ path: 'shots/login.png', fullPage: true });

  // Submitting clears the field immediately — write-only, never retained.
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#lg-password')).toHaveValue('');

  // Fixture-mode login() accepts any non-empty password — the gate lifts.
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 2000 });
});

test('an incorrect/rate-limited login shows the broker\'s own message, not a generic one, and never displays the password', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
  await forceUnauthenticated(page, 'Too many login attempts. Try again later.');

  // The rate-limit notice (what a real 429 would carry) renders honestly.
  await expect(page.locator('.modal')).toContainText('Too many login attempts. Try again later.');
  await expect(page.locator('#lg-password')).toHaveValue('');
});

test('a stubbed 401 mid-session returns the operator to the gate with an explanation, not a broken screen', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();

  // Simulate the failure of App.tsx's QueryCache/MutationCache onError ->
  // reportAuthExpired(...) wiring for an AuthError thrown by any verb call —
  // see this file's header comment for why this test drives the resulting
  // state directly instead of triggering a real 401.
  const message = 'Your session has expired — log in again.';
  await forceUnauthenticated(page, message);

  await expect(page.locator('.topbar')).toHaveCount(0);
  await expect(page.locator('#lg-password')).toBeVisible();
  await expect(page.locator('.modal')).toContainText(message);
  // Not a generic error dump — the operator gets exactly the gate, nothing else.
  await expect(page.locator('.modal h3')).toHaveText('Sign in');
});
