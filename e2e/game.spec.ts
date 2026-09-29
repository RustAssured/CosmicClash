import { expect, test, type Page } from '@playwright/test';

/**
 * Lead-owned end-to-end regression on the REAL app (all modules integrated): clean boot, deterministic replay across page loads,
 * a fight that makes progress, and the keyboard path from the boot screen to a live match.
 */
const errorsOf = (page: Page): string[] => {
  const errs: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
  return errs;
};

const ready = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
};

test('a harness fight boots clean, renders pixels and advances', async ({ page }) => {
  const errs = errorsOf(page);
  await page.goto('/?stage=nursery&a=lastone&b=asteroid&seed=5&t=30&freeze=1&hud=1');
  await ready(page);
  const s0 = await page.evaluate(() => window.__ADEUK__!.summary());
  expect(s0.phase).toBe('fight');
  expect(s0.fighters[0].titan).toBe('lastone');
  expect(s0.fighters[1].titan).toBe('asteroid');
  await page.evaluate(() => window.__ADEUK__!.step(60));
  const s1 = await page.evaluate(() => window.__ADEUK__!.summary());
  expect(s1.tick).toBeGreaterThan(s0.tick);
  const lit = await page.evaluate(() => {
    const px = window.__ADEUK__!.captureLogical();
    let n = 0;
    for (let i = 0; i < px.length; i += 97) if ((px[i]! & 0xffffff) !== 0) n++;
    return n / (px.length / 97);
  });
  expect(lit).toBeGreaterThan(0.3);
  expect(errs).toEqual([]);
});

test('identical params replay to an identical state hash on separate page loads', async ({ browser }) => {
  const run = async (): Promise<number> => {
    const page = await browser.newPage();
    await page.goto('/?mode=aivai&stage=nursery&a=lastone&b=asteroid&seed=9&ai=3&t=0&freeze=1&hud=0');
    await ready(page);
    await page.evaluate(() => window.__ADEUK__!.step(400));
    const h = await page.evaluate(() => window.__ADEUK__!.hash());
    await page.close();
    return h;
  };
  const a = await run();
  const b = await run();
  expect(a).toBe(b);
  expect(a).not.toBe(0);
});

test('a scripted Crush connects and the target loses matter', async ({ page }) => {
  const errs = errorsOf(page);
  await page.goto('/?stage=nursery&a=lastone&b=asteroid&seed=5&t=0&freeze=1&hud=0&gap=190&script0=4:crush');
  await ready(page);
  await page.evaluate(() => window.__ADEUK__!.step(220));
  const s = await page.evaluate(() => window.__ADEUK__!.summary());
  // the pacing target is a landed Crush removing 6–15 %; this guard only insists it is not negligible
  expect(s.fighters[1].massFrac).toBeLessThan(0.97);
  expect(errs).toEqual([]);
});
