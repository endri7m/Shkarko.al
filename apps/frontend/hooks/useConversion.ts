import { useState, useEffect, useRef, useCallback } from 'react';
import { JobStatus } from '@sonicflow/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const POLL_INTERVAL_MS = 2000;

export type ClientConversionStatus = 'idle' | 'submitting' | 'queued' | 'processing' | 'completed' | 'failed';

interface JobMetadata {
  duration?: number;
  fileSize?: number;
  filename?: string;
}

export function useConversion() {
  const [status, setStatus] = useState<ClientConversionStatus>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [s3Url, setS3Url] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<JobMetadata>({});

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filenameRef = useRef<string>('converted.mp3');

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setStatus('idle');
    setProgress(0);
    setErrorMessage(null);
    setS3Url(null);
    setMetadata({});
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleJobUpdate = useCallback((data: any, filename: string) => {
    if (!data) return;

    const jobStatus = (data.status || '').toUpperCase() as JobStatus;
    const jobProgress = typeof data.progress === 'number' ? data.progress : 0;

    setProgress(jobProgress);

    if (jobStatus === 'PROCESSING' || jobStatus === 'PENDING') {
      setStatus(jobStatus === 'PROCESSING' ? 'processing' : 'queued');
    } else if (jobStatus === 'COMPLETED') {
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
      const downloadUrl = data.s3Key
        ? `${backendUrl}/api/jobs/${data.id}/download`
        : data.s3Url || null;

      setS3Url(downloadUrl);
      setMetadata({
        duration: data.duration,
        fileSize: data.fileSize,
        filename,
      });
      setStatus('completed');
      setProgress(100);
      stopPolling();
    } else if (jobStatus === 'FAILED') {
      setErrorMessage(data.errorMessage || data.error_message || 'Conversion failed on the processing node.');
      setStatus('failed');
      stopPolling();
    }
  }, [stopPolling]);

  // Polling — calls GET /api/jobs/:id every 2 seconds
  const startPolling = useCallback((jobId: string, filename: string) => {
    stopPolling();
    filenameRef.current = filename;
    setStatus('queued');

    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/jobs/${jobId}`);
        if (!res.ok) {
          // Job not found yet — keep polling
          return;
        }
        const data = await res.json();
        handleJobUpdate(data, filename);
      } catch (err) {
        console.error('[Polling] Fetch error:', err);
        // Network hiccup — keep polling, don't fail the job
      }
    };

    // Poll immediately, then every 2 seconds
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [stopPolling, handleJobUpdate]);

  const convertFile = useCallback(async (file: File, bitrate: number, sampleRate: number) => {
    reset();
    setStatus('submitting');
    setMetadata({ filename: file.name });

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('bitrate', bitrate.toString());
      formData.append('sampleRate', sampleRate.toString());

      const response = await fetch(`${API_URL}/api/jobs/upload`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Server rejected the file upload.');

      startPolling(data.jobId, file.name);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to upload audio file.');
      setStatus('failed');
    }
  }, [reset, startPolling]);

  const convertUrl = useCallback(async (url: string, bitrate: number, sampleRate: number) => {
    reset();
    setStatus('queued');

    let filename = 'remote-audio';
    try {
      const u = new URL(url);
      filename = u.pathname.split('/').pop() || 'remote-audio';
    } catch {}
    setMetadata({ filename });

    try {
      const response = await fetch(`${API_URL}/api/v1/convert/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, bitrate, sampleRate }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Server rejected the URL request.');

      startPolling(data.jobId, filename);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to submit remote audio URL.');
      setStatus('failed');
    }
  }, [reset, startPolling]);

  return {
    status,
    progress,
    errorMessage,
    s3Url,
    metadata,
    convertFile,
    convertUrl,
    reset,
  };
}
