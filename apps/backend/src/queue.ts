import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import fs from 'fs';
import { EventEmitter } from 'events';
import { transcodeAudio, publishJobProgress } from './pipeline';
import { updateJobProgress } from './database';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export let useMemoryQueue = false;
export const localProgressEvents = new EventEmitter();

// Setup connection sharing for Redis
export let redisConnection: any = null;
export let audioQueue: any = null;

try {
  redisConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ
    connectTimeout: 2000,
  });

  redisConnection.on('error', (err: any) => {
    if (!useMemoryQueue) {
      console.warn('[Queue] Redis is offline. Switching to IN-PROCESS queue fallback.');
      useMemoryQueue = true;
    }
  });

  audioQueue = new Queue('audio-conversion', {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: true, // We store status in PostgreSQL
      removeOnFail: false,
    },
  });
} catch (error) {
  console.warn('[Queue] Redis connection failed. Switching to IN-PROCESS queue fallback.');
  useMemoryQueue = true;
}

export interface ConversionQueueJobData {
  jobId: string;
  sourceType: 'UPLOAD' | 'URL';
  sourcePath?: string; // Path to the uploaded file on shared scratch space
  sourceUrl?: string;  // Sanitized url to fetch
  sourceName: string;
  bitrate: 128 | 192 | 320;
  sampleRate: 44100 | 48000;
}

/**
 * Local asynchronous task processing loop (in-process runner fallback)
 */
async function runInProcessTranscode(jobId: string, data: ConversionQueueJobData): Promise<void> {
  console.log(`[Queue Fallback] Launching transcoding loop for job ${jobId}...`);
  try {
    // 1. Mark status as PROCESSING in DB
    await updateJobProgress(jobId, 0, 'PROCESSING');
    localProgressEvents.emit(`job-progress:${jobId}`, { jobId, status: 'PROCESSING', progress: 0 });

    // Mock BullMQ job object for progress updates
    const mockJob = {
      updateProgress: async (progressValue: number) => {
        await updateJobProgress(jobId, progressValue, 'PROCESSING');
        localProgressEvents.emit(`job-progress:${jobId}`, { jobId, status: 'PROCESSING', progress: progressValue });
      }
    } as any;

    // 2. Transcode
    const result = await transcodeAudio(mockJob, {
      jobId,
      sourceType: data.sourceType,
      sourcePath: data.sourcePath,
      sourceUrl: data.sourceUrl,
      bitrate: data.bitrate,
      sampleRate: data.sampleRate,
    });

    // Complete job - serve via backend download endpoint
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
    const localDownloadUrl = `${backendUrl}/api/jobs/${jobId}/download`;

    await updateJobProgress(jobId, 100, 'COMPLETED', undefined, undefined, result.fileSize, result.duration);
    
    const completionPayload = {
      jobId,
      status: 'COMPLETED' as const,
      progress: 100,
      s3Url: localDownloadUrl,
      duration: result.duration,
      fileSize: result.fileSize,
    };
    
    localProgressEvents.emit(`job-progress:${jobId}`, completionPayload);
    try {
      await publishJobProgress(jobId, 'COMPLETED', 100, {
        s3Url: localDownloadUrl,
        duration: result.duration,
        fileSize: result.fileSize,
      });
    } catch {}

    console.log(`[Queue Fallback] Job ${jobId} completed successfully.`);
  } catch (error: any) {
    console.error(`[Queue Fallback] Job ${jobId} failed:`, error);
    const friendlyErrorMessage = error.message || 'Transcoding engine encountered a local error.';

    await updateJobProgress(jobId, 0, 'FAILED', undefined, friendlyErrorMessage);
    
    const failPayload = {
      jobId,
      status: 'FAILED' as const,
      progress: 0,
      errorMessage: friendlyErrorMessage,
    };
    localProgressEvents.emit(`job-progress:${jobId}`, failPayload);
    try {
      await publishJobProgress(jobId, 'FAILED', 0, {
        errorMessage: friendlyErrorMessage,
      });
    } catch {}
  } finally {
    // Cleanup temporary upload files
    if (data.sourcePath && fs.existsSync(data.sourcePath)) {
      try {
        fs.unlinkSync(data.sourcePath);
      } catch (err) {
        console.error('[Queue Fallback] Cleanup error:', err);
      }
    }
  }
}

/**
 * Explicitly initialise the queue system. Called once at server startup.
 * Logs the active mode so Railway logs confirm which path is taken.
 */
export function initQueue(): void {
  const isRedisReady = redisConnection && redisConnection.status === 'ready';
  if (useMemoryQueue || !isRedisReady) {
    useMemoryQueue = true;
    console.log('[Queue] Initialised in IN-PROCESS mode (no Redis). Jobs run inside the backend process.');
  } else {
    console.log('[Queue] Initialised in BULLMQ/REDIS mode.');
  }
}

/**
 * Add an audio conversion task to the Redis/BullMQ queue, or run in-process if offline.
 */
export async function addConversionJob(jobId: string, data: ConversionQueueJobData): Promise<void> {
  const isRedisReady = redisConnection && redisConnection.status === 'ready';

  if (useMemoryQueue || !isRedisReady) {
    console.log(`[Queue] Redis is offline or not ready. Routing job ${jobId} to local in-process fallback.`);
    useMemoryQueue = true; // Lock memory queue mode
    setTimeout(() => {
      runInProcessTranscode(jobId, data).catch((err) => {
        console.error(`[Queue] Failed local task execution:`, err);
      });
    }, 50);
    return;
  }

  try {
    await audioQueue.add(`convert-${jobId}`, data, {
      jobId: jobId, // Deduplication in Redis
    });
    console.log(`[Queue] Job ${jobId} successfully pushed to BullMQ`);
  } catch (error) {
    console.warn(`[Queue] Failed pushing to BullMQ, falling back to local execution:`, error);
    useMemoryQueue = true;
    setTimeout(() => {
      runInProcessTranscode(jobId, data).catch((err) => {
        console.error(`[Queue] Failed local task execution:`, err);
      });
    }, 50);
  }
}
