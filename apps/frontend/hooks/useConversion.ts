import { useState, useEffect, useRef, useCallback } from 'react';
import { JobStatus } from '@sonicflow/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

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
  
  const eventSourceRef = useRef<EventSource | null>(null);

  // Close EventSource connection
  const closeConnection = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Reset converter state
  const reset = useCallback(() => {
    closeConnection();
    setStatus('idle');
    setProgress(0);
    setErrorMessage(null);
    setS3Url(null);
    setMetadata({});
  }, [closeConnection]);

  // Cleanup on unmount
  useEffect(() => {
    return () => closeConnection();
  }, [closeConnection]);

  // Connect to SSE stream
  const connectSSE = useCallback((jobId: string, filename: string) => {
    closeConnection();
    
    const sseUrl = `${API_URL}/api/jobs/${jobId}/progress`;
    const eventSource = new EventSource(sseUrl);
    eventSourceRef.current = eventSource;

    setStatus('queued');

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.error) {
          setErrorMessage(data.error);
          setStatus('failed');
          closeConnection();
          return;
        }

        const jobStatus = (data.status || '').toUpperCase() as JobStatus;
        const jobProgress = data.progress ?? 0;

        setProgress(jobProgress);

        if (jobStatus === 'PROCESSING') {
          setStatus('processing');
        } else if (jobStatus === 'COMPLETED') {
          setS3Url(data.s3Url || null);
          setMetadata((prev) => ({
            ...prev,
            duration: data.duration,
            fileSize: data.fileSize,
            filename,
          }));
          setStatus('completed');
          closeConnection();
        } else if (jobStatus === 'FAILED') {
          setErrorMessage(data.errorMessage || 'Conversion failed on the processing node.');
          setStatus('failed');
          closeConnection();
        }
      } catch (err) {
        console.error('Error parsing progress stream message:', err);
        setErrorMessage('Failed to read status updates from transcode server.');
        setStatus('failed');
        closeConnection();
      }
    };

    eventSource.onerror = (err) => {
      console.error('EventSource connection error:', err);
      setErrorMessage('Lost connection to audio processing console. Retrying...');
      // Allow connection to retry automatically, or fail if we've been trying too long
    };
  }, [closeConnection]);

  // Submit audio file for conversion
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
      
      if (!response.ok) {
        throw new Error(data.error || 'Server rejected the file upload.');
      }

      connectSSE(data.jobId, file.name);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to upload audio file.');
      setStatus('failed');
    }
  }, [connectSSE, reset]);

  // Submit audio URL for conversion
  const convertUrl = useCallback(async (url: string, bitrate: number, sampleRate: number) => {
    reset();
    setStatus('queued'); // Set to queued state immediately
    
    // Extract hypothetical filename
    let filename = 'remote-audio';
    try {
      const u = new URL(url);
      filename = u.pathname.split('/').pop() || 'remote-audio';
    } catch {}
    
    setMetadata({ filename });

    try {
      const response = await fetch(`${API_URL}/api/v1/convert/url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, bitrate, sampleRate }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Server rejected the URL request.');
      }

      connectSSE(data.jobId, filename);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to submit remote audio URL.');
      setStatus('failed');
    }
  }, [connectSSE, reset]);

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
