# Playwright base image ships Chromium + all system dependencies.
# Keep the tag in sync with the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY api ./api
COPY src ./src
COPY public ./public
RUN npx tsc && npm prune --omit=dev

ENV NODE_ENV=production \
    HEADLESS=false \
    POOL_SIZE=3 \
    PORT=3000

EXPOSE 3000
# xvfb-run provides a virtual display so Chromium can run headed —
# Cloudflare's managed challenge does not auto-resolve in true headless mode.
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1366x900x24", "node", "dist/api/index.js"]
