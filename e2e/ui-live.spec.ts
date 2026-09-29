import { expect, test, type Page } from '@playwright/test';

/**
 * The UI in the REAL app (all modules integrated), by keyboard only, the way a new player meets it:
 *   first launch → HOW TO PLAY opens by itself → skip → VS AI → difficulty → join → titans → stage → a live match → pause → resume.
 *
 * Software GL renders about one frame a second here (less when the machine is busy), and menus act once per frame, so every key
 * press is followed by a wait for whole frames (`frames`): a press is latched, so it is never lost, but two presses inside one
 * frame count as one. That is why a bare `press` loop with a fixed sleep stalls under load.
 */
const ready = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 180_000 });
};
const screen = (page: Page): Promise<string> => page.evaluate(() => window.__ADEUK__!.uiScreen());
const frames = (page: Page, n = 3): Promise<void> =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let k = count;
        const step = (): void => {
          if (--k <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
const press = async (page: Page, key: string): Promise<void> => {
  await page.keyboard.press(key);
  await frames(page);
};
const stored = (page: Page): Promise<{ seenHowTo?: boolean; matches?: number }> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('adeuk.ui.v1') ?? '{}'));

test('first launch to a live match, then pause and resume, by keyboard alone', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?q=0');
  await ready(page);
  expect(await screen(page)).toBe('boot');

  await press(page, 'Space'); // boot → title; a first launch opens HOW TO PLAY over it
  expect(await screen(page)).toBe('title');
  expect((await stored(page)).seenHowTo).toBe(true);
  await page.screenshot({ path: '.scratch/e2e/ui-live-howto.png', timeout: 180_000 });
  await press(page, 'KeyK'); // Back: skip the pages
  await press(page, 'ArrowDown'); // VERSUS → VS AI
  // title → difficulty → join → continue → lock the titan → lock the rival → (delay) → stage → the match
  for (const key of ['Space', 'Space', 'Space', 'Space', 'Space', 'Space', 'Space']) await press(page, key);
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'hud', null, { timeout: 300_000 });
  expect((await stored(page)).matches).toBe(1);

  await page.waitForFunction(() => window.__ADEUK__!.matchPhase() === 'fight', null, { timeout: 600_000 });
  await page.screenshot({ path: '.scratch/e2e/ui-live-fight.png', timeout: 180_000 });

  // pause: hold Escape across a frame (the shell reads the press inside a sim tick), then resume from the menu
  await page.keyboard.down('Escape');
  await frames(page, 4);
  await page.keyboard.up('Escape');
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'pause', null, { timeout: 300_000 });
  await page.screenshot({ path: '.scratch/e2e/ui-live-pause.png', timeout: 180_000 });
  const frozen = await page.evaluate(() => window.__ADEUK__!.summary().tick);
  await frames(page, 4);
  expect(
    await page.evaluate(() => window.__ADEUK__!.summary().tick),
    'the match is frozen while paused',
  ).toBe(frozen);
  await press(page, 'Space'); // RESUME is the first item
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'hud', null, { timeout: 300_000 });
  await page.waitForFunction((t) => window.__ADEUK__!.summary().tick > t, frozen, { timeout: 300_000 });
  expect(errors).toEqual([]);
});

test('training overlay with real fighter views: frame data while a move runs, at the bottom of the screen', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(
    '/?mode=training&p1=dummy&p2=dummy&stage=nursery&a=lastone&b=asteroid&seed=4&t=0&freeze=1&hud=1&q=0&gap=260&script0=2:crush*30',
  );
  await ready(page);
  await page.evaluate(() => window.__ADEUK__!.step(14)); // inside the Crush's startup
  await page.screenshot({ path: '.scratch/e2e/ui-live-training.png', timeout: 180_000 });
  const lit = await page.evaluate(() => {
    // the frame-data panels sit low: their region must hold drawn UI pixels (the top-left corner below the plate must not)
    const px = window.__ADEUK__!.captureLogical();
    const ink = (x0: number, y0: number, x1: number, y1: number): number => {
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) if ((px[y * 640 + x]! & 0xffffff) !== 0) n++;
      return n / ((x1 - x0) * (y1 - y0));
    };
    return { bottom: ink(8, 264, 208, 328), summary: window.__ADEUK__!.summary().phase };
  });
  expect(lit.bottom).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});

test('results with real fighter views: winner called over the fight, then REMATCH restarts and TITLE quits', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => localStorage.setItem('adeuk.ui.v1', '{"seenHowTo":true,"matches":3}'));
  await page.goto('/?mode=aivai&state=10&ai=6&stage=nursery&a=lastone&b=asteroid&seed=11&t=0&hud=1&q=0');
  await ready(page);
  const untilResults = async (): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await screen(page)) === 'results') return;
      await page.evaluate(() => window.__ADEUK__!.step(90));
      await frames(page, 2);
    }
    throw new Error('the match never reached the results screen');
  };
  await untilResults();
  await frames(page, 4);
  await page.screenshot({ path: '.scratch/e2e/ui-live-results.png', timeout: 180_000 });
  await press(page, 'Space'); // REMATCH
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'hud', null, { timeout: 300_000 });
  await untilResults();
  await frames(page, 4);
  await press(page, 'ArrowDown');
  await press(page, 'Space'); // TITLE
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'title', null, { timeout: 300_000 });
  expect(errors).toEqual([]);
});

test('attract mode: idle on the title starts an AI-vs-AI match, any key brings the title back', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await page.addInitScript(() => localStorage.setItem('adeuk.ui.v1', '{"seenHowTo":true,"matches":3}'));
  await page.goto('/?q=0');
  await ready(page);
  await press(page, 'Space'); // boot → title
  expect(await screen(page)).toBe('title');
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'attract', null, { timeout: 400_000 });
  await page.waitForFunction(() => window.__ADEUK__!.matchPhase() !== 'none', null, { timeout: 400_000 });
  await frames(page, 6);
  await page.screenshot({ path: '.scratch/e2e/ui-live-attract.png', timeout: 180_000 });
  await press(page, 'Space');
  await page.waitForFunction(() => window.__ADEUK__!.uiScreen() === 'title', null, { timeout: 300_000 });
  await page.waitForFunction(() => window.__ADEUK__!.matchPhase() === 'none', null, { timeout: 300_000 });
});
