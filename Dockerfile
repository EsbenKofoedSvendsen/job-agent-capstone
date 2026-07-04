# Playwright's official image ships Chromium + all the system libraries it needs.
# Pin the tag to the playwright version in package.json so the browser matches.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Install deps first for better layer caching. Includes devDeps (Tailwind) so
# the CSS can be compiled during the build. better-sqlite3 ships prebuilt linux
# binaries, so no compile step is needed for it.
COPY package*.json ./
RUN npm ci

# Make sure the Chromium build matches the installed playwright package exactly.
RUN npx playwright install chromium

COPY . .

# Compile the Tailwind stylesheet (public/tailwind.css) used by the UI.
RUN npm run build:css

ENV NODE_ENV=production
EXPOSE 5179

CMD ["node", "src/server.js"]
