import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const PORT = process.env.PORT || 4000;

app.set("trust proxy", 1);

const TEMP_DIR = process.env.TEMP_DIR || path.join(os.tmpdir(), "vidora");
const MAX_DURATION_MIN = 30;

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "1mb" }));

const jobs = new Map<
  string,
  {
    status: "pending" | "processing" | "completed" | "failed";
    progress: number;
    message?: string;
    downloadUrl?: string;
    filename?: string;
    error?: string;
    filePath?: string;
    createdAt: number;
  }
>();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > 1000 * 60 * 60) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try {
          fs.unlinkSync(job.filePath);
        } catch {}
      }
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

function normalizeYouTubeUrl(raw: string): string {
  let u = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^(www\.)?(youtube\.com|youtu\.be)\//i.test(u)) return `https://${u}`;
  return u;
}

const urlSchema = z.object({
  url: z
    .string()
    .min(1)
    .transform(normalizeYouTubeUrl)
    .pipe(
      z
        .string()
        .url()
        .refine(
          (u) => /youtube\.com|youtu\.be/i.test(u),
          "Only YouTube URLs are supported"
        )
    ),
});

const downloadSchema = urlSchema.extend({
  type: z.enum(["video", "audio"]).default("video"),
  quality: z.string().default("best"),
});

function runYtDlp(
  args: string[],
  timeoutMs = 5 * 60 * 1000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("yt-dlp timed out"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const errText = (stderr || stdout || "").trim();
        // Pick the most useful ERROR line
        const lines = errText.split("\n").filter(Boolean);
        const errorLine =
          lines.find((l) => /ERROR:/i.test(l)) ||
          lines.slice(-3).join(" ") ||
          `yt-dlp exited with code ${code}`;
        reject(new Error(errorLine.slice(0, 400)));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function publicBaseUrl(req: express.Request): string {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "localhost")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function sanitizeFilename(title: string, maxLen = 80): string {
  let name = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s\-\u00C0-\u024F.()\[\]]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) name = "vidora-download";
  if (name.length > maxLen) name = name.slice(0, maxLen).trim();
  return name;
}

function contentTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    opus: "audio/opus",
    wav: "audio/wav",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

function videoFormatSelector(quality: string): string {
  const heightMap: Record<string, number> = {
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
  };

  if (quality === "best" || !heightMap[quality]) {
    return "bestvideo*+bestaudio/best";
  }

  const h = heightMap[quality];
  return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
}

const YT_COMMON_ARGS = [
  "--no-playlist",
  "--no-warnings",
  "--force-ipv4",
  // Multiple clients improves success rate (web-only often fails)
  "--extractor-args",
  "youtube:player_client=android,web,ios,tv",
];

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vidora-backend" });
});

app.post("/api/info", async (req, res) => {
  try {
    const { url } = urlSchema.parse(req.body);

    const { stdout } = await runYtDlp([
      "--dump-json",
      ...YT_COMMON_ARGS,
      url,
    ]);

    const meta = JSON.parse(stdout);

    if (meta.duration && meta.duration > MAX_DURATION_MIN * 60) {
      return res.status(400).json({
        error: `Videos longer than ${MAX_DURATION_MIN} minutes are not supported`,
      });
    }

    res.json({
      title: meta.title || "Untitled",
      thumbnail:
        meta.thumbnail ||
        (meta.thumbnails && meta.thumbnails[meta.thumbnails.length - 1]?.url) ||
        "",
      duration: meta.duration ? formatDuration(meta.duration) : "-",
      uploader: meta.uploader || meta.channel || "Unknown",
      videoId: meta.id,
      formats: (meta.formats || [])
        .filter(
          (f: any) => f.ext && (f.vcodec !== "none" || f.acodec !== "none")
        )
        .slice(0, 20)
        .map((f: any) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || f.format_note,
          filesize: f.filesize || f.filesize_approx,
        })),
    });
  } catch (e: any) {
    console.error("info error:", e.message);
    const msg = String(e.message || "");
    res.status(400).json({
      error: /unavailable|private|not available/i.test(msg)
        ? "This video is unavailable or private."
        : /ERROR:|yt-dlp/i.test(msg)
          ? msg.replace(/^ERROR:\s*/i, "").slice(0, 200)
          : e.message || "Invalid request",
    });
  }
});

app.post("/api/download", async (req, res) => {
  try {
    const { url, type, quality } = downloadSchema.parse(req.body);
    const jobId = uuidv4();
    const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

    jobs.set(jobId, {
      status: "pending",
      progress: 0,
      message: "Queued",
      createdAt: Date.now(),
    });

    res.json({ jobId });

    (async () => {
      const job = jobs.get(jobId)!;
      job.status = "processing";
      job.message = "Downloading...";
      job.progress = 10;

      try {
        let videoTitle = "vidora-download";
        try {
          const { stdout: titleOut } = await runYtDlp([
            "--print",
            "%(title)s",
            ...YT_COMMON_ARGS,
            url,
          ]);
          const t = titleOut.trim().split("\n")[0];
          if (t) videoTitle = t;
        } catch {
          // keep fallback
        }

        const baseArgs: string[] = [
          ...YT_COMMON_ARGS,
          "-o",
          outTemplate,
          "--newline",
          "--progress",
        ];

        // Build candidate arg lists: primary format, then simpler fallbacks
        const attempts: string[][] = [];

        if (type === "audio") {
          const audioQ =
            quality === "320k" ? "0" : quality === "192k" ? "2" : "5";
          attempts.push([
            ...baseArgs,
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            audioQ,
            url,
          ]);
        } else {
          const fmt = videoFormatSelector(quality);
          // Primary
          attempts.push([
            ...baseArgs,
            "--merge-output-format",
            "mp4",
            "-f",
            fmt,
            url,
          ]);
          // Fallback: no height filter
          attempts.push([
            ...baseArgs,
            "--merge-output-format",
            "mp4",
            "-f",
            "bestvideo*+bestaudio/best",
            url,
          ]);
          // Last resort: single progressive stream
          attempts.push([...baseArgs, "-f", "best", url]);
        }

        let lastErr: Error | null = null;

        for (let i = 0; i < attempts.length; i++) {
          const args = attempts[i];
          console.log(`yt-dlp attempt ${i + 1}:`, args.join(" "));
          job.message =
            i === 0 ? "Downloading..." : `Retrying (attempt ${i + 1})...`;

          try {
            await new Promise<void>((resolve, reject) => {
              const proc = spawn("yt-dlp", args, {
                stdio: ["ignore", "pipe", "pipe"],
              });

              let lastProgress = 10;
              let stderr = "";

              const onData = (d: Buffer) => {
                const line = d.toString();
                stderr += line;
                const match = line.match(/(\d+\.?\d*)%/);
                if (match) {
                  const p = Math.min(
                    90,
                    Math.round(parseFloat(match[1]) * 0.8) + 10
                  );
                  if (p > lastProgress) {
                    lastProgress = p;
                    job.progress = p;
                    job.message = `Downloading... ${Math.round(parseFloat(match[1]))}%`;
                  }
                }
              };

              proc.stdout.on("data", onData);
              proc.stderr.on("data", onData);

              const timeout = setTimeout(() => {
                proc.kill("SIGKILL");
                reject(new Error("Download timed out"));
              }, 8 * 60 * 1000);

              proc.on("close", (code) => {
                clearTimeout(timeout);
                if (code === 0) resolve();
                else {
                  const lines = stderr.split("\n").filter(Boolean);
                  const errorLine =
                    lines.find((l) => /ERROR:/i.test(l)) ||
                    lines.slice(-2).join(" ") ||
                    `yt-dlp failed with code ${code}`;
                  reject(new Error(errorLine.slice(0, 400)));
                }
              });

              proc.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
              });
            });

            // Success — stop trying fallbacks
            lastErr = null;
            break;
          } catch (err: any) {
            lastErr = err;
            console.error(`attempt ${i + 1} failed:`, err.message);
            // Clean partial files before next attempt
            try {
              for (const f of fs.readdirSync(TEMP_DIR)) {
                if (f.startsWith(jobId)) {
                  fs.unlinkSync(path.join(TEMP_DIR, f));
                }
              }
            } catch {}
          }
        }

        if (lastErr) throw lastErr;

        const files = fs
          .readdirSync(TEMP_DIR)
          .filter((f) => f.startsWith(jobId));
        if (files.length === 0) throw new Error("Output file not found");

        const filePath = path.join(TEMP_DIR, files[0]);
        const ext =
          path.extname(files[0]).replace(".", "") ||
          (type === "audio" ? "mp3" : "mp4");
        const safeTitle = sanitizeFilename(videoTitle);
        const filename = `${safeTitle}.${ext}`;

        const stats = fs.statSync(filePath);

        job.status = "completed";
        job.progress = 100;
        job.message = "Ready";
        job.filePath = filePath;
        job.filename = filename;
        job.downloadUrl = `/api/file/${jobId}`;

        if (stats.size > 2 * 1024 * 1024 * 1024) {
          fs.unlinkSync(filePath);
          throw new Error("File too large");
        }
      } catch (e: any) {
        job.status = "failed";
        const raw = String(e.message || "Processing failed");
        // Friendlier messages
        let friendly = raw.replace(/^ERROR:\s*/i, "");
        if (/unavailable|private/i.test(friendly))
          friendly = "This video is unavailable or private.";
        else if (/Sign in|login required/i.test(friendly))
          friendly = "This video requires sign-in and cannot be downloaded.";
        else if (/age/i.test(friendly))
          friendly = "Age-restricted videos are not supported.";
        job.error = friendly.slice(0, 250);
        job.message = job.error;
        console.error("download job error:", e);
      }
    })();
  } catch (e: any) {
    res.status(400).json({ error: e.message || "Invalid request" });
  }
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    message: job.message,
    downloadUrl: job.downloadUrl
      ? `${publicBaseUrl(req)}${job.downloadUrl}`
      : undefined,
    filename: job.filename,
    error: job.error,
  });
});

app.get("/api/file/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "completed" || !job.filePath) {
    return res.status(404).json({ error: "File not available" });
  }
  if (!fs.existsSync(job.filePath)) {
    return res.status(404).json({ error: "File expired" });
  }

  const filename = job.filename || "vidora-download.mp4";
  const ext = path.extname(filename).replace(".", "") || "mp4";

  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
  );
  res.setHeader("Content-Type", contentTypeForExt(ext));
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`Vidora backend listening on :${PORT}`);
  console.log(`Temp dir: ${TEMP_DIR}`);
});
