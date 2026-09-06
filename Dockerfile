FROM node:22-bookworm-slim

# System deps + latest yt-dlp (pip can lag; binary is freshest)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV PORT=4000
ENV TEMP_DIR=/tmp/vidora

EXPOSE 4000

CMD ["npx", "tsx", "src/index.ts"]
