# Playwright's official image already has Chromium + all OS dependencies installed,
# which is the hard part of running a headless browser on Railway.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Railway sets PORT/etc automatically; this bot doesn't listen on a port, it just runs.
CMD ["node", "bot.js"]
