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
const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const PROFILE_DIR =
  process.env.BROWSER_PROFILE_DIR || path.join(os.tmpdir(), 'mf-browser-profile');
const NAV_TIMEOUT = 60000;

let context: BrowserContext | null = null;
let pool: Page[] = [];
let initPromise: Promise<BrowserContext> | null = null;

async function waitOutChallenge(page: Page, timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!/just a moment/i.test(title)) return;
    await page.waitForTimeout(2000);
  }
  throw new Error('Cloudflare challenge did not resolve in time');
}

async function init(): Promise<BrowserContext> {
  if (context) return context;
  if (!initPromise) {
    initPromise = (async () => {
      console.log(
        `[browser] launching chromium (headless=${HEADLESS}, pool=${POOL_SIZE})`,
      );
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--disable-sync',
        ],
      });
      const warmup = ctx.pages()[0] || (await ctx.newPage());
      warmup.setDefaultTimeout(NAV_TIMEOUT);
      await warmup.goto(BASE_URL + '/', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      await waitOutChallenge(warmup);
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
