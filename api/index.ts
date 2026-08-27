import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import createHttpError, { HttpError } from 'http-errors';

import { cache, TTL } from '../src/lib/cache';
import { shutdownBrowser } from '../src/browser/pool';
import {
  search,
  mangaInfo,
  mangaLanguages,
  mangaChapters,
  chapterImages,
  browseListing,
  parseMangaId,
} from '../src/scraper/mangafire';

const app = express();

app.use(cors());
app.use(express.json());

// Interactive UI: search → manga → chapters → pages, with copyable API URLs.
// Compiled file lives at dist/api/index.js, so public/ is two levels up.
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    engine: 'playwright-spa',
    message: 'MangaFire API — try /api/search/naruto',
  });
});

// ── image proxy (streams the image with the right Referer) ───────────────
app.get('/proxy-image', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const url = req.query.url as string;
    if (!url) return next(createHttpError(400, 'url query param required'));
    if (!/^https?:\/\//i.test(url)) return next(createHttpError(400, 'url must be http(s)'));

    const response = await axios.get(url, {
      responseType: 'stream',
      headers: { Referer: 'https://mangafire.to/' },
      timeout: 30000,
    });
    res.setHeader('Content-Type', String(response.headers['content-type'] || 'image/jpeg'));
    response.data.pipe(res);
  } catch (err) {
    next(createHttpError(502, 'Failed to proxy image'));
  }
});

app.get('/api/cache/stats', (_req: Request, res: Response) => {
  res.json(cache.stats());
});

app.get('/api/search/:keyword', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const keyword = req.params.keyword;
    const page = parseInt(req.query.page as string) || 1;
    res.json(
      await cache.getOrFetch(`search:${keyword}:${page}`, () => search(keyword, page), TTL.SEARCH),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/manga/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug, hid } = parseMangaId(req.params.id);
    res.json(
      await cache.getOrFetch(`manga-info:${hid}`, () => mangaInfo(hid, slug), TTL.MANGA_INFO),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/manga/:id/chapters', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug, hid } = parseMangaId(req.params.id);
    res.json(
      await cache.getOrFetch(`languages:${hid}`, () => mangaLanguages(hid, slug), TTL.CHAPTERS),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/manga/:id/chapters/:lng', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug, hid } = parseMangaId(req.params.id);
    const lng = req.params.lng;
    res.json(
      await cache.getOrFetch(
        `chapters:${hid}:${lng}`,
        () => mangaChapters(hid, slug, lng),
        TTL.CHAPTERS,
      ),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/chapter/:chapterId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cid = req.params.chapterId;
    res.json(
      await cache.getOrFetch(`chapter-imgs:${cid}`, () => chapterImages(cid), TTL.CHAPTER_IMGS),
    );
  } catch (e) {
    next(e);
  }
});

// ── listings ─────────────────────────────────────────────────────────────
app.get('/api/home', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(
      await cache.getOrFetch('home', () => browseListing('chapter_updated_at'), TTL.HOME),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/updated', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    res.json(
      await cache.getOrFetch(`updated:${page}`, () => browseListing('chapter_updated_at', page), TTL.LATEST),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/newest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    res.json(
      await cache.getOrFetch(`newest:${page}`, () => browseListing('year:desc', page), TTL.LATEST),
    );
  } catch (e) {
    next(e);
  }
});

app.get('/api/added', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    res.json(
      await cache.getOrFetch(`added:${page}`, () => browseListing('created_at:desc', page), TTL.LATEST),
    );
  } catch (e) {
    next(e);
  }
});

// ── 404 + error handler ──────────────────────────────────────────────────
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(createHttpError(404, 'Route not found'));
});

app.use((err: HttpError, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    status: err.status || 500,
  });
});

// Render/local: listen. (Vercel would consume the export, but this build
// targets Render — Chromium can't run in Vercel serverless.)
if (!process.env.VERCEL) {
  const PORT = parseInt(process.env.PORT || '3000');
  app.listen(PORT, () => console.log(`MangaFire API running on port ${PORT}`));
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await shutdownBrowser();
    process.exit(0);
  });
}

export default app;
