'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Link, ArrowRight, AlertTriangle } from 'lucide-react';

interface UrlInputProps {
  onSubmitUrl: (url: string) => void;
  disabled: boolean;
}

export default function UrlInput({ onSubmitUrl, disabled }: UrlInputProps) {
  const [url, setUrl] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      setLocalError('URL nuk mund të jetë bosh.');
      return;
    }

    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setLocalError('URL duhet të përdorë protokollin HTTP ose HTTPS.');
        return;
      }
    } catch {
      setLocalError('Ju lutem vendosni një URL të vlefshme.');
      return;
    }

    onSubmitUrl(trimmedUrl);
  };

  return (
    <form onSubmit={handleSubmit} className="w-full space-y-3">
      <div className="relative flex items-center">
        <div className="absolute left-4 text-gray-500">
          <Link className="w-4 h-4" />
        </div>
        
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={disabled}
          placeholder="Vendosni linkun e YouTube këtu"
          className="w-full pl-12 pr-16 py-4 bg-white/5 border border-white/10 rounded-xl font-sans text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple/50 focus:bg-white/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        />

        <motion.button
          type="submit"
          disabled={disabled || !url.trim()}
          whileHover={disabled ? {} : { scale: 1.05 }}
          whileTap={disabled ? {} : { scale: 0.95 }}
          className="absolute right-2 px-3 py-2 bg-brand-purple hover:bg-brand-purple/80 text-white rounded-lg transition-colors flex items-center justify-center disabled:opacity-50 disabled:hover:bg-brand-purple disabled:cursor-not-allowed"
        >
          <ArrowRight className="w-4 h-4" />
        </motion.button>
      </div>

      {localError && (
        <motion.div
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 text-red-400 text-xs bg-red-950/20 border border-red-500/10 px-3 py-2 rounded-xl"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          {localError}
        </motion.div>
      )}
    </form>
  );
}
