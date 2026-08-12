import fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------
export const RAW_DIR        = '/tmp/shkarko-al/raw';
export const CONVERTED_DIR  = '/tmp/shkarko-al/converted';
const COOKIES_PATH          = '/tmp/youtube-cookies.txt';

['/tmp/shkarko-al', RAW_DIR, CONVERTED_DIR].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Cookie setup — called once at startup and on every yt-dlp invocation
// ---------------------------------------------------------------------------
function setupCookies(): void {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw) {
    console.warn('[Cookies] YOUTUBE_COOKIES not set — yt-dlp will run without cookies.');
    return;
  }
  try {
    // Handle escaped newlines from Railway env vars (\n → real newline)
    const content = raw.replace(/\\n/g, '\n').trim();
    // Ensure Netscape header is present
    const final = content.startsWith('# Netscape')
      ? content
      : `# Netscape HTTP Cookie File\n${content}`;
    fs.writeFileSync(COOKIES_PATH, final, 'utf8');
    console.log(`[Cookies] Written to ${COOKIES_PATH} (${final.split('\n').length} lines)`);
  } catch (e) {
    console.error('[Cookies] Failed to write cookie file:', (e as Error).message);
  }
}

// Write cookies at module load
setupCookies();

// Re-export so index.ts can call it after env is loaded
export function initCookies(): void { setupCookies(); }

function cookieArgs(): string[] {
  if (fs.existsSync(COOKIES_PATH)) {
    const size = fs.statSync(COOKIES_PATH).size;
    if (size > 10) return ['--cookies', COOKIES_PATH];
  }
  return [];
}

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

// Verify yt-dlp actually runs at startup
try {
  const ver = execFileSync(ytDlpPath, ['--version'], { timeout: 5000 }).toString().trim();
  console.log(`[Pipeline] yt-dlp version: ${ver}`);
} catch (e) {
  console.error(`[Pipeline] yt-dlp --version FAILED:`, (e as Error).message);
}

// ---------------------------------------------------------------------------
// Shared yt-dlp base flags
// ---------------------------------------------------------------------------
// User-Agent should match the browser used to export the cookies
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const REFERER = 'https://www.youtube.com/';

function baseArgs(): string[] {
  return [
    '--no-warnings',
    '--no-check-certificates',
    '--force-ipv4',
    '--socket-timeout', '30',       // fail fast if no response in 30s
    '--retries', '2',               // retry twice then give up
    '--user-agent', UA,
    '--referer',    REFERER,
    '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,configs',
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

export interface ConvertResult {
  outputPath: string;
  fileSize:   number;
  title:      string;
  thumbnail:  string | null;
  duration:   number;
}

// ---------------------------------------------------------------------------
// Helper: spawn yt-dlp, collect stdout, reject on non-zero exit
// ---------------------------------------------------------------------------
function runYtDlp(args: string[], label: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    console.log(`[${label}] ${ytDlpPath} ${args.join(' ')}`);
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (c: Buffer) => out.push(c));
    proc.stderr!.on('data', (c: Buffer) => {
      err.push(c);
      process.stdout.write(`[${label}] ${c}`);
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs).unref();

    proc.on('error', e => { clearTimeout(timer); reject(e); });

    proc.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        console.error(`[${label}] FULL STDERR:\n${stderr}`);
        // User-friendly error messages
        if (stderr.includes('Sign in') || stderr.includes('confirm') || stderr.includes('bot'))
          reject(new Error('YouTube kërkon përditësimin e Cookies te Railway.'));
        else if (stderr.includes('403') || stderr.includes('Forbidden'))
          reject(new Error('YouTube bllokoi kërkesën (403). Provo përsëri ose përditëso Cookies.'));
        else if (stderr.includes('429') || stderr.includes('Too Many'))
          reject(new Error('Shumë kërkesa. Prisni pak minuta.'));
        else if (stderr.includes('unavailable') || stderr.includes('not found'))
          reject(new Error('Video nuk u gjet ose është e fshehur.'));
        else
          reject(new Error(`yt-dlp dështoi (kod ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

// ---------------------------------------------------------------------------
// STEP 1 — Discovery
// ---------------------------------------------------------------------------
export async function discoverVideo(url: string): Promise<VideoMeta> {
  // Use -j without --simulate so yt-dlp makes a real but metadata-only request
  // --simulate still requires full page load which can hang on blocked IPs
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
// STEP 2 — Download raw audio to disk
// ---------------------------------------------------------------------------
export function downloadAudio(url: string, rawPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-progress',
      '--limit-rate', '5M',
      '-o', rawPath,
      ...baseArgs(),
      url,
    ];
    console.log(`[Download] ${ytDlpPath} ${args.join(' ')}`);
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const err: Buffer[] = [];

    proc.stdout!.on('data', (c: Buffer) => process.stdout.write(`[yt-dlp] ${c}`));
    proc.stderr!.on('data', (c: Buffer) => { err.push(c); process.stdout.write(`[yt-dlp] ${c}`); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('Shkarkimi skadoi pas 8 minutave.'));
    }, 8 * 60_000).unref();

    proc.on('error', e => { clearTimeout(timer); reject(e); });

    proc.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        console.error(`[Download] FULL STDERR:\n${stderr}`);
        if (stderr.includes('Sign in') || stderr.includes('bot'))
          reject(new Error('YouTube kërkon përditësimin e Cookies te Railway.'));
        else if (stderr.includes('403'))
          reject(new Error('YouTube bllokoi kërkesën (403). Përditëso Cookies.'));
        else
          reject(new Error(`Shkarkimi dështoi (kod ${code})`));
        return;
      }

      if (!fs.existsSync(rawPath)) {
        reject(new Error(`Skedari raw nuk u gjet: ${rawPath}`)); return;
      }
      const size = fs.statSync(rawPath).size;
      console.log(`[Download] Kompletuar. Madhësia raw: ${size} bytes`);
      if (size === 0) {
        reject(new Error('Skedari i shkarkuar është 0 bytes.')); return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// STEP 3 — Convert raw → MP3
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
