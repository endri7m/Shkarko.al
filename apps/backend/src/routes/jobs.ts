import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import IORedis from 'ioredis';
import { createJob, getJob, updateJobProgress } from '../database';
import { addConversionJob, useMemoryQueue, localProgressEvents } from '../queue';
import { ssrfProtection } from '../middleware/ssrf';
import { uploadRateLimiter } from '../middleware/rateLimit';

const router = Router();

// Ensure local directories exist
const SCRATCH_DIR = '/tmp/sonicflow-scratch';
const UPLOAD_DIR = path.join(SCRATCH_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // Temp filename before validation
    cb(null, `${uuidv4()}-${file.originalname}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB Max
  },
});

/**
 * Validate audio files based on magic bytes signatures.
 */
async function validateAudioMagicBytes(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(12);
    try {
      fs.readSync(fd, buffer, 0, 12, 0);
      
      const hex = buffer.toString('hex').toLowerCase();
      
      // MP3: Starts with ID3 (494433) or Sync Word (fff..., ffe...)
      if (hex.startsWith('494433') || hex.startsWith('fff') || hex.startsWith('ffe')) {
        return resolve(true);
      }
      
      // WAV: Starts with RIFF (52494646) and Wave (57415645) at index 8
      if (hex.startsWith('52494646') && hex.substring(16, 24) === '57415645') {
        return resolve(true);
      }

      // FLAC: Starts with fLaC (664c6143)
      if (hex.startsWith('664c6143')) {
        return resolve(true);
      }

      // OGG: Starts with OggS (4f676753)
      if (hex.startsWith('4f676753')) {
        return resolve(true);
      }

      // M4A: Starts with ftypM4A (667479704d3441) at offset 4
      if (hex.substring(8, 22) === '667479704d3441' || hex.substring(8, 20) === '667479706d7034') {
        return resolve(true);
      }

      resolve(false);
    } catch (e) {
      console.error('Error reading magic bytes:', e);
      resolve(false);
    } finally {
      fs.closeSync(fd);
    }
  });
}

/**
 * Endpoint for Direct Audio File Upload
 */
router.post('/upload', uploadRateLimiter, upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  const tempFilePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    // 1. Validate magic numbers to ensure it's a real audio file
    const isValidAudio = await validateAudioMagicBytes(tempFilePath);
    if (!isValidAudio) {
      // Clean up invalid upload
      fs.unlinkSync(tempFilePath);
      return res.status(400).json({ error: 'Uploaded file is not a valid audio file (failed magic number check).' });
    }

    // 2. Rename file to match final jobId
    const jobId = uuidv4();
    const finalPath = path.join(UPLOAD_DIR, `${jobId}${path.extname(originalName)}`);
    fs.renameSync(tempFilePath, finalPath);

    // Parse options
    const bitrate = parseInt(req.body.bitrate, 10) || 320;
    const sampleRate = parseInt(req.body.sampleRate, 10) || 44100;

    if (![128, 192, 320].includes(bitrate)) {
      return res.status(400).json({ error: 'Invalid bitrate. Allowed values: 128, 192, 320.' });
    }
    if (![44100, 48000].includes(sampleRate)) {
      return res.status(400).json({ error: 'Invalid sample rate. Allowed values: 44100, 48000.' });
    }

    // 3. Register job in database
    const job = await createJob(
      jobId,
      'UPLOAD',
      originalName,
      undefined,
      bitrate,
      sampleRate
    );

    // 4. Push task to queue
    await addConversionJob(jobId, {
      jobId,
      sourceType: 'UPLOAD',
      sourcePath: finalPath,
      sourceName: originalName,
      bitrate: bitrate as any,
      sampleRate: sampleRate as any,
    });

    return res.json({ jobId, status: job.status });
  } catch (error) {
    console.error('Upload endpoint error:', error);
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    return res.status(500).json({ error: 'Internal server error while queueing upload conversion.' });
  }
});

/**
 * Endpoint for Remote Audio URL Conversion (SSRF protected)
 */
router.post('/url', uploadRateLimiter, ssrfProtection, async (req: Request, res: Response) => {
  const { url } = req.body;
  const bitrate = parseInt(req.body.bitrate, 10) || 320;
  const sampleRate = parseInt(req.body.sampleRate, 10) || 44100;

  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  if (![128, 192, 320].includes(bitrate)) {
    return res.status(400).json({ error: 'Invalid bitrate. Allowed values: 128, 192, 320.' });
  }
  if (![44100, 48000].includes(sampleRate)) {
    return res.status(400).json({ error: 'Invalid sample rate. Allowed values: 44100, 48000.' });
  }

  try {
    const jobId = uuidv4();
    const parsedUrl = new URL(url);
    const filename = path.basename(parsedUrl.pathname) || 'remote-audio';

    // Register job in DB
    const job = await createJob(
      jobId,
      'URL',
      filename,
      url,
      bitrate,
      sampleRate
    );

    // Push task to queue
    await addConversionJob(jobId, {
      jobId,
      sourceType: 'URL',
      sourceUrl: url,
      sourceName: filename,
      bitrate: bitrate as any,
      sampleRate: sampleRate as any,
    });

    return res.json({ jobId, status: job.status });
  } catch (error) {
    console.error('URL endpoint error:', error);
    return res.status(500).json({ error: 'Internal server error while queueing URL conversion.' });
  }
});

/**
 * Poll Job Status
 */
router.get('/:id', async (req: Request, res: Response) => {
  const job = await getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  return res.json(job);
});

/**
 * SSE Progress Stream
 */
router.get('/:id/progress', async (req: Request, res: Response) => {
  const jobId = req.params.id;
  const job = await getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  // Setup SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable proxy buffering (Nginx)
  });

  // Write initial state
  res.write(`data: ${JSON.stringify({ jobId, status: job.status, progress: job.progress, s3Url: job.s3Key ? `http://localhost:9000/sonicflow-bucket/${job.s3Key}` : undefined, errorMessage: job.errorMessage })}\n\n`);

  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    return res.end();
  }

  // Connect to Redis for updates, or use Local In-Memory Event Listener if offline
  if (useMemoryQueue) {
    const onProgressUpdate = (payload: any) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
        localProgressEvents.off(`job-progress:${jobId}`, onProgressUpdate);
        res.end();
      }
    };

    localProgressEvents.on(`job-progress:${jobId}`, onProgressUpdate);

    req.on('close', () => {
      localProgressEvents.off(`job-progress:${jobId}`, onProgressUpdate);
    });
    return;
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisSubscriber = new IORedis(redisUrl);
  const channel = `job-progress:${jobId}`;

  redisSubscriber.subscribe(channel, (err) => {
    if (err) {
      console.error(`SSE redis subscription error:`, err);
      res.write(`data: ${JSON.stringify({ error: 'Progress updates stream interrupted.' })}\n\n`);
      res.end();
    }
  });

  redisSubscriber.on('message', (chan, message) => {
    if (chan === channel) {
      res.write(`data: ${message}\n\n`);
      
      const payload = JSON.parse(message);
      if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
        redisSubscriber.unsubscribe(channel);
        redisSubscriber.quit();
        res.end();
      }
    }
  });

  // Clean up subscription on client disconnect
  req.on('close', () => {
    redisSubscriber.unsubscribe(channel);
    redisSubscriber.quit();
  });
});

/**
 * Local download fallback route serving from scratch space.
 */
router.get('/:id/download', async (req: Request, res: Response) => {
  const jobId = req.params.id;
  const filePath = path.join(SCRATCH_DIR, 'converted', `${jobId}.mp3`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Transcoded file not found or expired.' });
  }

  const job = await getJob(jobId);
  
  // Clean, web-safe filename format: Title-of-Video.mp3
  let filename = 'converted-audio.mp3';
  if (job && job.sourceName) {
    const cleanTitle = job.sourceName
      .replace(/[^a-zA-Z0-9\s-_]/g, '') // strip special characters
      .trim()
      .replace(/\s+/g, '-'); // replace whitespace with dashes
    filename = `${cleanTitle}.mp3`;
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.download(filePath, filename);
});

export default router;
