import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 8933,
    proxy: {
      // 开发模式下把 API 请求转发给 node 服务
      '/api': { target: 'http://localhost:8930', changeOrigin: true },
    },
  },
});
