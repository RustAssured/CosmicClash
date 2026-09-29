import type { Page } from '@playwright/test';

/**
 * Fake gamepads for Playwright, installed as a REPLACEMENT for `navigator.getGamepads` before any page script runs.
 *
 * What this exercises: the whole input pipeline from `navigator.getGamepads()` upward — id parsing, mapping/layout tables,
 * hat decoding, deadzones, latching, auto-assignment, menu navigation, the Controller Check, storage and reload.
 * What it CANNOT exercise: a real Switch Pro Controller. Headless Chromium has no Bluetooth and no HID stack, so nothing here
 * proves what a browser actually reports for real hardware; the shapes below (ids, mapping strings, button/axis counts, hat
 * values) are written from documented browser behaviour and must be confirmed on hardware (README, "Known issues").
 *
 * Like Chrome (and unlike Firefox), `getGamepads()` returns fresh SNAPSHOTS on every call, so any code that held on to a pad
 * object across frames would see stale values here exactly as it would in Chrome.
 */
export interface PadSpec {
  id: string;
  mapping: 'standard' | '';
  buttons: number;
  axes: readonly number[];
  /** Give the pad a `vibrationActuator` that records what it is asked to play. */
  rumble?: boolean;
  /** Index in the `getGamepads()` array (default: first free). */
  index?: number;
}

export const HAT = {
  neutral: 1.2857142686843872,
  u: -1,
  ur: -0.7142857313156128,
  r: -0.4285714030265808,
  dr: -0.14285719394683838,
  d: 0.14285707473754883,
  dl: 0.4285714626312256,
  l: 0.7142857313156128,
  ul: 1,
} as const;

/** Switch Pro Controller as Chrome reports it with the W3C 'standard' mapping (Linux hid-nintendo, macOS, recent Windows). */
export const PRO_STANDARD: PadSpec = {
  id: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
  mapping: 'standard',
  buttons: 17,
  axes: [0, 0, 0, 0],
  rumble: true,
};

/** Switch Pro Controller on the legacy DirectInput-style path: no mapping, 16 buttons, 10 axes with the D-pad as a hat on axis 9. */
export const PRO_LEGACY: PadSpec = {
  id: 'Pro Controller (Vendor: 057e Product: 2009)',
  mapping: '',
  buttons: 16,
  axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.neutral],
  rumble: false,
};

export const XBOX_STANDARD: PadSpec = {
  id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)',
  mapping: 'standard',
  buttons: 17,
  axes: [0, 0, 0, 0],
  rumble: true,
};

export async function installFakePads(page: Page): Promise<void> {
  // esbuild-based runners (tsx) wrap named functions in `__name(...)`; the serialised init script needs that helper to exist
  await page.addInitScript('window.__name = window.__name || ((f) => f);');
  await page.addInitScript(() => {
    interface FakeButton {
      pressed: boolean;
      touched: boolean;
      value: number;
    }
    interface FakePad {
      id: string;
      index: number;
      mapping: string;
      connected: boolean;
      timestamp: number;
      buttons: FakeButton[];
      axes: number[];
      vibrationActuator?: { playEffect(type: string, params: unknown): Promise<string> };
      effects: { type: string; params: unknown }[];
    }
    const pads: (FakePad | null)[] = [];
    const snapshot = (p: FakePad): unknown => ({
      id: p.id,
      index: p.index,
      mapping: p.mapping,
      connected: p.connected,
      timestamp: p.timestamp,
      buttons: p.buttons.map((b) => ({ pressed: b.pressed, touched: b.touched, value: b.value })),
      axes: p.axes.slice(),
      vibrationActuator: p.vibrationActuator,
      hapticActuators: undefined,
    });
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => pads.map((p) => (p ? snapshot(p) : null)),
    });
    const api = {
      plug(spec: PadSpec): number {
        let index = spec.index ?? pads.findIndex((p) => !p);
        if (index < 0) index = pads.length;
        const pad: FakePad = {
          id: spec.id,
          index,
          mapping: spec.mapping,
          connected: true,
          timestamp: 1,
          buttons: Array.from({ length: spec.buttons }, () => ({ pressed: false, touched: false, value: 0 })),
          axes: spec.axes.slice(),
          effects: [],
        };
        if (spec.rumble)
          pad.vibrationActuator = {
            playEffect: (type: string, params: unknown): Promise<string> => {
              pad.effects.push({ type, params });
              return Promise.resolve('complete');
            },
          };
        pads[index] = pad;
        const ev = new Event('gamepadconnected');
        (ev as Event & { gamepad?: unknown }).gamepad = snapshot(pad);
        window.dispatchEvent(ev);
        return index;
      },
      unplug(index: number): void {
        const p = pads[index];
        if (!p) return;
        p.connected = false;
        const ev = new Event('gamepaddisconnected');
        (ev as Event & { gamepad?: unknown }).gamepad = snapshot(p);
        pads[index] = null;
        window.dispatchEvent(ev);
      },
      button(index: number, b: number, down: boolean | number): void {
        const p = pads[index];
        if (!p) return;
        const v = typeof down === 'number' ? down : down ? 1 : 0;
        const btn = p.buttons[b]!;
        btn.value = v;
        btn.pressed = v > 0.5;
        btn.touched = v > 0;
        p.timestamp++;
      },
      axis(index: number, a: number, v: number): void {
        const p = pads[index];
        if (!p) return;
        p.axes[a] = v;
        p.timestamp++;
      },
      effects(index: number): { type: string; params: unknown }[] {
        return pads[index]?.effects.slice() ?? [];
      },
    };
    (window as unknown as { __fp: typeof api }).__fp = api;
  });
}

/** Wait for `n` more animation frames of the sandbox (the input manager polls once per frame). */
export async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = (): void => {
          if (--left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

export const plug = (page: Page, spec: PadSpec): Promise<number> =>
  page.evaluate((s) => (window as unknown as { __fp: { plug(s: PadSpec): number } }).__fp.plug(s), spec);

export const setButton = (page: Page, index: number, b: number, down: boolean | number): Promise<void> =>
  page.evaluate(
    ([i, btn, d]) =>
      (
        window as unknown as { __fp: { button(i: number, b: number, d: boolean | number): void } }
      ).__fp.button(i, btn, d),
    [index, b, down] as const,
  );

export const setAxis = (page: Page, index: number, a: number, v: number): Promise<void> =>
  page.evaluate(
    ([i, ax, val]) =>
      (window as unknown as { __fp: { axis(i: number, a: number, v: number): void } }).__fp.axis(i, ax, val),
    [index, a, v] as const,
  );

/** Press and release a raw button the way a thumb does: held for a few frames so the game's tick sampling cannot miss it. */
export async function tap(page: Page, index: number, b: number, holdFrames = 4): Promise<void> {
  await setButton(page, index, b, true);
  await frames(page, holdFrames);
  await setButton(page, index, b, false);
  await frames(page, holdFrames);
}
