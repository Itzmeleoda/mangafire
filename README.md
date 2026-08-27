# MangaFire API

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Itzmeleoda/mangafire)

> **One-click deploy:** the button above opens Render with everything
> pre-filled from `render.yaml` (Docker runtime, env vars, start command).
> Sign in to Render, review, and click **Apply** — that's it.

A scraper API for **mangafire.to** built with Express + **Playwright**.

mangafire.to was rebuilt as a React SPA behind Cloudflare. Every data endpoint
(`/api/titles`, `/api/chapters/...`) requires a client-side `vrf` token minted by
obfuscated, URL-bound JavaScript — plain HTTP scraping gets `403 {"message":"Missing token."}`.
So this API drives a real headless browser and **intercepts the SPA's own API
responses** instead of scraping HTML. Same technique as the Electron Manga Bot's
`mangafire.py` fallback, but running server-side so your PC doesn't carry the load.

Response shapes match the legacy aizen-manga contract, so the Electron app's
`sources/mangafire.py` works against it unchanged via its `MANGAFIRE_API` env var.

## Interactive web UI

Open your deployed URL (e.g. `https://mangafire-api.onrender.com`) in a browser.
You get a dark-themed console where you can:

- **Search** any manga and see real covers/results
- **Open a series** — info, genres, status, language picker
- **Browse all chapters** (pagination is walked server-side)
- **Open a chapter** and preview every page image
- **Copy any API URL** with one click — the exact endpoint to paste into your
  app (info URL, chapters URL, pages URL, all image URLs, or the base URL for
  `MANGAFIRE_API`)

The JSON health check moved to `GET /health`.

## Architecture

```
Electron app ──HTTP──▶ this API (Render) ──Playwright──▶ mangafire.to SPA
                          │                                  │
                          └── intercepts ◀── /api/titles, /api/chapters (vrf minted by SPA)
```

- One persistent Chromium context, launched on first request; Cloudflare is
  cleared once on a warm-up page.
- A small pool of pages (`POOL_SIZE`, default 3) serves concurrent requests.
- In-memory TTL cache with in-flight dedup shields the site from duplicate scrapes.
- Chapter ids are compound tokens `hid~slug~number~chapterId` so the images
  endpoint can rebuild a reader URL from a cid alone.

## Routes

| Route | Returns |
|---|---|
| `GET /` | interactive web UI (search → chapters → pages, copy API URLs) |
| `GET /health` | health + engine info (JSON) |
| `GET /api/search/:keyword?page=1` | `{currentPage, totalPages, results:[{id,title,poster,type}]}` |
| `GET /api/manga/:id` | `{mangaInfo:{title,altTitles,poster,status,type,description,author,published,genres,rating}, languages}` |
| `GET /api/manga/:id/chapters` | language list `[{id,title,chapters,logo}]` |
| `GET /api/manga/:id/chapters/:lng` | chapter list `[{number,title,chapterId,language,releaseDate}]` (walks pagination, dedupes by number) |
| `GET /api/chapter/:chapterId` | list of page image URLs (strings) |
| `GET /api/home`, `/api/updated`, `/api/newest`, `/api/added` | browse listings |
| `GET /proxy-image?url=` | streams an image with the correct `Referer` |
| `GET /api/cache/stats` | cache entries + TTLs |

Manga ids use the legacy `slug.hid` format (e.g. `solo-leveling.lrmyz`).
Errors are `{ "error": <message>, "status": <number> }`.

Image URLs returned by `/api/chapter/:id` are direct CDN links
(`*.mfcdn*.xyz`) that download with a plain `Referer: https://mangafire.to/`
header — no cookies needed. Your app downloads the pages itself.

## Local development

```bash
npm install
npx playwright install chromium
npm run build
# headed mode (visible browser) is useful locally if Cloudflare challenges:
HEADLESS=false PORT=3000 node dist/api/index.js
```

Then:

```bash
curl "http://localhost:3000/api/search/solo%20leveling"
curl "http://localhost:3000/api/manga/solo-leveling.lrmyz/chapters/en"
curl "http://localhost:3000/api/chapter/<cid from the list>"
```

## Deploy on Render

Chromium can't run on Vercel serverless — use Render (or any Docker host).

**One click:** press the **Deploy to Render** button at the top of this README.
Render reads `render.yaml` and pre-fills the service (Docker runtime, free plan,
env vars, health check on `/`). Sign in, click **Apply**, done.

Manual alternative: Render → New → **Blueprint** → select this repo, or
New → **Web Service** with runtime **Docker** (uses `Dockerfile`, based on the
official Playwright image).

First request after deploy takes ~30–60s (browser launch + Cloudflare warm-up);
afterwards searches take ~10–15s and chapter images ~3s.

> Free-tier note: Render free instances sleep after inactivity; the first request
> after sleep pays the cold-start cost again. A paid instance stays warm.

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `HEADLESS` | `false` | keep `false` on servers: Cloudflare's managed challenge won't auto-resolve in true headless mode. The Docker image runs headed Chromium inside a virtual display (Xvfb). |
| `POOL_SIZE` | `2` | concurrent browser pages (memory ≈ 150–250 MB each; keep at 2 on Render's 512 MB free tier) |
| `BROWSER_PROFILE_DIR` | OS temp | persistent browser profile location |

## Wiring the Electron "Manga Bot"

`Manga Bot/sources/mangafire.py` reads the API base from `MANGAFIRE_API`:

```bash
set MANGAFIRE_API=https://<your-app>.onrender.com
```

The app uses it as its primary path (search → info → chapters → image URLs)
and only falls back to its local browser if the API is down.

## Verified locally (2026-08-27)

- `search "solo leveling"` → real results, ~13s
- `manga/solo-leveling.lrmyz` → full metadata + languages
- `chapters/en` → 241 unique chapters (pagination walked, duplicates removed), ~14s
- `chapter/lrmyz~solo-leveling~1~8113167` → 106 page URLs, ~3s
- first page URL downloaded with curl + Referer → valid 169 KB JPEG

## Limitations & caveats

- **Cold start**: first request launches the browser and clears Cloudflare (~30–60s).
- **Chapter pagination** is walked by clicking the SPA's pagination controls;
  very long series cap at ~60 page-clicks as a safety bound.
- **Search pagination** beyond page 1 depends on the SPA's pagination controls
  being clickable; page 1 is always reliable.
- If mangafire rotates its protection, the interceptors may need selector/URL
  updates in `src/scraper/mangafire.ts`.
- This scrapes a third-party site — keep request volume low, personal use only.
