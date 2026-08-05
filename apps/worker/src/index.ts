import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { transcodeAudio, publishJobProgress } from './pipeline.js';
import { uploadToS3, getDownloadPresignedUrl } from './storage.js';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL || 'postgresql://sonicflow_user:sonicflow_password@localhost:5432/sonicflow?sslmode=disable';

// Setup Redis connection for Worker
const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

/**
 * Direct Postgres Client to update job logs in DB
 */
async function updateDbJob(
  jobId: string,
  status: string,
  extra: { s3Key?: string; errorMessage?: string; fileSize?: number; duration?: number; sourceName?: string } = {}
) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const query = `
      UPDATE conversion_jobs
      SET status = $2,
          progress = $3,
          s3_key = COALESCE($4, s3_key),
          error_message = COALESCE($5, error_message),
          file_size = COALESCE($6, file_size),
          duration = COALESCE($7, duration),
          source_name = COALESCE($8, source_name),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    const progress = status === 'COMPLETED' ? 100 : (status === 'FAILED' ? 0 : 0);
    const values = [
      jobId,
      status,
      progress,
      extra.s3Key || null,
      extra.errorMessage || null,
      extra.fileSize || null,
      extra.duration || null,
      extra.sourceName || null,
    ];
    await client.query(query, values);
  } catch (err) {
    console.error(`[Worker] Database update error for job ${jobId}:`, err);
  } finally {
    await client.end();
  }
}

/**
 * Cleanup helper for scratch disk paths
 */
function cleanupFiles(...paths: (string | undefined)[]) {
  for (const filePath of paths) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`[Worker Cleanup] Deleted temporary file: ${filePath}`);
      } catch (err) {
        console.error(`[Worker Cleanup] Failed to delete file ${filePath}:`, err);
      }
    }
  }
}

/**
 * BullMQ Worker implementation
 */
const worker = new Worker(
  'audio-conversion',
  async (job: Job) => {
    const { jobId, sourceType, sourcePath, sourceUrl, bitrate, sampleRate } = job.data;
    console.log(`[Worker] Processing job ${jobId} (${sourceType})`);
    
    let convertedPath: string | undefined;

    try {
      // 1. Mark status as PROCESSING in DB
      await updateDbJob(jobId, 'PROCESSING');
      await publishJobProgress(jobId, 'PROCESSING', 0);

      // 2. Perform transcoding using FFmpeg pipeline
      const result = await transcodeAudio(job, {
        jobId,
        sourceType,
        sourcePath,
        sourceUrl,
        bitrate,
        sampleRate,
      });

      convertedPath = result.outputPath;
      const s3Key = `${jobId}.mp3`;

      // 3. Upload converted MP3 to S3/MinIO
      await uploadToS3(convertedPath, s3Key, 'audio/mpeg');

      // 4. Generate download pre-signed link (1-hour validation)
      const presignedUrl = await getDownloadPresignedUrl(s3Key);

      // 5. Update Postgres DB as COMPLETED
      await updateDbJob(jobId, 'COMPLETED', {
        s3Key,
        fileSize: result.fileSize,
        duration: result.duration,
        sourceName: result.title,
      });

      // 6. Signal completion over Redis PubSub
      await publishJobProgress(jobId, 'COMPLETED', 100, {
        s3Url: presignedUrl,
        duration: result.duration,
        fileSize: result.fileSize,
      });

      console.log(`[Worker] Job ${jobId} completed successfully!`);
    } catch (error: any) {
      console.error(`[Worker] Job ${jobId} failed:`, error);
      
      const friendlyErrorMessage = error.message || 'Transcoding engine encountered a read/write error.';

      // Update Postgres DB as FAILED
      await updateDbJob(jobId, 'FAILED', {
        errorMessage: friendlyErrorMessage,
      });

      // Signal failure over PubSub
      await publishJobProgress(jobId, 'FAILED', 0, {
        errorMessage: friendlyErrorMessage,
      });
    } finally {
      // 7. Housekeeping: Remove local scratch files
      cleanupFiles(sourcePath, convertedPath);
    }
  },
  {
    connection: redisConnection,
    concurrency: 4, // Allow up to 4 parallel conversions per container node
  }
);

console.log('[SonicFlow Worker] Transcoding worker is running and listening for jobs...');

// Handle clean shutdowns
async function gracefulShutdown() {
  console.log('[SonicFlow Worker] Shutting down worker...');
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
