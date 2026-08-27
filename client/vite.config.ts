import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const assetBase = (process.env.ASSET_CDN_BASE_URL || process.env.VITE_ASSET_CDN_BASE_URL || '').trim();

export default defineConfig({
  base: assetBase ? `${assetBase.replace(/\/+$/, '')}/` : '/',
  envDir: '..',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://localhost:3010',
      '/uploads': 'http://localhost:3010',
      '/ws': { target: 'ws://localhost:3010', ws: true },
    },
  },
});
