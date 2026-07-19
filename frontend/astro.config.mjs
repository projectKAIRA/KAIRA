// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://trykaira.ai';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  integrations: [sitemap()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
      hmr: { clientPort: 443, protocol: 'wss' },
    },
  },
});
