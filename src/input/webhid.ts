import type { PadButtonLike, PadLike } from './types';
import { Pad } from './types';

/**
 * Optional WebHID enhancement for the Nintendo Switch Pro Controller (Chrome/Edge only, behind an explicit user button).
 *
 * What it does: opens the pad over HID, asks for the full 0x30 standard input report (~60–120 Hz, independent of the
 * browser's own gamepad polling), decodes buttons + 12-bit sticks, and offers HD-rumble output. The decoded state is exposed
 * as a `PadLike` in STANDARD layout, so it flows through exactly the same pipeline (deadzone, bindings, nav) as any pad.
 *
 * What it does not do, honestly: it has been unit-tested against synthetic reports built from the community-documented
 * report layout (dekuNukem/Nintendo_Switch_Reverse_Engineering), NOT against a real controller — there is no Bluetooth
 * hardware in the build sandbox. Every failure (unsupported browser, permission denied, device busy because the browser's
 * own gamepad backend holds it, send errors) degrades silently to the ordinary Gamepad API path.
 */

/** Structural subset of `HIDDevice`. */
export interface HidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: 'inputreport', listener: (e: HidInputReportEventLike) => void): void;
  removeEventListener(type: 'inputreport', listener: (e: HidInputReportEventLike) => void): void;
}
export interface HidInputReportEventLike {
  readonly reportId: number;
  readonly data: DataView;
}
export interface HidLike {
  requestDevice(opts: { filters: { vendorId: number; productId?: number }[] }): Promise<HidDeviceLike[]>;
  getDevices(): Promise<HidDeviceLike[]>;
}

export const NINTENDO_VENDOR = 0x057e;
export const PRO_PRODUCT = 0x2009;

export const hidSupported = (nav: { hid?: unknown } | undefined): boolean =>
  !!nav && !!nav.hid && typeof (nav.hid as HidLike).requestDevice === 'function';

/* ------------------------------------------------------------------------------------------------ *
 *  Report decoding — standard full report 0x30 (after WebHID strips the report id):
 *    [0] timer  [1] battery+connection  [2] right buttons  [3] shared buttons  [4] left buttons
 *    [5..7] left stick (2×12 bit)   [8..10] right stick (2×12 bit)
 *    right: Y 01, X 02, B 04, A 08, SR 10, SL 20, R 40, ZR 80
 *    shared: − 01, + 02, R-stick 04, L-stick 08, Home 10, Capture 20
 *    left: Down 01, Up 02, Right 04, Left 08, SR 10, SL 20, L 40, ZL 80
 * ------------------------------------------------------------------------------------------------ */
export interface HidSnapshot {
  /** Canonical (standard-layout) button values. */
  buttons: Float32Array;
  /** Sticks, −1..1, +y DOWN. */
  axes: [number, number, number, number];
  timer: number;
  battery: number;
}

export const createHidSnapshot = (): HidSnapshot => ({
  buttons: new Float32Array(20),
  axes: [0, 0, 0, 0],
  timer: 0,
  battery: 0,
});

/** Nominal 12-bit stick geometry of a Pro Controller before calibration: centre 2048, ≈ ±1500 of travel. */
export const STICK_CENTRE = 2048;
export const STICK_RANGE = 1500;

const norm = (raw: number): number => Math.max(-1, Math.min(1, (raw - STICK_CENTRE) / STICK_RANGE));

/** Decode a 0x30/0x21/0x3f-style standard report body. Returns false if the report is too short or not a standard one. */
export function parseStandardReport(reportId: number, d: DataView, out: HidSnapshot): boolean {
  if (reportId !== 0x30 && reportId !== 0x21 && reportId !== 0x31) return false;
  if (d.byteLength < 11) return false;
  const right = d.getUint8(2);
  const shared = d.getUint8(3);
  const left = d.getUint8(4);
  const b = out.buttons;
  b[Pad.WEST] = right & 0x01 ? 1 : 0; // Y
  b[Pad.NORTH] = right & 0x02 ? 1 : 0; // X
  b[Pad.SOUTH] = right & 0x04 ? 1 : 0; // B
  b[Pad.EAST] = right & 0x08 ? 1 : 0; // A
  b[Pad.R1] = right & 0x40 ? 1 : 0;
  b[Pad.R2] = right & 0x80 ? 1 : 0;
  b[Pad.SELECT] = shared & 0x01 ? 1 : 0;
  b[Pad.START] = shared & 0x02 ? 1 : 0;
  b[Pad.R3] = shared & 0x04 ? 1 : 0;
  b[Pad.L3] = shared & 0x08 ? 1 : 0;
  b[Pad.HOME] = shared & 0x10 ? 1 : 0;
  b[Pad.CAPTURE] = shared & 0x20 ? 1 : 0;
  b[Pad.DOWN] = left & 0x01 ? 1 : 0;
  b[Pad.UP] = left & 0x02 ? 1 : 0;
  b[Pad.RIGHT] = left & 0x04 ? 1 : 0;
  b[Pad.LEFT] = left & 0x08 ? 1 : 0;
  b[Pad.L1] = left & 0x40 ? 1 : 0;
  b[Pad.L2] = left & 0x80 ? 1 : 0;
  // SL/SR exist on both halves (rail buttons); either half counts.
  b[Pad.SL] = right & 0x20 || left & 0x20 ? 1 : 0;
  b[Pad.SR] = right & 0x10 || left & 0x10 ? 1 : 0;

  const lx = d.getUint8(5) | ((d.getUint8(6) & 0x0f) << 8);
  const ly = (d.getUint8(6) >> 4) | (d.getUint8(7) << 4);
  const rx = d.getUint8(8) | ((d.getUint8(9) & 0x0f) << 8);
  const ry = (d.getUint8(9) >> 4) | (d.getUint8(10) << 4);
  out.axes[0] = norm(lx);
  out.axes[1] = 0 - norm(ly); // the pad reports up as larger; the game is +y DOWN
  out.axes[2] = norm(rx);
  out.axes[3] = 0 - norm(ry);
  out.timer = d.getUint8(0);
  out.battery = d.getUint8(1) >> 4;
  return true;
}

/* ------------------------------------------------------------------------------------------------ *
 *  Rumble encoding (HD rumble, 4 bytes per actuator). Neutral is 00 01 40 40.
 *    hf = (round(log2(hfHz/10)·32) − 0x60) · 4   → byte0 = hf & 0xFF, byte1 = hfAmp | (hf >> 8 & 1)
 *    lf = round(log2(lfHz/10)·32) − 0x40         → byte2 = lf | (lfAmp odd ? 0x80 : 0), byte3 = 0x40 + (lfAmp >> 1)
 *  Amplitudes here are a linear approximation of the real (non-linear) table, capped at the documented safe maxima
 *  (hf 0xC8, lf 0x72). Unverified on hardware.
 * ------------------------------------------------------------------------------------------------ */
export const RUMBLE_NEUTRAL: readonly number[] = [0x00, 0x01, 0x40, 0x40];

export function encodeRumble(
  hfHz: number,
  hfAmp: number,
  lfHz: number,
  lfAmp: number,
  out: number[] = [],
): number[] {
  const hfF = Math.max(82, Math.min(1252, hfHz));
  const lfF = Math.max(41, Math.min(626, lfHz));
  const hf = (Math.round(Math.log2(hfF / 10) * 32) - 0x60) * 4;
  const lf = Math.round(Math.log2(lfF / 10) * 32) - 0x40;
  const hfa = Math.round(Math.max(0, Math.min(1, hfAmp)) * 100) * 2; // 0..200 even
  const lfa = Math.round(Math.max(0, Math.min(1, lfAmp)) * (0x72 - 0x40) * 2); // 0..100
  out[0] = hf & 0xff;
  out[1] = (hfa + ((hf >> 8) & 1)) & 0xff;
  out[2] = (lf + (lfa & 1 ? 0x80 : 0)) & 0xff;
  out[3] = 0x40 + (lfa >> 1);
  return out;
}

/** Map a dual-rumble request (strong/weak 0..1) to HD rumble: strong → low band, weak → high band. */
export function encodeDualRumble(strong: number, weak: number, out: number[] = []): number[] {
  return encodeRumble(320, weak, 160, strong, out);
}

/* ------------------------------------------------------------------------------------------------ *
 *  The HID pad
 * ------------------------------------------------------------------------------------------------ */
export class HidPad {
  readonly snapshot: HidSnapshot = createHidSnapshot();
  private packet = 0;
  private started = false;
  private lastReportAt = 0;
  private readonly listener = (e: HidInputReportEventLike): void => {
    if (parseStandardReport(e.reportId, e.data, this.snapshot)) this.lastReportAt = Date.now();
  };
  private readonly view: PadLike;
  private readonly buttonObjs: PadButtonLike[];

  constructor(readonly device: HidDeviceLike) {
    const snap = this.snapshot;
    this.buttonObjs = [];
    for (let i = 0; i < 20; i++) {
      this.buttonObjs.push({
        get pressed() {
          return snap.buttons[i]! > 0.5;
        },
        get value() {
          return snap.buttons[i]!;
        },
      });
    }
    const lastReport = (): number => this.lastReportAt;
    this.view = {
      id: `${(device.productName ?? 'Pro Controller').trim()} (WebHID Vendor: 057e Product: ${device.productId.toString(16).padStart(4, '0')})`,
      index: 100,
      connected: true,
      mapping: 'standard',
      get timestamp() {
        return lastReport();
      },
      axes: snap.axes,
      buttons: this.buttonObjs,
    };
  }

  /** A `PadLike` in standard layout backed by the live snapshot. */
  get pad(): PadLike {
    return this.view;
  }

  get receiving(): boolean {
    return this.started && Date.now() - this.lastReportAt < 1500;
  }

  async start(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.listener);
    this.started = true;
    // Subcommand 0x03: set input report mode → 0x30 (standard full). Subcommand 0x48: enable vibration.
    await this.subcommand(0x03, [0x30]);
    await this.subcommand(0x48, [0x01]);
  }

  private async subcommand(id: number, args: number[]): Promise<void> {
    const data = new Uint8Array(48);
    data[0] = this.packet++ & 0x0f;
    data.set(RUMBLE_NEUTRAL, 1);
    data.set(RUMBLE_NEUTRAL, 5);
    data[9] = id;
    data.set(args, 10);
    await this.device.sendReport(0x01, data);
  }

  /** Fire-and-forget HD rumble. Swallows every error. */
  rumble(strong: number, weak: number): void {
    if (!this.started) return;
    try {
      const data = new Uint8Array(9);
      data[0] = this.packet++ & 0x0f;
      const r = encodeDualRumble(strong, weak);
      data.set(r, 1);
      data.set(r, 5);
      void this.device.sendReport(0x10, data).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    try {
      this.device.removeEventListener('inputreport', this.listener);
      this.started = false;
      if (this.device.opened) await this.device.close();
    } catch {
      /* ignore */
    }
  }
}
