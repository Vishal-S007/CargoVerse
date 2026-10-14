import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // the API server (npm run dev / npm run server) listens on PORT from .env, 4000 by default
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiPort = env.PORT || '4000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true,
      // 127.0.0.1 rather than localhost: on some systems localhost resolves to IPv6 only
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
});
