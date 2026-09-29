import { chromium, type Browser, type Page } from '@playwright/test';

/** Shared Playwright launch for evidence/perf tools: preinstalled Chromium with software WebGL2 (SwiftShader). */
export async function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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

export interface OpenedPage {
  page: Page;
  errors: string[];
}

/** Open the game with harness params, collect console errors, wait for `window.__ADEUK__.ready`. */
export async function openGame(
  browser: Browser,
  url: string,
  viewport = { width: 1280, height: 720 },
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
