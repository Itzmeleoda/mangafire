/**
 * mangafire.to scraper — SPA edition.
 *
 * The site is a React SPA behind Cloudflare; every data endpoint requires a
 * client-side `vrf` token minted by obfuscated JS. Instead of reproducing the
 * token algorithm we drive a real browser and intercept the SPA's own API
 * responses:
 *
 *   search    /browse?keyword=X            -> GET /api/titles?keyword=...
 *   info      /title/{hid}-{slug}          -> GET /api/titles/{hid}
 *   chapters  /title/{hid}-{slug} (+click) -> GET /api/titles/{hid}/chapters?...
 *   images    /title/{hid}-{slug}/chapter/N-> GET /api/chapters/{chapterId}
 *
 * Response shapes are mapped back to the legacy aizen-manga contract so
 * existing clients (the Electron Manga Bot's mangafire.py) work unchanged.
 * Chapter ids are compound tokens `hid~slug~number~chapterId` so the images
 * endpoint can rebuild a reader URL from a cid alone.
 */
import createHttpError from 'http-errors';
import { Page } from 'playwright';
import { BASE_URL, withPage, waitForApi } from '../browser/pool';

const CID_SEP = '~';

// ── id helpers ───────────────────────────────────────────────────────────

/** Public manga id is `{slug}.{hid}` (legacy-compatible). */
export function parseMangaId(id: string): { slug: string; hid: string } {
  const dot = id.lastIndexOf('.');
  if (dot <= 0 || dot === id.length - 1) {
    // Bare hid (no slug) — still usable for info/chapters navigation.
    return { slug: '', hid: id };
  }
  return { slug: id.slice(0, dot), hid: id.slice(dot + 1) };
}

export function makeCid(hid: string, slug: string, number: string | number, chapterId: string | number): string {
  return [hid, slug, String(number), String(chapterId)].join(CID_SEP);
}

export function parseCid(cid: string): { hid: string; slug: string; number: string; chapterId: string } {
  const parts = cid.split(CID_SEP);
  if (parts.length !== 4 || !parts[0] || !parts[3]) {
    throw createHttpError(
      400,
      'chapterId must be the compound token returned by /api/manga/:id/chapters/:lng',
    );
  }
  return { hid: parts[0], slug: parts[1], number: parts[2], chapterId: parts[3] };
}

// ── small utils ──────────────────────────────────────────────────────────

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function posterUrl(poster: any): string | null {
  if (!poster) return null;
  if (typeof poster === 'string') return poster;
  return poster.large || poster.medium || poster.small || null;
}

function nameOf(x: any): string {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return x.name || x.title || '';
}

async function gotoSpa(page: Page, path: string): Promise<void> {
  try {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err: any) {
    throw createHttpError(502, `navigation to ${path} failed: ${err?.message || err}`);
  }
  // Give the SPA a moment to fire its API calls; CF interstitials are handled
  // at warm-up, but re-check just in case.
  const title = await page.title().catch(() => '');
  if (/just a moment/i.test(title)) {
    await page.waitForFunction(() => !/just a moment/i.test(document.title), undefined, {
      timeout: 45000,
    }).catch(() => {});
  }
}

// ── search ───────────────────────────────────────────────────────────────

interface TitlesResponse {
  items: any[];
  meta: { total: number; perPage: number; page: number; lastPage: number; hasNext: boolean };
}

function mapTitleItem(it: any) {
  return {
    id: it?.slug && it?.hid ? `${it.slug}.${it.hid}` : String(it?.hid || it?.id || ''),
    title: it?.title || null,
    poster: posterUrl(it?.poster),
    type: it?.type || null,
  };
}

export async function search(keyword: string, page = 1) {
  return withPage(async (p) => {
    const wait = waitForApi<TitlesResponse>(
      p,
      (u) => u.includes('/api/titles') && new URL(u).searchParams.has('keyword'),
      30000,
    );
    await gotoSpa(p, `/browse?keyword=${encodeURIComponent(keyword)}&sort=relevance:desc`);
    const data = await wait;
    if (!data || !Array.isArray(data.items)) {
      throw createHttpError(502, 'search: SPA did not return results (Cloudflare or layout change?)');
    }

    // Best-effort client-side pagination: click forward until meta.page matches.
    let current = data;
    const results = current.items.map(mapTitleItem);
    let guard = 0;
    while (current.meta && current.meta.page < page && current.meta.hasNext && guard++ < 10) {
      const next = await clickPaginationPage(p, current.meta.page + 1);
      if (!next) break;
      current = next;
      results.push(...current.items.map(mapTitleItem));
    }

    const slice = current.meta
      ? results.slice((page - 1) * current.meta.perPage, page * current.meta.perPage)
      : results;

    return {
      currentPage: page,
      totalPages: current.meta?.lastPage || 1,
      results: current.meta && current.meta.page === page ? current.items.map(mapTitleItem) : slice,
    };
  });
}

/** Click the pagination control for a target page; returns the captured response. */
async function clickPaginationPage(p: Page, targetPage: number): Promise<TitlesResponse | null> {
  const wait = waitForApi<TitlesResponse>(
    p,
    (u) => u.includes('/api/titles') && new URL(u).searchParams.get('page') === String(targetPage),
    15000,
  );
  const clicked = await p
    .evaluate((target: number) => {
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const exact = nodes.find(
        (n) => (n.textContent || '').trim() === String(target) && (n as HTMLElement).offsetParent !== null,
      );
      const next = nodes.find(
        (n) =>
          /next/i.test((n as HTMLElement).getAttribute('aria-label') || '') ||
          /»|›/.test((n.textContent || '').trim()),
      );
      const el = exact || next;
      if (el) {
        (el as HTMLElement).click();
        return true;
      }
      return false;
    }, targetPage)
    .catch(() => false);
  if (!clicked) return null;
  return wait;
}

// ── series info ──────────────────────────────────────────────────────────

export async function mangaInfo(hid: string, slug = '') {
  return withPage(async (p) => {
    const wait = waitForApi<any>(
      p,
      (u) => {
        try {
          return new URL(u).pathname === `/api/titles/${hid}`;
        } catch {
          return false;
        }
      },
      30000,
    );
    await gotoSpa(p, slug ? `/title/${hid}-${slug}` : `/title/${hid}`);
    const json = await wait;
    const d = json?.data;
    if (!d || !d.title) {
      throw createHttpError(502, 'manga info: SPA did not return title data');
    }

    const genres = [
      ...(d.genres || []).map(nameOf),
      ...(d.themes || []).map(nameOf),
      ...(d.demographics || []).map(nameOf),
    ].filter(Boolean);

    return {
      mangaInfo: {
        title: d.title,
        altTitles: Array.isArray(d.altTitles) ? d.altTitles.join(', ') : d.altTitles || null,
        poster: posterUrl(d.poster),
        status: d.status || null,
        type: d.type || null,
        description: stripHtml(d.synopsisHtml) || null,
        author: (d.authors || []).map(nameOf).filter(Boolean).join(', ') || null,
        published: d.year ? String(d.year) : null,
        genres,
        rating: d.rating != null ? String(d.rating) : null,
        chapters: [],
      },
      relatedManga: [],
      similarManga: [],
      languages: (d.languages || []).map((l: string) => ({ id: l, title: l, chapters: null, logo: null })),
    };
  });
}

/** Language list for /api/manga/:id/chapters (derived from the info payload). */
export async function mangaLanguages(hid: string, slug = '') {
  const info = await mangaInfo(hid, slug);
  return (info as any).languages || [];
}

// ── chapter list ─────────────────────────────────────────────────────────

interface ChaptersResponse {
  items: { id: number; number: number | string; name: string; language: string; createdAt: number }[];
  meta: { total: number; perPage: number; page: number; lastPage: number; hasNext: boolean };
}

export async function mangaChapters(hid: string, slug: string, language: string) {
  return withPage(async (p) => {
    const match = (u: string) => {
      try {
        const url = new URL(u);
        return (
          url.pathname === `/api/titles/${hid}/chapters` &&
          (url.searchParams.get('language') || 'en').toLowerCase() === language.toLowerCase()
        );
      } catch {
        return false;
      }
    };

    const first = waitForApi<ChaptersResponse>(p, match, 20000);
    await gotoSpa(p, slug ? `/title/${hid}-${slug}` : `/title/${hid}`);
    await p.waitForTimeout(4000);

    let resp = await first;
    if (!resp || !Array.isArray(resp.items)) {
      // Chapters panel not auto-loaded — click its tab and wait again.
      await p
        .evaluate(() => {
          const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
          const tab = nodes.find((n) =>
            /^chapters?$/i.test((n.textContent || '').trim().split('\n')[0]),
          );
          if (tab) (tab as HTMLElement).click();
        })
        .catch(() => {});
      resp = await waitForApi<ChaptersResponse>(p, match, 15000);
    }
    if (!resp || !Array.isArray(resp.items) || resp.items.length === 0) {
      throw createHttpError(502, 'chapters: SPA returned no chapter data');
    }

    // Walk pagination so long series return every chapter, not just page 1.
    // Dedupe by chapter number: the SPA returns duplicate entries per number
    // (e.g. multiple upload types); keep the first one seen (newest pages
    // arrive first in desc order).
    const seen = new Map<string, any>();
    const absorb = (items: any[]) => {
      for (const it of items) {
        const key = String(it.number);
        if (!seen.has(key)) seen.set(key, it);
      }
    };
    absorb(resp.items);

    let meta = resp.meta;
    let guard = 0;
    while (meta && meta.hasNext && guard++ < 60) {
      const next = await clickChapterPage(p, hid, language, meta.page + 1);
      if (!next || !Array.isArray(next.items) || next.items.length === 0) break;
      absorb(next.items);
      if (!next.meta || next.meta.page === meta.page) break;
      meta = next.meta;
    }

    const chapters = Array.from(seen.values())
      .map((ch) => ({
        number: String(ch.number),
        title: ch.name && ch.name !== '.' ? ch.name : '',
        chapterId: makeCid(hid, slug, ch.number, ch.id),
        language: ch.language || language,
        releaseDate: ch.createdAt ? new Date(ch.createdAt * 1000).toISOString().slice(0, 10) : null,
      }))
      .sort((a, b) => parseFloat(a.number) - parseFloat(b.number));

    return chapters;
  });
}

async function clickChapterPage(
  p: Page,
  hid: string,
  language: string,
  targetPage: number,
): Promise<ChaptersResponse | null> {
  const wait = waitForApi<ChaptersResponse>(
    p,
    (u) => {
      try {
        const url = new URL(u);
        return (
          url.pathname === `/api/titles/${hid}/chapters` &&
          url.searchParams.get('page') === String(targetPage) &&
          (url.searchParams.get('language') || 'en').toLowerCase() === language.toLowerCase()
        );
      } catch {
        return false;
      }
    },
    15000,
  );
  const clicked = await p
    .evaluate((target: number) => {
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const visible = nodes.filter((n) => (n as HTMLElement).offsetParent !== null);
      const exact = visible.find((n) => (n.textContent || '').trim() === String(target));
      const next = visible.find(
        (n) =>
          /next/i.test((n as HTMLElement).getAttribute('aria-label') || '') ||
          /»|›/.test((n.textContent || '').trim()),
      );
      const el = exact || next;
      if (el) {
        (el as HTMLElement).click();
        return true;
      }
      return false;
    }, targetPage)
    .catch(() => false);
  if (!clicked) return null;
  return wait;
}

// ── chapter images ───────────────────────────────────────────────────────

export async function chapterImages(cid: string): Promise<string[]> {
  const { hid, slug, number, chapterId } = parseCid(cid);
  return withPage(async (p) => {
    const wait = waitForApi<any>(
      p,
      (u) => {
        try {
          return new URL(u).pathname === `/api/chapters/${chapterId}`;
        } catch {
          return false;
        }
      },
      30000,
    );
    // The reader route takes the internal chapter id, not the chapter number.
    const readerPath = slug
      ? `/title/${hid}-${slug}/chapter/${chapterId}`
      : `/title/${hid}/chapter/${chapterId}`;
    await gotoSpa(p, readerPath);
    const json = await wait;
    const pages = json?.data?.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      throw createHttpError(502, 'chapter images: SPA returned no pages');
    }
    return pages.map((pg: any) => pg.url).filter((u: any) => typeof u === 'string' && u.startsWith('http'));
  });
}

// ── browse listings (home / updated / newest / added) ───────────────────

export async function browseListing(sort: string, page = 1) {
  return withPage(async (p) => {
    const wait = waitForApi<TitlesResponse>(
      p,
      (u) => u.includes('/api/titles') && !new URL(u).searchParams.has('keyword'),
      30000,
    );
    await gotoSpa(p, `/browse?sort=${encodeURIComponent(sort)}`);
    const data = await wait;
    if (!data || !Array.isArray(data.items)) {
      throw createHttpError(502, 'browse: SPA did not return a listing');
    }
    return {
      results: data.items.map(mapTitleItem),
      currentPage: data.meta?.page || page,
      totalPages: data.meta?.lastPage || 1,
      hasNextPage: !!data.meta?.hasNext,
    };
  });
}
