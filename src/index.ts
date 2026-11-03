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
const MAX_DURATION_MIN = Number(process.env.MAX_DURATION_MIN || 30);
const PROXY_URL = (process.env.YTDLP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();
const CONCURRENT_FRAGMENTS = Math.max(1, Math.min(8, Number(process.env.YTDLP_CONCURRENT_FRAGMENTS || 4)));
const BGUTIL_POT_URL = (process.env.BGUTIL_POT_URL || "http://127.0.0.1:4416").trim();

const COOKIES_PATH = path.join(TEMP_DIR, "cookies.txt");

function looksLikeNetscape(text: string): boolean {
  return (
    /# Netscape HTTP Cookie File/i.test(text) ||
    /\.youtube\.com\s/i.test(text) ||
    /youtube\.com\t/i.test(text)
  );
}

function resolveCookiesFile(): string {
  const fromFile = (process.env.YTDLP_COOKIES_FILE || "").trim();
  if (fromFile && fs.existsSync(fromFile)) {
    console.log("[vidora] cookies from file:", fromFile);
    return fromFile;
  }

  // Prefer base64 — survives Render multiline env mangling
  const b64 = (process.env.YTDLP_COOKIES_B64 || "").trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (!looksLikeNetscape(decoded)) {
        console.warn("[vidora] YTDLP_COOKIES_B64 decoded but doesn't look like Netscape cookies");
      }
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      fs.writeFileSync(COOKIES_PATH, decoded.endsWith("\n") ? decoded : decoded + "\n", "utf8");
      console.log("[vidora] cookies from YTDLP_COOKIES_B64, bytes=", decoded.length);
      return COOKIES_PATH;
    } catch (e) {
      console.error("[vidora] failed to decode YTDLP_COOKIES_B64", e);
    }
  }

  const raw = (process.env.YTDLP_COOKIES || "").trim();
  if (!raw) return "";

  // Handle both real newlines and escaped \\n from env UIs
  let content = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
  // Some UIs turn tabs into spaces — try to recover common pattern
  if (!/\t/.test(content) && /\.youtube\.com\s+TRUE\s+/i.test(content)) {
    content = content.replace(/(\S)\s+(TRUE|FALSE)\s+/gi, "$1\t$2\t");
  }

  if (!looksLikeNetscape(content)) {
    console.warn("[vidora] YTDLP_COOKIES set but content does not look like Netscape cookies.txt");
  }

  try {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(COOKIES_PATH, content.endsWith("\n") ? content : content + "\n", "utf8");
    console.log("[vidora] cookies from YTDLP_COOKIES, bytes=", content.length);
    return COOKIES_PATH;
  } catch (e) {
    console.error("[vidora] failed to write cookies", e);
    return "";
  }
}

const COOKIES_FILE = resolveCookiesFile();
const HAS_COOKIES = Boolean(COOKIES_FILE && fs.existsSync(COOKIES_FILE));

// Sequential by default — parallel races burn CPU/RAM on free Render and confuse YouTube
const PLAYER_CLIENTS = (
  process.env.YTDLP_PLAYER_CLIENTS ||
  (HAS_COOKIES ? "tv,web,mweb,android" : "tv,mweb,android,web_embedded")
)
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

let lastGoodClient: string | null = null;
const clientSuccess = new Map<string, number>();

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
    client?: string;
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
  for (const [c, ts] of clientSuccess) {
    if (now - ts > 30 * 60 * 1000) clientSuccess.delete(c);
  }
}, 5 * 60 * 1000);

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

function orderedClients(): string[] {
  return [...PLAYER_CLIENTS].sort((a, b) => {
    const sa = clientSuccess.get(a) || 0;
    const sb = clientSuccess.get(b) || 0;
    if (sa !== sb) return sb - sa;
    if (a === lastGoodClient) return -1;
    if (b === lastGoodClient) return 1;
    return 0;
  });
}

function cookieArgs(): string[] {
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    return ["--cookies", COOKIES_FILE];
  }
  return [];
}

function proxyArgs(): string[] {
  if (PROXY_URL) return ["--proxy", PROXY_URL];
  return [];
}

function baseYtArgs(client: string): string[] {
  const extractorParts = [`youtube:player_client=${client}`];
  if (BGUTIL_POT_URL) {
    extractorParts.push(`youtubepot-bgutilhttp:base_url=${BGUTIL_POT_URL}`);
  }

  return [
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    "--socket-timeout", "12",
    "--retries", "1",
    "--fragment-retries", "2",
    "--concurrent-fragments", String(CONCURRENT_FRAGMENTS),
    "--extractor-args",
    extractorParts.join(";"),
    ...cookieArgs(),
    ...proxyArgs(),
  ];
}

function videoFormatForQuality(quality: string): string {
  const map: Record<string, string> = {
    best: "bv*+ba/b",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
    "720p": "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    "480p": "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b",
    "360p": "bv*[height<=360]+ba/b[height<=360]/bv*+ba/b",
  };
  return map[quality] || map.best;
}

function isBotBlock(msg: string): boolean {
  return /Sign in to confirm|not a bot|bot check|PO Token|confirm you.re not|HTTP Error 403|blocked|LOGIN_REQUIRED/i.test(
    msg
  );
}

function runYtDlp(
  args: string[],
  timeoutMs = 22_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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
        const lines = errText.split("\n").filter(Boolean);
        const errorLine =
          lines.find((l) => /ERROR:/i.test(l)) ||
          lines.slice(-3).join(" ") ||
          `yt-dlp exited with code ${code}`;
        reject(new Error(errorLine.slice(0, 600)));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Sequential clients — faster overall on free tier + less IP pressure */
async function runYtDlpWithFallback(
  buildArgs: (client: string) => string[],
  timeoutMs = 20_000
): Promise<{ stdout: string; stderr: string; client: string }> {
  const clients = orderedClients();
  if (clients.length === 0) throw new Error("No player clients configured");

  const errors: Error[] = [];

  for (const client of clients) {
    try {
      const r = await runYtDlp(buildArgs(client), timeoutMs);
      lastGoodClient = client;
      clientSuccess.set(client, Date.now());
      return { ...r, client };
    } catch (e: any) {
      errors.push(e);
      console.warn(`yt-dlp client=${client} failed:`, String(e.message || e).slice(0, 180));
      // If clearly bot-blocked, still try next client (cookies + different client can help)
    }
  }

  throw errors[errors.length - 1] || new Error("All YouTube clients failed");
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

function friendlyError(raw: string): string {
  const msg = String(raw || "").replace(/^ERROR:\s*/i, "");

  if (isBotBlock(msg) || /timed out|No progress/i.test(msg)) {
    return "This video can’t be downloaded right now. Please try again in a few minutes.";
  }
  if (/unavailable|private|not available/i.test(msg)) {
    return "This video is unavailable or private.";
  }
  if (/age/i.test(msg)) {
    return "This video is age-restricted and can’t be downloaded.";
  }
  if (/Unsupported URL|Only YouTube/i.test(msg)) {
    return "Please enter a valid YouTube link.";
  }
  return "Something went wrong while processing this video. Please try again.";
}

app.get("/health", (_req, res) => {
  let cookieBytes = 0;
  let cookieLooksOk = false;
  try {
    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
      const t = fs.readFileSync(COOKIES_FILE, "utf8");
      cookieBytes = t.length;
      cookieLooksOk = looksLikeNetscape(t);
    }
  } catch {}

  res.json({
    status: "ok",
    service: "vidora-backend",
    clients: orderedClients(),
    lastGoodClient,
    concurrentFragments: CONCURRENT_FRAGMENTS,
    potProvider: BGUTIL_POT_URL,
    cookiesConfigured: HAS_COOKIES,
    cookiesBytes: cookieBytes,
    cookiesLookValid: cookieLooksOk,
    proxyConfigured: Boolean(PROXY_URL),
  });
});

app.post("/api/info", async (req, res) => {
  try {
    const { url } = urlSchema.parse(req.body);

    const { stdout, client } = await runYtDlpWithFallback(
      (c) => ["--dump-json", "--no-download", ...baseYtArgs(c), url],
      22_000
    );

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
      client,
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
    res.status(400).json({
      error: friendlyError(String(e.message || "Invalid request")),
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
      job.message = "Getting video info…";
      job.progress = 5;

      try {
        let videoTitle = "vidora-download";
        let preferredClient = lastGoodClient || orderedClients()[0];

        try {
          const { stdout: metaOut, client } = await runYtDlpWithFallback(
            (c) => [
              "--print",
              "%(title)s",
              "--skip-download",
              ...baseYtArgs(c),
              url,
            ],
            20_000
          );
          const t = metaOut.trim().split("\n")[0];
          if (t) videoTitle = t;
          preferredClient = client;
          job.client = client;
          job.message = "Starting download…";
          job.progress = 12;
        } catch (probeErr: any) {
          if (isBotBlock(String(probeErr?.message || ""))) {
            throw probeErr;
          }
        }

        const tryOrder = [
          preferredClient,
          ...orderedClients().filter((c) => c !== preferredClient),
        ].slice(0, 3);

        let lastErr: Error | null = null;
        let succeeded = false;

        for (const client of tryOrder) {
          try {
            for (const f of fs.readdirSync(TEMP_DIR)) {
              if (f.startsWith(jobId)) fs.unlinkSync(path.join(TEMP_DIR, f));
            }
          } catch {}

          const args: string[] = [
            ...baseYtArgs(client),
            "-o",
            outTemplate,
            "--newline",
            "--progress",
            "--no-mtime",
          ];

          if (type === "audio") {
            args.push("-x", "--audio-format", "mp3");
            if (quality === "320k") args.push("--audio-quality", "0");
            else if (quality === "192k") args.push("--audio-quality", "2");
            else args.push("--audio-quality", "5");
          } else {
            args.push(
              "--merge-output-format",
              "mp4",
              "-f",
              videoFormatForQuality(quality)
            );
          }

          args.push(url);
          console.log(`yt-dlp client=${client}`);
          job.message = "Downloading…";
          job.client = client;

          try {
            await new Promise<void>((resolve, reject) => {
              const proc = spawn("yt-dlp", args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
              });

              let lastProgress = 12;
              let stderr = "";
              let sawProgress = false;

              const onData = (d: Buffer) => {
                const line = d.toString();
                stderr += line;
                const match = line.match(/(\d+\.?\d*)%/);
                if (match) {
                  sawProgress = true;
                  const p = Math.min(
                    92,
                    Math.round(parseFloat(match[1]) * 0.8) + 12
                  );
                  if (p > lastProgress) {
                    lastProgress = p;
                    job.progress = p;
                    job.message = `Downloading… ${Math.round(parseFloat(match[1]))}%`;
                  }
                }
              };

              proc.stdout.on("data", onData);
              proc.stderr.on("data", onData);

              const stallTimer = setTimeout(() => {
                if (!sawProgress) {
                  proc.kill("SIGKILL");
                  reject(new Error("No progress"));
                }
              }, 35_000);

              const timeout = setTimeout(() => {
                proc.kill("SIGKILL");
                reject(new Error("Download timed out"));
              }, 8 * 60 * 1000);

              proc.on("close", (code) => {
                clearTimeout(timeout);
                clearTimeout(stallTimer);
                if (code === 0) resolve();
                else {
                  const lines = stderr.split("\n").filter(Boolean);
                  const errorLine =
                    lines.find((l) => /ERROR:/i.test(l)) ||
                    lines.slice(-2).join(" ") ||
                    `yt-dlp failed with code ${code}`;
                  reject(new Error(errorLine.slice(0, 600)));
                }
              });

              proc.on("error", (err) => {
                clearTimeout(timeout);
                clearTimeout(stallTimer);
                reject(err);
              });
            });

            succeeded = true;
            lastErr = null;
            lastGoodClient = client;
            clientSuccess.set(client, Date.now());
            break;
          } catch (err: any) {
            lastErr = err;
            console.warn(`download client=${client} failed:`, err.message);
            if (isBotBlock(String(err.message || ""))) {
              // try next client
            }
          }
        }

        if (!succeeded) throw lastErr || new Error("Download failed");

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
        job.error = friendlyError(String(e.message || "Processing failed"));
        job.message = job.error;
        console.error("download job error:", e.message);
      }
    })();
  } catch (e: any) {
    res.status(400).json({ error: friendlyError(e.message || "Invalid request") });
  }
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    message: job.message,
    client: job.client,
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
  console.log(`Clients: ${PLAYER_CLIENTS.join(", ")}`);
  console.log(`POT provider: ${BGUTIL_POT_URL}`);
  console.log(`Cookies: ${HAS_COOKIES ? "yes" : "NO"}`);
  console.log(`Proxy: ${PROXY_URL ? "yes" : "no"}`);
});
