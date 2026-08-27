/**
 * Playwright browser pool.
 *
 * mangafire.to is a React SPA behind Cloudflare; every data endpoint needs a
 * client-side `vrf` token, so we drive a real browser and intercept the SPA's
 * own API responses instead of scraping HTML.
 *
 * One persistent context is launched on first use, Cloudflare is cleared once
 * on a warm-up page, then a small pool of pages serves concurrent requests.
 */
import path from 'path';
import os from 'os';
import { chromium, BrowserContext, Page } from 'playwright';

export const BASE_URL = 'https://mangafire.to';

const POOL_SIZE = Math.max(1, parseInt(process.env.POOL_SIZE || '3', 10));
// Cloudflare's managed challenge does not auto-resolve in true headless mode,
// so on servers we run HEADED Chromium inside a virtual display (Xvfb —
// included in the official Playwright Docker image; the CMD starts it via
// xvfb-run). Default is therefore headed; set HEADLESS=true only if you know
// your environment clears CF headless.
const HEADLESS = process.env.HEADLESS === 'true';
const PROFILE_DIR =
  process.env.BROWSER_PROFILE_DIR || path.join(os.tmpdir(), 'mf-browser-profile');
const NAV_TIMEOUT = 60000;
const CHALLENGE_TIMEOUT = 90000;
const WARMUP_RETRIES = 3;

let context: BrowserContext | null = null;
let pool: Page[] = [];
let initPromise: Promise<BrowserContext> | null = null;

// Observable browser state (surfaced on /health).
let browserState: 'idle' | 'starting' | 'ready' | 'failed' = 'idle';
let browserError = '';
let readyAt = 0;

export function browserStatus() {
  return {
    state: browserState,
    error: browserError || undefined,
    readyFor: readyAt ? Math.round((Date.now() - readyAt) / 1000) + 's' : undefined,
    poolFree: pool.length,
    poolSize: POOL_SIZE,
  };
}

/**
 * Kick off browser launch + Cloudflare warm-up immediately (called at boot)
 * so the first real request doesn't pay the 60–90s cold-start cost and trip
 * the platform's proxy timeout.
 */
export function prewarm(): void {
  init().then(
    () => {
      browserState = 'ready';
      readyAt = Date.now();
      console.log('[browser] prewarm complete — ready for requests');
    },
    (err) => {
      browserState = 'failed';
      browserError = err?.message || String(err);
      console.error(`[browser] prewarm failed: ${browserError} (will retry on next request)`);
    },
  );
}

/** Click the Turnstile checkbox if one is rendered (managed challenges). */
async function tryClickTurnstile(page: Page): Promise<void> {
  try {
    for (const frame of page.frames()) {
      if (!/challenges\.cloudflare\.com/.test(frame.url())) continue;
      const box = await frame.$('input[type="checkbox"], .ctp-checkbox-container, #challenge-stage');
      if (box) {
        await box.click({ timeout: 3000 }).catch(() => {});
        return;
      }
    }
  } catch {
    /* no challenge frame yet */
  }
}

async function waitOutChallenge(page: Page, timeoutMs = CHALLENGE_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastClick = 0;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!/just a moment/i.test(title)) return;
    // Nudge the Turnstile widget every ~8s while we wait.
    if (Date.now() - lastClick > 8000) {
      lastClick = Date.now();
      await tryClickTurnstile(page);
    }
    await page.waitForTimeout(2000);
  }
  // Diagnostics: what is the challenge page actually showing?
  const title = await page.title().catch(() => '?');
  const url = page.url();
  const shot = path.join(os.tmpdir(), `mf-cf-failure-${Date.now()}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  console.warn(`[browser] challenge stuck — title="${title}" url=${url} screenshot=${shot}`);
  throw new Error('Cloudflare challenge did not resolve in time');
}

async function init(): Promise<BrowserContext> {
  if (context) return context;
  if (!initPromise) {
    browserState = 'starting';
    browserError = '';
    initPromise = (async () => {
      console.log(
        `[browser] launching chromium (headless=${HEADLESS}, pool=${POOL_SIZE}, display=${process.env.DISPLAY || 'none'})`,
      );
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--disable-sync',
          '--window-size=1366,900',
        ],
        viewport: { width: 1366, height: 900 },
        // No userAgent override: Chromium's native UA matches its platform,
        // and Cloudflare flags UA/platform mismatches.
      });
      const warmup = ctx.pages()[0] || (await ctx.newPage());
      warmup.setDefaultTimeout(NAV_TIMEOUT);

      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= WARMUP_RETRIES; attempt++) {
        try {
          await warmup.goto(BASE_URL + '/', {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT,
          });
          await waitOutChallenge(warmup);
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          console.warn(`[browser] warm-up attempt ${attempt}/${WARMUP_RETRIES} failed: ${err?.message}`);
          await warmup.waitForTimeout(3000);
        }
      }
      if (lastErr) {
        await ctx.close().catch(() => {});
        throw lastErr;
      }
      console.log(`[browser] cloudflare cleared, title: ${await warmup.title()}`);

      pool = [warmup];
      for (let i = 1; i < POOL_SIZE; i++) {
        const p = await ctx.newPage();
        p.setDefaultTimeout(NAV_TIMEOUT);
        pool.push(p);
      }
      context = ctx;
      return ctx;
    })().catch((err) => {
      initPromise = null; // allow retry on next request
      browserState = 'idle';
      throw err;
    });
  }
  return initPromise;
}

/** Run `fn` with an exclusive page from the pool. */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  await init();
  // Simple exclusive checkout: pop a page, run, push back.
  while (pool.length === 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = pool.shift()!;
  try {
    return await fn(page);
  } finally {
    // Close stray dialogs/tabs state: navigate away so the next user starts clean.
    page.removeAllListeners('response');
    pool.push(page);
  }
}

/**
 * Resolve with the JSON body of the first 200 response whose URL matches,
 * or null on timeout. Register BEFORE triggering the navigation.
 */
export function waitForApi<T = any>(
  page: Page,
  match: (url: string) => boolean,
  timeoutMs = 25000,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      page.off('response', onResponse);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onResponse = async (resp: import('playwright').Response) => {
      if (done) return;
      if (resp.status() !== 200 || !match(resp.url())) return;
      try {
        const json = await resp.json();
        finish(json as T);
      } catch {
        /* not JSON — ignore */
      }
    };
    page.on('response', onResponse);
  });
}

/** Collect every matching API response until `stop()` or timeout. */
export function collectApi<T = any>(
  page: Page,
  match: (url: string) => boolean,
  timeoutMs = 25000,
): { promise: Promise<T[]>; stop: () => void } {
  const items: T[] = [];
  let done = false;
  let resolveFn: (v: T[]) => void;
  const promise = new Promise<T[]>((resolve) => {
    resolveFn = resolve;
  });
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    page.off('response', onResponse);
    resolveFn(items);
  };
  const timer = setTimeout(finish, timeoutMs);
  const onResponse = async (resp: import('playwright').Response) => {
    if (done) return;
    if (resp.status() !== 200 || !match(resp.url())) return;
    try {
      items.push((await resp.json()) as T);
    } catch {
      /* ignore non-JSON */
    }
  };
  page.on('response', onResponse);
  return { promise, stop: finish };
}

export async function shutdownBrowser(): Promise<void> {
  try {
    if (context) await context.close();
  } catch {
    /* ignore */
  }
  context = null;
  pool = [];
  initPromise = null;
}
