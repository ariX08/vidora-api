FROM node:22-bookworm-slim

# System deps + Python (yt-dlp plugins) + Deno + FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    git \
    unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/bin:${PATH}"
ENV DENO_DIR=/tmp/deno
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# yt-dlp + POT plugin
RUN pip3 install -U --no-cache-dir \
    yt-dlp \
    bgutil-ytdlp-pot-provider

# Build bgutil POT HTTP server
WORKDIR /opt/bgutil
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git . \
    && cd server \
    && npm ci \
    && ./node_modules/.bin/tsc \
    && npm prune --omit=dev \
    && npm cache clean --force

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=4000
ENV TEMP_DIR=/tmp/vidora
ENV YTDLP_CONCURRENT_FRAGMENTS=8
ENV BGUTIL_POT_URL=http://127.0.0.1:4416

EXPOSE 4000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
