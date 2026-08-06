import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import IORedis from 'ioredis';
import { Job } from 'bullmq';
import { JobStatus } from '@sonicflow/shared';
import { spawn, execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Scratch directories — guaranteed to exist at module load
// ---------------------------------------------------------------------------
const SCRATCH_DIR = '/tmp/shkarko-al';
const CONVERTED_DIR = path.join(SCRATCH_DIR, 'converted');
const UPLOAD_DIR = path.join(SCRATCH_DIR, 'uploads');

[SCRATCH_DIR, CONVERTED_DIR, UPLOAD_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
});
console.log(`[Pipeline] Dirs ready: ${CONVERTED_DIR}`);

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------
function resolveBin(names: string[]): string {
  for (const p of names) {
    if (p.startsWith('/') && fs.existsSync(p)) return p;
  }
  for (const name of names.filter(n => !n.startsWith('/'))) {
    try {
      const r = execFileSync('which', [name]).toString().trim();
      if (r) return r;
    } catch {}
  }
  return names[names.length - 1];
}

const ffmpegPath  = resolveBin(['/usr/bin/ffmpeg',  '/usr/local/bin/ffmpeg',  ffmpegStatic || 'ffmpeg']);
const ffprobePath = resolveBin(['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']);
const ytDlpPath   = resolveBin(['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp']);

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log(`[FFmpeg]  ffmpeg:  ${ffmpegPath}`);
console.log(`[FFmpeg]  ffprobe: ${ffprobePath}`);
console.log(`[yt-dlp] binary:  ${ytDlpPath}`);

// ---------------------------------------------------------------------------
// Active process tracking — kill all on SIGTERM
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
// Constants
// ---------------------------------------------------------------------------
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
// Duration string → seconds
// ---------------------------------------------------------------------------
function parseDurationToSeconds(s: string): number {
  try {
    const p = s.split(':');
    if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
    return parseFloat(s) || 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// UPLOAD: transcode from local file
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
    let settled = false;

    const done = (r: TranscodeResult) => { if (!settled) { settled = true; resolve(r); } };
    const fail = (e: Error)           => { if (!settled) { settled = true; reject(e); } };

    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .addOptions(['-threads', '0'])
      .on('start', cmd => console.log(`[FFmpeg ${jobId}] ${cmd}`))
      .on('codecData', d => { if (d.duration) totalDuration = parseDurationToSeconds(d.duration); })
      .on('progress', async p => {
        let pct = p.percent !== undefined
          ? Math.round(p.percent)
          : totalDuration > 0 && p.timemark
            ? Math.round((parseDurationToSeconds(p.timemark) / totalDuration) * 100)
            : 0;
        pct = Math.max(1, Math.min(99, pct));
        await job.updateProgress(pct).catch(() => {});
        await publishJobProgress(jobId, 'PROCESSING', pct);
      })
      .on('end', () => {
        // Immediate resolve — no ffprobe, no post-processing
        let fileSize = 0;
        try { if (fs.existsSync(outputPath)) fileSize = fs.statSync(outputPath).size; } catch {}
        console.log(`[FFmpeg ${jobId}] UPLOAD complete. Size: ${fileSize}`);
        done({ outputPath, duration: totalDuration, fileSize, title });
      })
      .on('error', err => {
        console.error(`[FFmpeg ${jobId}] Error: ${err.message}`);
        fail(err);
      })
      .save(outputPath);
  });
}

// ---------------------------------------------------------------------------
// URL: yt-dlp stdout → FFmpeg stdin (pipe method)
// No ffprobe, no metadata embedding, no post-processing — immediate resolve
// ---------------------------------------------------------------------------
export async function transcodeAudio(job: Job, options: TranscodeOptions): Promise<TranscodeResult> {
  const { jobId, sourceType, sourcePath, sourceUrl, bitrate, sampleRate } = options;
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);

  // Ensure output dir exists
  try { fs.mkdirSync(CONVERTED_DIR, { recursive: true }); } catch {}

  // ---- UPLOAD ----
  if (sourceType === 'UPLOAD') {
    if (!fs.existsSync(sourcePath!)) throw new Error(`Source file missing: ${sourcePath}`);
    console.log(`[Processor] UPLOAD job: ${jobId}`);
    return transcodeFromFile(job, jobId, sourcePath!, outputPath, bitrate, sampleRate, path.basename(sourcePath!));
  }

  // ---- URL — pipe method ----
  console.log(`[Processor] URL job: ${jobId} | ${sourceUrl}`);

  const ytDlpProc = track(spawn(ytDlpPath, [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--no-warnings', '--no-progress',
    '--extractor-args', 'youtube:player_client=ios,android',
    '--user-agent', USER_AGENT,
    '--referer', REFERER,
    '--buffer-size', '16K',
    '-o', '-',
    sourceUrl!,
  ]));

  // Hard 5-minute kill timer
  const killTimer = setTimeout(() => {
    try { ytDlpProc.kill('SIGKILL'); } catch {}
  }, 5 * 60_000).unref();

  const stderrChunks: Buffer[] = [];
  ytDlpProc.stderr!.on('data', (c: Buffer) => {
    stderrChunks.push(c);
    process.stdout.write(`[yt-dlp ${jobId}] ${c.toString()}`);
  });

  return new Promise<TranscodeResult>((resolve, reject) => {
    let totalDuration = 0;
    let settled = false;

    const done = (r: TranscodeResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        try { ytDlpProc.kill('SIGKILL'); } catch {}
        resolve(r);
      }
    };
    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        try { ytDlpProc.kill('SIGKILL'); } catch {}
        reject(e);
      }
    };

    ytDlpProc.on('error', (err: any) => {
      fail(err.code === 'ENOENT'
        ? new Error('yt-dlp is not installed.')
        : new Error(`yt-dlp error: ${err.message}`));
    });

    ytDlpProc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        const msg = Buffer.concat(stderrChunks).toString('utf8');
        console.error(`[yt-dlp ${jobId}] exit ${code}: ${msg}`);
        // Only fail if FFmpeg hasn't already resolved
        if (!settled) fail(new Error(`yt-dlp failed (code ${code}): ${msg.slice(0, 200)}`));
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
      .on('start', cmd => console.log(`[FFmpeg ${jobId}] ${cmd}`))
      .on('codecData', d => {
        if (d.duration) {
          totalDuration = parseDurationToSeconds(d.duration);
          console.log(`[FFmpeg ${jobId}] Duration: ${totalDuration}s`);
        }
      })
      .on('progress', async p => {
        let pct = 0;
        if (p.percent !== undefined && p.percent > 0) {
          pct = Math.round(p.percent);
        } else if (totalDuration > 0 && p.timemark) {
          pct = Math.round((parseDurationToSeconds(p.timemark) / totalDuration) * 100);
        }
        pct = Math.max(1, Math.min(99, pct));
        await job.updateProgress(pct).catch(() => {});
        await publishJobProgress(jobId, 'PROCESSING', pct);
      })
      .on('end', () => {
        // *** NUCLEAR OPTION: resolve immediately, nothing else ***
        let fileSize = 0;
        try { if (fs.existsSync(outputPath)) fileSize = fs.statSync(outputPath).size; } catch {}
        console.log(`[FFmpeg ${jobId}] END — size: ${fileSize} bytes — resolving NOW`);
        done({ outputPath, duration: totalDuration, fileSize, title: jobId });
      })
      .on('error', err => {
        console.error(`[FFmpeg ${jobId}] Error: ${err.message}`);
        fail(err);
      })
      .save(outputPath);
  });
}
