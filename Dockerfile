FROM node:20-slim

# Install Google Chrome Stable (real Chrome, not Chromium — matches TLS fingerprint)
RUN apt-get update && apt-get install -y \
  wget gnupg ca-certificates fonts-liberation xvfb \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
  && apt-get update \
  && apt-get install -y google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# Install Playwright system deps for connecting to Chrome
RUN npx playwright install-deps chromium

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN npm run install:all

# Copy source and build
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV DISPLAY=:99
EXPOSE 3001

# Start Xvfb virtual display so Chrome runs headful (Google blocks headless OAuth)
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp & sleep 1 && node server/dist/index.js"]
