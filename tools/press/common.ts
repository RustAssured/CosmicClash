import type { Browser, Page } from '@playwright/test';
import type { PressCfg } from '../../dev/press/press';

/** Press kit shared bits: the work folder, config ↔ query string, the worker page. */
export const PRESS = 'press';
export const WORK = 'press/work';

export const query = (c: PressCfg): string =>
  `mode=aivai&a=${c.a}&b=${c.b}&stage=${c.stage}&seed=${c.seed}&ai=${c.ai}${c.script0 ? `&script0=${encodeURIComponent(c.script0)}` : ''}`;
export const cfgKey = (c: PressCfg): string =>
  `${c.a}-${c.b}-${c.stage}-${c.seed}${c.script0 ? `-s${c.script0.length % 97}` : ''}`;

export async function openWorker(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`[worker pageerror] ${e.message}`));
  page.on('console', (m) => {
    // a missing favicon is the dev server's business, not the worker's
    if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource/.test(m.text()))
      console.error(`[worker ${m.type()}] ${m.text()}`);
  });
  await page.goto(`${url}/dev/press/press.html`);
  await page.waitForFunction(() => window.__press !== undefined, null, { timeout: 120_000 });
  return page;
}

export const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
