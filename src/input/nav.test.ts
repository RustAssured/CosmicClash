import { describe, expect, it } from 'vitest';
import { NAV, NavRepeater, StickNav } from './nav';

describe('NavRepeater', () => {
  it('fires on press, waits the initial delay, then repeats at the repeat interval', () => {
    const r = new NavRepeater({ delayMs: 400, repeatMs: 100 });
    const fired: number[] = [];
    for (let t = 0; t <= 1200; t += 10) if (r.step(t, NAV.DOWN) & NAV.DOWN) fired.push(t);
    expect(fired[0]).toBe(0);
    expect(fired[1]).toBe(400);
    expect(fired[2]).toBe(500);
    expect(fired[3]).toBe(600);
    expect(fired.length).toBe(1 + 1 + 8);
  });
  it('re-fires immediately on a fresh press and stops when released', () => {
    const r = new NavRepeater({ delayMs: 400, repeatMs: 100 });
    expect(r.step(0, NAV.UP)).toBe(NAV.UP);
    expect(r.step(16, NAV.UP)).toBe(0);
    expect(r.step(32, 0)).toBe(0);
    expect(r.step(48, NAV.UP)).toBe(NAV.UP);
    expect(r.step(2000, 0)).toBe(0);
  });
  it('cancels opposite directions', () => {
    const r = new NavRepeater();
    expect(r.step(0, NAV.LEFT | NAV.RIGHT)).toBe(0);
    expect(r.step(10, NAV.UP | NAV.DOWN)).toBe(0);
  });
  it('does not burst after a frame hitch', () => {
    const r = new NavRepeater({ delayMs: 400, repeatMs: 100 });
    r.step(0, NAV.RIGHT);
    expect(r.step(400, NAV.RIGHT)).toBe(NAV.RIGHT);
    expect(r.step(1400, NAV.RIGHT)).toBe(NAV.RIGHT); // one catch-up fire…
    expect(r.step(1416, NAV.RIGHT)).toBe(0); // …not ten
  });
  it('tracks directions independently', () => {
    const r = new NavRepeater({ delayMs: 400, repeatMs: 100 });
    expect(r.step(0, NAV.LEFT)).toBe(NAV.LEFT);
    expect(r.step(100, NAV.LEFT | NAV.UP)).toBe(NAV.UP);
  });
});

describe('StickNav', () => {
  it('engages at 0.55, holds until below 0.38 (hysteresis)', () => {
    const s = new StickNav();
    expect(s.step(0.5, 0)).toBe(0);
    expect(s.step(0.6, 0)).toBe(NAV.RIGHT);
    expect(s.step(0.45, 0)).toBe(NAV.RIGHT);
    expect(s.step(0.3, 0)).toBe(0);
    expect(s.step(-0.9, 0)).toBe(NAV.LEFT);
  });
  it('picks the dominant axis on diagonals so menus do not move on both axes', () => {
    const s = new StickNav();
    expect(s.step(0.9, 0.6)).toBe(NAV.RIGHT);
    s.reset();
    expect(s.step(0.6, 0.9)).toBe(NAV.DOWN);
    s.reset();
    expect(s.step(0.8, 0.75)).toBe(NAV.RIGHT | NAV.DOWN); // truly diagonal: both
  });
});
