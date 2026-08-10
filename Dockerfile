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
# /app/data so the deduplication state and the run counter survive restarts.
RUN mkdir -p /app/data /app/screenshots

# The container runs as root on purpose. A Railway Volume is mounted at runtime
# owned by root, *over* whatever the image created, so a non-root user cannot
# write to it — the state file then fails to save and the periodic summary
# never fires. Chromium already runs with --no-sandbox (required in any
# container), so switching to `pwuser` would buy no isolation here.
CMD ["npm", "run", "monitor"]
