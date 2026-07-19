/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"SF Pro Display"', '-apple-system', 'BlinkMacSystemFont', '"Helvetica Neue"', 'Segoe UI', 'Inter', 'Roboto', 'Arial', 'sans-serif'],
        data: ['"SF Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ink: {
          DEFAULT: '#1d1d1f',
          soft: '#494950',
          muted: '#86868b',
        },
        purple: {
          DEFAULT: '#0071e3',
          bright: '#0a84ff',
          mid: '#5ac8fa',
          light: '#b6dcff',
        },
        violet: {
          DEFAULT: '#1d1d1f',
          mid: '#7c3aed',
          light: '#a78bfa',
        },
        magenta: '#ff375f',
      },
      boxShadow: {
        glass: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -12px rgba(15, 23, 42, 0.10), 0 20px 40px -20px rgba(15, 23, 42, 0.10)',
        'glass-lg': '0 2px 4px rgba(15, 23, 42, 0.06), 0 16px 40px -14px rgba(15, 23, 42, 0.16), 0 32px 64px -20px rgba(15, 23, 42, 0.14)',
        cta: '0 6px 20px -6px rgba(0, 0, 0, 0.30), 0 2px 6px -2px rgba(0, 0, 0, 0.20)',
      },
      transitionTimingFunction: {
        press: 'cubic-bezier(0.32, 0.72, 0, 1)',
        enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
