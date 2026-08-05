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
// FFmpeg path resolution — prefer system ffmpeg on Linux (Railway/Docker),
// fall back to ffmpeg-static for local dev on other platforms.
// ---------------------------------------------------------------------------
function resolveFfmpegPath(): string {
  // 1. Try system ffmpeg (installed via apk in Dockerfile)
  const systemPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log(`[FFmpeg] Using system ffmpeg: ${p}`);
      return p;
    }
  }
  // 2. Try which/where as fallback
  try {
    const result = execFileSync('which', ['ffmpeg']).toString().trim();
    if (result) {
      console.log(`[FFmpeg] Found ffmpeg via which: ${result}`);
      return result;
    }
  } catch {}
  // 3. Fall back to ffmpeg-static (local dev)
  if (ffmpegStatic) {
    console.log(`[FFmpeg] Using ffmpeg-static: ${ffmpegStatic}`);
    return ffmpegStatic;
  }
  throw new Error('FFmpeg binary not found. Install ffmpeg or ffmpeg-static.');
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
  return 'ffprobe'; // hope it's on PATH
}

const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log(`[FFmpeg] ffprobe path: ${ffprobePath}`);

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
// yt-dlp via spawn — no buffer limit
// ---------------------------------------------------------------------------
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const proc = spawn('yt-dlp', args);

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', (err: any) => {
      reject(err.code === 'ENOENT'
        ? new Error('Media Extractor (yt-dlp) is not installed on this host system.')
        : err);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(errChunks).toString('utf8') || `yt-dlp exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

async function extractMediaInfo(url: string): Promise<{ streamUrl: string; title: string; artist: string; thumbnailUrl: string | null }> {
  // Use bestaudio only — never download video data
  const audioFormat = 'bestaudio[ext=m4a]/bestaudio/best';
  const baseArgs = [
    '--no-warnings', '--quiet', '--no-progress',
    '--extractor-args', 'youtube:player_client=ios,android',
    '--user-agent', USER_AGENT,
    '--referer', REFERER,
    '--buffer-size', '16K',
  ];

  try {
    // Metadata and stream URL in parallel
    const [metaStdout, streamStdout] = await Promise.all([
      runYtDlp(['-j', ...baseArgs, '-f', audioFormat, url]),
      runYtDlp(['-g', ...baseArgs, '-f', audioFormat, url]),
    ]);

    let metadata: YtDlpMetadata = {};
    try { metadata = JSON.parse(metaStdout.trim()); } catch {}

    const streamUrl = streamStdout.trim();
    if (!streamUrl) throw new Error('No direct stream URL resolved.');

    return {
      streamUrl,
      title: metadata.title || 'Unknown Title',
      artist: metadata.uploader || metadata.artist || 'Unknown Artist',
      thumbnailUrl: metadata.thumbnail || null,
    };
  } catch (error: any) {
    const e = (error.message || '').toString();
    if (e.includes('is not installed')) throw error;
    if (e.includes('HTTP Error 403') || e.includes('Forbidden'))
      throw new Error('Access Forbidden: Ingestion blocked by the media provider (HTTP 403).');
    if (e.includes('HTTP Error 429') || e.includes('Too Many Requests'))
      throw new Error('Rate Limited: Too many requests sent to the provider (HTTP 429).');
    if (e.includes('Sign in to confirm') || e.includes('confirm your age'))
      throw new Error('Age-Restricted: Stream requires age verification.');
    if (e.includes('Unsupported URL') || e.includes('Unsupported'))
      throw new Error('Format Not Supported: Provider is not supported by the extractor.');
    if (e.includes('timed out') || e.includes('timeout'))
      throw new Error('Network Timeout: The provider took too long to respond.');
    if (e.includes('Video unavailable') || e.includes('does not exist') || e.includes('not found'))
      throw new Error('Invalid URL: Media is unavailable or has been deleted.');
    throw new Error(`Media Extraction Failed: ${e || 'Unable to parse media stream'}`);
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
// Main transcode function
// ---------------------------------------------------------------------------
export async function transcodeAudio(job: Job, options: TranscodeOptions): Promise<TranscodeResult> {
  const { jobId, sourceType, sourcePath, sourceUrl, bitrate, sampleRate } = options;
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);

  let inputSource = sourceType === 'UPLOAD' ? sourcePath! : sourceUrl!;
  let metadataTitle = sourceType === 'UPLOAD' && sourcePath ? path.basename(sourcePath) : '';
  let metadataArtist = '';
  let thumbnailPath: string | null = null;
  let hasExtractedStream = false;

  if (sourceType === 'URL') {
    try {
      console.log(`[Ingestion ${jobId}] Spawning extractor for: ${sourceUrl}`);
      const extraction = await extractMediaInfo(sourceUrl!);
      inputSource = extraction.streamUrl;
      metadataTitle = extraction.title;
      metadataArtist = extraction.artist;
      hasExtractedStream = true;
      if (extraction.thumbnailUrl) {
        thumbnailPath = await downloadThumbnail(extraction.thumbnailUrl, jobId);
      }
    } catch (e: any) {
      if (!sourceUrl!.match(/\.(mp3|wav|ogg|flac|m4a|aac)(\?|$)/i)) throw e;
      console.log(`[Ingestion ${jobId}] Direct audio URL fallback.`);
    }
  }

  if (sourceType === 'UPLOAD' && !fs.existsSync(inputSource)) {
    throw new Error(`Upload source file does not exist: ${inputSource}`);
  }

  console.log(`[Processor] Starting ffmpeg for job: ${jobId}`);

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputSource);

    // Network stream resilience
    if (sourceType === 'URL') {
      command = command.inputOptions([
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
      ]);
    }

    // Cover art embedding
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      command = command
        .input(thumbnailPath)
        .outputOptions([
          '-map', '0:a',
          '-map', '1:v',
          '-disposition:v:0', 'attached_pic',
        ]);
    }

    // ID3 metadata tags
    if (hasExtractedStream) {
      command = command.outputOptions([
        '-metadata', `title=${metadataTitle}`,
        '-metadata', `artist=${metadataArtist}`,
        '-id3v2_version', '3',
        '-metadata:s:v', 'title=Album cover',
        '-metadata:s:v', 'comment=Cover (front)',
      ]);
    }

    let totalDuration = 0;

    command
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      // Speed optimisations: use all CPU cores, fastest encode preset
      .addOptions(['-threads', '0'])
      .on('start', (cmdline) => {
        console.log(`[FFmpeg Job ${jobId}] Command: ${cmdline}`);
      })
      .on('codecData', (data) => {
        if (data.duration) {
          totalDuration = parseDurationToSeconds(data.duration);
          console.log(`[FFmpeg Job ${jobId}] Duration: ${totalDuration}s`);
        }
      })
      .on('progress', async (progress) => {
        let percent = 0;
        if (progress.percent !== undefined) {
          percent = Math.round(progress.percent);
        } else if (totalDuration > 0 && progress.timemark) {
          percent = Math.round((parseDurationToSeconds(progress.timemark) / totalDuration) * 100);
        }
        percent = Math.max(1, Math.min(99, percent)); // always show at least 1% once started
        await job.updateProgress(percent);
        await publishJobProgress(jobId, 'PROCESSING', percent);
      })
      .on('end', () => {
        console.log(`[FFmpeg Job ${jobId}] Transcoding complete.`);
        if (thumbnailPath && fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);

        try {
          const stats = fs.statSync(outputPath);
          ffmpeg.ffprobe(outputPath, (err, meta) => {
            resolve({
              outputPath,
              duration: (!err && meta?.format?.duration) ? Math.round(meta.format.duration) : totalDuration,
              fileSize: stats.size,
              title: metadataTitle || 'Converted Audio',
            });
          });
        } catch (e) {
          reject(new Error(`Failed to stat output file: ${(e as Error).message}`));
        }
      })
      .on('error', (err) => {
        console.error(`[FFmpeg Job ${jobId}] Error:`, err.message);
        if (thumbnailPath && fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
        reject(err);
      })
      .save(outputPath);
  });
}

function parseDurationToSeconds(durationStr: string): number {
  try {
    const parts = durationStr.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(durationStr) || 0;
  } catch { return 0; }
}
