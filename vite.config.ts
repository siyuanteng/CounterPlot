import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const backendPort = env.PORT || '3001';
  const backendUrl = `http://localhost:${backendPort}`;
  return {
    plugins: [react(), tailwindcss()],
    define: {
      // Expose backend port to frontend so store.ts can connect directly in dev
      'import.meta.env.VITE_BACKEND_PORT': JSON.stringify(backendPort),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      host: '0.0.0.0', // allow LAN access
      proxy: {
        '/api': backendUrl,
        '/generated': backendUrl,
        '/socket.io': {
          target: backendUrl,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
