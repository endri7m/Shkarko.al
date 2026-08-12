'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Music, Cpu, ShieldAlert, KeyRound, Radio } from 'lucide-react';
import { useConversion } from '../hooks/useConversion';
import UrlInput from '../components/UrlInput';
import Console from '../components/Console';
import Player from '../components/Player';

export default function Home() {
  const [bitrate, setBitrate] = useState<128 | 192 | 320>(320);
  const [sampleRate, setSampleRate] = useState<44100 | 48000>(44100);

  const {
    status,
    progress,
    errorMessage,
    s3Url,
    downloadUrl,
    metadata,
    convertUrl,
    reset,
  } = useConversion();

  const handleUrlSubmit = (url: string) => {
    convertUrl(url, bitrate, sampleRate);
  };

  const isConverting = ['submitting', 'queued', 'discovering', 'downloading', 'processing'].includes(status);

  return (
    <div className="min-h-screen relative flex flex-col justify-between overflow-hidden">
      {/* Background Decorative Glow Panels */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand-purple/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-brand-blue/10 rounded-full blur-3xl pointer-events-none" />

      {/* Navigation Header */}
      <header className="px-6 py-6 border-b border-white/5 relative z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-gradient-to-tr from-brand-purple to-brand-glow rounded-xl shadow-magenta-glow">
              <Music className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white bg-clip-text">
              Shkarko<span className="text-brand-purple">.al</span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full">
              <Radio className="w-3.5 h-3.5 animate-pulse" />
              Motorri Online
            </span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl mx-auto px-6 py-12 w-full grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">
        {/* Left Column: Title and Settings */}
        <div className="lg:col-span-5 space-y-8 flex flex-col justify-center">
          <div className="space-y-4">
            <motion.h1 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-4xl lg:text-5xl font-extrabold tracking-tight text-white leading-tight"
            >
              Cilësi e lartë <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-purple via-brand-glow to-brand-blue">
                Konvertim Audio
              </span>
            </motion.h1>
            <p className="text-gray-400 text-sm leading-relaxed max-w-md">
              Shkarko.al përpunon linqet e YouTube përmes një kanali me performancë të lartë të mundësuar nga FFmpeg. Konvertoni drejtpërdrejt në MP3 deri në 320kbps pa vonesa.
            </p>
          </div>

          {/* Transcode Settings Section */}
          <div className="glass-panel p-6 rounded-2xl border border-white/5 space-y-5">
            <h3 className="text-sm font-semibold text-white tracking-wide uppercase">
              Profilet e Motorrit
            </h3>

            {/* Bitrate Selector */}
            <div className="space-y-2">
              <label className="text-xs text-gray-400 block font-mono">CILËSIA (BITRATE)</label>
              <div className="grid grid-cols-3 gap-2 bg-white/5 p-1 rounded-xl border border-white/5">
                {([128, 192, 320] as const).map((b) => (
                  <button
                    key={b}
                    onClick={() => !isConverting && setBitrate(b)}
                    disabled={isConverting}
                    className={`py-2 rounded-lg text-xs font-semibold transition-all ${
                      bitrate === b
                        ? 'bg-brand-purple text-white shadow-glass-glow'
                        : 'text-gray-400 hover:text-white disabled:opacity-50'
                    }`}
                  >
                    {b} kbps
                  </button>
                ))}
              </div>
            </div>

            {/* Sample Rate Selector */}
            <div className="space-y-2">
              <label className="text-xs text-gray-400 block font-mono">KAMPIONIMI (SAMPLE RATE)</label>
              <div className="grid grid-cols-2 gap-2 bg-white/5 p-1 rounded-xl border border-white/5">
                {([44100, 48000] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => !isConverting && setSampleRate(s)}
                    disabled={isConverting}
                    className={`py-2 rounded-lg text-xs font-semibold transition-all ${
                      sampleRate === s
                        ? 'bg-brand-purple text-white shadow-glass-glow'
                        : 'text-gray-400 hover:text-white disabled:opacity-50'
                    }`}
                  >
                    {(s / 1000).toFixed(1)} kHz
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Dynamic Process State Machine */}
        <div className="lg:col-span-7 flex items-center">
          <div className="w-full">
            {status === 'idle' && (
              <div className="space-y-6">
                <div>
                  <UrlInput onSubmitUrl={handleUrlSubmit} disabled={false} />
                </div>
              </div>
            )}

            {/* Processing and Error States */}
            {['submitting', 'queued', 'discovering', 'downloading', 'processing', 'failed'].includes(status) && (
              <div className="space-y-4">
                {/* Thumbnail + title card — appears as soon as discovery completes */}
                {metadata.title && metadata.thumbnail && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 glass-panel rounded-xl p-3 border border-white/5"
                  >
                    <img
                      src={metadata.thumbnail}
                      alt={metadata.title}
                      className="w-14 h-14 rounded-lg object-cover shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs text-gray-400 font-mono mb-0.5">U gjet:</p>
                      <p className="text-sm font-semibold text-white truncate">{metadata.title}</p>
                    </div>
                  </motion.div>
                )}
                <Console
                  status={status}
                  progress={progress}
                  filename={metadata.title || metadata.filename || 'Skedari audio'}
                  errorMessage={errorMessage}
                  onRetry={reset}
                  sourceType="URL"
                />
              </div>
            )}

            {/* Completed Preview / Download */}
            {status === 'completed' && s3Url && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                <Player
                  s3Url={s3Url}
                  downloadUrl={downloadUrl || s3Url}
                  filename={metadata.filename || 'converted.mp3'}
                  duration={metadata.duration || 0}
                  fileSize={metadata.fileSize || 0}
                  bitrate={bitrate}
                  sampleRate={sampleRate}
                  onReset={reset}
                />
              </motion.div>
            )}
          </div>
        </div>
      </main>

      {/* Enterprise Standards Footer */}
      <footer className="px-6 py-8 border-t border-white/5 relative z-10 bg-[#02050c]">
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-gray-500">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/5 rounded-lg text-brand-purple border border-white/5">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h5 className="font-semibold text-gray-300">Motorri me Kanale Rrjedhëse</h5>
              <p className="mt-0.5">Konvertimi përmes kanaleve të FFmpeg shmang ngarkimin e plotë të skedarëve në memorien RAM.</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/5 rounded-lg text-brand-purple border border-white/5">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <h5 className="font-semibold text-gray-300">Mbrojtja e Sigurisë</h5>
              <p className="mt-0.5">Verifikimi automatik i llojeve të skedarëve parandalon sulmet dhe injektimet e dëmshme.</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/5 rounded-lg text-brand-purple border border-white/5">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h5 className="font-semibold text-gray-300">Bllokimi DNS SSRF</h5>
              <p className="mt-0.5">Rezolvon dhe bllokon kërkesat e linqeve të cilat synojnë rrjetet private lokale.</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
