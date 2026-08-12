import fs from 'fs';
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

try {
  const ver = execFileSync(ytDlpPath, ['--version'], { timeout: 5000 }).toString().trim();
  console.log(`[Pipeline] yt-dlp version: ${ver}`);
} catch (e) {
  console.error('[Pipeline] yt-dlp --version FAILED:', (e as Error).message);
}

// ---------------------------------------------------------------------------
// Cookie support (optional — used only if YOUTUBE_COOKIES env var is set)
// ---------------------------------------------------------------------------
const COOKIES_PATH = '/tmp/youtube-cookies.txt';

export function initCookies(): void {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw) {
    console.log('[Cookies] No YOUTUBE_COOKIES set — using client spoofing only.');
    return;
  }
  try {
    const content = raw.replace(/\\n/g, '\n').trim();
    const final   = content.startsWith('# Netscape')
      ? content
      : `# Netscape HTTP Cookie File\n${content}`;
    fs.writeFileSync(COOKIES_PATH, final, 'utf8');
    console.log(`[Cookies] Written (${final.split('\n').length} lines)`);
  } catch (e) {
    console.error('[Cookies] Write failed:', (e as Error).message);
  }
}

function cookieArgs(): string[] {
  if (fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 10)
    return ['--cookies', COOKIES_PATH];
  return [];
}

// ---------------------------------------------------------------------------
// Base yt-dlp flags — Android/iOS client spoofing, no cookies required
// ---------------------------------------------------------------------------
const UA = 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip';

function baseArgs(): string[] {
  return [
    '--no-warnings',
    '--no-check-certificates',
    '--force-ipv4',
    '--no-cache-dir',
    '--socket-timeout', '30',
    '--retries', '3',
    '--buffer-size', '16K',
    '--user-agent', UA,
    // Android + iOS clients — most bot-resistant without cookies
    '--extractor-args', 'youtube:player_client=android,ios;player_skip=webpage,configs',
    ...cookieArgs(),
  ];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface VideoMeta {
  title:     string;
  thumbnail: string | null;
  duration:  number;
  uploader:  string;
}

// ---------------------------------------------------------------------------
// Helper: run yt-dlp and collect stdout
// ---------------------------------------------------------------------------
function runYtDlp(args: string[], label: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    console.log(`[${label}] Running: ${ytDlpPath} ${args.slice(0, 6).join(' ')} ...`);
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (c: Buffer) => out.push(c));
    proc.stderr!.on('data', (c: Buffer) => {
      err.push(c);
      process.stdout.write(`[${label}] ${c}`);
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      const errText = Buffer.concat(err).toString('utf8');
      console.error(`[${label}] TIMED OUT after ${timeoutMs / 1000}s. Last stderr:\n${errText}`);
      reject(new Error(`${label} skadoi pas ${timeoutMs / 1000}s`));
    }, timeoutMs).unref();

    proc.on('error', e => { clearTimeout(timer); reject(e); });

    proc.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        console.error(`[${label}] FULL STDERR (exit ${code}):\n${stderr}`);
        if (stderr.includes('Sign in') || stderr.includes('confirm') || stderr.includes('bot'))
          reject(new Error('YouTube po kërkon autentikim. Shto YOUTUBE_COOKIES te Railway.'));
        else if (stderr.includes('403') || stderr.includes('Forbidden'))
          reject(new Error('YouTube bllokoi kërkesën (403). IP i Railway është i bllokuar.'));
        else if (stderr.includes('429') || stderr.includes('Too Many'))
          reject(new Error('Shumë kërkesa. Prisni pak minuta.'));
        else if (stderr.includes('unavailable') || stderr.includes('not found') || stderr.includes('private'))
          reject(new Error('Video nuk u gjet, është private ose e fshehur.'));
        else
          reject(new Error(`yt-dlp dështoi (${code}): ${stderr.slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

// ---------------------------------------------------------------------------
// STEP 1 — Discovery: metadata only, no download
// ---------------------------------------------------------------------------
export async function discoverVideo(url: string): Promise<VideoMeta> {
  const stdout = await runYtDlp(
    ['-j', '--no-playlist', '--no-progress', ...baseArgs(), url],
    'Discovery',
    90_000
  );
  try {
    const j = JSON.parse(stdout.trim());
    return {
      title:     j.title     || 'Unknown Title',
      thumbnail: j.thumbnail || null,
      duration:  Math.round(j.duration || 0),
      uploader:  j.uploader  || j.channel || 'Unknown',
    };
  } catch {
    throw new Error('Metadata u mor por nuk mund të analizohej.');
  }
}

// ---------------------------------------------------------------------------
// STEP 2 — Download raw audio to disk with live progress reporting
// ---------------------------------------------------------------------------
export function downloadAudio(
  url: string,
  rawPath: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Try m4a first, fall back to bestaudio
    const formatArg = 'bestaudio[ext=m4a]/bestaudio/best';
    const args = [
      '-f', formatArg,
      '--no-playlist',
      '--no-cache-dir',
      '--socket-timeout', '30',
      '--retries', '3',
      '--buffer-size', '16K',
      '--progress',              // enable progress output
      '--newline',               // one line per progress update
      '-o', rawPath,
      ...baseArgs(),
      url,
    ];

    console.log(`[Download] Starting download to ${rawPath}`);
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errBufs: Buffer[] = [];

    proc.stdout!.on('data', (c: Buffer) => {
      const line = c.toString();
      process.stdout.write(`[yt-dlp] ${line}`);

      // Parse yt-dlp progress lines: "[download]  45.2% of ..."
      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const pct = Math.round(parseFloat(match[1]));
        onProgress(Math.max(1, Math.min(99, pct)));
      }
    });

    proc.stderr!.on('data', (c: Buffer) => {
      errBufs.push(c);
      process.stdout.write(`[yt-dlp err] ${c}`);
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('Shkarkimi skadoi pas 8 minutave.'));
    }, 8 * 60_000).unref();

    proc.on('error', e => { clearTimeout(timer); reject(e); });

    proc.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(errBufs).toString('utf8');

      if (code !== 0) {
        console.error(`[Download] FULL STDERR (exit ${code}):\n${stderr}`);
        if (stderr.includes('Sign in') || stderr.includes('bot'))
          reject(new Error('YouTube po kërkon autentikim. Shto YOUTUBE_COOKIES te Railway.'));
        else if (stderr.includes('403'))
          reject(new Error('YouTube bllokoi shkarkimin (403). IP i Railway është i bllokuar.'));
        else
          reject(new Error(`Shkarkimi dështoi (${code}): ${stderr.slice(0, 200)}`));
        return;
      }

      // yt-dlp sometimes writes to a slightly different path (adds extension)
      // Check for .m4a, .webm, .mp4 variants if exact path not found
      let actualPath = rawPath;
      if (!fs.existsSync(rawPath)) {
        const variants = [rawPath.replace('.m4a', '.webm'), rawPath.replace('.m4a', '.mp4'), rawPath.replace('.m4a', '.opus')];
        for (const v of variants) {
          if (fs.existsSync(v)) { actualPath = v; break; }
        }
      }

      if (!fs.existsSync(actualPath)) {
        reject(new Error(`Skedari raw nuk u gjet pas shkarkimit: ${rawPath}`)); return;
      }
      const size = fs.statSync(actualPath).size;
      console.log(`[Download] Kompletuar. Rruga: ${actualPath} | Madhësia: ${size} bytes`);
      if (size === 0) { reject(new Error('Skedari i shkarkuar është 0 bytes.')); return; }

      // Rename to expected path if different
      if (actualPath !== rawPath) {
        try { fs.renameSync(actualPath, rawPath); } catch {}
      }

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
): Promise<number> {
  return new Promise((resolve, reject) => {
    let duration = 0;
    let settled  = false;
    const done = (s: number) => { if (!settled) { settled = true; resolve(s); } };
    const fail = (e: Error)  => { if (!settled) { settled = true; reject(e); } };

    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioFrequency(sampleRate)
      .audioChannels(2)
      .outputOptions(['-vn', '-threads', '0'])
      .on('start', cmd => console.log(`[FFmpeg] ${cmd}`))
      .on('codecData', d => { if (d.duration) duration = parseSecs(d.duration); })
      .on('progress', p => {
        let pct = 0;
        if (p.percent !== undefined && p.percent > 0) pct = Math.round(p.percent);
        else if (duration > 0 && p.timemark) pct = Math.round((parseSecs(p.timemark) / duration) * 100);
        onProgress(Math.max(1, Math.min(99, pct)));
      })
      .on('end', () => {
        setImmediate(() => {
          if (!fs.existsSync(outputPath)) { fail(new Error('Output MP3 nuk u gjet.')); return; }
          const size = fs.statSync(outputPath).size;
          if (size === 0) { fail(new Error('FFmpeg prodhoi skedar 0 bytes.')); return; }
          console.log(`[FFmpeg] Gati. Madhësia: ${size} bytes`);
          done(size);
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
