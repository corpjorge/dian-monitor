# Official Playwright image: Chromium and every system library it needs are
# already installed and version-matched to the Playwright npm package.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    # The container runs one check and exits — Railway Cron restarts it.
    HEADLESS=true \
    # Chromium is already in the image; don't re-download it on npm install.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Install dependencies first so this layer is cached across code changes.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Application code.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Compile once at build time: a type error fails the build instead of the
# 3 a.m. cron run.
RUN npm run typecheck

# Writable directories for state and diagnostics. Mount a Railway Volume on
# /app/data if you want the deduplication state to survive restarts.
RUN mkdir -p /app/data /app/screenshots && chown -R pwuser:pwuser /app

# The Playwright image ships this non-root user; use it.
USER pwuser

CMD ["npm", "run", "monitor"]
