import { describe, expect, it } from 'vitest';
import { Btn, emptyInput, type InputFrame } from '@/contracts';
import { Aftermath } from './aftermath';

const bounds = { minX: 0, maxX: 1000, minY: 0, maxY: 500 };
const none = { dragX: 0, dragY: 0, wheel: 0 };
const frame = (over: Partial<InputFrame>): InputFrame => ({ ...emptyInput(), ...over });

describe('aftermath view', () => {
  it('pans with the stick (screen-aligned, slower when zoomed) and stays in bounds', () => {
    const a = new Aftermath(500, 250, bounds);
    // one second in 0.1 s frames (a single frame is clamped to 0.1 s so a hitch never flings the view)
    for (let i = 0; i < 10; i++) a.update(frame({ moveX: 1 }), 0.1, none);
    expect(a.x).toBeCloseTo(760, 6);
    a.zoom = 2;
    for (let i = 0; i < 10; i++) a.update(frame({ moveX: 1 }), 0.1, none);
    expect(a.x).toBeCloseTo(890, 6);
    for (let i = 0; i < 20; i++) a.update(frame({ moveX: 1 }), 0.1, none);
    expect(a.x).toBe(1000);
  });

  it('zooms in whole steps 1–4 with Y / X and the wheel, orbits with ZR / ZL', () => {
    const a = new Aftermath(500, 250, bounds);
    for (let i = 0; i < 6; i++) a.update(frame({ pressed: Btn.STRIKE }), 0.016, none);
    expect(a.zoom).toBe(4);
    a.update(frame({ pressed: Btn.CRUSH }), 0.016, none);
    a.update(frame({}), 0.016, { dragX: 0, dragY: 0, wheel: 1 });
    expect(a.zoom).toBe(2);
    for (let i = 0; i < 10; i++) a.update(frame({ held: Btn.ULTIMATE }), 0.1, none);
    expect(a.roll).toBeGreaterThan(0.5);
    for (let i = 0; i < 10; i++) a.update(frame({ held: Btn.GUARD }), 0.1, none);
    expect(a.roll).toBeCloseTo(0, 6);
  });

  it('reports save (A), HUD (−) and leave (B or +)', () => {
    const a = new Aftermath(500, 250, bounds);
    expect(a.update(frame({ pressed: Btn.SIGNATURE }), 0.016, none).save).toBe(true);
    expect(a.update(frame({ pressed: Btn.TRAINING }), 0.016, none).toggleHud).toBe(true);
    expect(a.update(frame({ pressed: Btn.SURGE }), 0.016, none).exit).toBe(true);
    expect(a.update(frame({ pressed: Btn.PAUSE }), 0.016, none).exit).toBe(true);
    expect(a.update(frame({}), 0.016, none)).toEqual({ save: false, exit: false, toggleHud: false });
  });

  it('hides its hints on the save frame only', () => {
    const a = new Aftermath(500, 250, bounds);
    expect(a.drawHints()).toBe(true);
    a.hideHintsOnce = true;
    expect(a.drawHints()).toBe(false);
    expect(a.drawHints()).toBe(true);
  });
});
