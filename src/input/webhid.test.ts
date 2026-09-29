import { describe, expect, it } from 'vitest';
import {
  HidPad,
  RUMBLE_NEUTRAL,
  createHidSnapshot,
  encodeDualRumble,
  encodeRumble,
  hidSupported,
  parseStandardReport,
  type HidDeviceLike,
  type HidInputReportEventLike,
} from './webhid';
import { Pad } from './types';

/** Build a 0x30 report body (what WebHID hands over after stripping the report id). */
function report(o: {
  right?: number;
  shared?: number;
  left?: number;
  lx?: number;
  ly?: number;
  rx?: number;
  ry?: number;
}): DataView {
  const b = new Uint8Array(60);
  b[0] = 0x42;
  b[1] = 0x90;
  b[2] = o.right ?? 0;
  b[3] = o.shared ?? 0;
  b[4] = o.left ?? 0;
  const lx = o.lx ?? 2048;
  const ly = o.ly ?? 2048;
  const rx = o.rx ?? 2048;
  const ry = o.ry ?? 2048;
  b[5] = lx & 0xff;
  b[6] = ((lx >> 8) & 0x0f) | ((ly & 0x0f) << 4);
  b[7] = (ly >> 4) & 0xff;
  b[8] = rx & 0xff;
  b[9] = ((rx >> 8) & 0x0f) | ((ry & 0x0f) << 4);
  b[10] = (ry >> 4) & 0xff;
  return new DataView(b.buffer);
}

describe('parseStandardReport (0x30)', () => {
  it('decodes the face buttons at their Nintendo positions', () => {
    const s = createHidSnapshot();
    expect(parseStandardReport(0x30, report({ right: 0x01 }), s)).toBe(true); // Y
    expect(s.buttons[Pad.WEST]).toBe(1);
    parseStandardReport(0x30, report({ right: 0x02 }), s); // X
    expect(s.buttons[Pad.NORTH]).toBe(1);
    expect(s.buttons[Pad.WEST]).toBe(0);
    parseStandardReport(0x30, report({ right: 0x04 }), s); // B
    expect(s.buttons[Pad.SOUTH]).toBe(1);
    parseStandardReport(0x30, report({ right: 0x08 }), s); // A
    expect(s.buttons[Pad.EAST]).toBe(1);
    parseStandardReport(0x30, report({ right: 0xc0 }), s); // R + ZR
    expect(s.buttons[Pad.R1]).toBe(1);
    expect(s.buttons[Pad.R2]).toBe(1);
  });
  it('decodes shared and left-hand buttons', () => {
    const s = createHidSnapshot();
    parseStandardReport(0x30, report({ shared: 0x23 }), s);
    expect(s.buttons[Pad.SELECT]).toBe(1);
    expect(s.buttons[Pad.START]).toBe(1);
    expect(s.buttons[Pad.CAPTURE]).toBe(1);
    expect(s.buttons[Pad.HOME]).toBe(0);
    parseStandardReport(0x30, report({ left: 0xcf }), s);
    for (const b of [Pad.DOWN, Pad.UP, Pad.RIGHT, Pad.LEFT, Pad.L1, Pad.L2]) expect(s.buttons[b]).toBe(1);
  });
  it('decodes 12-bit sticks, centre → 0, +y flipped to DOWN', () => {
    const s = createHidSnapshot();
    parseStandardReport(0x30, report({}), s);
    expect(s.axes).toEqual([0, 0, 0, 0]);
    parseStandardReport(0x30, report({ lx: 2048 + 1500, ly: 2048 + 1500, rx: 0, ry: 4095 }), s);
    expect(s.axes[0]).toBeCloseTo(1);
    expect(s.axes[1]).toBeCloseTo(-1); // pad "up" (larger) → game −y
    expect(s.axes[2]).toBe(-1); // clamped
    expect(s.axes[3]).toBe(-1);
  });
  it('rejects other report ids and truncated reports', () => {
    const s = createHidSnapshot();
    expect(parseStandardReport(0x3f, report({}), s)).toBe(false);
    expect(parseStandardReport(0x30, new DataView(new ArrayBuffer(4)), s)).toBe(false);
  });
});

describe('rumble encoding', () => {
  it('encodes "no vibration at the neutral frequencies" as the documented neutral frame 00 01 40 40', () => {
    expect(encodeRumble(320, 0, 160, 0)).toEqual([...RUMBLE_NEUTRAL]);
    expect(encodeDualRumble(0, 0)).toEqual([...RUMBLE_NEUTRAL]);
  });
  it('stays within the documented safe maxima for full strength', () => {
    const r = encodeDualRumble(1, 1);
    expect(r[1]! & 0xfe).toBeLessThanOrEqual(0xc8);
    expect(r[3]!).toBeLessThanOrEqual(0x72);
    expect(r.every((v) => v >= 0 && v <= 255)).toBe(true);
  });
  it('is monotonic in amplitude', () => {
    const a = encodeDualRumble(0.2, 0.2);
    const b = encodeDualRumble(0.8, 0.8);
    expect(b[1]! & 0xfe).toBeGreaterThan(a[1]! & 0xfe);
    expect(b[3]!).toBeGreaterThan(a[3]!);
  });
});

class FakeHidDevice implements HidDeviceLike {
  vendorId = 0x057e;
  productId = 0x2009;
  productName = 'Pro Controller';
  opened = false;
  sent: { id: number; data: Uint8Array }[] = [];
  private ls = new Set<(e: HidInputReportEventLike) => void>();
  failSend = false;
  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  async sendReport(id: number, data: BufferSource): Promise<void> {
    if (this.failSend) throw new Error('send failed');
    this.sent.push({ id, data: new Uint8Array(data as ArrayBuffer) });
  }
  addEventListener(_t: 'inputreport', l: (e: HidInputReportEventLike) => void): void {
    this.ls.add(l);
  }
  removeEventListener(_t: 'inputreport', l: (e: HidInputReportEventLike) => void): void {
    this.ls.delete(l);
  }
  emit(dv: DataView): void {
    for (const l of this.ls) l({ reportId: 0x30, data: dv });
  }
}

describe('HidPad', () => {
  it('opens the device, requests the 0x30 report mode and vibration, and exposes a standard-layout PadLike', async () => {
    const dev = new FakeHidDevice();
    const hp = new HidPad(dev);
    await hp.start();
    expect(dev.opened).toBe(true);
    expect(dev.sent.length).toBe(2);
    expect(dev.sent[0]!.id).toBe(0x01);
    expect(dev.sent[0]!.data[9]).toBe(0x03); // subcommand: set input report mode
    expect(dev.sent[0]!.data[10]).toBe(0x30);
    expect(dev.sent[1]!.data[9]).toBe(0x48); // subcommand: enable vibration
    dev.emit(report({ right: 0x08, lx: 2048 + 1500 }));
    expect(hp.pad.mapping).toBe('standard');
    expect(hp.pad.buttons[Pad.EAST]!.pressed).toBe(true);
    expect(hp.pad.buttons[Pad.WEST]!.pressed).toBe(false);
    expect(hp.pad.axes[0]).toBeCloseTo(1);
    expect(hp.receiving).toBe(true);
    hp.rumble(1, 0.5);
    expect(dev.sent[2]!.id).toBe(0x10);
    await hp.stop();
    expect(dev.opened).toBe(false);
  });
  it('rumble never throws even if the device rejects', async () => {
    const dev = new FakeHidDevice();
    const hp = new HidPad(dev);
    await hp.start();
    dev.failSend = true;
    expect(() => hp.rumble(1, 1)).not.toThrow();
    await Promise.resolve();
  });
  it('hidSupported feature-detects', () => {
    expect(hidSupported(undefined)).toBe(false);
    expect(hidSupported({})).toBe(false);
    expect(hidSupported({ hid: { requestDevice: () => Promise.resolve([]) } })).toBe(true);
  });
});
