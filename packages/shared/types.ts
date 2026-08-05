export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type SourceType = 'UPLOAD' | 'URL';

export interface ConversionOptions {
  bitrate: 128 | 192 | 320;
  sampleRate: 44100 | 48000;
}

export interface ConversionJob {
  id: string;
  sourceType: SourceType;
  sourceName: string;
  sourceUrl?: string;
  bitrate: number;
  sampleRate: number;
  status: JobStatus;
  progress: number;
  s3Key?: string;
  errorMessage?: string;
  fileSize?: number;
  duration?: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobProgressUpdate {
  jobId: string;
  status: JobStatus;
  progress: number;
  s3Url?: string;
  errorMessage?: string;
  fileSize?: number;
  duration?: number;
}
