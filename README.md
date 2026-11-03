# Vidora API 🎬

Backend for **Vidora** — fast YouTube download & conversion service.

Deploy to **Railway / Fly.io / any host** that can run yt-dlp + FFmpeg.

Frontend: [vidora-frontend](https://github.com/ariX08/vidora-frontend)

## What’s new (speed + anti-bot)

- **Parallel client probing** — top 3 player clients race; first success wins (much lower latency on bot walls).
- **Client memory** — remembers which client worked last and prefers it.
- **Concurrent fragments** (`YTDLP_CONCURRENT_FRAGMENTS=8`) — multi-connection DASH/HLS downloads.
- **2026 client order**: `tv`, `tv_simply`, `android`, `android_vr`, `web_embedded`, `mweb`, `web`.
- **Deno** in Docker for YouTube JS / n-challenge solving.
- **Proxy support** via `YTDLP_PROXY` (residential proxies are the strongest defence against datacenter bot blocks).
- **Cookies** still supported via `YTDLP_COOKIES_FILE`.
- Single metadata pass (no extra title fetch).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health + active client order + proxy status |
| POST | `/api/info` | `{ "url": "..." }` → video metadata (+ which client worked) |
| POST | `/api/download` | `{ "url", "type": "video"|"audio", "quality" }` → `{ "jobId" }` |
| GET | `/api/job/:id` | Job status + progress + client used |
| GET | `/api/file/:id` | Stream the finished file |

## Local development

```bash
npm install
# Requires yt-dlp + ffmpeg on PATH (Deno recommended)
npm run dev
```

## Environment variables

```bash
PORT=4000
TEMP_DIR=/tmp/vidora
MAX_DURATION_MIN=30

# Speed
YTDLP_CONCURRENT_FRAGMENTS=8          # 4–16 recommended

# Anti-bot (pick what you need)
YTDLP_PLAYER_CLIENTS=tv,tv_simply,android,android_vr,web_embedded,mweb,web
YTDLP_PROXY=http://user:pass@residential-proxy:port   # strongest option
YTDLP_COOKIES_FILE=/path/to/cookies.txt               # for age-restricted / logged-in
```

## Docker

```bash
docker build -t vidora-api .
docker run -p 4000:4000 \
  -e YTDLP_PROXY=http://user:pass@host:port \
  -e YTDLP_CONCURRENT_FRAGMENTS=8 \
  vidora-api
```

> **Note**: Pure datacenter IPs still get blocked by YouTube. A residential / mobile proxy (`YTDLP_PROXY`) or a non-cloud host is the most reliable long-term fix. Client rotation + Deno + force-IPv4 handle a large fraction of cases without a proxy.

## Tech

- Node.js + Express + TypeScript
- yt-dlp (latest binary) + FFmpeg + Deno
- Zod validation
- In-memory job store (swap for Redis if you scale horizontally)
