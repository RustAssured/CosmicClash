import { describe, expect, it } from 'vitest';
import {
  StickCapture,
  applyCalibration,
  newCalibration,
  processStick,
  radialDeadzone,
  rotationFromUp,
} from './deadzone';

const o = { x: 0, y: 0 };

describe('radialDeadzone', () => {
  it('is exactly zero inside the deadzone, including on diagonals', () => {
    radialDeadzone(0.1, 0.1, 0.2, o);
    expect(o).toEqual({ x: 0, y: 0 });
    radialDeadzone(0.19, 0, 0.2, o);
    expect(o).toEqual({ x: 0, y: 0 });
    radialDeadzone(0, 0, 0.2, o);
    expect(o).toEqual({ x: 0, y: 0 });
  });
  it('rescales continuously: no jump when leaving the deadzone, exactly 1 at full deflection', () => {
    radialDeadzone(0.2001, 0, 0.2, o);
    expect(o.x).toBeLessThan(0.001);
    radialDeadzone(1, 0, 0.2, o);
    expect(o.x).toBeCloseTo(1, 6);
    radialDeadzone(0.6, 0, 0.2, o);
    expect(o.x).toBeCloseTo(0.5, 6); // (0.6−0.2)/(1−0.2)
  });
  it('preserves direction (unlike a per-axis deadzone) and never exceeds unit magnitude', () => {
    const angle = Math.atan2(0.3, 0.9);
    radialDeadzone(0.9, 0.3, 0.18, o);
    expect(Math.atan2(o.y, o.x)).toBeCloseTo(angle, 9);
    for (const [x, y] of [
      [1, 1],
      [-1, 1],
      [1.2, -0.9],
      [0.99, 0.99],
    ] as const) {
      radialDeadzone(x, y, 0.18, o);
      expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('keeps a small deflection on one axis from leaking into the other', () => {
    radialDeadzone(0.5, 0.05, 0.18, o);
    expect(o.x).toBeGreaterThan(0);
    expect(Math.abs(o.y)).toBeLessThan(0.05);
  });
});

describe('calibration', () => {
  it('subtracts the centre and rescales each half-axis by its measured travel', () => {
    const cal = { cx: 0.1, cy: -0.05, minX: 0.8, maxX: 0.9, minY: 0.85, maxY: 0.8 };
    applyCalibration(0.1, -0.05, cal, o);
    expect(o.x).toBeCloseTo(0);
    expect(o.y).toBeCloseTo(0);
    applyCalibration(0.1 + 0.9, -0.05, cal, o);
    expect(o.x).toBeCloseTo(1);
    applyCalibration(0.1 - 0.8, -0.05, cal, o);
    expect(o.x).toBeCloseTo(-1);
    applyCalibration(0.1, -0.05 + 0.8, cal, o);
    expect(o.y).toBeCloseTo(1);
  });
  it('clamps octagonal-gate corners to the unit disc', () => {
    applyCalibration(1, 1, newCalibration(), o);
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(1, 9);
  });
  it('passes through with no calibration, and processStick chains calibration → deadzone', () => {
    applyCalibration(0.3, -0.2, null, o);
    expect(o).toEqual({ x: 0.3, y: -0.2 });
    // a drifting stick resting at (0.12, 0.08) reads as dead once calibrated, even with a tiny deadzone
    processStick(0.12, 0.08, { cx: 0.12, cy: 0.08, minX: 1, maxX: 1, minY: 1, maxY: 1 }, 0.05, o);
    expect(o).toEqual({ x: 0, y: 0 });
  });
});

describe('StickCapture', () => {
  it('averages the rest position, then records travel on all four sides', () => {
    const c = new StickCapture(10, 20);
    for (let i = 0; i < 10; i++) c.feed(0.06 + (i % 2) * 0.002, -0.04);
    expect(c.phase).toBe('range');
    // roll around the gate at ~0.85 radius
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      c.feed(0.06 + Math.cos(a) * 0.85, -0.04 + Math.sin(a) * 0.85);
    }
    c.feed(0.06, -0.04); // back to rest
    expect(c.phase).toBe('done');
    const r = c.result();
    expect(r.cx).toBeCloseTo(0.061, 2);
    expect(r.cy).toBeCloseTo(-0.04, 2);
    for (const v of [r.minX, r.maxX, r.minY, r.maxY]) expect(v).toBeGreaterThan(0.8);
  });
  it('refuses to average the centre while the stick is held off-centre', () => {
    const c = new StickCapture(5, 10);
    for (let i = 0; i < 20; i++) c.feed(0.9, 0);
    expect(c.phase).toBe('centre');
  });
  it('does not complete by idling', () => {
    const c = new StickCapture(3, 5);
    for (let i = 0; i < 200; i++) c.feed(0, 0);
    expect(c.phase).toBe('range');
  });
  it('finish() force-completes with sane minimums', () => {
    const c = new StickCapture(2, 5);
    c.feed(0, 0);
    c.feed(0, 0);
    const r = c.finish();
    expect(c.phase).toBe('done');
    expect(r.maxX).toBeGreaterThanOrEqual(0.3);
  });
});

describe('rotationFromUp', () => {
  it('finds the quarter-turn that maps the pushed direction to "up"', () => {
    expect(rotationFromUp(0, -1)).toBe(0); // already up
    expect(rotationFromUp(-1, 0)).toBe(1); // pushed left  → clockwise turn makes it up
    expect(rotationFromUp(0, 1)).toBe(2);
    expect(rotationFromUp(1, 0)).toBe(3);
    expect(rotationFromUp(0.1, 0.1)).toBeNull(); // too small to judge
  });
});
