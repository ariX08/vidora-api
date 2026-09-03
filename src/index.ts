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

const TEMP_DIR = process.env.TEMP_DIR || path.join(os.tmpdir(), "vidora");
const MAX_DURATION_MIN = 30;

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Allow all origins so the Vercel frontend can call this API
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

const urlSchema = z.object({
  url: z.string().url().refine(
    (u) => /youtube\.com|youtu\.be/i.test(u),
    "Only YouTube URLs are supported"
  ),
});

const downloadSchema = urlSchema.extend({
  type: z.enum(["video", "audio"]).default("video"),
  quality: z.string().default("best"),
});

function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
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
    }, 5 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
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
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vidora-backend" });
});

app.post("/api/info", async (req, res) => {
  try {
    const { url } = urlSchema.parse(req.body);

    const { stdout } = await runYtDlp([
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--extractor-args",
      "youtube:player_client=web,android,tv",
      "--force-ipv4",
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
      duration: meta.duration ? formatDuration(meta.duration) : "\u2014",
      uploader: meta.uploader || meta.channel || "Unknown",
      videoId: meta.id,
      formats: (meta.formats || [])
        .filter((f: any) => f.ext && (f.vcodec !== "none" || f.acodec !== "none"))
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
      error: msg.includes("unavailable")
        ? "This video is unavailable or private."
        : msg.includes("yt-dlp") || msg.includes("ERROR")
          ? "Could not fetch video info. Try another URL."
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
      job.message = "Downloading\u2026";
      job.progress = 10;

      try {
        const args: string[] = [
          "--no-playlist",
          "--no-warnings",
          "-o",
          outTemplate,
          "--newline",
          "--progress",
          "--extractor-args",
          "youtube:player_client=web,android,tv",
          "--force-ipv4",
        ];

        if (type === "audio") {
          args.push("-x", "--audio-format", "mp3");
          if (quality === "320k") args.push("--audio-quality", "0");
          else if (quality === "192k") args.push("--audio-quality", "2");
          else args.push("--audio-quality", "5");
        } else {
          args.push("--merge-output-format", "mp4");
          if (quality === "best") {
            args.push("-f", "bv*+ba/b", "-S", "res,vcodec:h264");
          } else {
            const resMap: Record<string, string> = {
              "1080p": "1080",
              "720p": "720",
              "480p": "480",
              "360p": "360",
            };
            const r = resMap[quality] || "720";
            args.push("-f", "bv*+ba/b", "-S", `res:${r},vcodec:h264`);
          }
        }

        args.push(url);

        await new Promise<void>((resolve, reject) => {
          const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

          let lastProgress = 10;

          const onData = (d: Buffer) => {
            const line = d.toString();
            const match = line.match(/(\d+\.?\d*)%/);
            if (match) {
              const p = Math.min(90, Math.round(parseFloat(match[1]) * 0.8) + 10);
              if (p > lastProgress) {
                lastProgress = p;
                job.progress = p;
                job.message = `Downloading\u2026 ${Math.round(parseFloat(match[1]))}%`;
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
            else reject(new Error(`yt-dlp failed with code ${code}`));
          });

          proc.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(jobId));
        if (files.length === 0) throw new Error("Output file not found");

        const filePath = path.join(TEMP_DIR, files[0]);
        const filename = files[0].replace(jobId + ".", "vidora-");
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
        job.error = e.message || "Processing failed";
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
      ? `${req.protocol}://${req.get("host")}${job.downloadUrl}`
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

  const filename = job.filename || "download";
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/octet-stream");

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`Vidora backend listening on :${PORT}`);
  console.log(`Temp dir: ${TEMP_DIR}`);
});
