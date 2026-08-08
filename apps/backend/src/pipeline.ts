import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

export const RAW_DIR       = '/tmp/shkarko-al/raw';
export const CONVERTED_DIR = '/tmp/shkarko-al/converted';
const COOKIE_FILE          = '/tmp/cookies.txt';

['/tmp/shkarko-al', RAW_DIR, CONVERTED_DIR].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// Funksion i përmirësuar për Cookies
function getCookieFlag(): string[] {
  const content = process.env.YOUTUBE_COOKIES;
  if (content && content.length > 50) {
    try {
      fs.writeFileSync(COOKIE_FILE, content.trim());
      console.log(`[Pipeline] Cookies u shkruan në ${COOKIE_FILE} (${content.length} bytes)`);
      return ['--cookies', COOKIE_FILE];
    } catch (e) {
      console.error('[Pipeline] Gabim shkrimi cookies:', e);
    }
  } else {
    console.warn('[Pipeline] KUJDES: Variabla YOUTUBE_COOKIES është bosh ose shumë e shkurtër!');
  }
  return [];
}

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export async function discoverVideo(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const cookieArgs = getCookieFlag();

    console.log(`[Discovery] Duke kërkuar metadata për: ${url}`);

    const proc = spawn(ytDlpPath, [
      ...cookieArgs,
      '--dump-json',
      '--simulate',
      '--no-check-certificates',
      '--user-agent', UA,
      '--extractor-args', 'youtube:player_client=android,web',
      url,
    ]);

    proc.stdout!.on('data', (c) => out.push(c));
    proc.stderr!.on('data', (c) => err.push(c));

    // Rritim kohën në 60 sekonda sepse YouTube është i ngadaltë me serverat
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('YouTube nuk u përgjigj (Timeout 60s). Provo një link tjetër ose refresh Cookies.'));
    }, 60_000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const errorMsg = Buffer.concat(err).toString();
        console.error(`[Discovery] yt-dlp error:`, errorMsg);
        reject(new Error('YouTube bllokoi kërkesën. Sigurohu që Cookies te Railway janë të saktë.'));
        return;
      }
      try {
        const json = JSON.parse(Buffer.concat(out).toString());
        resolve({
          title: json.title,
          thumbnail: json.thumbnail,
          duration: json.duration,
          uploader: json.uploader
        });
      } catch (e) {
        reject(new Error('Dështoi leximi i të dhënave të videos.'));
      }
    });
  });
}

export async function downloadAudio(url: string, rawPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cookieArgs = getCookieFlag();
    const proc = spawn(ytDlpPath, [
      ...cookieArgs,
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--user-agent', UA,
      '-o', rawPath,
      url
    ]);

    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Shkarkimi zgjati shumë.')); }, 300_000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Shkarkimi dështoi.'));
    });
  });
}

export async function convertToMp3(input: string, output: string, bitrate: number, rate: number, onProgress: any): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .on('progress', p => onProgress(Math.round(p.percent || 0)))
      .on('end', () => resolve(fs.statSync(output).size))
      .on('error', e => reject(e))
      .save(output);
  });
}