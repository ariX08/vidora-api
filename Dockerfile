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

# Copy package files first for better layer caching
COPY package.json ./

# Install ALL dependencies (including TypeScript for the build)
RUN npm install

# Copy source code
COPY . .

# Compile TypeScript → JavaScript
RUN npx tsc

ENV NODE_ENV=production
ENV PORT=4000
ENV TEMP_DIR=/tmp/vidora

EXPOSE 4000

# Start the compiled app
CMD ["node", "dist/index.js"]
