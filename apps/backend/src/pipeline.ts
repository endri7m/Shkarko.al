import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// ---------------------------------------------------------------------------
// Dirs
// ---------------------------------------------------------------------------
const RAW_DIR       = '/tmp/raw';
const CONVERTED_DIR = '/tmp/converted';
[RAW_DIR, CONVERTED_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

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
console.log(`[Pipeline] ffmpeg: ${ffmpegPath}`);
console.log(`[Pipeline] yt-dlp: ${ytDlpPath}`);

const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.youtube.com/';

// ---------------------------------------------------------------------------
// Helper: run a process, resolve on exit 0, reject otherwise
// ---------------------------------------------------------------------------
function run(bin: string, args: string[], label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[${label}] ${bin} ${args.join(' ')}`);
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (c: Buffer) => process.stdout.write(`[${label}] ${c}`));
    proc.stderr!.on('data', (c: Buffer) => process.stdout.write(`[${label}] ${c}`));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs).unref();

    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: ffmpeg conversion via fluent-ffmpeg
// ---------------------------------------------------------------------------
function convertFile(
  input: string,
  output: string,
  bitrate: number,
  sampleRate: number,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let duration = 0;
    ffmpeg(input)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .outputOptions(['-vn', '-threads', '0'])
      .on('codecData', d => { if (d.duration) duration = parseSecs(d.duration); })
      .on('progress', p => {
        let pct = 0;
        if (p.percent !== undefined && p.percent > 0) pct = Math.round(p.percent);
        else if (duration > 0 && p.timemark) pct = Math.round((parseSecs(p.timemark) / duration) * 100);
        onProgress(Math.max(1, Math.min(99, pct)));
      })
      .on('end', () => {
        setImmediate(() => {
          const size = fs.existsSync(output) ? fs.statSync(output).size : 0;
          console.log(`[FFmpeg] Done. Output size: ${size} bytes`);
          resolve();
        });
      })
      .on('error', err => {
        console.error(`[FFmpeg] Error: ${err.message}`);
        reject(err);
      })
      .save(output);
  });
}

function parseSecs(s: string): number {
  try {
    const p = s.split(':');
    if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
    return parseFloat(s) || 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Main: sequential download → convert
// ---------------------------------------------------------------------------
export interface ConvertResult {
  outputPath: string;
  fileSize: number;
  title: string;
}

export async function processJob(
  jobId: string,
  sourceUrl: string,
  bitrate: number,
  sampleRate: number,
  onProgress: (pct: number) => void
): Promise<ConvertResult> {

  const rawPath    = path.join(RAW_DIR,       `${jobId}.m4a`);
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);

  // Clean up any leftovers from previous attempts
  [rawPath, outputPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

  // Wrap entire operation in a 5-minute timeout
  const TIMEOUT = 5 * 60_000;
  return Promise.race([
    _processJob(jobId, sourceUrl, bitrate, sampleRate, rawPath, outputPath, onProgress),
    new Promise<ConvertResult>((_, reject) =>
      setTimeout(() => reject(new Error('Job timed out after 5 minutes')), TIMEOUT).unref()
    ),
  ]);
}

async function _processJob(
  jobId: string,
  sourceUrl: string,
  bitrate: number,
  sampleRate: number,
  rawPath: string,
  outputPath: string,
  onProgress: (pct: number) => void
): Promise<ConvertResult> {

  // ── STEP 1: Get title (best-effort, 20s timeout) ──────────────────────────
  let title = 'Unknown Title';
  try {
    const { execFileSync: exec } = await import('child_process');
    const meta = exec(ytDlpPath, [
      '--no-warnings', '--quiet', '-j',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--user-agent', UA, '--referer', REFERER,
      sourceUrl,
    ], { timeout: 20_000 }).toString();
    const parsed = JSON.parse(meta.trim());
    title = parsed.title || title;
    console.log(`[Pipeline ${jobId}] Title: "${title}"`);
  } catch (e) {
    console.warn(`[Pipeline ${jobId}] Could not fetch title:`, (e as Error).message);
  }

  onProgress(5);

  // ── STEP 2: Download raw audio to disk ────────────────────────────────────
  console.log(`[Pipeline ${jobId}] Downloading to ${rawPath}`);
  await run(ytDlpPath, [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--no-warnings', '--no-progress',
    '--extractor-args', 'youtube:player_client=ios,android',
    '--user-agent', UA,
    '--referer', REFERER,
    '-o', rawPath,
    sourceUrl,
  ], `yt-dlp ${jobId}`, 4 * 60_000);

  // Verify raw file
  if (!fs.existsSync(rawPath)) throw new Error(`Raw file not found after download: ${rawPath}`);
  const rawSize = fs.statSync(rawPath).size;
  console.log(`[Pipeline ${jobId}] Raw file size: ${rawSize} bytes`);
  if (rawSize === 0) throw new Error('Downloaded file is 0 bytes — yt-dlp produced no output');

  onProgress(40);

  // ── STEP 3: Convert to MP3 ────────────────────────────────────────────────
  console.log(`[Pipeline ${jobId}] Converting ${rawPath} → ${outputPath}`);
  await convertFile(rawPath, outputPath, bitrate, sampleRate, onProgress);

  // Verify output
  if (!fs.existsSync(outputPath)) throw new Error(`Output MP3 not found: ${outputPath}`);
  const fileSize = fs.statSync(outputPath).size;
  if (fileSize === 0) throw new Error('Converted MP3 is 0 bytes');

  // Clean up raw file
  try { fs.unlinkSync(rawPath); } catch {}

  console.log(`[Pipeline ${jobId}] Complete. MP3 size: ${fileSize} bytes`);
  return { outputPath, fileSize, title };
}
