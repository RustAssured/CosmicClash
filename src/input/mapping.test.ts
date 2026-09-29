import { describe, expect, it } from 'vitest';
import { decodeHat, detectPress, normalizePad, rawRefValue, rotateStick } from './mapping';
import { LAYOUT_NINTENDO_DIRECTINPUT, LAYOUT_STANDARD, LAYOUT_XBOX_FIREFOX_LINUX } from './profiles';
import { DI, FakePad, HAT_NEUTRAL, HAT_VALUES, proDirectInput, proStandard } from './testing';
import { Pad, createPadState } from './types';

describe('hat decoding', () => {
  it('decodes all eight directions from the documented values', () => {
    for (const [dir, v] of Object.entries(HAT_VALUES)) expect(decodeHat(v)).toBe(dir);
  });
  it('treats the neutral values (1.286 and 3.286) and non-finite as null', () => {
    expect(decodeHat(HAT_NEUTRAL)).toBeNull();
    expect(decodeHat(3.2857142857142856)).toBeNull();
    expect(decodeHat(NaN)).toBeNull();
    expect(decodeHat(undefined)).toBeNull();
  });
  it('does not mistake a rest value of 0 (drivers report 0 before first use) for a direction', () => {
    expect(decodeHat(0)).toBeNull();
  });
});

describe('standard layout', () => {
  it('maps Nintendo positions: 0 bottom(B) 1 right(A) 2 left(Y) 3 top(X), triggers, dpad, home, capture', () => {
    const p = proStandard();
    const s = createPadState();
    for (let i = 0; i < 18; i++) {
      p.releaseAll();
      p.set(i, true);
      normalizePad(p, LAYOUT_STANDARD, 0, s);
      expect(s.buttons[i]).toBe(1);
      expect(s.buttons.reduce((a, b) => a + b, 0)).toBe(1);
    }
    expect(Pad.SOUTH).toBe(0);
    expect(Pad.EAST).toBe(1);
    expect(Pad.WEST).toBe(2);
    expect(Pad.NORTH).toBe(3);
  });
  it('keeps analog trigger travel', () => {
    const p = proStandard();
    p.set(7, 0.42);
    const s = createPadState();
    normalizePad(p, LAYOUT_STANDARD, 0, s);
    expect(s.buttons[Pad.R2]).toBeCloseTo(0.42);
  });
  it('reads sticks from axes 0..3', () => {
    const p = proStandard().axis(0, 0.5).axis(1, -0.25).axis(2, -1).axis(3, 1);
    const s = createPadState();
    normalizePad(p, LAYOUT_STANDARD, 0, s);
    expect([s.lx, s.ly, s.rx, s.ry]).toEqual([0.5, -0.25, -1, 1]);
  });
});

describe('Nintendo DirectInput (non-standard) layout', () => {
  const cases: [string, number, number][] = [
    ['B', DI.B, Pad.SOUTH],
    ['A', DI.A, Pad.EAST],
    ['Y', DI.Y, Pad.WEST],
    ['X', DI.X, Pad.NORTH],
    ['L', DI.L, Pad.L1],
    ['R', DI.R, Pad.R1],
    ['ZL', DI.ZL, Pad.L2],
    ['ZR', DI.ZR, Pad.R2],
    ['-', DI.MINUS, Pad.SELECT],
    ['+', DI.PLUS, Pad.START],
    ['L3', DI.L3, Pad.L3],
    ['R3', DI.R3, Pad.R3],
    ['Home', DI.HOME, Pad.HOME],
    ['Capture', DI.CAPTURE, Pad.CAPTURE],
  ];
  it.each(cases)('raw %s → canonical position', (_n, raw, canon) => {
    const p = proDirectInput();
    p.set(raw, true);
    const s = createPadState();
    normalizePad(p, LAYOUT_NINTENDO_DIRECTINPUT, 0, s);
    expect(s.buttons[canon]).toBe(1);
    expect(s.buttons.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('decodes the D-pad hat on axis 9 in all eight directions incl. diagonals', () => {
    const s = createPadState();
    const want: Record<string, number[]> = {
      u: [Pad.UP],
      d: [Pad.DOWN],
      l: [Pad.LEFT],
      r: [Pad.RIGHT],
      ur: [Pad.UP, Pad.RIGHT],
      ul: [Pad.UP, Pad.LEFT],
      dr: [Pad.DOWN, Pad.RIGHT],
      dl: [Pad.DOWN, Pad.LEFT],
    };
    for (const [dir, v] of Object.entries(HAT_VALUES)) {
      const p = proDirectInput().axis(9, v);
      normalizePad(p, LAYOUT_NINTENDO_DIRECTINPUT, 0, s);
      const on = [Pad.UP, Pad.DOWN, Pad.LEFT, Pad.RIGHT].filter((b) => s.buttons[b] === 1);
      expect(on.sort()).toEqual(want[dir]!.slice().sort());
    }
    normalizePad(proDirectInput(), LAYOUT_NINTENDO_DIRECTINPUT, 0, s);
    expect([Pad.UP, Pad.DOWN, Pad.LEFT, Pad.RIGHT].every((b) => s.buttons[b] === 0)).toBe(true);
  });
});

describe('axis-encoded triggers (Xbox on Firefox/Linux)', () => {
  const mk = (): FakePad => {
    const p = new FakePad('45e-28e-Microsoft X-Box 360 pad', 0, '', 11, new Array<number>(8).fill(0));
    return p;
  };
  it('ignores a trigger axis that still reads 0 (uninitialised driver) until it has been seen at rest (−1)', () => {
    const s = createPadState();
    const p = mk();
    normalizePad(p, LAYOUT_XBOX_FIREFOX_LINUX, 0, s);
    expect(s.buttons[Pad.L2]).toBe(0); // 0 would decode as 0.5 pull without the arming guard
    p.axis(2, -1);
    normalizePad(p, LAYOUT_XBOX_FIREFOX_LINUX, 0, s);
    expect(s.buttons[Pad.L2]).toBe(0);
    p.axis(2, 1);
    normalizePad(p, LAYOUT_XBOX_FIREFOX_LINUX, 0, s);
    expect(s.buttons[Pad.L2]).toBe(1);
    p.axis(2, 0);
    normalizePad(p, LAYOUT_XBOX_FIREFOX_LINUX, 0, s);
    expect(s.buttons[Pad.L2]).toBeCloseTo(0.5);
  });
  it('reads the D-pad from axes 6/7 and sticks from 0,1 / 3,4', () => {
    const s = createPadState();
    const p = mk().axis(6, -1).axis(7, 1).axis(3, 0.5).axis(4, -0.5);
    normalizePad(p, LAYOUT_XBOX_FIREFOX_LINUX, 0, s);
    expect(s.buttons[Pad.LEFT]).toBe(1);
    expect(s.buttons[Pad.DOWN]).toBe(1);
    expect([s.rx, s.ry]).toEqual([0.5, -0.5]);
  });
});

describe('sideways stick rotation', () => {
  it('rotates a stick vector by quarter turns clockwise (+y down)', () => {
    const o: [number, number] = [0, 0];
    rotateStick(0, -1, 1, o); // up → right
    expect(o).toEqual([1, 0]);
    rotateStick(0, -1, 2, o); // up → down
    expect(o[0]).toBeCloseTo(0);
    expect(o[1]).toBeCloseTo(1);
    rotateStick(0, -1, 3, o); // up → left
    expect(o).toEqual([-1, 0]);
    rotateStick(0.3, 0.4, 4, o);
    expect(o).toEqual([0.3, 0.4]);
    rotateStick(1, 0, -1, o); // −1 ≡ 3
    expect(o[0]).toBeCloseTo(0);
    expect(o[1]).toBeCloseTo(-1);
  });
  it('is applied to both sticks by normalizePad', () => {
    const p = proStandard().axis(1, -1).axis(2, 1);
    const s = createPadState();
    normalizePad(p, LAYOUT_STANDARD, 1, s);
    expect(s.lx).toBe(1);
    expect(s.ly).toBeCloseTo(0);
    expect(s.rx).toBeCloseTo(0);
    expect(s.ry).toBe(1);
  });
});

describe('raw references and press detection', () => {
  it('reads buttons, axis directions and hat directions', () => {
    const p = proDirectInput().set(5, true).axis(4, -0.9).axis(9, HAT_VALUES.r);
    expect(rawRefValue(p, { k: 'b', i: 5 })).toBe(1);
    expect(rawRefValue(p, { k: 'b', i: 6 })).toBe(0);
    expect(rawRefValue(p, { k: 'a', i: 4, s: -1 })).toBeCloseTo(0.9);
    expect(rawRefValue(p, { k: 'a', i: 4, s: 1 })).toBe(0);
    expect(rawRefValue(p, { k: 'h', d: 'r' }, 9)).toBe(1);
    expect(rawRefValue(p, { k: 'h', d: 'l' }, 9)).toBe(0);
  });
  it('detectPress finds a button, a hat direction, or an axis pushed away from rest — and nothing at rest', () => {
    const rest = { axes: [0, 0, 0, 0, -1, -1, 0, 0, 0, HAT_NEUTRAL] };
    const p = proDirectInput();
    p.axes[4] = -1;
    p.axes[5] = -1;
    expect(detectPress(p, rest, 9)).toBeNull();
    p.set(3, true);
    expect(detectPress(p, rest, 9)).toEqual({ k: 'b', i: 3 });
    p.releaseAll();
    p.axis(9, HAT_VALUES.u);
    expect(detectPress(p, rest, 9)).toEqual({ k: 'h', d: 'u' });
    p.axis(9, HAT_NEUTRAL);
    p.axis(5, 0.9); // a trigger axis travelling from −1 to +1 counts
    expect(detectPress(p, rest, 9)).toEqual({ k: 'a', i: 5, s: 1 });
  });
});
