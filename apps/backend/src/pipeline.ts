import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import IORedis from 'ioredis';
import { Job } from 'bullmq';
import { JobStatus } from '@sonicflow/shared';
import { spawn, execFileSync, spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Directories — created at module load, absolute paths
// ---------------------------------------------------------------------------
const SCRATCH_DIR  = '/tmp/shkarko-al';
const RAW_DIR      = path.join(SCRATCH_DIR, 'raw');
const CONVERTED_DIR = path.join(SCRATCH_DIR, 'converted');
const UPLOAD_DIR   = path.join(SCRATCH_DIR, 'uploads');

[SCRATCH_DIR, RAW_DIR, CONVERTED_DIR, UPLOAD_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
});
console.log(`[Pipeline] Dirs: raw=${RAW_DIR} converted=${CONVERTED_DIR}`);

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------
function resolveBin(candidates: string[]): string {
  for (const p of candidates) {
    if (p.startsWith('/') && fs.existsSync(p)) return p;
  }
  for (const name of candidates.filter(n => !n.startsWith('/'))) {
    try {
      const r = execFileSync('which', [name]).toString().trim();
      if (r) return r;
    } catch {}
  }
  return candidates[candidates.length - 1];
}

const ffmpegPath  = resolveBin(['/usr/bin/ffmpeg',  '/usr/local/bin/ffmpeg',  ffmpegStatic || 'ffmpeg']);
const ffprobePath = resolveBin(['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']);
const ytDlpPath   = resolveBin(['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp']);

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log(`[FFmpeg]  path: ${ffmpegPath}`);
console.log(`[yt-dlp] path: ${ytDlpPath}`);

// ---------------------------------------------------------------------------
// Active process tracking — SIGKILL all on shutdown
// ---------------------------------------------------------------------------
const activeProcs = new Set<ReturnType<typeof spawn>>();
process.on('SIGTERM', () => {
  for (const p of activeProcs) { try { p.kill('SIGKILL'); } catch {} }
});
function track(proc: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  activeProcs.add(proc);
  proc.on('close', () => activeProcs.delete(proc));
  return proc;
}

// ---------------------------------------------------------------------------
// Redis publisher — lazy, silent
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
// Constants
// ---------------------------------------------------------------------------
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER    = 'https://www.youtube.com/';

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

interface YtDlpMeta {
  title?: string;
  uploader?: string;
  artist?: string;
}

// ---------------------------------------------------------------------------
// Redis progress publisher
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
// Duration string → seconds
// ---------------------------------------------------------------------------
function parseSecs(s: string): number {
  try {
    const p = s.split(':');
    if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
    return parseFloat(s) || 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Run yt-dlp as a child process, collect stdout
// ---------------------------------------------------------------------------
function runYtDlp(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const proc = track(spawn(ytDlpPath, args));

    proc.stdout!.on('data', (c: Buffer) => out.push(c));
    proc.stderr!.on('data', (c: Buffer) => {
      err.push(c);
      process.stdout.write(`[yt-dlp] ${c.toString()}`);
    });

    proc.on('error', (e: any) => {
      reject(e.code === 'ENOENT' ? new Error('yt-dlp not found') : e);
    });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString().slice(0, 400) || `yt-dlp exit ${code}`));
      } else {
        resolve(Buffer.concat(out).toString('utf8'));
      }
    });

    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs).unref();
  });
}

// ---------------------------------------------------------------------------
// STEP 1 — Fetch metadata (title, artist)
// ---------------------------------------------------------------------------
async function fetchMeta(url: string): Promise<YtDlpMeta> {
  try {
    const stdout = await runYtDlp([
      '-j', '--no-warnings', '--quiet', '--no-progress',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', USER_AGENT,
      '--referer', REFERER,
      url,
    ], 30_000);
    return JSON.parse(stdout.trim());
  } catch (e) {
    console.warn('[Pipeline] Metadata fetch failed (non-fatal):', (e as Error).message);
    return {};
  }
}

// ---------------------------------------------------------------------------
// STEP 2 — Download raw audio to disk (NOT pipe)
// ---------------------------------------------------------------------------
function downloadRaw(url: string, rawPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[yt-dlp] Downloading to disk: ${rawPath}`);
    const proc = track(spawn(ytDlpPath, [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-warnings', '--no-progress',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', USER_AGENT,
      '--referer', REFERER,
      '-o', rawPath,
      url,
    ]));

    proc.stderr!.on('data', (c: Buffer) => process.stdout.write(`[yt-dlp] ${c.toString()}`));

    proc.on('error', (e: any) => {
      reject(e.code === 'ENOENT' ? new Error('yt-dlp not found') : e);
    });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`yt-dlp download exited with code ${code}`));
      } else {
        // Verify file exists and has bytes
        if (!fs.existsSync(rawPath)) {
          reject(new Error(`Raw file missing after download: ${rawPath}`));
          return;
        }
        const size = fs.statSync(rawPath).size;
        console.log(`[yt-dlp] Download complete. Raw file size: ${size} bytes`);
        if (size === 0) {
          reject(new Error('Downloaded raw file is 0 bytes — yt-dlp produced no output'));
          return;
        }
        resolve();
      }
    });

    // 10 minute hard timeout for large files
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('yt-dlp download timed out after 10 minutes'));
    }, 10 * 60_000).unref();
  });
}

// ---------------------------------------------------------------------------
// STEP 3 — Convert local file to MP3 via FFmpeg
// ---------------------------------------------------------------------------
function convertToMp3(
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
    let settled = false;
    const done = (r: TranscodeResult) => { if (!settled) { settled = true; resolve(r); } };
    const fail = (e: Error)           => { if (!settled) { settled = true; reject(e); } };

    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .addOptions(['-threads', '0'])
      .outputOptions(['-vn'])
      .on('start', cmd => console.log(`[FFmpeg ${jobId}] ${cmd}`))
      .on('codecData', d => {
        if (d.duration) {
          totalDuration = parseSecs(d.duration);
          console.log(`[FFmpeg ${jobId}] Duration: ${totalDuration}s`);
        }
      })
      .on('progress', async p => {
        let pct = 0;
        if (p.percent !== undefined && p.percent > 0) {
          pct = Math.round(p.percent);
        } else if (totalDuration > 0 && p.timemark) {
          pct = Math.round((parseSecs(p.timemark) / totalDuration) * 100);
        }
        pct = Math.max(1, Math.min(99, pct));
        await job.updateProgress(pct).catch(() => {});
        await publishJobProgress(jobId, 'PROCESSING', pct);
      })
      .on('end', () => {
        // Wait one tick for OS to flush file buffers
        setImmediate(() => {
          try {
            const size = fs.statSync(outputPath).size;
            console.log(`[FFmpeg ${jobId}] MP3 ready. Size: ${size} bytes`);
            done({ outputPath, duration: totalDuration, fileSize: size, title });
          } catch (e) {
            fail(new Error(`Cannot stat output: ${(e as Error).message}`));
          }
        });
      })
      .on('error', err => {
        console.error(`[FFmpeg ${jobId}] Error: ${err.message}`);
        fail(err);
      })
      .save(outputPath);
  });
}

// ---------------------------------------------------------------------------
// Main export — sequential: metadata → download → convert
// ---------------------------------------------------------------------------
export async function transcodeAudio(job: Job, options: TranscodeOptions): Promise<TranscodeResult> {
  const { jobId, sourceType, sourcePath, sourceUrl, bitrate, sampleRate } = options;
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);

  // Ensure dirs exist
  [RAW_DIR, CONVERTED_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

  // ---- UPLOAD: already on disk, just convert ----
  if (sourceType === 'UPLOAD') {
    if (!fs.existsSync(sourcePath!)) throw new Error(`Source missing: ${sourcePath}`);
    const size = fs.statSync(sourcePath!).size;
    console.log(`[Processor] UPLOAD job ${jobId} | file size: ${size}`);
    if (size === 0) throw new Error('Uploaded file is 0 bytes');
    return convertToMp3(job, jobId, sourcePath!, outputPath, bitrate, sampleRate, path.basename(sourcePath!));
  }

  // ---- URL: disk-first approach ----
  console.log(`[Processor] URL job ${jobId} | ${sourceUrl}`);

  // STEP 1: metadata (non-blocking, best-effort)
  await publishJobProgress(jobId, 'PROCESSING', 1);
  const meta = await fetchMeta(sourceUrl!);
  const title  = meta.title    || 'Unknown Title';
  const artist = meta.uploader || meta.artist || 'Unknown Artist';
  console.log(`[Processor] Title: "${title}" | Artist: "${artist}"`);

  // STEP 2: download raw audio to disk
  await publishJobProgress(jobId, 'PROCESSING', 5);
  const rawPath = path.join(RAW_DIR, `${jobId}.m4a`);
  await downloadRaw(sourceUrl!, rawPath);
  await publishJobProgress(jobId, 'PROCESSING', 40);

  // STEP 3: convert to MP3
  console.log(`[Processor] Converting ${rawPath} → ${outputPath}`);
  let result: TranscodeResult;
  try {
    result = await convertToMp3(job, jobId, rawPath, outputPath, bitrate, sampleRate, title);
  } finally {
    // Always clean up raw file
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch {}
  }

  console.log(`[Processor] Job ${jobId} complete. Title: "${title}" | Size: ${result.fileSize}`);
  return { ...result, title };
}
