'use client';

import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { UploadCloud, FileAudio, AlertTriangle } from 'lucide-react';

interface DropperProps {
  onFileSelected: (file: File) => void;
  disabled: boolean;
}

export default function Dropper({ onFileSelected, disabled }: DropperProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;

    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const processFile = (file: File) => {
    setLocalError(null);

    // Limit client side to 50MB
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      setLocalError('File size exceeds the 50MB limit.');
      return;
    }

    onFileSelected(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (disabled) return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (disabled) return;

    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const onButtonClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  return (
    <div className="w-full">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="audio/*"
        onChange={handleChange}
        disabled={disabled}
      />

      <motion.div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={onButtonClick}
        whileHover={disabled ? {} : { scale: 1.005 }}
        whileTap={disabled ? {} : { scale: 0.995 }}
        className={`relative flex flex-col items-center justify-center min-h-[220px] rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-all duration-300 glass-panel ${
          isDragActive
            ? 'border-brand-purple bg-brand-purple/10 shadow-magenta-glow'
            : 'border-white/10 hover:border-white/20'
        } ${disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}`}
      >
        <div className="p-4 bg-white/5 rounded-full mb-4 border border-white/5 shadow-inner">
          <UploadCloud className={`w-8 h-8 text-brand-purple transition-transform duration-300 ${isDragActive ? '-translate-y-1 animate-pulse' : ''}`} />
        </div>

        <h3 className="text-lg font-medium text-white mb-2">
          Drag & Drop Audio Source
        </h3>
        <p className="text-sm text-gray-400 mb-4 max-w-xs">
          Supports WAV, FLAC, OGG, M4A, AAC, and MP3 up to 50MB
        </p>

        <span className="px-4 py-2 bg-brand-purple hover:bg-brand-purple/80 text-white text-xs font-semibold rounded-lg shadow-glass-glow transition-all duration-300">
          Browse Files
        </span>

        {localError && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute bottom-4 flex items-center gap-2 text-red-400 text-xs bg-red-950/40 border border-red-500/20 px-3 py-1.5 rounded-full"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {localError}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
