import { Job } from 'bullmq';
import { JobStatus } from '@sonicflow/shared';
interface TranscodeOptions {
    jobId: string;
    sourceType: 'UPLOAD' | 'URL';
    sourcePath?: string;
    sourceUrl?: string;
    bitrate: 128 | 192 | 320;
    sampleRate: 44100 | 48000;
}
interface TranscodeResult {
    outputPath: string;
    duration: number;
    fileSize: number;
}
/**
 * Publishes progress status update via Redis PubSub
 */
export declare function publishJobProgress(jobId: string, status: JobStatus, progress: number, extra?: {
    s3Url?: string;
    errorMessage?: string;
    fileSize?: number;
    duration?: number;
}): Promise<void>;
/**
 * Run FFmpeg transcode pipeline with stream piping or native remote-reading.
 */
export declare function transcodeAudio(job: Job, options: TranscodeOptions): Promise<TranscodeResult>;
export {};
