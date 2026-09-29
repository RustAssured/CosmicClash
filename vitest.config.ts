import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': src } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tools/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'threads',
  },
});
