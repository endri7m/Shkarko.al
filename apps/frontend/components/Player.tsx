'use client';

import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Play, Pause, Download, Volume2, VolumeX, FileAudio, RotateCcw, Clock } from 'lucide-react';

interface PlayerProps {
  s3Url: string;
  downloadUrl: string;
  filename: string;
  duration: number; // in seconds
  fileSize: number; // in bytes
  bitrate: number;
  sampleRate: number;
  onReset: () => void;
}

export default function Player({ s3Url, downloadUrl, filename, duration, fileSize, bitrate, sampleRate, onReset }: PlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const seekSliderRef = useRef<HTMLInputElement>(null);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // Audio events hook
  const onTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const onAudioEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(e => console.error("Playback failed:", e));
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const seekTime = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = seekTime;
      setCurrentTime(seekTime);
    }
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  // Time formatter (seconds -> MM:SS)
  const formatTime = (timeSecs: number) => {
    const mins = Math.floor(timeSecs / 60);
    const secs = Math.floor(timeSecs % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const formattedSize = fileSize ? (fileSize / (1024 * 1024)).toFixed(2) + ' MB' : '0.00 MB';

  return (
    <div className="w-full space-y-6">
      {/* Hidden audio core */}
      <audio
        ref={audioRef}
        src={s3Url}
        onTimeUpdate={onTimeUpdate}
        onEnded={onAudioEnded}
      />

      {/* Main player board */}
      <div className="glass-panel rounded-2xl p-6 shadow-glass-glow border border-white/5 relative overflow-hidden">
        {/* Abstract glowing sphere in background */}
        <div className="absolute -right-24 -bottom-24 w-48 h-48 bg-brand-purple/10 rounded-full blur-3xl pointer-events-none" />

        {/* Audio info header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="p-3 bg-brand-purple/15 rounded-xl border border-brand-purple/20 text-brand-purple">
            <FileAudio className="w-6 h-6 animate-pulse-glow" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-white truncate">{filename}</h4>
            <p className="text-xs text-gray-400 mt-1 flex items-center gap-3 font-mono">
              <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-gray-500" /> {formatTime(duration)}</span>
              <span>•</span>
              <span>{bitrate} kbps</span>
              <span>•</span>
              <span>{(sampleRate / 1000).toFixed(1)} kHz</span>
            </p>
          </div>
        </div>

        {/* Animated Waveform Visualizer */}
        <div className="flex items-end justify-between gap-1 h-14 px-2 mb-6">
          {Array.from({ length: 48 }).map((_, i) => {
            // Generate pseudo random waves
            const h = Math.abs(Math.sin((i + 1) * 0.2)) * 80 + 10;
            // Pulse if playing
            const scaleY = isPlaying ? [1, 1.4, 0.7, 1.1, 1][(i % 5)] : 1;
            
            return (
              <motion.div
                key={i}
                initial={{ height: `${h}%` }}
                animate={isPlaying ? {
                  height: [`${h}%`, `${h * 1.3}%`, `${h * 0.6}%`, `${h}%`],
                } : { height: `${h}%` }}
                transition={{
                  duration: 1.2,
                  repeat: Infinity,
                  repeatType: "reverse",
                  delay: i * 0.02,
                }}
                className={`w-1 rounded-full ${
                  currentTime / duration > i / 48
                    ? 'bg-gradient-to-t from-brand-purple to-brand-glow'
                    : 'bg-white/10'
                }`}
              />
            );
          })}
        </div>

        {/* Seek slider */}
        <div className="space-y-2 mb-6">
          <input
            ref={seekSliderRef}
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={handleSeek}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-brand-purple hover:accent-brand-glow focus:outline-none transition-all"
          />
          <div className="flex justify-between text-xs text-gray-400 font-mono">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Control buttons & Volume board */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Play Button */}
            <motion.button
              onClick={togglePlay}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="p-3 bg-brand-purple hover:bg-brand-purple/80 text-white rounded-full shadow-glass-glow transition-all"
            >
              {isPlaying ? <Pause className="w-5 h-5 fill-white" /> : <Play className="w-5 h-5 fill-white translate-x-0.5" />}
            </motion.button>

            {/* Mute Button */}
            <button
              onClick={toggleMute}
              className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
            >
              {isMuted ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5" />}
            </button>

            {/* Volume slider */}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                setVolume(parseFloat(e.target.value));
                setIsMuted(false);
              }}
              className="w-20 h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-gray-400 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-mono bg-white/5 border border-white/5 px-2.5 py-1.5 rounded-lg">
              {formattedSize}
            </span>
          </div>
        </div>
      </div>

      {/* Action panel (Download / Convert Again) */}
      <div className="grid grid-cols-2 gap-4">
        <a
          href={downloadUrl}
          download={filename.replace(/\.[^/.]+$/, "") + ".mp3"}
          className="flex items-center justify-center gap-2 py-3.5 bg-gradient-to-r from-brand-purple to-brand-glow text-white text-sm font-semibold rounded-xl shadow-glass-glow hover:opacity-90 active:scale-[0.98] transition-all text-center cursor-pointer"
        >
          <Download className="w-4 h-4" />
          Shkarko MP3
        </a>
        
        <button
          onClick={onReset}
          className="flex items-center justify-center gap-2 py-3.5 bg-white/5 hover:bg-white/10 text-white text-sm font-semibold rounded-xl border border-white/10 active:scale-[0.98] transition-all"
        >
          <RotateCcw className="w-4 h-4" />
          Konverto një link tjetër
        </button>
      </div>

      <p className="text-center text-xs text-gray-500 font-mono">
        💡 Skedari fshihet automatikisht nga serveri pas 1 ore.
      </p>
    </div>
  );
}
