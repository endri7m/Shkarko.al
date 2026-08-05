/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#030712", // Very dark gray/black
        surface: {
          light: "rgba(255, 255, 255, 0.03)",
          DEFAULT: "rgba(17, 24, 39, 0.7)",
          dark: "rgba(3, 7, 18, 0.9)",
        },
        brand: {
          purple: "#8B5CF6", // Electric purple
          blue: "#3B82F6", // Deep ocean blue
          glow: "#D946EF", // Hot pink highlight
        }
      },
      fontFamily: {
        sans: ['var(--font-outfit)', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        'glass-glow': '0 8px 32px 0 rgba(139, 92, 246, 0.15)',
        'magenta-glow': '0 0 25px 0 rgba(217, 70, 239, 0.3)',
      },
      animation: {
        'pulse-glow': 'pulseGlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 8s linear infinite',
      },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { opacity: 1, filter: 'drop-shadow(0 0 15px rgba(139, 92, 246, 0.6))' },
          '50%': { opacity: 0.7, filter: 'drop-shadow(0 0 5px rgba(139, 92, 246, 0.2))' },
        }
      }
    },
  },
  plugins: [],
}
