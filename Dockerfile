# Playwright's image ships Chromium and its system libraries. Keep the tag in step with
# the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY public ./public

RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/server.js"]
