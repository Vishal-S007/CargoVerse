import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // the API server (npm run server / npm run dev) listens on 4000
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
