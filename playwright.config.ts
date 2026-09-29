import { defineConfig } from '@playwright/test';

/** Chromium 1194 ships pre-installed under PLAYWRIGHT_BROWSERS_PATH; software GL (SwiftShader) gives WebGL2 headless. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
