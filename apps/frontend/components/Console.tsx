'use client';

import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, RefreshCw, XCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { ClientConversionStatus } from '../hooks/useConversion';

interface ConsoleProps {
  status: ClientConversionStatus;
  progress: number;
  filename: string;
  errorMessage: string | null;
  onRetry: () => void;
  sourceType: 'UPLOAD' | 'URL';
}

interface LogEntry {
  timestamp: string;
  source: 'system' | 'ffmpeg' | 'storage' | 'error' | 'success';
  message: string;
}

export default function Console({ status, progress, filename, errorMessage, onRetry, sourceType }: ConsoleProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  const getTimestamp = () => {
    const d = new Date();
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };

  const addLog = (message: string, source: LogEntry['source'] = 'system') => {
    setLogs((prev) => [...prev, { timestamp: getTimestamp(), source, message }]);
  };

  // State machine logger side-effect
  useEffect(() => {
    if (status === 'submitting') {
      setLogs([]);
      addLog(`[Klienti] Duke krijuar lidhjen me serverin, duke ngarkuar burimin "${filename}"...`, 'system');
    } else if (status === 'queued') {
      addLog('[Gateway] Kërkesa u regjistrua me sukses. Duke e kaluar në radhën e përpunimit...', 'system');
      addLog('[Radha] Duke pritur për procesorin e parë të lirë...', 'system');
    } else if (status === 'processing') {
      if (logs.filter((l) => l.message.includes('procesorin')).length === 0) {
        addLog('[Procesori] U caktua lidhja. Duke aktivizuar kanalin FFmpeg...', 'system');
        addLog(`[FFmpeg] Profili i daljes u konfigurua: Audio Codec=libmp3lame`, 'ffmpeg');
      }
    } else if (status === 'completed') {
      addLog(`[FFmpeg] Konvertimi përfundoi. Skedari u shkrua në diskun e përkohshëm.`, 'ffmpeg');
      addLog('[Hapësira] Duke ruajtur skedarin audio në diskun e sigurt S3...', 'storage');
      addLog('[Hapësira] Ruajtja u krye. U krijua një token i sigurt shkarkimi prej 1 ore.', 'success');
      addLog('[Shkarko.al] Kërkesa u përpunua me sukses. Vegla e dëgjimit është gati.', 'success');
    } else if (status === 'failed') {
      addLog(`[Motorri] GABIM KRITIK: ${errorMessage || 'Përplasje e panjohur e sistemit'}`, 'error');
      addLog('[Sistemi] Lidhjet e përpunimit u shkëputën.', 'error');
    }
  }, [status, filename, errorMessage]);

  // Log progress updates
  useEffect(() => {
    if (status === 'processing' && progress > 0) {
      // Limit logs spamming, log every 20% interval
      const lastLoggedProgress = logs
        .filter((l) => l.message.startsWith('[FFmpeg] Transcoding progress:'))
        .map((l) => {
          const match = l.message.match(/\d+/);
          return match ? parseInt(match[0], 10) : 0;
        })
        .pop() || 0;

      if (progress - lastLoggedProgress >= 20 || progress === 99) {
        addLog(`[FFmpeg] Progresi i konvertimit: ${progress}%`, 'ffmpeg');
      }
    }
  }, [progress, status]);

  // Auto-scroll logs
  useEffect(() => {
    consoleBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="w-full glass-panel rounded-2xl overflow-hidden shadow-glass-glow border border-white/5">
      {/* Console Title Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/5">
        <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
          <Terminal className="w-4 h-4 text-brand-purple" />
          <span>shkarko-worker-console --job-monitor</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/30 border border-red-500/50"></span>
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/30 border border-yellow-500/50"></span>
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/30 border border-green-500/50"></span>
        </div>
      </div>

      {/* Logs Viewport */}
      <div className="p-4 h-60 overflow-y-auto font-mono text-xs bg-[#050b18] text-gray-300 space-y-1.5 scrollbar-thin">
        <AnimatePresence initial={false}>
          {logs.map((log, index) => {
            let colorClass = 'text-brand-purple';
            if (log.source === 'ffmpeg') colorClass = 'text-brand-blue';
            if (log.source === 'storage') colorClass = 'text-cyan-400';
            if (log.source === 'error') colorClass = 'text-red-400 font-bold';
            if (log.source === 'success') colorClass = 'text-green-400 font-bold';

            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-start gap-2 leading-relaxed"
              >
                <span className="text-gray-600 select-none">{log.timestamp}</span>
                <ChevronRight className="w-3.5 h-3.5 text-gray-600 mt-0.5 shrink-0" />
                <span className={colorClass}>{log.message}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div ref={consoleBottomRef} />
      </div>

      {/* Progress & Actions Footer */}
      <div className="p-4 bg-white/5 border-t border-white/5 space-y-4">
        {status !== 'failed' && status !== 'completed' && (
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-400 flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-brand-purple" />
                {status === 'submitting' && (sourceType === 'UPLOAD' ? 'Duke ngarkuar skedarin...' : 'Duke marrë të dhënat e videos...')}
                {status === 'queued' && 'Në radhë pritjeje...'}
                {status === 'processing' && (sourceType === 'UPLOAD' ? 'Duke konvertuar me FFmpeg...' : 'Duke përpunuar audion...')}
              </span>
              <span className="font-semibold text-brand-purple font-mono">{progress}%</span>
            </div>
            
            {/* Progress Bar Container */}
            <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
                className="h-full bg-gradient-to-r from-brand-purple to-brand-glow rounded-full shadow-magenta-glow"
              />
            </div>
          </div>
        )}

        {status === 'completed' && (
          <div className="flex items-center gap-2 text-sm text-green-400 font-semibold bg-green-950/20 border border-green-500/10 p-3 rounded-xl">
            <CheckCircle2 className="w-5 h-5 shrink-0 text-green-400" />
            <span>Skedari juaj është gati</span>
          </div>
        )}

        {status === 'failed' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5 text-sm text-red-400 font-semibold bg-red-950/20 border border-red-500/10 p-3 rounded-xl">
              <XCircle className="w-5 h-5 shrink-0 text-red-400 mt-0.5" />
              <div>
                <p>Gabim Konvertimi</p>
                <p className="text-xs font-normal text-gray-400 mt-1 font-mono">{errorMessage || 'Ndodhi një gabim gjatë përpunimit të audios.'}</p>
              </div>
            </div>
            <button
              onClick={onRetry}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-medium border border-white/10 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Konverto një link tjetër
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
