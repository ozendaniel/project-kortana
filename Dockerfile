FROM node:20-slim

# Install Google Chrome Stable (real Chrome, not Chromium — matches TLS fingerprint)
RUN apt-get update && apt-get install -y \
  wget gnupg ca-certificates fonts-liberation \
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
EXPOSE 3001

CMD ["node", "server/dist/index.js"]
