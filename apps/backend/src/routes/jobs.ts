import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { discoverVideo, downloadAudio, convertToMp3, CONVERTED_DIR, RAW_DIR } from '../pipeline';

const router = Router();
const BACKEND_URL = () => process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
type JobStatus = 'PENDING' | 'DISCOVERING' | 'DOWNLOADING' | 'CONVERTING' | 'COMPLETED' | 'FAILED';

interface JobState {
  id:           string;
  status:       JobStatus;
  progress:     number;
  title:        string;
  thumbnail:    string | null;
  duration:     number;
  fileSize:     number;
  errorMessage: string | undefined;
  createdAt:    string;
}

const jobs = new Map<string, JobState>();

// Clean up old jobs and files every hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, job] of jobs) {
    if (new Date(job.createdAt).getTime() < cutoff) {
      jobs.delete(id);
      [path.join(CONVERTED_DIR, `${id}.mp3`), path.join(RAW_DIR, `${id}.m4a`)]
        .forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    }
  }
}, 60 * 60_000).unref();

// ---------------------------------------------------------------------------
// POST /url
// ---------------------------------------------------------------------------
router.post('/url', async (req: Request, res: Response) => {
  const { url } = req.body;
  const bitrate    = parseInt(req.body.bitrate,    10) || 192;
  const sampleRate = parseInt(req.body.sampleRate, 10) || 44100;

  if (!url)                                return res.status(400).json({ error: 'URL is required' });
  if (![128, 192, 320].includes(bitrate))  return res.status(400).json({ error: 'Invalid bitrate' });
  if (![44100, 48000].includes(sampleRate)) return res.status(400).json({ error: 'Invalid sampleRate' });

  const jobId = uuidv4();
  const job: JobState = {
    id: jobId, status: 'PENDING', progress: 0,
    title: '', thumbnail: null, duration: 0,
    fileSize: 0, errorMessage: undefined,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  // Respond immediately
  res.json({ jobId, status: 'PENDING' });

  // Fire-and-forget processing
  setImmediate(() => runJob(job, url, bitrate, sampleRate));
});

// ---------------------------------------------------------------------------
// Core job runner — sequential: discover → download → convert
// ---------------------------------------------------------------------------
async function runJob(
  job: JobState,
  url: string,
  bitrate: number,
  sampleRate: number
): Promise<void> {
  const { id: jobId } = job;
  const rawPath    = path.join(RAW_DIR,       `${jobId}.m4a`);
  const outputPath = path.join(CONVERTED_DIR, `${jobId}.mp3`);

  // Clean up leftovers
  [rawPath, outputPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

  // 5-minute overall timeout
  const timeout = setTimeout(() => {
    if (job.status !== 'COMPLETED' && job.status !== 'FAILED') {
      job.status = 'FAILED';
      job.errorMessage = 'Job timed out after 5 minutes';
      console.error(`[Jobs] ${jobId} timed out`);
    }
  }, 5 * 60_000).unref();

  try {
    // ── STEP 1: Discovery ──────────────────────────────────────────────────
    job.status   = 'DISCOVERING';
    job.progress = 2;
    console.log(`[Jobs] ${jobId} DISCOVERING: ${url}`);

    const meta = await discoverVideo(url);
    job.title     = meta.title;
    job.thumbnail = meta.thumbnail;
    job.duration  = meta.duration;
    job.progress  = 10;
    console.log(`[Jobs] ${jobId} Found: "${meta.title}" (${meta.duration}s)`);

    // ── STEP 2: Download ───────────────────────────────────────────────────
    job.status   = 'DOWNLOADING';
    job.progress = 15;
    console.log(`[Jobs] ${jobId} DOWNLOADING`);

    await downloadAudio(url, rawPath);
    job.progress = 45;

    // ── STEP 3: Convert ────────────────────────────────────────────────────
    job.status   = 'CONVERTING';
    job.progress = 50;
    console.log(`[Jobs] ${jobId} CONVERTING`);

    const fileSize = await convertToMp3(
      rawPath, outputPath,
      bitrate, sampleRate,
      (pct: number) => {
        // Map FFmpeg's 1-99 into our 50-99 range
        job.progress = Math.round(50 + pct * 0.49);
      }
    );

    job.fileSize = fileSize;
    job.status   = 'COMPLETED';
    job.progress = 100;
    console.log(`[Jobs] ${jobId} COMPLETED — "${job.title}" ${fileSize} bytes`);

  } catch (err: any) {
    job.status       = 'FAILED';
    job.progress     = 0;
    job.errorMessage = err.message || 'Conversion failed';
    console.error(`[Jobs] ${jobId} FAILED:`, err.message);
  } finally {
    clearTimeout(timeout);
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// GET /:id — poll status every 2s
// ---------------------------------------------------------------------------
router.get('/:id', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const base     = BACKEND_URL();
  const filePath = path.join(CONVERTED_DIR, `${job.id}.mp3`);

  // File-system override — if file is there and job not yet marked complete
  if (job.status !== 'COMPLETED' && job.status !== 'FAILED' && fs.existsSync(filePath)) {
    const size = fs.statSync(filePath).size;
    if (size > 0) {
      job.status   = 'COMPLETED';
      job.progress = 100;
      job.fileSize = size;
    }
  }

  const response: any = {
    id:           job.id,
    status:       job.status,
    progress:     job.progress,
    title:        job.title || job.id,
    thumbnail:    job.thumbnail,
    duration:     job.duration,
    fileSize:     job.fileSize,
    errorMessage: job.errorMessage,
    createdAt:    job.createdAt,
  };

  if (job.status === 'COMPLETED') {
    response.s3Url      = `${base}/downloads/${job.id}.mp3`;
    response.downloadUrl = response.s3Url;
  }

  return res.json(response);
});

// ---------------------------------------------------------------------------
// GET / — list recent jobs (debug)
// ---------------------------------------------------------------------------
router.get('/', (_req: Request, res: Response) => {
  return res.json(Array.from(jobs.values()).slice(-20));
});

export default router;
