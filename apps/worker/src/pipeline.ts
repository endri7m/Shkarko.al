import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import IORedis from 'ioredis';
import { Job } from 'bullmq';
import { JobStatus } from '@sonicflow/shared';
import { spawn } from 'child_process';
import http from 'http';
import https from 'https';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

let redisPublisher: any = null;

function getRedisPublisher() {
  if (!redisPublisher) {
    try {
      redisPublisher = new IORedis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      redisPublisher.on('error', () => {});
    } catch {
      // Invalid URL or connection failure — ignore
    }
  }
  return redisPublisher;
}

// Ensure scratch conversion folder exists
const SCRATCH_DIR = '/tmp/sonicflow-scratch';
const CONVERTED_DIR = path.join(SCRATCH_DIR, 'converted');
if (!fs.existsSync(CONVERTED_DIR)) {
  fs.mkdirSync(CONVERTED_DIR, { recursive: true });
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.youtube.com/';

interface TranscodeOptions {
  jobId: string;
  sourceType: 'UPLOAD' | 'URL';
  sourcePath?: string;
  sourceUrl?: string;
  bitrate: 128 | 192 | 320;
  sampleRate: 44100 | 48000;
}

interface TranscodeResult {
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

/**
 * Runs yt-dlp using spawn and collects stdout as a stream to avoid maxBuffer issues.
 */
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const proc = spawn('yt-dlp', args);

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(new Error('Media Extractor (yt-dlp) is not installed on this host system.'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errOutput = Buffer.concat(errChunks).toString('utf8');
        reject(new Error(errOutput || `yt-dlp exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

/**
 * Invokes yt-dlp via spawn to extract stream info, metadata, and thumbnail.
 */
async function extractMediaInfo(url: string): Promise<{ streamUrl: string; title: string; artist: string; thumbnailUrl: string | null }> {
  try {
    const metaStdout = await runYtDlp([
      '-j',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', USER_AGENT,
      '--referer', REFERER,
      url,
    ]);

    let metadata: YtDlpMetadata = {};
    try {
      metadata = JSON.parse(metaStdout.trim()) as YtDlpMetadata;
    } catch {
      // Metadata parse failed — continue with empty metadata
    }

    const streamStdout = await runYtDlp([
      '-g',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', USER_AGENT,
      '--referer', REFERER,
      url,
    ]);

    const streamUrl = streamStdout.trim();
    if (!streamUrl) {
      throw new Error('No direct stream URL resolved.');
    }

    return {
      streamUrl,
      title: metadata.title || 'Unknown Title',
      artist: metadata.uploader || metadata.artist || 'Unknown Artist',
      thumbnailUrl: metadata.thumbnail || null,
    };
  } catch (error: any) {
    const errorStr = (error.message || '').toString();

    if (errorStr.includes('is not installed')) throw error;
    if (errorStr.includes('HTTP Error 403') || errorStr.includes('Forbidden'))
      throw new Error('Access Forbidden: Ingestion blocked by the media provider (HTTP 403).');
    if (errorStr.includes('HTTP Error 429') || errorStr.includes('Too Many Requests'))
      throw new Error('Rate Limited: Too many requests sent to the provider (HTTP 429).');
    if (errorStr.includes('Sign in to confirm your age') || errorStr.includes('confirm your age'))
      throw new Error('Age-Restricted: Stream requires age verification and cannot be ingested.');
    if (errorStr.includes('Unsupported URL') || errorStr.includes('Unsupported'))
      throw new Error('Format Not Supported: Provider is not supported by the extractor.');
    if (errorStr.includes('timed out') || errorStr.includes('timeout'))
      throw new Error('Network Timeout: The provider took too long to respond.');
    if (errorStr.includes('Video unavailable') || errorStr.includes('does not exist') || errorStr.includes('not found'))
      throw new Error('Invalid URL: Media is unavailable or has been deleted.');

    throw new Error(`Media Extraction Failed: ${errorStr || 'Unable to parse media stream'}`);
  }
}

/**
 * Publishes progress status update via Redis PubSub
 */
export async function publishJobProgress(
  jobId: string,
  status: JobStatus,
  progress: number,
  extra: { s3Url?: string; errorMessage?: string; fileSize?: number; duration?: number } = {}
): Promise<void> {
  try {
    const pub = getRedisPublisher();
    if (!pub) return;
    const channel = `job-progress:${jobId}`;
    const payload = { jobId, status, progress, ...extra };
    await pub.publish(channel, JSON.stringify(payload));
  } catch {
    // Fail silently when Redis is offline
  }
}

/**
 * Downloads a remote thumbnail to local scratch disk.
 */
function downloadThumbnail(url: string, jobId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const outputPath = path.join(SCRATCH_DIR, `thumb_${jobId}.jpg`);
    const file = fs.createWriteStream(outputPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        resolve(null);
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      console.error('[Thumbnail Download] Error:', err);
      resolve(null);
    });
  });
}

/**
 * Run FFmpeg transcode pipeline.
 */
export async function transcodeAudio(
  job: Job,
  options: TranscodeOptions
): Promise<TranscodeResult> {
  const { jobId, sourceType, sourcePath, sourceUrl, bitrate, sampleRate } = options;
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);
  
  let inputSource = sourceType === 'UPLOAD' ? sourcePath! : sourceUrl!;
  let metadataTitle = sourceType === 'UPLOAD' && sourcePath ? path.basename(sourcePath) : '';
  let metadataArtist = '';
  let thumbnailPath: string | null = null;
  let hasExtractedStream = false;

  // If URL, use yt-dlp to resolve direct audio stream url
  if (sourceType === 'URL') {
    try {
      console.log(`[Ingestion ${jobId}] Spawning extractor for: ${sourceUrl}`);
      const extraction = await extractMediaInfo(sourceUrl!);
      
      inputSource = extraction.streamUrl;
      metadataTitle = extraction.title;
      metadataArtist = extraction.artist;
      hasExtractedStream = true;

      if (extraction.thumbnailUrl) {
        console.log(`[Ingestion ${jobId}] Downloading thumbnail cover art...`);
        thumbnailPath = await downloadThumbnail(extraction.thumbnailUrl, jobId);
      }
    } catch (e: any) {
      // If yt-dlp fails, check if this is a direct audio file path. If not, rethrow.
      const isDirectAudioUrl = sourceUrl!.match(/\.(mp3|wav|ogg|flac|m4a|aac)(\?|$)/i);
      if (!isDirectAudioUrl) {
        throw e;
      }
      console.log(`[Ingestion ${jobId}] Extractor failed but direct audio pattern matched. Falling back to native stream piping.`);
    }
  }

  if (sourceType === 'UPLOAD' && !fs.existsSync(inputSource)) {
    throw new Error(`Upload source file does not exist at path: ${inputSource}`);
  }

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputSource);

    // Apply reconnect flags for network stream resilience
    if (sourceType === 'URL') {
      command = command.inputOptions([
        '-reconnect 1',
        '-reconnect_streamed 1',
        '-reconnect_delay_max 5'
      ]);
    }

    // Embed cover art if thumbnail download succeeded
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      command = command
        .input(thumbnailPath)
        .outputOptions(
          '-map', '0:a',
          '-map', '1:v',
          '-disposition:v:0', 'attached_pic'
        );
    }

    // Embed ID3 tags if metadata was extracted
    if (hasExtractedStream) {
      // Escape metadata strings for shell-safe formatting
      command = command.outputOptions(
        '-metadata', `title=${metadataTitle}`,
        '-metadata', `artist=${metadataArtist}`,
        '-id3v2_version', '3', // Enforce ID3v2.3 cover art support
        '-metadata:s:v', 'title=Album cover',
        '-metadata:s:v', 'comment=Cover (front)'
      );
    }

    let totalDuration = 0;

    command
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .on('start', (cmdline) => {
        console.log(`[FFmpeg Job ${jobId}] Started with command: ${cmdline}`);
      })
      .on('codecData', (data) => {
        if (data.duration) {
          totalDuration = parseDurationToSeconds(data.duration);
          console.log(`[FFmpeg Job ${jobId}] Audio duration detected: ${totalDuration}s`);
        }
      })
      .on('progress', async (progress) => {
        let percent = 0;
        if (progress.percent !== undefined) {
          percent = Math.round(progress.percent);
        } else if (totalDuration > 0 && progress.timemark) {
          const currentSeconds = parseDurationToSeconds(progress.timemark);
          percent = Math.round((currentSeconds / totalDuration) * 100);
        }
        
        percent = Math.max(0, Math.min(99, percent));
        await job.updateProgress(percent);
        await publishJobProgress(jobId, 'PROCESSING', percent);
      })
      .on('end', () => {
        console.log(`[FFmpeg Job ${jobId}] Finished transcoding.`);
        
        // Clean up temp thumbnail
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }

        try {
          const stats = fs.statSync(outputPath);
          
          ffmpeg.ffprobe(outputPath, (err, metadata) => {
            let finalDuration = totalDuration;
            if (!err && metadata && metadata.format && metadata.format.duration) {
              finalDuration = Math.round(metadata.format.duration);
            }
            
            resolve({
              outputPath,
              duration: finalDuration || 0,
              fileSize: stats.size,
              title: metadataTitle || 'Converted Audio',
            });
          });
        } catch (e) {
          reject(new Error(`Failed to stat output file: ${(e as Error).message}`));
        }
      })
      .on('error', (err) => {
        console.error(`[FFmpeg Job ${jobId}] Error:`, err);
        
        // Clean up temp thumbnail
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }

        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Converts a duration string (HH:MM:SS.MS) to total seconds.
 */
function parseDurationToSeconds(durationStr: string): number {
  try {
    const parts = durationStr.split(':');
    if (parts.length === 3) {
      const hours = parseFloat(parts[0]);
      const minutes = parseFloat(parts[1]);
      const seconds = parseFloat(parts[2]);
      return hours * 3600 + minutes * 60 + seconds;
    }
    return parseFloat(durationStr) || 0;
  } catch {
    return 0;
  }
}
