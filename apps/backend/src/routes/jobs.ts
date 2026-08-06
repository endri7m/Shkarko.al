import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { processJob } from '../pipeline';

const router = Router();

const BACKEND_URL    = () => process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
const CONVERTED_DIR  = '/tmp/converted';
const UPLOAD_DIR     = '/tmp/uploads';

[CONVERTED_DIR, UPLOAD_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

// ---------------------------------------------------------------------------
// In-memory job store — no DB, no Redis, no BullMQ
// ---------------------------------------------------------------------------
interface JobState {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  progress: number;
  title: string;
  fileSize: number;
  errorMessage?: string;
  createdAt: string;
}

const jobs = new Map<string, JobState>();

function getOrFail(id: string, res: Response): JobState | null {
  const j = jobs.get(id);
  if (!j) { res.status(404).json({ error: 'Job not found' }); return null; }
  return j;
}

// ---------------------------------------------------------------------------
// POST /url  — submit YouTube/audio URL
// ---------------------------------------------------------------------------
router.post('/url', async (req: Request, res: Response) => {
  const { url } = req.body;
  const bitrate    = parseInt(req.body.bitrate,    10) || 320;
  const sampleRate = parseInt(req.body.sampleRate, 10) || 44100;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (![128, 192, 320].includes(bitrate))         return res.status(400).json({ error: 'Invalid bitrate' });
  if (![44100, 48000].includes(sampleRate))        return res.status(400).json({ error: 'Invalid sampleRate' });

  const jobId = uuidv4();
  const job: JobState = {
    id: jobId,
    status: 'PENDING',
    progress: 0,
    title: '',
    fileSize: 0,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  // Respond immediately with jobId — processing runs in background
  res.json({ jobId, status: 'PENDING' });

  // Fire-and-forget async processing
  setImmediate(async () => {
    job.status   = 'PROCESSING';
    job.progress = 1;

    try {
      const result = await processJob(
        jobId,
        url,
        bitrate as 128 | 192 | 320,
        sampleRate as 44100 | 48000,
        (pct: number) => {
          job.progress = pct;
        }
      );

      job.status   = 'COMPLETED';
      job.progress = 100;
      job.title    = result.title;
      job.fileSize = result.fileSize;
      console.log(`[Jobs] ${jobId} COMPLETED — "${result.title}" ${result.fileSize} bytes`);
    } catch (err: any) {
      job.status       = 'FAILED';
      job.progress     = 0;
      job.errorMessage = err.message || 'Conversion failed';
      console.error(`[Jobs] ${jobId} FAILED:`, err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id  — poll status (called every 2s by frontend)
// ---------------------------------------------------------------------------
router.get('/:id', (req: Request, res: Response) => {
  const job = getOrFail(req.params.id, res);
  if (!job) return;

  const base = BACKEND_URL();
  const filePath = path.join(CONVERTED_DIR, `${job.id}.mp3`);

  // Double-check: if file exists but status not updated yet, force COMPLETED
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
// GET /  — list recent jobs (debug)
// ---------------------------------------------------------------------------
router.get('/', (_req: Request, res: Response) => {
  const list = Array.from(jobs.values()).slice(-20);
  return res.json(list);
});

export default router;
