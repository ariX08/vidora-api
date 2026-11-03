# Vidora API 🎬

Backend for **Vidora** — YouTube download & conversion with built-in bot-bypass.

## What’s included

- **bgutil PO Token provider** (runs inside the same container)
- yt-dlp + FFmpeg + Deno
- Parallel player-client probing
- Concurrent fragment downloads
- Production-friendly error messages

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health + POT status |
| POST | `/api/info` | `{ "url" }` → metadata |
| POST | `/api/download` | `{ "url", "type", "quality" }` → `{ "jobId" }` |
| GET | `/api/job/:id` | Status / progress |
| GET | `/api/file/:id` | Download file |

## Deploy (Docker)

```bash
docker build -t vidora-api .
docker run -p 4000:4000 vidora-api
```

The entrypoint automatically starts:

1. bgutil POT HTTP server on `127.0.0.1:4416`
2. The Node API on port 4000

yt-dlp is configured to talk to the POT server, so many bot walls are handled without an external proxy.

## Optional env vars

```bash
PORT=4000
TEMP_DIR=/tmp/vidora
MAX_DURATION_MIN=30
YTDLP_CONCURRENT_FRAGMENTS=8
YTDLP_PLAYER_CLIENTS=tv,mweb,web_embedded,android,web

# Optional — still the strongest option if needed
YTDLP_PROXY=http://user:pass@host:port

# Optional cookies for age-restricted / extra reliability
YTDLP_COOKIES_FILE=/path/to/cookies.txt

# Only change if you run POT elsewhere
BGUTIL_POT_URL=http://127.0.0.1:4416
```

## Notes

- PO tokens help a lot on flagged IPs but are **not a 100% guarantee**.
- Extremely aggressive datacenter blocks may still need a residential proxy or cookies.
- User-facing errors are soft. Real yt-dlp errors stay in the server logs.
