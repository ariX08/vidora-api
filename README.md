# Vidora API 🎬

Backend for **Vidora** — YouTube download & conversion service.

Deploy this to **Railway** (or any host that supports yt-dlp + FFmpeg).

Frontend: [vidora-frontend](https://github.com/ariX08/vidora-frontend)

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/info` | `{ "url": "..." }` → video metadata |
| POST | `/api/download` | `{ "url", "type": "video"|"audio", "quality" }` → `{ "jobId" }` |
| GET | `/api/job/:id` | Job status + progress |
| GET | `/api/file/:id` | Stream the finished file |

## Local development

```bash
npm install
# Requires yt-dlp and ffmpeg on PATH
npm run dev
```

## Railway / Docker

This repo includes a `Dockerfile` that installs Node, yt-dlp and FFmpeg.

Environment variables:

```
PORT=4000
TEMP_DIR=/tmp/vidora
ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:3000
```

> **Note**: Railway has previously restricted yt-dlp usage related to copyrighted content. If deployment is blocked, use Fly.io, a VPS, or self-host.

## Tech

- Node.js + Express + TypeScript
- yt-dlp + FFmpeg
- Zod validation
- In-memory job store (swap for Redis/Supabase for scale)
