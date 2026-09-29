import { describe, expect, it } from 'vitest';
import { Btn } from '@/contracts';
import {
  DIR_BITS,
  KEY_LAYOUT_P1,
  KEY_LAYOUT_P2,
  KeyboardState,
  dirsToStick,
  isGameKey,
  keyLabel,
} from './keyboard';
import { ACTIONS } from './types';

describe('keyboard layouts', () => {
  const codes = (l: typeof KEY_LAYOUT_P1): Set<string> => {
    const s = new Set<string>();
    for (const v of [...Object.values(l.move), ...Object.values(l.actions)]) for (const c of v) s.add(c);
    return s;
  };
  it('give every action at least one key and never share a gameplay key between the two players', () => {
    for (const l of [KEY_LAYOUT_P1, KEY_LAYOUT_P2])
      for (const a of ACTIONS) expect(l.actions[a].length).toBeGreaterThan(0);
    const a = codes(KEY_LAYOUT_P1);
    for (const c of codes(KEY_LAYOUT_P2)) expect(a.has(c)).toBe(false);
  });
  it('do not bind one key to two actions within a layout', () => {
    for (const l of [KEY_LAYOUT_P1, KEY_LAYOUT_P2]) {
      const seen = new Set<string>();
      for (const a of ACTIONS)
        for (const c of l.actions[a]) {
          expect(seen.has(c), `${l.id}:${c}`).toBe(false);
          seen.add(c);
        }
    }
  });
  it('use physical codes (AZERTY-safe) and prevent default on game keys only', () => {
    expect(isGameKey('KeyW')).toBe(true);
    expect(isGameKey('ArrowLeft')).toBe(true);
    expect(isGameKey('F5')).toBe(false);
    expect(isGameKey('KeyR')).toBe(false);
  });
  it('label keys readably', () => {
    expect(keyLabel('KeyJ')).toBe('J');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('Numpad4')).toBe('N4');
    expect(keyLabel('Space')).toBe('SPACE');
  });
});

describe('KeyboardState', () => {
  it('reports held actions and directions', () => {
    const k = new KeyboardState(KEY_LAYOUT_P1);
    k.keyDown('KeyJ');
    k.keyDown('KeyD');
    expect(k.heldActions()).toBe(Btn.STRIKE);
    expect(k.heldDirs()).toBe(DIR_BITS.r);
    k.keyUp('KeyJ');
    expect(k.heldActions()).toBe(0);
  });
  it('latches a tap shorter than a tick so it is not lost, then clears', () => {
    const k = new KeyboardState(KEY_LAYOUT_P1);
    k.keyDown('KeyK');
    k.keyDown('KeyA');
    k.keyUp('KeyK');
    k.keyUp('KeyA');
    expect(k.heldActions()).toBe(0);
    expect(k.latchHeld).toBe(Btn.SURGE);
    expect(k.latchDirs).toBe(DIR_BITS.l);
    k.consumeLatch();
    expect(k.latchHeld).toBe(0);
  });
  it('supports two keys for one action and remaps', () => {
    const k = new KeyboardState(KEY_LAYOUT_P1);
    k.keyDown('Space');
    expect(k.heldActions() & Btn.GUARD).toBeTruthy();
    k.keyUp('Space');
    k.overrides = { strike: ['KeyH'] };
    k.keyDown('KeyJ');
    expect(k.heldActions()).toBe(0); // J no longer strikes
    k.keyDown('KeyH');
    expect(k.heldActions()).toBe(Btn.STRIKE);
  });
  it('releaseAll clears stuck keys (window blur)', () => {
    const k = new KeyboardState(KEY_LAYOUT_P2);
    k.keyDown('ArrowUp');
    k.releaseAll();
    expect(k.heldDirs()).toBe(0);
  });
});

describe('dirsToStick', () => {
  it('normalises diagonals so they are no faster than cardinals, and cancels opposites', () => {
    const o = { x: 0, y: 0 };
    dirsToStick(DIR_BITS.u | DIR_BITS.r, o);
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(1, 9);
    expect(o.y).toBeLessThan(0);
    dirsToStick(DIR_BITS.l | DIR_BITS.r, o);
    expect(o).toEqual({ x: 0, y: 0 });
    dirsToStick(DIR_BITS.d, o);
    expect(o).toEqual({ x: 0, y: 1 });
  });
});
