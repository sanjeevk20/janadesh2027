import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works on any host (GitHub Pages, Vercel, Cloudflare).
  base: './',
  // main.ts awaits the basemap check at top level.
  build: { target: 'es2022' },
});
