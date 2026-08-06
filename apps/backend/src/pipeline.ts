import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import IORedis from 'ioredis';
import { Job } from 'bullmq';
import { JobStatus } from '@sonicflow/shared';
import { spawn, execFileSync } from 'child_process';
import http from 'http';
import https from 'https';

// ---------------------------------------------------------------------------
// FFmpeg path resolution
// ---------------------------------------------------------------------------
function resolveFfmpegPath(): string {
  const systemPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log(`[FFmpeg] Using system ffmpeg: ${p}`);
      return p;
    }
  }
  try {
    const result = execFileSync('which', ['ffmpeg']).toString().trim();
    if (result) { console.log(`[FFmpeg] Found via which: ${result}`); return result; }
  } catch {}
  if (ffmpegStatic) {
    console.log(`[FFmpeg] Using ffmpeg-static: ${ffmpegStatic}`);
    return ffmpegStatic;
  }
  throw new Error('FFmpeg binary not found.');
}

function resolveFfprobePath(): string {
  const systemPaths = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const result = execFileSync('which', ['ffprobe']).toString().trim();
    if (result) return result;
  } catch {}
  return 'ffprobe';
}

function resolveYtDlpPath(): string {
  const candidates = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const r = execFileSync('which', ['yt-dlp']).toString().trim();
    if (r) return r;
  } catch {}
  return 'yt-dlp';
}

const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();
const ytDlpPath = resolveYtDlpPath();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log(`[FFmpeg] ffprobe: ${ffprobePath}`);
console.log(`[yt-dlp] Binary: ${ytDlpPath}`);

// ---------------------------------------------------------------------------
// Redis publisher — lazy, silent failures
// ---------------------------------------------------------------------------
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redisPublisher: any = null;

function getRedisPublisher() {
  if (!redisPublisher) {
    try {
      redisPublisher = new IORedis(redisUrl, { lazyConnect: true });
      redisPublisher.on('error', () => {});
    } catch {}
  }
  return redisPublisher;
}

// ---------------------------------------------------------------------------
// Scratch directories
// ---------------------------------------------------------------------------
const SCRATCH_DIR = '/tmp/sonicflow-scratch';
const CONVERTED_DIR = path.join(SCRATCH_DIR, 'converted');
if (!fs.existsSync(CONVERTED_DIR)) {
  fs.mkdirSync(CONVERTED_DIR, { recursive: true });
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.youtube.com/';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TranscodeOptions {
  jobId: string;
  sourceType: 'UPLOAD' | 'URL';
  sourcePath?: string;
  sourceUrl?: string;
  bitrate: 128 | 192 | 320;
  sampleRate: 44100 | 48000;
}

export interface TranscodeResult {
  outputPath: string;
  duration: number;
  fileSize: number;
  title: string;
}

interface YtDlpMetadata {
  title?: string;
  uploader?: string;
  artist?: string;
  thumbnail?: string;
}

// ---------------------------------------------------------------------------
// Track active child processes for cleanup on shutdown
// ---------------------------------------------------------------------------
const activeProcesses = new Set<ReturnType<typeof spawn>>();

process.on('SIGTERM', () => {
  console.log(`[Pipeline] SIGTERM — killing ${activeProcesses.size} active child processes`);
  for (const proc of activeProcesses) {
    try { proc.kill('SIGKILL'); } catch {}
  }
});

function trackProcess(proc: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  activeProcesses.add(proc);
  proc.on('close', () => activeProcesses.delete(proc));
  return proc;
}

function runYtDlpText(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const proc = trackProcess(spawn(ytDlpPath, args));

    proc.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr!.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', (err: any) => {
      reject(err.code === 'ENOENT' ? new Error('yt-dlp is not installed.') : err);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(errChunks).toString('utf8') || `yt-dlp exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });

    // Auto-kill after 30s to prevent zombies
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 30_000).unref();
  });
}

async function fetchMetadata(url: string): Promise<YtDlpMetadata> {
  try {
    const stdout = await runYtDlpText([
      '-j',
      '--no-warnings', '--quiet', '--no-progress',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', USER_AGENT,
      '--referer', REFERER,
      url,
    ]);
    try { return JSON.parse(stdout.trim()); } catch { return {}; }
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Redis PubSub progress publisher
// ---------------------------------------------------------------------------
export async function publishJobProgress(
  jobId: string,
  status: JobStatus,
  progress: number,
  extra: { s3Url?: string; errorMessage?: string; fileSize?: number; duration?: number } = {}
): Promise<void> {
  try {
    const pub = getRedisPublisher();
    if (!pub) return;
    await pub.publish(`job-progress:${jobId}`, JSON.stringify({ jobId, status, progress, ...extra }));
  } catch {}
}

// ---------------------------------------------------------------------------
// Thumbnail downloader
// ---------------------------------------------------------------------------
function downloadThumbnail(url: string, jobId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const outputPath = path.join(SCRATCH_DIR, `thumb_${jobId}.jpg`);
    const file = fs.createWriteStream(outputPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        return resolve(null);
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(outputPath); });
    }).on('error', () => {
      file.close();
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Duration string → seconds
// ---------------------------------------------------------------------------
function parseDurationToSeconds(durationStr: string): number {
  try {
    const parts = durationStr.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(durationStr) || 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Embed ID3 metadata + cover art into finished MP3 (post-transcode, copy codec)
// ---------------------------------------------------------------------------
function embedMetadata(
  filePath: string,
  title: string,
  artist: string,
  thumbnailPath: string | null
): Promise<void> {
  return new Promise((resolve) => {
    const tmpPath = filePath + '.meta.mp3';
    let command = ffmpeg(filePath).audioCodec('copy');

    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      command = command
        .input(thumbnailPath)
        .outputOptions([
          '-map', '0:a',
          '-map', '1:v',
          '-disposition:v:0', 'attached_pic',
        ]);
    }

    command
      .outputOptions([
        '-metadata', `title=${title}`,
        '-metadata', `artist=${artist}`,
        '-id3v2_version', '3',
      ])
      .on('end', () => {
        try { fs.renameSync(tmpPath, filePath); } catch {}
        resolve();
      })
      .on('error', () => {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        resolve(); // non-fatal
      })
      .save(tmpPath);
  });
}

// ---------------------------------------------------------------------------
// Transcode from local file (UPLOAD flow)
// ---------------------------------------------------------------------------
function transcodeFromFile(
  job: Job,
  jobId: string,
  inputPath: string,
  outputPath: string,
  bitrate: number,
  sampleRate: number,
  title: string
): Promise<TranscodeResult> {
  return new Promise((resolve, reject) => {
    let totalDuration = 0;

    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .addOptions(['-threads', '0'])
      .on('start', (cmd) => console.log(`[FFmpeg Job ${jobId}] Command: ${cmd}`))
      .on('codecData', (data) => {
        if (data.duration) totalDuration = parseDurationToSeconds(data.duration);
      })
      .on('progress', async (progress) => {
        let percent = progress.percent !== undefined
          ? Math.round(progress.percent)
          : totalDuration > 0 && progress.timemark
            ? Math.round((parseDurationToSeconds(progress.timemark) / totalDuration) * 100)
            : 0;
        percent = Math.max(1, Math.min(99, percent));
        await job.updateProgress(percent).catch(() => {});
        await publishJobProgress(jobId, 'PROCESSING', percent);
      })
      .on('end', () => {
        try {
          if (!fs.existsSync(outputPath)) {
            return reject(new Error(`Output file not found: ${outputPath}`));
          }
          const stats = fs.statSync(outputPath);

          let probeSettled = false;
          const probeTimeout = setTimeout(() => {
            if (!probeSettled) {
              probeSettled = true;
              resolve({ outputPath, duration: totalDuration, fileSize: stats.size, title });
            }
          }, 5000);

          ffmpeg.ffprobe(outputPath, (err, meta) => {
            if (probeSettled) return;
            probeSettled = true;
            clearTimeout(probeTimeout);
            resolve({
              outputPath,
              duration: (!err && meta?.format?.duration) ? Math.round(meta.format.duration) : totalDuration,
              fileSize: stats.size,
              title,
            });
          });
        } catch (e) {
          reject(new Error(`Failed to stat output: ${(e as Error).message}`));
        }
      })
      .on('error', (err) => {
        console.error(`[FFmpeg Job ${jobId}] Error: ${err.message}`);
        reject(err);
      })
      .save(outputPath);
  });
}

// ---------------------------------------------------------------------------
// Main transcode function — PIPE METHOD for URLs
// yt-dlp stdout → FFmpeg stdin (YouTube never sees FFmpeg)
// ---------------------------------------------------------------------------
export async function transcodeAudio(job: Job, options: TranscodeOptions): Promise<TranscodeResult> {
  const { jobId, sourceType, sourcePath, sourceUrl, bitrate, sampleRate } = options;
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);

  // ---- UPLOAD path ----
  if (sourceType === 'UPLOAD') {
    if (!fs.existsSync(sourcePath!)) {
      throw new Error(`Upload source file does not exist: ${sourcePath}`);
    }
    console.log(`[Processor] Starting ffmpeg for job: ${jobId} (UPLOAD)`);
    return transcodeFromFile(job, jobId, sourcePath!, outputPath, bitrate, sampleRate, path.basename(sourcePath!));
  }

  // ---- URL path — pipe method ----
  console.log(`[Processor] Starting yt-dlp pipe for job: ${jobId} | URL: ${sourceUrl}`);

  // Fetch metadata in background — non-blocking
  let metadataTitle = 'Unknown Title';
  let metadataArtist = 'Unknown Artist';
  let thumbnailPath: string | null = null;

  const metaPromise = fetchMetadata(sourceUrl!).then(async (meta) => {
    metadataTitle = meta.title || 'Unknown Title';
    metadataArtist = meta.uploader || meta.artist || 'Unknown Artist';
    if (meta.thumbnail) {
      thumbnailPath = await downloadThumbnail(meta.thumbnail, jobId);
    }
  }).catch(() => {});

  // Spawn yt-dlp piping audio to stdout — stream directly, never buffer in memory
  const ytDlpProc = trackProcess(spawn(ytDlpPath, [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--no-warnings', '--no-progress',
    '--extractor-args', 'youtube:player_client=ios,android',
    '--user-agent', USER_AGENT,
    '--referer', REFERER,
    '--buffer-size', '16K',
    '-o', '-',
    sourceUrl!,
  ]));

  // Auto-kill yt-dlp after 5 minutes to prevent zombies on hung streams
  const ytDlpKillTimer = setTimeout(() => {
    try { ytDlpProc.kill('SIGKILL'); } catch {}
  }, 5 * 60_000).unref();

  const errChunks: Buffer[] = [];
  ytDlpProc.stderr!.on('data', (chunk: Buffer) => {
    errChunks.push(chunk);
    process.stdout.write(`[yt-dlp ${jobId}] ${chunk.toString()}`);
  });

  console.log(`[Processor] Starting ffmpeg for job: ${jobId} (PIPE)`);

  const transcodeResult = await new Promise<TranscodeResult>((resolve, reject) => {
    let totalDuration = 0;
    let resolved = false;

    const safeResolve = (result: TranscodeResult) => {
      if (!resolved) { resolved = true; resolve(result); }
    };
    const safeReject = (err: Error) => {
      if (!resolved) { resolved = true; reject(err); }
    };

    ytDlpProc.on('error', (err: any) => {
      safeReject(err.code === 'ENOENT'
        ? new Error('yt-dlp is not installed.')
        : new Error(`yt-dlp spawn error: ${err.message}`));
    });

    ytDlpProc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        const errMsg = Buffer.concat(errChunks).toString('utf8');
        console.error(`[yt-dlp ${jobId}] Exited with code ${code}: ${errMsg}`);
      }
    });

    ffmpeg()
      .input(ytDlpProc.stdout! as any)
      .inputFormat('mp4')
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .addOptions(['-threads', '0'])
      .outputOptions(['-vn'])
      .on('start', (cmdline) => {
        console.log(`[FFmpeg Job ${jobId}] Command: ${cmdline}`);
        console.log(`[FFmpeg] Process spawned successfully`);
      })
      .on('codecData', (data) => {
        if (data.duration) {
          totalDuration = parseDurationToSeconds(data.duration);
          console.log(`[FFmpeg Job ${jobId}] Duration: ${totalDuration}s`);
        }
      })
      .on('progress', async (progress) => {
        let percent = 0;
        if (progress.percent !== undefined && progress.percent > 0) {
          percent = Math.round(progress.percent);
        } else if (totalDuration > 0 && progress.timemark) {
          percent = Math.round((parseDurationToSeconds(progress.timemark) / totalDuration) * 100);
        }
        percent = Math.max(1, Math.min(99, percent));
        await job.updateProgress(percent).catch(() => {});
        await publishJobProgress(jobId, 'PROCESSING', percent);
      })
      .on('end', () => {
        console.log(`[FFmpeg Job ${jobId}] Transcoding complete. Verifying output file...`);
        try {
          if (!fs.existsSync(outputPath)) {
            return safeReject(new Error(`Output file not found at: ${outputPath}`));
          }
          const stats = fs.statSync(outputPath);
          console.log(`[FFmpeg Job ${jobId}] Output file size: ${stats.size} bytes`);

          // Use ffprobe with a hard timeout — don't let it hang
          let probeSettled = false;
          const probeTimeout = setTimeout(() => {
            if (!probeSettled) {
              probeSettled = true;
              console.warn(`[FFmpeg Job ${jobId}] ffprobe timed out — using estimated duration`);
              safeResolve({ outputPath, duration: totalDuration, fileSize: stats.size, title: metadataTitle });
            }
          }, 5000);

          ffmpeg.ffprobe(outputPath, (err, meta) => {
            if (probeSettled) return;
            probeSettled = true;
            clearTimeout(probeTimeout);
            safeResolve({
              outputPath,
              duration: (!err && meta?.format?.duration) ? Math.round(meta.format.duration) : totalDuration,
              fileSize: stats.size,
              title: metadataTitle,
            });
          });
        } catch (e) {
          safeReject(new Error(`Failed to stat output: ${(e as Error).message}`));
        }
      })
      .on('error', (err) => {
        console.error(`[FFmpeg Job ${jobId}] Error: ${err.message}`);
        clearTimeout(ytDlpKillTimer);
        try { ytDlpProc.kill('SIGKILL'); } catch {}
        safeReject(err);
      })
      .save(outputPath);
  });

  clearTimeout(ytDlpKillTimer);

  // Wait for metadata (max 5s) then embed — skip entirely if it takes too long
  try {
    await Promise.race([metaPromise, new Promise(r => setTimeout(r, 5000))]);
    if (metadataTitle !== 'Unknown Title' || thumbnailPath) {
      await Promise.race([
        embedMetadata(outputPath, metadataTitle, metadataArtist, thumbnailPath),
        new Promise(r => setTimeout(r, 5000)), // hard 5s timeout on embed
      ]);
      console.log(`[FFmpeg Job ${jobId}] Metadata embedded.`);
    }
  } catch (e) {
    console.warn(`[FFmpeg Job ${jobId}] Metadata embed failed (non-fatal):`, e);
  }

  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try { fs.unlinkSync(thumbnailPath); } catch {}
  }

  console.log(`[FFmpeg Job ${jobId}] Job fully complete. File: ${outputPath}`);
  return { ...transcodeResult, title: metadataTitle };
}
