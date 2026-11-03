FROM node:22-bookworm-slim

# System deps + Deno (for YouTube n-challenge / EJS) + latest yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
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
# Parallel fragment downloads (big speed win on DASH/HLS)
ENV YTDLP_CONCURRENT_FRAGMENTS=8
# Override client order if needed: tv,tv_simply,android,...
# ENV YTDLP_PLAYER_CLIENTS=tv,android,web_embedded
# Optional residential proxy (strongest anti-bot measure)
# ENV YTDLP_PROXY=http://user:pass@host:port
# Optional cookies file path inside container
# ENV YTDLP_COOKIES_FILE=/app/cookies.txt

EXPOSE 4000

CMD ["npx", "tsx", "src/index.ts"]
