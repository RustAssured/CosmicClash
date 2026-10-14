import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * The build id online peers compare at the handshake (src/net/config.ts `buildId`, docs/netplay/STEP1.md): the commit the
 * bundle is built from. Vercel and GitHub Actions name it in the environment; locally it is read from .git; else 'dev'.
 * The same commit on Vercel and on Pages gives the same id, so players on either site can meet.
 */
function buildCommit(): string {
  const env = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (env) return env.slice(0, 12);
  try {
    const head = readFileSync(new URL('./.git/HEAD', import.meta.url), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 12);
    const ref = head.slice(5);
    try {
      return readFileSync(new URL(`./.git/${ref}`, import.meta.url), 'utf8')
        .trim()
        .slice(0, 12);
    } catch {
      const packed = readFileSync(new URL('./.git/packed-refs', import.meta.url), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      if (line) return line.slice(0, 12);
    }
  } catch {
    /* not a git checkout */
  }
  return 'dev';
}

export default defineConfig({
  base: './',
  resolve: { alias: { '@': src } },
  define: { __ADEUK_BUILD__: JSON.stringify(buildCommit()) },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  server: { host: '0.0.0.0', port: 5173, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173 },
});
