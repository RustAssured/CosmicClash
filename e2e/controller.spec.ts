import { expect, test, type Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { startDevServer } from '../tools/ui/devserver';
import {
  HAT,
  PRO_LEGACY,
  PRO_STANDARD,
  frames,
  installFakePads,
  plug,
  setAxis,
  setButton,
  tap,
  type PadSpec,
} from '../tools/ui/e2e-fake-pads';

/**
 * Controller Check, end to end, in a real browser, against FAKE gamepads.
 *
 * Read this before trusting a green run: the fakes reproduce what browsers are DOCUMENTED to report for a Switch Pro
 * Controller (ids, mapping strings, button and axis counts, hat encoding). They prove the pipeline — parsing, layout tables,
 * hat decoding, deadzones, latching, assignment, navigation, remapping, persistence — not that a physical controller reports
 * those numbers. The Controller Check screen exists precisely so that a player (or the next developer with the hardware in
 * hand) can see the raw numbers and remap in ten seconds when reality differs.
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

async function open(page: Page, query = 'screen=controller'): Promise<void> {
  await installFakePads(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}/dev/ui/index.html?${query}`);
  await page.waitForFunction(() => window.__sandbox?.ready === true);
  (page as Page & { __errors?: string[] }).__errors = errors;
}
const errorsOf = (page: Page): string[] => (page as Page & { __errors?: string[] }).__errors ?? [];

/** Canonical positional buttons (`Pad` in src/input/types.ts) currently held, from the Controller Check's own live view. */
async function heldCanon(page: Page, id = 'pad:0'): Promise<number[]> {
  return page.evaluate((dev) => {
    const live = window.__sandbox!.input.live(dev);
    if (!live) return [];
    const out: number[] = [];
    live.canon.forEach((v, i) => {
      if (v > 0.5) out.push(i);
    });
    return out;
  }, id);
}

const CANON = { SOUTH: 0, EAST: 1, WEST: 2, NORTH: 3, L1: 4, R1: 5, L2: 6, R2: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16, CAPTURE: 17 } as const;

/** Bits from `Btn` in src/contracts/input.ts (kept literal so this spec does not import the app). */
const BTN = { STRIKE: 1, CRUSH: 2, SURGE: 4, SIGNATURE: 8, ULTIMATE: 16, GUARD: 32, FEINT: 64, PAUSE: 128, TRAINING: 256 } as const;

async function region(page: Page): Promise<number[]> {
  // the whole logical layer, thinned, as a cheap fingerprint of "did the screen change"
  return page.evaluate(() => {
    const px = window.__sandbox!.ui.layer.pixels;
    const out: number[] = [];
    for (let i = 0; i < px.length; i += 7) out.push(px[i]!);
    return out;
  });
}
const changed = (a: number[], b: number[]): number => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

test.describe('Switch Pro Controller, W3C standard mapping (Linux hid-nintendo, macOS, current Windows)', () => {
  test('is detected, named and given Nintendo glyphs; every raw button lights its own position', async ({ page }) => {
    await open(page);
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    // Chrome hides pads until the first press: emulate the "press any button" that reveals them
    await tap(page, 0, 0);
    const info = await page.evaluate(() => window.__sandbox!.input.devices().find((d) => d.id === 'pad:0'));
    expect(info).toBeTruthy();
    expect(info!.profile).toBe('switch-pro');
    expect(info!.family).toBe('nintendo');
    expect(info!.mapping).toBe('standard');
    expect(info!.layoutId).toBe('standard');
    expect(info!.hasRumble).toBe(true);

    // raw index i -> canonical position i on the standard mapping (indices 0-16); each one alone
    const lit: number[][] = [];
    for (let raw = 0; raw <= 16; raw++) {
      await setButton(page, 0, raw, true);
      await frames(page, 3);
      lit.push(await heldCanon(page));
      await setButton(page, 0, raw, false);
      await frames(page, 3);
    }
    expect(lit.map((l) => l.join(','))).toEqual(Array.from({ length: 17 }, (_, i) => String(i)));

    // the screen itself reacts: press ZR and the drawn layer must differ from the idle drawing
    const idle = await region(page);
    await setButton(page, 0, CANON.R2, true);
    await frames(page, 4);
    const pressed = await region(page);
    expect(changed(idle, pressed)).toBeGreaterThan(20);
    await page.screenshot({ path: `${SHOTS}/controller-pro-standard-zr.png` });
    await setButton(page, 0, CANON.R2, false);
    expect(errorsOf(page)).toEqual([]);
  });

  test('default Nintendo layout in game: Y strike, X crush, B surge, A signature, ZR ultimate, ZL guard, L/R feint, + pause, − training', async ({ page }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_STANDARD);
    await frames(page, 3);
    await tap(page, 0, CANON.SOUTH); // reveals the pad (and joins P1)
    const expected: [number, number, string][] = [
      [CANON.WEST, BTN.STRIKE, 'Y'],
      [CANON.NORTH, BTN.CRUSH, 'X'],
      [CANON.SOUTH, BTN.SURGE, 'B'],
      [CANON.EAST, BTN.SIGNATURE, 'A'],
      [CANON.R2, BTN.ULTIMATE, 'ZR'],
      [CANON.L2, BTN.GUARD, 'ZL'],
      [CANON.L1, BTN.FEINT, 'L'],
      [CANON.R1, BTN.FEINT, 'R'],
      [CANON.START, BTN.PAUSE, '+'],
      [CANON.SELECT, BTN.TRAINING, '−'],
    ];
    for (const [pos, bit, label] of expected) {
      await page.evaluate(() => window.__sandbox!.resetSeen());
      await setButton(page, 0, pos, true);
      await frames(page, 4);
      const held = await page.evaluate(() => window.__sandbox!.game.held[0]);
      expect(held & bit, `raw ${pos} should hold Btn ${bit}`).toBe(bit);
      await setButton(page, 0, pos, false);
      await frames(page, 4);
      const seen = await page.evaluate(() => window.__sandbox!.game.seenPressed[0]);
      expect(seen & bit, `the tap of raw ${pos} must register as a pressed edge`).toBe(bit);
      if (label !== 'R') {
        const text = await page.evaluate(([b]) => {
          const map: Record<number, string> = { 1: 'strike', 2: 'crush', 4: 'surge', 8: 'signature', 16: 'ultimate', 32: 'guard', 64: 'feint', 128: 'pause', 256: 'training' };
          return window.__sandbox!.input.actionLabel('pad:0', map[b!] as never);
        }, [bit]);
        if (label !== 'L') expect(text).toBe(label);
      }
    }
  });

  test('a one-frame tap (about 16 ms) registers: the sim samples it at tick time and the edge is delivered', async ({ page }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_STANDARD);
    await tap(page, 0, CANON.SOUTH);
    await page.evaluate(() => window.__sandbox!.resetSeen());
    // Chrome has no press events: a button is only ever seen if a poll lands while it is down. Hold it for exactly ONE frame.
    await page.evaluate(async () => {
      const box = window.__sandbox!;
      const fp = (window as unknown as { __fp: { button(i: number, b: number, d: boolean): void } }).__fp;
      const f0 = box.frames;
      fp.button(0, 2, true); // raw 2 = west = Y = Strike
      while (box.frames < f0 + 1) await new Promise((r) => requestAnimationFrame(r));
      fp.button(0, 2, false);
    });
    await frames(page, 6);
    const seen = await page.evaluate(() => window.__sandbox!.game.seenPressed[0]);
    expect(seen & BTN.STRIKE).toBe(BTN.STRIKE);
  });
});

test.describe('Switch Pro Controller, legacy DirectInput-style mapping (no mapping string, D-pad hat on axis 9)', () => {
  test('raw B A Y X L R ZL ZR − + L3 R3 Home Capture map to their positions; the hat decodes to the D-pad', async ({ page }) => {
    await open(page);
    await plug(page, PRO_LEGACY);
    await frames(page, 4);
    await tap(page, 0, 1);
    const info = await page.evaluate(() => window.__sandbox!.input.devices().find((d) => d.id === 'pad:0'));
    expect(info!.profile).toBe('switch-pro');
    expect(info!.layoutId).toBe('nintendo-directinput');
    expect(info!.mapping).toBe('non-standard'); // the browser reported an empty mapping string
    expect(info!.hasRumble).toBe(false);

    // documented raw order: 0 B, 1 A, 2 Y, 3 X, 4 L, 5 R, 6 ZL, 7 ZR, 8 −, 9 +, 10 L3, 11 R3, 12 Home, 13 Capture
    const positions = [CANON.SOUTH, CANON.EAST, CANON.WEST, CANON.NORTH, CANON.L1, CANON.R1, CANON.L2, CANON.R2, CANON.SELECT, CANON.START, CANON.L3, CANON.R3, CANON.HOME, CANON.CAPTURE];
    for (let raw = 0; raw < positions.length; raw++) {
      await setButton(page, 0, raw, true);
      await frames(page, 3);
      expect(await heldCanon(page), `legacy raw ${raw}`).toEqual([positions[raw]]);
      await setButton(page, 0, raw, false);
      await frames(page, 3);
    }

    // hat: neutral is a value > 1 (a naive reader would call it "left+down" or "held"), then the eight directions
    const dirs: [keyof typeof HAT, string, number[]][] = [
      ['u', 'u', [CANON.UP]],
      ['ur', 'ur', [CANON.UP, CANON.RIGHT]],
      ['r', 'r', [CANON.RIGHT]],
      ['dr', 'dr', [CANON.DOWN, CANON.RIGHT]],
      ['d', 'd', [CANON.DOWN]],
      ['dl', 'dl', [CANON.DOWN, CANON.LEFT]],
      ['l', 'l', [CANON.LEFT]],
      ['ul', 'ul', [CANON.UP, CANON.LEFT]],
    ];
    expect(await heldCanon(page)).toEqual([]);
    for (const [key, hat, canon] of dirs) {
      await setAxis(page, 0, 9, HAT[key]);
      await frames(page, 3);
      expect(await page.evaluate(() => window.__sandbox!.input.live('pad:0')!.hat), `hat ${key}`).toBe(hat);
      expect(await heldCanon(page), `hat ${key}`).toEqual(canon);
    }
    await setAxis(page, 0, 9, HAT.neutral);
    await frames(page, 3);
    expect(await heldCanon(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/controller-pro-legacy.png` });
    expect(errorsOf(page)).toEqual([]);
  });

  test('menus work from the legacy pad: hat down, confirm on raw A', async ({ page }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_LEGACY);
    await frames(page, 4);
    await tap(page, 0, 12); // Home: reveals the pad without navigating anywhere
    // title: VERSUS, VS AI, TRAINING, CONTROLLER CHECK, OPTIONS: three hat-downs land on CONTROLLER CHECK
    for (let i = 0; i < 3; i++) {
      await setAxis(page, 0, 9, HAT.d);
      await frames(page, 4);
      await setAxis(page, 0, 9, HAT.neutral);
      await frames(page, 4);
    }
    await tap(page, 0, 1); // A: confirm (east, Nintendo label mode)
    await page.waitForFunction(() => window.__sandbox!.ui.screen === 'controller');
  });
});

test.describe('stick', () => {
  test('radial deadzone: a resting drift is ignored, a real push reaches the game and has the right sign (+y is down)', async ({ page }) => {
    await open(page, 'screen=title');
    await plug(page, PRO_STANDARD);
    await tap(page, 0, CANON.SOUTH);
    await setAxis(page, 0, 0, 0.09); // typical resting drift
    await setAxis(page, 0, 1, -0.07);
    await frames(page, 6);
    expect(await page.evaluate(() => [window.__sandbox!.game.moveX[0], window.__sandbox!.game.moveY[0]])).toEqual([0, 0]);
    await setAxis(page, 0, 0, 1);
    await setAxis(page, 0, 1, 0);
    await frames(page, 6);
    const right = await page.evaluate(() => [window.__sandbox!.game.moveX[0], window.__sandbox!.game.moveY[0]]);
    expect(right[0]).toBeGreaterThan(0.95);
    expect(Math.abs(right[1]!)).toBeLessThan(0.05);
    await setAxis(page, 0, 0, 0);
    await setAxis(page, 0, 1, 1); // stick pushed DOWN: y is +1 in the raw Gamepad API and +y is down in InputFrame
    await frames(page, 6);
    const down = await page.evaluate(() => [window.__sandbox!.game.moveX[0], window.__sandbox!.game.moveY[0]]);
    expect(down[1]).toBeGreaterThan(0.95);
  });
});

test.describe('remapping and persistence', () => {
  test('remap Strike to R through the Controller Check with the pad alone; it survives a reload and drives the game', async ({ page }) => {
    await open(page);
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 0, CANON.SOUTH);
    expect(await page.evaluate(() => window.__sandbox!.ui.screen)).toBe('controller');

    // LIVE tab -> RIGHT -> REMAP tab -> DOWN -> first row (STRIKE) -> confirm (east) -> press the new button
    await tap(page, 0, CANON.RIGHT);
    await tap(page, 0, CANON.DOWN);
    await tap(page, 0, CANON.EAST);
    await page.waitForFunction(() => window.__sandbox!.input.capture.status === 'waiting');
    await page.screenshot({ path: `${SHOTS}/controller-remap-waiting.png` });
    await tap(page, 0, CANON.R1);
    await page.waitForFunction(() => window.__sandbox!.input.live('pad:0')!.custom.includes('strike'));
    await frames(page, 6);
    await page.screenshot({ path: `${SHOTS}/controller-remap-done.png` });

    const before = await page.evaluate(() => JSON.stringify(window.__sandbox!.input.live('pad:0')!.bindings));
    expect(before).toContain('strike');

    // reload: a fresh page, the same pad plugged in again
    await page.reload();
    await page.waitForFunction(() => window.__sandbox?.ready === true);
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 0, CANON.SOUTH);
    const after = await page.evaluate(() => JSON.stringify(window.__sandbox!.input.live('pad:0')!.bindings));
    expect(after).toBe(before);
    expect(await page.evaluate(() => window.__sandbox!.input.live('pad:0')!.custom)).toContain('strike');

    // and the game sees it: R now strikes; the old Y no longer does
    await page.evaluate(() => window.__sandbox!.resetSeen());
    await setButton(page, 0, CANON.R1, true);
    await frames(page, 4);
    expect((await page.evaluate(() => window.__sandbox!.game.held[0])) & BTN.STRIKE).toBe(BTN.STRIKE);
    await setButton(page, 0, CANON.R1, false);
    await frames(page, 4);
    await setButton(page, 0, CANON.WEST, true);
    await frames(page, 4);
    expect((await page.evaluate(() => window.__sandbox!.game.held[0])) & BTN.STRIKE).toBe(0);
    await setButton(page, 0, CANON.WEST, false);
    expect(errorsOf(page)).toEqual([]);
  });

  test('the remap is stored as a RAW reference, so it survives the same pad appearing under a different browser mapping', async ({ page }) => {
    await open(page);
    await plug(page, PRO_LEGACY);
    await frames(page, 4);
    await tap(page, 0, 1);
    await page.evaluate(() => window.__sandbox!.input.beginCapture('pad:0', 'strike'));
    await tap(page, 0, 5); // raw 5 = R on the legacy layout
    await page.waitForFunction(() => window.__sandbox!.input.live('pad:0')!.custom.includes('strike'));
    const stored = (await page.evaluate(() => localStorage.getItem('adeuk.input.v1'))) ?? '';
    expect(stored).toContain('strike');
    // the profile key (vendor:product:mapping) is part of the key: a wrong table can never poison another pad's bindings
    expect(stored).toContain('057e');
  });

  test('corrupt stored settings are ignored instead of crashing the page', async ({ page }) => {
    await installFakePads(page);
    await page.addInitScript(() => {
      for (const k of ['adeuk.input.v1', 'adeuk.input', 'adeuk.ui.v1']) localStorage.setItem(k, '{"not": [json');
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/dev/ui/index.html?screen=controller`);
    await page.waitForFunction(() => window.__sandbox?.ready === true);
    await plug(page, PRO_STANDARD);
    await tap(page, 0, CANON.SOUTH);
    expect(errors).toEqual([]);
  });
});

test.describe('hot-plug and multiple pads', () => {
  const xboxLike: PadSpec = { id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', mapping: 'standard', buttons: 17, axes: [0, 0, 0, 0], rumble: true };

  test('two pads become P1 and P2 in the order they appeared; unplugging one frees its slot without a stuck button', async ({ page }) => {
    await open(page, 'screen=title');
    // Chrome lists a pad only after its first press and hands out the lowest free index, so index order IS appearance order
    await plug(page, xboxLike);
    await frames(page, 4);
    await tap(page, 0, CANON.SOUTH);
    await plug(page, PRO_STANDARD);
    await frames(page, 4);
    await tap(page, 1, CANON.SOUTH);
    expect(await page.evaluate(() => window.__sandbox!.input.assignment())).toEqual(['pad:0', 'pad:1']);
    expect(await page.evaluate(() => window.__sandbox!.input.devices().filter((d) => d.id.startsWith('pad')).map((d) => d.family))).toEqual(['xbox', 'nintendo']);

    // hold Strike on P1's pad and yank it out: the game must see it released, never stuck
    await setButton(page, 0, CANON.WEST, true);
    await frames(page, 4);
    expect((await page.evaluate(() => window.__sandbox!.game.held[0])) & BTN.STRIKE).toBe(BTN.STRIKE);
    await page.evaluate(() => (window as unknown as { __fp: { unplug(i: number): void } }).__fp.unplug(0));
    await frames(page, 6);
    expect((await page.evaluate(() => window.__sandbox!.game.held[0])) & BTN.STRIKE).toBe(0);
    expect(await page.evaluate(() => window.__sandbox!.input.devices().some((d) => d.id === 'pad:0' && d.connected))).toBe(false);
    expect(await page.evaluate(() => window.__sandbox!.input.assignment())).not.toContain('pad:0');
  });
});
