// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// TODO: replace with the real production domain before launch.
const SITE_URL = 'https://projectkaira.com';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
