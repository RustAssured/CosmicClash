import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  base: './',
  resolve: { alias: { '@': src } },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  server: { host: '0.0.0.0', port: 5173, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173 },
});
