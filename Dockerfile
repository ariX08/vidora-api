FROM node:22-bookworm-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && pip3 install --break-system-packages -U yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
RUN npm run build || true

ENV NODE_ENV=production
ENV PORT=4000
ENV TEMP_DIR=/tmp/vidora

EXPOSE 4000

CMD ["node", "dist/index.js"]
