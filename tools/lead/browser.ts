import { chromium, type Browser, type Page } from '@playwright/test';

const LINUX_SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Shared Playwright launch for evidence/perf tools.
 *  - Linux sandbox (the first build's environment): the preinstalled Chromium with software WebGL2 (SwiftShader).
 *  - Windows (WJ's machine): the installed Microsoft Edge (Chromium) on the real GPU, headless.
 * `CHROMIUM_PATH` overrides both.
 */
export async function launch(): Promise<Browser> {
  if (process.env.CHROMIUM_PATH || process.platform !== 'win32') {
    return chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || LINUX_SANDBOX_CHROMIUM,
      args: [
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  }
  return chromium.launch({
    channel: 'msedge',
    args: ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
}

/**
 * Real-time evidence on the real GPU: a HEADED, full-screen Edge window (rAF at the display's refresh rate, real
 * vsync, real audio device). Background/occlusion throttling is disabled so another window on top cannot slow it.
 */
export async function launchRealtime(): Promise<Browser> {
  return chromium.launch({
    channel: process.env.CHROMIUM_PATH ? undefined : 'msedge',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: false,
    args: [
      '--kiosk',
      '--start-fullscreen',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
}

export interface OpenedPage {
  page: Page;
  errors: string[];
}

/** Open the game with harness params, collect console errors, wait for `window.__ADEUK__.ready`. */
export async function openGame(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number } | null = { width: 1280, height: 720 },
): Promise<OpenedPage> {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
  return { page, errors };
}
