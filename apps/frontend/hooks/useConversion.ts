import { useState, useEffect, useRef, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const POLL_MS = 2000;

export type ClientConversionStatus = 'idle' | 'submitting' | 'queued' | 'discovering' | 'downloading' | 'processing' | 'completed' | 'failed';

export interface JobMetadata {
  duration?:  number;
  fileSize?:  number;
  filename?:  string;
  title?:     string;
  thumbnail?: string | null;
}

const STATUS_MAP: Record<string, ClientConversionStatus> = {
  PENDING:     'queued',
  DISCOVERING: 'discovering',
  DOWNLOADING: 'downloading',
  CONVERTING:  'processing',
  PROCESSING:  'processing',
  COMPLETED:   'completed',
  FAILED:      'failed',
};

export function useConversion() {
  const [status,       setStatus]       = useState<ClientConversionStatus>('idle');
  const [progress,     setProgress]     = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [s3Url,        setS3Url]        = useState<string | null>(null);
  const [metadata,     setMetadata]     = useState<JobMetadata>({});

  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const filenameRef = useRef<string>('converted.mp3');

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setStatus('idle');
    setProgress(0);
    setErrorMessage(null);
    setS3Url(null);
    setMetadata({});
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handlePollData = useCallback((data: any, fallbackFilename: string) => {
    if (!data) return;

    const mapped: ClientConversionStatus = STATUS_MAP[data.status?.toUpperCase()] || 'queued';
    const pct = typeof data.progress === 'number' ? data.progress : 0;

    setProgress(pct);

    if (mapped === 'completed') {
      // s3Url → audio player src, downloadUrl → download button href
      const downloadUrl = data.s3Url || data.downloadUrl || null;
      console.log('[useConversion] COMPLETED. Play URL:', data.s3Url, '| Download URL:', data.downloadUrl);
      setS3Url(downloadUrl);
      setProgress(100);
      setMetadata(prev => ({
        ...prev,
        filename:  data.title || prev.filename || 'converted.mp3',
        title:     data.title    || prev.title,
        thumbnail: data.thumbnail ?? prev.thumbnail,
        duration:  data.duration || prev.duration,
        fileSize:  data.fileSize || prev.fileSize,
      }));
      setStatus('completed');
      stopPolling();
    } else if (mapped === 'failed') {
      setErrorMessage(data.errorMessage || 'Conversion failed.');
      setStatus('failed');
      stopPolling();
    } else {
      // Update metadata progressively during processing
      setMetadata(prev => ({
        ...prev,
        filename:  data.title || fallbackFilename,
        title:     data.title     || prev.title,
        thumbnail: data.thumbnail ?? prev.thumbnail,
        duration:  data.duration  || prev.duration,
        fileSize:  data.fileSize  || prev.fileSize,
      }));
      setStatus(mapped);
    }
  }, [stopPolling]);

  const startPolling = useCallback((jobId: string, filename: string) => {
    stopPolling();
    filenameRef.current = filename;
    setStatus('queued');

    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/jobs/${jobId}`);
        if (!res.ok) return; // keep polling
        handlePollData(await res.json(), filename);
      } catch { /* network hiccup — keep polling */ }
    };

    poll();
    pollRef.current = setInterval(poll, POLL_MS);
  }, [stopPolling, handlePollData]);

  const convertUrl = useCallback(async (url: string, bitrate: number, sampleRate: number) => {
    reset();
    setStatus('submitting');

    let filename = 'audio';
    try { filename = new URL(url).hostname; } catch {}
    setMetadata({ filename });

    try {
      const res  = await fetch(`${API_URL}/api/v1/convert/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, bitrate, sampleRate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server rejected the request.');
      startPolling(data.jobId, filename);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to submit URL.');
      setStatus('failed');
    }
  }, [reset, startPolling]);

  const convertFile = useCallback(async (file: File, bitrate: number, sampleRate: number) => {
    reset();
    setStatus('submitting');
    setMetadata({ filename: file.name });

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('bitrate', String(bitrate));
      form.append('sampleRate', String(sampleRate));

      const res  = await fetch(`${API_URL}/api/jobs/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload rejected.');
      startPolling(data.jobId, file.name);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to upload.');
      setStatus('failed');
    }
  }, [reset, startPolling]);

  return { status, progress, errorMessage, s3Url, metadata, convertUrl, convertFile, reset };
}
