FROM node:22-bookworm-slim

# Deno (JS challenges) + latest yt-dlp + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && deno --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/bin:${PATH}"
ENV DENO_DIR=/tmp/deno

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=4000
ENV TEMP_DIR=/tmp/vidora
ENV YTDLP_CONCURRENT_FRAGMENTS=8

EXPOSE 4000

CMD ["npx", "tsx", "src/index.ts"]
