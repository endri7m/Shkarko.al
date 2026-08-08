import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------
export const RAW_DIR       = '/tmp/shkarko-al/raw';
export const CONVERTED_DIR = '/tmp/shkarko-al/converted';

['/tmp/shkarko-al', RAW_DIR, CONVERTED_DIR].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------
function resolveBin(candidates: string[]): string {
  for (const p of candidates) {
    if (p.startsWith('/') && fs.existsSync(p)) return p;
  }
  for (const name of candidates.filter(n => !n.startsWith('/'))) {
    try { return execFileSync('which', [name]).toString().trim(); } catch {}
  }
  return candidates[candidates.length - 1];
}

const ffmpegPath = resolveBin(['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', ffmpegStatic || 'ffmpeg']);
const ytDlpPath  = resolveBin(['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp']);

ffmpeg.setFfmpegPath(ffmpegPath);
console.log(`[Pipeline] ffmpeg:  ${ffmpegPath}`);
console.log(`[Pipeline] yt-dlp:  ${ytDlpPath}`);

const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.youtube.com/';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface VideoMeta {
  title: string;
  thumbnail: string | null;
  duration: number; // seconds
  uploader: string;
}

export interface ConvertResult {
  outputPath: string;
  fileSize: number;
  title: string;
  thumbnail: string | null;
  duration: number;
}

// ---------------------------------------------------------------------------
// STEP 1 — Discovery: fetch metadata only, no download
// ---------------------------------------------------------------------------
export async function discoverVideo(url: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    const proc = spawn(ytDlpPath, [
      '--dump-json',
      '--simulate',
      '--no-warnings',
      '--no-check-certificates',
      '--prefer-free-formats',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', UA,
      '--referer', REFERER,
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (c: Buffer) => out.push(c));
    proc.stderr!.on('data', (c: Buffer) => err.push(c));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('Metadata fetch timed out after 30s'));
    }, 30_000).unref();

    proc.on('error', e => { clearTimeout(timer); reject(e); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = Buffer.concat(err).toString().slice(0, 400);
        console.error(`[Discovery] yt-dlp exit ${code}: ${msg}`);
        reject(new Error('YouTube has restricted access. Retrying...'));
        return;
      }
      try {
        const raw = Buffer.concat(out).toString('utf8').trim();
        const json = JSON.parse(raw);
        resolve({
          title:     json.title     || 'Unknown Title',
          thumbnail: json.thumbnail || null,
          duration:  Math.round(json.duration || 0),
          uploader:  json.uploader  || json.channel || 'Unknown Artist',
        });
      } catch {
        reject(new Error('Failed to parse video metadata'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// STEP 2 — Download raw audio to disk
// ---------------------------------------------------------------------------
export function downloadAudio(url: string, rawPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[Download] Starting → ${rawPath}`);

    const proc = spawn(ytDlpPath, [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-warnings', '--no-progress',
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', UA,
      '--referer', REFERER,
      '--limit-rate', '5M',
      '-o', rawPath,
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (c: Buffer) => process.stdout.write(`[yt-dlp] ${c}`));
    proc.stderr!.on('data', (c: Buffer) => process.stdout.write(`[yt-dlp] ${c}`));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('Download timed out after 8 minutes'));
    }, 8 * 60_000).unref();

    proc.on('error', e => { clearTimeout(timer); reject(e); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`yt-dlp download failed (code ${code})`)); return; }

      if (!fs.existsSync(rawPath)) { reject(new Error(`Raw file not found: ${rawPath}`)); return; }
      const size = fs.statSync(rawPath).size;
      console.log(`[Download] Complete. Raw size: ${size} bytes`);
      if (size === 0) { reject(new Error('Downloaded file is 0 bytes')); return; }

      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// STEP 3 — Convert raw file to MP3
// ---------------------------------------------------------------------------
export function convertToMp3(
  inputPath: string,
  outputPath: string,
  bitrate: number,
  sampleRate: number,
  onProgress: (pct: number) => void
): Promise<number> { // returns fileSize
  return new Promise((resolve, reject) => {
    let duration = 0;
    let settled  = false;

    const done = (size: number) => { if (!settled) { settled = true; resolve(size); } };
    const fail = (e: Error)     => { if (!settled) { settled = true; reject(e); } };

    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .audioChannels(2)
      .outputOptions(['-vn', '-threads', '0'])
      .on('start', cmd => console.log(`[FFmpeg] ${cmd}`))
      .on('codecData', d => {
        if (d.duration) duration = parseSecs(d.duration);
      })
      .on('progress', p => {
        let pct = 0;
        if (p.percent !== undefined && p.percent > 0) pct = Math.round(p.percent);
        else if (duration > 0 && p.timemark) pct = Math.round((parseSecs(p.timemark) / duration) * 100);
        onProgress(Math.max(1, Math.min(99, pct)));
      })
      .on('end', () => {
        setImmediate(() => {
          try {
            const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
            console.log(`[FFmpeg] Done. Size: ${size} bytes`);
            if (size === 0) { fail(new Error('FFmpeg produced a 0-byte output file')); return; }
            done(size);
          } catch (e) { fail(e as Error); }
        });
      })
      .on('error', err => { console.error(`[FFmpeg] ${err.message}`); fail(err); })
      .save(outputPath);
  });
}

function parseSecs(s: string): number {
  try {
    const p = s.split(':');
    if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
    return parseFloat(s) || 0;
  } catch { return 0; }
}
