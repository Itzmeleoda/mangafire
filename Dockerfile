# Playwright base image ships Chromium + system dependencies.
# Keep the tag in sync with the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Xvfb + xauth: headed Chromium on a virtual display. Cloudflare's managed
# challenge does not auto-resolve in true headless mode.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx tsc && npm prune --omit=dev && chmod +x entrypoint.sh

ENV NODE_ENV=production \
    HEADLESS=false \
    POOL_SIZE=2 \
    PORT=3000

EXPOSE 3000
CMD ["sh", "/app/entrypoint.sh"]
