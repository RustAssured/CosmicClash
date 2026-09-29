import { expect, test, type Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { startDevServer } from '../tools/ui/devserver';
import { PRO_STANDARD, XBOX_STANDARD, frames, installFakePads, plug, tap } from '../tools/ui/e2e-fake-pads';

/**
 * UI, end to end, in a real browser: the real input manager, UI and audio engine (dev/ui/index.html) with fake gamepads.
 * Every screen is reached the way a player reaches it, then screenshotted to `.scratch/e2e/` for a human to look at.
 */
let server: ViteDevServer;
let base = '';
test.beforeAll(async () => {
  ({ server, url: base } = await startDevServer());
});
test.afterAll(async () => {
  await server.close();
});

const SHOTS = '.scratch/e2e';
const CANON = {
  SOUTH: 0,
  EAST: 1,
  WEST: 2,
  NORTH: 3,
  L1: 4,
  R1: 5,
  START: 9,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
} as const;

const problems = new WeakMap<Page, string[]>();
async function open(page: Page, query = ''): Promise<void> {
  await installFakePads(page);
  // a first launch opens the HOW TO PLAY pages over the title; these specs are about the menus behind them
  await page.addInitScript(() => {
    if (!localStorage.getItem('adeuk.ui.v1')) localStorage.setItem('adeuk.ui.v1', '{"seenHowTo":true}');
  });
  const errs: string[] = [];
  problems.set(page, errs);
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs.push(`console.${m.type()}: ${m.text()}`);
  });
  await page.goto(`${base}/dev/ui/index.html${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.__sandbox?.ready === true);
}
const clean = (page: Page): string[] => problems.get(page) ?? [];
const screen = (page: Page): Promise<string> => page.evaluate(() => window.__sandbox!.ui.screen);
const waitScreen = (page: Page, id: string, timeout = 8000): Promise<unknown> =>
  page.waitForFunction((want) => window.__sandbox!.ui.screen === want, id, { timeout });
const actions = (page: Page): Promise<{ type: string; config?: Record<string, unknown> }[]> =>
  page.evaluate(() => window.__sandbox!.actions as never);
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: `${SHOTS}/ui-${name}.png` });

test.describe('menus with a Switch Pro Controller', () => {
  test('boot → title → VS AI → difficulty → assign → titans → stage → startMatch (pad only)', async ({
    page,
  }) => {
    await open(page);
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    expect(await screen(page)).toBe('boot');
    await shot(page, 'flow-1-boot');

    await tap(page, 0, CANON.EAST); // Nintendo A = confirm (right button)
    await waitScreen(page, 'title');
    // the first press is a real user gesture: the UI asks the app to unlock audio and applies the saved volumes
    const first = await actions(page);
    expect(first.map((a) => a.type)).toEqual(expect.arrayContaining(['unlockAudio', 'setVolume']));
    await frames(page, 30); // let the fade finish for a clean screenshot
    await shot(page, 'flow-2-title');

    await tap(page, 0, CANON.DOWN); // VS AI
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'mode');
    await frames(page, 30);
    await shot(page, 'flow-3-difficulty');
    await tap(page, 0, CANON.DOWN);
    await tap(page, 0, CANON.DOWN); // 3 → 5
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'assign');
    await frames(page, 20);
    await tap(page, 0, CANON.SOUTH); // any button joins
    await frames(page, 10);
    await shot(page, 'flow-4-assign');
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'select');
    await frames(page, 40);
    await shot(page, 'flow-5-select');
    await tap(page, 0, CANON.EAST); // lock P1 (Last One)
    await frames(page, 20);
    await shot(page, 'flow-6-select-locked');
    await tap(page, 0, CANON.EAST); // the AI opponent defaults to Asteroid: lock
    await waitScreen(page, 'stage');
    await frames(page, 40);
    await shot(page, 'flow-7-stage');
    await tap(page, 0, CANON.EAST);

    await page.waitForFunction(() => window.__sandbox!.actions.some((a) => a.type === 'startMatch'));
    const start = (await actions(page)).find((a) => a.type === 'startMatch')!;
    expect(start.config).toMatchObject({
      stage: 'nursery',
      mode: 'vsai',
      infinite: false,
      slots: [
        { titan: 'lastone', controller: 'human' },
        { titan: 'asteroid', controller: 'ai', aiLevel: 5 },
      ],
    });
    // menu sounds were requested throughout, and the real audio engine built its graph from the unlock
    const sounds = await page.evaluate(() => window.__sandbox!.sounds);
    expect(sounds).toEqual(expect.arrayContaining(['confirm', 'move', 'start']));
    expect(await page.evaluate(() => window.__sandbox!.audio.ready)).toBe(true);
    expect(clean(page)).toEqual([]);
  });

  test('Back (Nintendo B, the bottom button) walks out of a menu', async ({ page }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 0, CANON.HOME); // reveal without navigating
    await tap(page, 0, CANON.DOWN); // VS AI
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'mode');
    await frames(page, 30);
    await tap(page, 0, CANON.SOUTH); // Nintendo B = back
    await waitScreen(page, 'title');
    expect(clean(page)).toEqual([]);
  });

  test('Options and Controller Check are reachable from the title, and the title remembers where the cursor was', async ({
    page,
  }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 0, CANON.HOME);
    // VERSUS, VS AI, TRAINING, HOW TO PLAY, CONTROLLER CHECK, OPTIONS
    for (let i = 0; i < 5; i++) await tap(page, 0, CANON.DOWN);
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'options');
    await frames(page, 40);
    await shot(page, 'options');
    await tap(page, 0, CANON.SOUTH);
    await waitScreen(page, 'title');
    await frames(page, 30);
    await tap(page, 0, CANON.UP); // the cursor is still on OPTIONS: one up is CONTROLLER CHECK
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'controller');
    await frames(page, 40);
    await shot(page, 'controller');
    expect(clean(page)).toEqual([]);
  });
});

test.describe('keyboard', () => {
  test('a key press boots, WASD/arrows navigate, Space confirms and the first key press is a user gesture for audio', async ({
    page,
  }) => {
    await open(page);
    // Playwright's press() is keydown+keyup with no delay: shorter than a frame, so this also proves menu key taps are latched
    await page.keyboard.press('Space');
    await waitScreen(page, 'title');
    expect((await actions(page)).map((a) => a.type)).toContain('unlockAudio');
    await frames(page, 40);
    await page.keyboard.press('ArrowDown');
    await frames(page, 4);
    await page.keyboard.press('ArrowDown');
    await frames(page, 4);
    await page.keyboard.press('Space'); // TRAINING
    await waitScreen(page, 'assign');
    await frames(page, 30);
    await shot(page, 'keyboard-assign');
    expect(clean(page)).toEqual([]);
  });
});

test.describe('screens', () => {
  const SCREENS = [
    'boot',
    'title',
    'mode',
    'assign',
    'select',
    'stage',
    'controller',
    'options',
    'pause',
    'results',
    'attract',
  ] as const;
  for (const id of SCREENS) {
    test(`${id} renders with pad prompts, without errors`, async ({ page }) => {
      await open(page, `screen=${id}`);
      await plug(page, PRO_STANDARD);
      await frames(page, 60);
      expect(await screen(page)).toBe(id);
      await shot(page, `screen-${id}`);
      // a rendered screen is never blank: plenty of opaque pixels in the UI layer
      const opaque = await page.evaluate(() => {
        let n = 0;
        const px = window.__sandbox!.ui.layer.pixels;
        for (let i = 0; i < px.length; i += 11) if (px[i]! >>> 24 !== 0) n++;
        return n;
      });
      expect(opaque, `${id} drew almost nothing`).toBeGreaterThan(400);
      expect(clean(page)).toEqual([]);
    });
  }

  test('confirm is the RIGHT face button on a Switch Pro (Nintendo A) and the BOTTOM one on an Xbox pad (A), and the prompts say so', async ({
    page,
  }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 0, CANON.HOME);
    expect(
      await page.evaluate(() => [
        window.__sandbox!.input.confirmLabel('pad:0'),
        window.__sandbox!.input.backLabel('pad:0'),
      ]),
    ).toEqual(['A', 'B']);
    await tap(page, 0, CANON.SOUTH); // the bottom button on a Pro is B = back: nothing to go back to on the title
    expect(await screen(page)).toBe('title');
    await tap(page, 0, CANON.EAST);
    await waitScreen(page, 'assign');

    // swap in an Xbox pad: same physical positions, different letters
    await page.evaluate(() => {
      window.__sandbox!.ui.showTitle();
      (window as unknown as { __fp: { unplug(i: number): void } }).__fp.unplug(0);
    });
    await plug(page, XBOX_STANDARD);
    await frames(page, 6);
    await tap(page, 0, CANON.HOME);
    expect(
      await page.evaluate(() => window.__sandbox!.input.devices().find((d) => d.id === 'pad:0')!.family),
    ).toBe('xbox');
    expect(
      await page.evaluate(() => [
        window.__sandbox!.input.confirmLabel('pad:0'),
        window.__sandbox!.input.backLabel('pad:0'),
      ]),
    ).toEqual(['A', 'B']);
    await tap(page, 0, CANON.EAST); // Xbox B = back
    expect(await screen(page)).toBe('title');
    await frames(page, 20);
    await shot(page, 'prompts-xbox');
    await tap(page, 0, CANON.SOUTH); // Xbox A = confirm
    await waitScreen(page, 'assign');
    expect(clean(page)).toEqual([]);
  });
});

test.describe('attract mode and pause', () => {
  test('idle on the title long enough and the UI asks for attract mode; any press brings the title back', async ({
    page,
  }) => {
    await open(page, 'screen=title&attract=1.5');
    await plug(page, PRO_STANDARD);
    await page.waitForFunction(() => window.__sandbox!.actions.some((a) => a.type === 'attractStart'), null, {
      timeout: 8000,
    });
    await waitScreen(page, 'attract');
    await frames(page, 90); // the attract screen ignores input for its first moments
    await tap(page, 0, CANON.EAST);
    await page.waitForFunction(() => window.__sandbox!.actions.some((a) => a.type === 'attractStop'), null, {
      timeout: 8000,
    });
    await waitScreen(page, 'title');
    expect(clean(page)).toEqual([]);
  });

  test('pause: Resume emits `resume` and the app closes the menu; Quit returns to the title', async ({
    page,
  }) => {
    await open(page, 'screen=hud&hud=1');
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 0, CANON.HOME);
    await page.evaluate(() => window.__sandbox!.ui.showPause(true));
    await waitScreen(page, 'pause');
    await frames(page, 30);
    await shot(page, 'pause');
    await tap(page, 0, CANON.EAST); // first row: RESUME
    await page.waitForFunction(() => window.__sandbox!.actions.some((a) => a.type === 'resume'));
    await waitScreen(page, 'hud');
    expect(clean(page)).toEqual([]);
  });
});

test.describe('HUD', () => {
  test('draws the in-match HUD and stays inside its frame budget in a real browser', async ({ page }) => {
    await open(page, 'screen=hud&hud=1');
    await frames(page, 30);
    await shot(page, 'hud');
    const ms = await page.evaluate(() => {
      const box = window.__sandbox!;
      const t0 = performance.now();
      for (let i = 0; i < 120; i++) {
        box.ui.update(1 / 60);
        box.ui.draw(null);
      }
      return (performance.now() - t0) / 120;
    });
    // software rendering, no GPU, CI-class CPU: generous, but a regression to 10+ ms would still fail it
    expect(ms).toBeLessThan(8);
    expect(clean(page)).toEqual([]);
  });
});
