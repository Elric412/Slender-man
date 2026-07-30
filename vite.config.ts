import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] }
      }
    }
  },
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true }
});
