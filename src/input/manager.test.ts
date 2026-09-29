import { describe, expect, it } from 'vitest';
import { Btn, emptyInput, type InputFrame } from '@/contracts';
import { createInputManager } from './manager';
import { createMemoryStore } from './storage';
import {
  DI,
  HAT_VALUES,
  createFakeGamepads,
  dualSenseStandard,
  joyconLeftStandard,
  joyconRightDirectInput,
  proDirectInput,
  proStandard,
  xboxStandard,
} from './testing';
import { Pad, type InputManager, type KeyValueStore } from './types';
import type { HidDeviceLike, HidInputReportEventLike, HidLike } from './webhid';

interface Rig {
  m: InputManager;
  pads: ReturnType<typeof createFakeGamepads>;
  win: EventTarget;
  store: KeyValueStore;
  clock: { t: number };
  /** Advance one 60 Hz tick: poll every slot and return the frames. */
  tick: () => [InputFrame, InputFrame];
  frame: (ms?: number) => void;
  key: (code: string, down: boolean) => void;
}

function rig(opts: { store?: KeyValueStore | null; hid?: HidLike | null; ua?: string } = {}): Rig {
  const pads = createFakeGamepads();
  const win = new EventTarget();
  const store = opts.store === undefined ? createMemoryStore() : opts.store;
  const clock = { t: 1000 };
  const m = createInputManager({
    window: win,
    getGamepads: pads.getGamepads,
    storage: store,
    now: () => clock.t,
    hid: opts.hid ?? null,
    userAgent: opts.ua ?? 'Chrome/124',
  });
  m.attach();
  let tickNo = 0;
  const f0 = emptyInput();
  const f1 = emptyInput();
  return {
    m,
    pads,
    win,
    store: store as KeyValueStore,
    clock,
    tick: () => {
      tickNo++;
      m.source(0).poll(tickNo, f0);
      m.source(1).poll(tickNo, f1);
      return [f0, f1];
    },
    frame: (ms = 16) => {
      clock.t += ms;
      m.poll(clock.t);
    },
    key: (code, down) => {
      const e = Object.assign(new Event(down ? 'keydown' : 'keyup'), { code, repeat: false });
      win.dispatchEvent(e);
    },
  };
}

describe('Switch Pro (standard mapping) → InputFrame', () => {
  it('auto-assigns the first pad to P1 and reports Nintendo family and rumble capability', () => {
    const r = rig();
    const p = r.pads.plug(proStandard().withRumble());
    r.frame();
    const info = r.m.devices().find((d) => d.id === 'pad:0')!;
    expect(info.profile).toBe('switch-pro');
    expect(info.family).toBe('nintendo');
    expect(info.mapping).toBe('standard');
    expect(info.vendor).toBe(0x057e);
    expect(info.product).toBe(0x2009);
    expect(info.hasRumble).toBe(true);
    expect(r.m.assignment()[0]).toBe('pad:0');
    expect(p.connected).toBe(true);
  });

  it('maps the default layout: Y Strike · X Crush · B Surge · A Signature · ZR Ultimate · ZL Guard · L/R Feint · + Pause · − Training', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    const table: [number, number][] = [
      [Pad.WEST, Btn.STRIKE], // Y
      [Pad.NORTH, Btn.CRUSH], // X
      [Pad.SOUTH, Btn.SURGE], // B
      [Pad.EAST, Btn.SIGNATURE], // A
      [Pad.R2, Btn.ULTIMATE], // ZR
      [Pad.L2, Btn.GUARD], // ZL
      [Pad.L1, Btn.FEINT], // L
      [Pad.R1, Btn.FEINT], // R
      [Pad.START, Btn.PAUSE], // +
      [Pad.SELECT, Btn.TRAINING], // −
    ];
    for (const [raw, bit] of table) {
      p.releaseAll();
      r.tick();
      p.set(raw, true);
      const [f] = r.tick();
      expect(f.held, `raw ${raw}`).toBe(bit);
      expect(f.pressed).toBe(bit);
    }
  });

  it('edges are per tick: pressed exactly once, held while down, released exactly once', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.tick();
    p.set(Pad.NORTH, true);
    expect(r.tick()[0]).toMatchObject({ held: Btn.CRUSH, pressed: Btn.CRUSH, released: 0 });
    expect(r.tick()[0]).toMatchObject({ held: Btn.CRUSH, pressed: 0, released: 0 });
    expect(r.tick()[0]).toMatchObject({ held: Btn.CRUSH, pressed: 0, released: 0 });
    p.release(Pad.NORTH);
    expect(r.tick()[0]).toMatchObject({ held: 0, pressed: 0, released: Btn.CRUSH });
    expect(r.tick()[0]).toMatchObject({ held: 0, pressed: 0, released: 0 });
  });

  it('treats analog triggers with hysteresis: presses at 0.5, holds down to 0.32', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.tick();
    p.set(Pad.R2, 0.3);
    expect(r.tick()[0].held).toBe(0);
    p.set(Pad.R2, 0.55);
    expect(r.tick()[0].held).toBe(Btn.ULTIMATE);
    p.set(Pad.R2, 0.4);
    expect(r.tick()[0].held).toBe(Btn.ULTIMATE);
    p.set(Pad.R2, 0.2);
    expect(r.tick()[0].held).toBe(0);
  });

  it('samples the device AT TICK TIME (no rAF poll needed) and never smears one press over two ticks', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.tick();
    // no manager.poll() at all between these ticks
    p.set(Pad.WEST, true);
    expect(r.tick()[0].pressed).toBe(Btn.STRIKE);
    expect(r.tick()[0].pressed).toBe(0);
  });

  it('a tap shorter than one tick (seen by a faster frame poll) is latched for the next tick, then released', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.tick();
    p.set(Pad.SOUTH, true);
    r.frame(4);
    p.release(Pad.SOUTH);
    r.frame(4);
    const f = r.tick()[0];
    expect(f.held).toBe(Btn.SURGE);
    expect(f.pressed).toBe(Btn.SURGE);
    const g = r.tick()[0];
    expect(g.held).toBe(0);
    expect(g.released).toBe(Btn.SURGE);
  });

  it('reads the left stick with a radial deadzone and D-pad as full deflection; stick wins when larger', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    p.axis(0, 0.1).axis(1, 0.1);
    let f = r.tick()[0];
    expect([f.moveX, f.moveY]).toEqual([0, 0]);
    p.axis(0, 1).axis(1, 0);
    f = r.tick()[0];
    expect(f.moveX).toBeCloseTo(1);
    p.axis(0, 0).axis(1, -0.6);
    f = r.tick()[0];
    expect(f.moveY).toBeLessThan(0);
    expect(f.moveY).toBeGreaterThan(-1);
    p.axis(1, 0).set(Pad.LEFT, true).set(Pad.UP, true);
    f = r.tick()[0];
    expect(f.moveX).toBeCloseTo(-Math.SQRT1_2);
    expect(f.moveY).toBeCloseTo(-Math.SQRT1_2);
  });

  it('honours the deadzone setting and clamps the output to the unit disc', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.m.updateSettings({ deadzone: 0.4 });
    p.axis(0, 0.35);
    expect(r.tick()[0].moveX).toBe(0);
    p.axis(0, 1).axis(1, 1);
    const f = r.tick()[0];
    expect(Math.hypot(f.moveX, f.moveY)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('Switch Pro (non-standard mapping, Firefox-style)', () => {
  it('maps the DirectInput table to the same actions, and decodes the D-pad hat into movement', () => {
    const r = rig({ ua: 'Firefox/130.0' });
    const p = r.pads.plug(proDirectInput());
    r.tick();
    expect(r.m.devices().find((d) => d.id === 'pad:0')!.layoutId).toBe('nintendo-directinput');
    const table: [number, number][] = [
      [DI.Y, Btn.STRIKE],
      [DI.X, Btn.CRUSH],
      [DI.B, Btn.SURGE],
      [DI.A, Btn.SIGNATURE],
      [DI.ZR, Btn.ULTIMATE],
      [DI.ZL, Btn.GUARD],
      [DI.L, Btn.FEINT],
      [DI.R, Btn.FEINT],
      [DI.PLUS, Btn.PAUSE],
      [DI.MINUS, Btn.TRAINING],
    ];
    for (const [raw, bit] of table) {
      p.releaseAll();
      r.tick();
      p.set(raw, true);
      expect(r.tick()[0].held, `raw ${raw}`).toBe(bit);
    }
    p.releaseAll();
    p.axis(9, HAT_VALUES.dl);
    const f = r.tick()[0];
    expect(f.moveX).toBeCloseTo(-Math.SQRT1_2);
    expect(f.moveY).toBeCloseTo(Math.SQRT1_2);
    p.axis(9, 1.2857);
    expect(r.tick()[0].moveX).toBe(0);
  });
});

describe('other pads by position', () => {
  it('Xbox and PlayStation pads use the same physical positions as the Nintendo layout', () => {
    for (const mk of [xboxStandard, dualSenseStandard]) {
      const r = rig();
      const p = r.pads.plug(mk());
      r.tick();
      p.set(Pad.WEST, true); // Xbox X / PS Square = physical left = Strike
      expect(r.tick()[0].held).toBe(Btn.STRIKE);
    }
  });
  it('single sideways Joy-Cons use SL/SR for Guard/Ultimate', () => {
    const r = rig();
    const p = r.pads.plug(joyconLeftStandard());
    r.tick();
    expect(r.m.devices().find((d) => d.id === 'pad:0')!.profile).toBe('joycon-l');
    p.set(Pad.SL, true);
    expect(r.tick()[0].held).toBe(Btn.GUARD);
    p.releaseAll().set(Pad.SR, true);
    expect(r.tick()[0].held).toBe(Btn.ULTIMATE);
  });
  it('non-standard sideways Joy-Con (R) gets a default stick rotation; setRotation overrides and persists', () => {
    const store = createMemoryStore();
    const r = rig({ store });
    const p = r.pads.plug(joyconRightDirectInput());
    r.frame();
    expect(r.m.live('pad:0')!.rotation).toBe(1);
    p.axis(1, -1); // physical up in the upright frame
    let f = r.tick()[0];
    expect(f.moveX).toBeCloseTo(1); // quarter-turn clockwise: up → right
    r.m.setRotation('pad:0', 3);
    f = r.tick()[0];
    expect(f.moveX).toBeCloseTo(-1);
    const r2 = rig({ store });
    r2.pads.plug(joyconRightDirectInput());
    r2.frame();
    expect(r2.m.live('pad:0')!.rotation).toBe(3);
    r2.m.setRotation('pad:0', null);
    expect(r2.m.live('pad:0')!.rotation).toBe(1);
  });
  it('rotation wizard: pushing the stick "away" derives the quarter-turn', () => {
    const r = rig();
    const p = r.pads.plug(joyconLeftStandard());
    r.frame();
    r.m.beginRotationWizard('pad:0');
    r.frame();
    expect(r.m.capture.status).toBe('waiting');
    p.axis(0, -1); // pushed "away" reads as raw LEFT
    r.frame();
    expect(r.m.capture.status).toBe('done');
    expect(r.m.live('pad:0')!.rotation).toBe(1);
    p.axis(0, 0);
    expect(r.tick()[0].moveX).toBe(0);
    p.axis(0, -1);
    expect(r.tick()[0].moveY).toBeLessThan(-0.9); // now "up" is up
  });
});

describe('hot-plug and P1/P2 assignment', () => {
  it('keyboards are the default until a pad appears; a pad becomes P1 and the keyboard moves to P2', () => {
    const r = rig();
    r.frame();
    expect(r.m.assignment()).toEqual(['kb1', 'kb2']);
    r.pads.plug(proStandard());
    r.frame();
    expect(r.m.assignment()).toEqual(['pad:0', 'kb1']);
    r.pads.plug(xboxStandard(1));
    r.frame();
    expect(r.m.assignment()).toEqual(['pad:0', 'pad:1']);
  });
  it('notifies onDevices on connect, disconnect and assignment', () => {
    const r = rig();
    let n = 0;
    r.m.onDevices(() => n++);
    r.pads.plug(proStandard());
    r.frame();
    const a = n;
    expect(a).toBeGreaterThan(0);
    r.pads.unplug(0);
    r.frame();
    expect(n).toBeGreaterThan(a);
    expect(r.m.devices().some((d) => d.id === 'pad:0')).toBe(false);
    expect(r.m.assignment()).toEqual(['kb1', 'kb2']);
  });
  it('a disconnected pad releases everything (no stuck buttons) and an empty slot is neutral', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.tick();
    p.set(Pad.WEST, true);
    expect(r.tick()[0].held).toBe(Btn.STRIKE);
    r.pads.unplug(0);
    const f = r.tick()[0]; // slot 0 falls back to a keyboard: nothing pressed
    expect(f.held).toBe(0);
  });
  it('manual assign/swap; taking the other slot’s device swaps rather than leaving a slot empty', () => {
    const r = rig();
    r.pads.plug(proStandard());
    r.pads.plug(xboxStandard(1));
    r.frame();
    r.m.swapSlots();
    expect(r.m.assignment()).toEqual(['pad:1', 'pad:0']);
    r.m.assign(0, 'pad:0');
    expect(r.m.assignment()).toEqual(['pad:0', 'pad:1']);
    r.m.assign(1, 'kb2');
    expect(r.m.assignment()).toEqual(['pad:0', 'kb2']);
    r.m.autoAssign();
    expect(r.m.assignment()).toEqual(['pad:0', 'pad:1']);
    r.m.assign(0, 'nope');
    expect(r.m.assignment()).toEqual(['pad:0', 'pad:1']);
  });
  it('two players use two pads independently', () => {
    const r = rig();
    const a = r.pads.plug(proStandard());
    const b = r.pads.plug(xboxStandard(1));
    r.tick();
    a.set(Pad.WEST, true);
    b.set(Pad.NORTH, true);
    const [f0, f1] = r.tick();
    expect(f0.held).toBe(Btn.STRIKE);
    expect(f1.held).toBe(Btn.CRUSH);
  });
  it('replaces a device when a different controller takes over the same index', () => {
    const r = rig();
    r.pads.plug(proStandard());
    r.frame();
    r.pads.plug(xboxStandard(0));
    r.frame();
    expect(r.m.devices().find((d) => d.id === 'pad:0')!.profile).toBe('xbox');
  });
});

describe('keyboard', () => {
  it('P1 WASD/IJKL and P2 arrows/numpad, driven by KeyboardEvent.code', () => {
    const r = rig();
    r.tick();
    r.key('KeyD', true);
    r.key('KeyJ', true);
    r.key('ArrowLeft', true);
    r.key('Numpad8', true);
    const [f0, f1] = r.tick();
    expect(f0.moveX).toBe(1);
    expect(f0.held).toBe(Btn.STRIKE);
    expect(f1.moveX).toBe(-1);
    expect(f1.held).toBe(Btn.CRUSH);
    r.key('KeyJ', false);
    expect(r.tick()[0].released).toBe(Btn.STRIKE);
  });
  it('a key tapped and released between two ticks is not lost', () => {
    const r = rig();
    r.tick();
    r.key('KeyL', true);
    r.key('KeyL', false);
    const f = r.tick()[0];
    expect(f.pressed).toBe(Btn.SIGNATURE);
    expect(r.tick()[0].held).toBe(0);
  });
  it('window blur releases stuck keys', () => {
    const r = rig();
    r.tick();
    r.key('KeyW', true);
    expect(r.tick()[0].moveY).toBe(-1);
    r.win.dispatchEvent(new Event('blur'));
    expect(r.tick()[0].moveY).toBe(0);
  });
  it('ignores modifier chords so browser shortcuts still work', () => {
    const r = rig();
    r.tick();
    const e = Object.assign(new Event('keydown'), { code: 'KeyJ', ctrlKey: true, repeat: false });
    r.win.dispatchEvent(e);
    expect(r.tick()[0].held).toBe(0);
  });
});

describe('menu navigation', () => {
  it('D-pad fires on press then auto-repeats; works from any device', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.frame();
    p.set(Pad.DOWN, true);
    r.frame();
    expect(r.m.nav('any').down).toBe(true);
    let n = 0;
    for (let i = 0; i < 60; i++) {
      r.frame(16);
      if (r.m.nav('any').down) n++;
    }
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(9);
    p.release(Pad.DOWN);
    r.frame();
    expect(r.m.nav('any').down).toBe(false);
  });
  it('left stick navigates with hysteresis', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.frame();
    p.axis(0, 0.9);
    r.frame();
    expect(r.m.nav('any').right).toBe(true);
    r.frame(16);
    expect(r.m.nav('any').right).toBe(false);
  });
  it('confirm is Nintendo A (right) on a Pro in label mode, and the bottom button in positional mode', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.frame();
    p.set(Pad.EAST, true);
    r.frame();
    expect(r.m.nav(0).confirm).toBe(true);
    p.releaseAll();
    r.frame();
    p.set(Pad.SOUTH, true); // Nintendo B = back
    r.frame();
    expect(r.m.nav(0).back).toBe(true);
    expect(r.m.nav(0).confirm).toBe(false);
    p.releaseAll();
    r.frame();
    r.m.updateSettings({ confirmMode: 'positional' });
    p.set(Pad.SOUTH, true);
    r.frame();
    expect(r.m.nav(0).confirm).toBe(true);
  });
  it('confirm is the bottom button (Xbox A / Cross) on Xbox and PlayStation pads in label mode', () => {
    for (const mk of [xboxStandard, dualSenseStandard]) {
      const r = rig();
      const p = r.pads.plug(mk());
      r.frame();
      p.set(Pad.SOUTH, true);
      r.frame();
      expect(r.m.nav(0).confirm).toBe(true);
    }
  });
  it('per-slot nav follows that slot’s device only', () => {
    const r = rig();
    const a = r.pads.plug(proStandard());
    const b = r.pads.plug(xboxStandard(1));
    r.frame();
    b.set(Pad.DOWN, true);
    r.frame();
    expect(r.m.nav(1).down).toBe(true);
    expect(r.m.nav(0).down).toBe(false);
    expect(r.m.nav('any').down).toBe(true);
    b.releaseAll();
    a.set(Pad.START, true);
    r.frame();
    r.frame();
    r.frame();
    a.releaseAll();
    r.frame();
    a.set(Pad.START, true);
    r.frame();
    expect(r.m.nav(0).start).toBe(true);
  });
  it('keyboard nav: arrows, Enter, Escape', () => {
    const r = rig();
    r.frame();
    r.key('ArrowDown', true);
    r.frame();
    expect(r.m.nav('any').down).toBe(true);
    r.key('ArrowDown', false);
    r.key('Enter', true);
    r.frame();
    expect(r.m.nav('any').confirm).toBe(true);
    r.key('Enter', false);
    r.key('Escape', true);
    r.frame();
    expect(r.m.nav('any').back).toBe(true);
  });
  it('press-any-button activity fires once per fresh press and never for stick drift', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.frame();
    const seen: string[] = [];
    r.m.onActivity((d) => seen.push(d.id));
    p.axis(0, 0.9);
    r.frame();
    expect(seen).toEqual([]);
    p.set(Pad.WEST, true);
    r.frame();
    r.frame();
    expect(seen).toEqual(['pad:0']);
    const drained: unknown[] = [];
    r.m.drainActivity(drained as never[]);
    expect(drained.length).toBe(1);
    expect(r.m.lastActiveDevice()?.id).toBe('pad:0');
  });
});

describe('remap (Controller Check)', () => {
  it('captures the next press for an action, ignoring the press that started the capture, and persists across reloads', () => {
    const store = createMemoryStore();
    const r = rig({ store });
    const p = r.pads.plug(proStandard());
    r.frame();
    p.set(Pad.EAST, true); // the confirm press on the "Strike" row is still held…
    r.m.beginCapture('pad:0', 'strike');
    r.frame();
    expect(r.m.capture.status).toBe('waiting'); // …so it must not be captured
    p.releaseAll();
    r.frame();
    p.set(7, true); // player presses ZR
    r.frame();
    expect(r.m.capture).toMatchObject({ status: 'done', action: 'strike', result: 'button 7' });
    p.releaseAll();
    r.frame();
    // menus were suppressed during capture
    expect(r.m.nav('any').confirm).toBe(false);
    // Strike now fires on button 7 (ZR); ZR still also fires its default Ultimate, and Y no longer strikes
    p.set(7, true);
    expect(r.tick()[0].held).toBe(Btn.STRIKE | Btn.ULTIMATE);
    p.releaseAll();
    p.set(Pad.WEST, true);
    expect(r.tick()[0].held).toBe(0);
  });

  it('rebinding leaves other actions alone and stops the old default from firing', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.frame();
    r.m.beginCapture('pad:0', 'strike');
    r.frame();
    p.set(10, true); // L3
    r.frame();
    p.releaseAll();
    r.frame();
    expect(r.m.capture.status).toBe('done');
    r.m.ackCapture();
    expect(r.m.capture.status).toBe('idle');
    p.set(Pad.WEST, true);
    expect(r.tick()[0].held).toBe(0); // Y no longer strikes
    p.releaseAll();
    p.set(10, true);
    expect(r.tick()[0].held).toBe(Btn.STRIKE);
    p.releaseAll();
    p.set(Pad.NORTH, true);
    expect(r.tick()[0].held).toBe(Btn.CRUSH); // untouched
  });

  it('persists: a second manager on the same storage sees the remap; reset restores defaults', () => {
    const store = createMemoryStore();
    const a = rig({ store });
    const pa = a.pads.plug(proStandard());
    a.frame();
    a.m.beginCapture('pad:0', 'guard');
    a.frame();
    pa.set(11, true);
    a.frame();
    expect(a.m.capture.status).toBe('done');

    const b = rig({ store });
    const pb = b.pads.plug(proStandard());
    b.tick();
    pb.set(11, true);
    expect(b.tick()[0].held).toBe(Btn.GUARD);
    pb.releaseAll();
    pb.set(Pad.L2, true);
    expect(b.tick()[0].held).toBe(0);
    b.m.resetBindings('pad:0');
    expect(b.tick()[0].held).toBe(Btn.GUARD);
    const c = rig({ store });
    const pc = c.pads.plug(proStandard());
    pc.set(11, true);
    expect(c.tick()[0].held).toBe(0);
  });

  it('remaps a raw hat direction and a non-standard trigger axis (uncertain tables stay fixable)', () => {
    const r = rig({ ua: 'Firefox/130.0' });
    const p = r.pads.plug(proDirectInput());
    r.frame();
    r.m.beginCapture('pad:0', 'surge');
    r.frame();
    p.axis(9, HAT_VALUES.u);
    r.frame();
    expect(r.m.capture).toMatchObject({ status: 'done', result: 'hat U' });
    p.axis(9, 1.2857);
    r.frame();
    p.axis(9, HAT_VALUES.u);
    expect(r.tick()[0].held & Btn.SURGE).toBeTruthy();
  });

  it('keyboard remap: next key press becomes the binding; Escape cancels; clearBinding restores the default', () => {
    const store = createMemoryStore();
    const r = rig({ store });
    r.frame();
    r.m.beginCapture('kb1', 'strike');
    r.key('Escape', true);
    r.frame();
    expect(r.m.capture.status).toBe('cancelled');
    r.key('Escape', false);
    r.m.beginCapture('kb1', 'strike');
    r.key('KeyH', true);
    r.frame();
    expect(r.m.capture).toMatchObject({ status: 'done', result: 'H' });
    r.key('KeyH', false);
    expect(r.m.actionLabel('kb1', 'strike')).toBe('H');
    r.key('KeyJ', true);
    expect(r.tick()[0].held).toBe(0);
    r.key('KeyJ', false);
    r.key('KeyH', true);
    expect(r.tick()[0].held).toBe(Btn.STRIKE);
    const r2 = rig({ store });
    expect(r2.m.actionLabel('kb1', 'strike')).toBe('H');
    r2.m.clearBinding('kb1', 'strike');
    expect(r2.m.actionLabel('kb1', 'strike')).toBe('J');
  });

  it('a capture that nobody answers times out', () => {
    const r = rig();
    r.pads.plug(proStandard());
    r.frame();
    r.m.beginCapture('pad:0', 'crush');
    r.frame(13_000);
    expect(r.m.capture.status).toBe('cancelled');
  });
});

describe('stick calibration wizard', () => {
  it('measures a drifting centre and a short range, stores it, and applies it to movement', () => {
    const store = createMemoryStore();
    const r = rig({ store });
    const p = r.pads.plug(proStandard());
    p.axis(0, 0.09).axis(1, -0.07); // drifting rest position
    r.frame();
    r.m.beginCalibration('pad:0');
    for (let i = 0; i < 40; i++) r.frame();
    expect(r.m.calibration.phase).toBe('range');
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * Math.PI * 2 * 2;
      p.axis(0, 0.09 + Math.cos(a) * 0.8).axis(1, -0.07 + Math.sin(a) * 0.8);
      r.frame();
    }
    p.axis(0, 0.09).axis(1, -0.07);
    r.frame();
    expect(r.m.calibration.phase).toBe('done');
    expect(r.m.live('pad:0')!.hasCalibration).toBe(true);
    // the drifting rest position now reads as dead, and the short travel reaches 1.0
    expect(r.tick()[0].moveX).toBe(0);
    p.axis(0, 0.09 + 0.8);
    expect(r.tick()[0].moveX).toBeCloseTo(1, 1);
    // persisted for this model
    const r2 = rig({ store });
    const p2 = r2.pads.plug(proStandard());
    p2.axis(0, 0.09).axis(1, -0.07);
    expect(r2.tick()[0].moveX).toBe(0);
    r2.m.clearCalibration('pad:0');
    expect(r2.tick()[0].moveX).toBe(0); // 0.09 is inside the 0.18 deadzone anyway
    p2.axis(0, 0.9).axis(1, 0);
    expect(r2.tick()[0].moveX).toBeCloseTo((0.9 - 0.18) / 0.82, 6);
  });
  it('can be cancelled, and finishCalibration accepts partial travel', () => {
    const r = rig();
    const p = r.pads.plug(proStandard());
    r.frame();
    r.m.beginCalibration('pad:0');
    r.m.cancelCalibration();
    expect(r.m.calibration.phase).toBe('idle');
    r.m.beginCalibration('pad:0');
    for (let i = 0; i < 40; i++) r.frame();
    p.axis(0, 0.7);
    r.frame();
    r.m.finishCalibration();
    expect(r.m.calibration.phase).toBe('done');
  });
});

describe('rumble', () => {
  it('routes to the slot’s pad through vibrationActuator, scaled by the rumble setting and rate-limited', () => {
    const r = rig();
    const p = r.pads.plug(proStandard().withRumble());
    r.frame();
    r.m.rumble(0, 0.4, 0.2, 200);
    expect(p.effects.length).toBe(1);
    expect(p.effects[0]!.params).toMatchObject({ strongMagnitude: 0.4, weakMagnitude: 0.2, duration: 200 });
    r.clock.t += 10;
    r.m.rumble(0, 0.4, 0.2, 200); // same strength inside the gap: dropped
    expect(p.effects.length).toBe(1);
    r.clock.t += 10;
    r.m.rumble(0, 1, 1, 200); // stronger: goes through
    expect(p.effects.length).toBe(2);
    r.clock.t += 500;
    r.m.updateSettings({ rumble: 0.5 });
    r.m.rumble(0, 1, 0, 100);
    expect(p.effects[2]!.params.strongMagnitude).toBeCloseTo(0.5);
    r.m.updateSettings({ rumble: 0 });
    r.clock.t += 500;
    r.m.rumble(0, 1, 1, 100);
    expect(p.effects.length).toBe(3);
  });
  it('is a silent no-op for keyboards, empty slots and pads without motors', () => {
    const r = rig();
    expect(() => r.m.rumble(0, 1, 1, 100)).not.toThrow();
    r.pads.plug(proStandard());
    r.frame();
    expect(() => r.m.rumble(0, 1, 1, 100)).not.toThrow();
  });
});

describe('labels and prompts', () => {
  it('shows Nintendo labels for a Pro, follows the label-mode override, and reads remaps back', () => {
    const r = rig();
    r.pads.plug(proStandard());
    r.frame();
    expect(r.m.actionLabel('pad:0', 'strike')).toBe('Y');
    expect(r.m.actionLabel('pad:0', 'signature')).toBe('A');
    expect(r.m.actionLabel('pad:0', 'ultimate')).toBe('ZR');
    expect(r.m.actionLabel('pad:0', 'pause')).toBe('+');
    expect(r.m.confirmLabel('pad:0')).toBe('A');
    expect(r.m.backLabel('pad:0')).toBe('B');
    r.m.updateSettings({ labelMode: 'xbox' });
    expect(r.m.actionLabel('pad:0', 'strike')).toBe('X');
    expect(r.m.confirmLabel('pad:0')).toBe('A'); // Xbox A = the bottom button
    r.m.updateSettings({ labelMode: 'auto', confirmMode: 'positional' });
    expect(r.m.confirmLabel('pad:0')).toBe('B'); // positional: bottom button, printed B on a Nintendo pad
  });
  it('shows key names for keyboards', () => {
    const r = rig();
    expect(r.m.actionLabel('kb1', 'crush')).toBe('I');
    expect(r.m.actionLabel('kb2', 'strike')).toBe('N4');
  });
  it('promptFamily follows the last used pad, else the first pad, else Nintendo', () => {
    const r = rig();
    expect(r.m.promptFamily()).toBe('nintendo');
    r.pads.plug(xboxStandard());
    r.frame();
    expect(r.m.promptFamily()).toBe('xbox');
  });
});

describe('settings persistence', () => {
  it('saves settings and notifies subscribers; a broken store never breaks the game', () => {
    const store = createMemoryStore();
    const r = rig({ store });
    let last = 0;
    r.m.onSettings((s) => (last = s.deadzone));
    r.m.updateSettings({ deadzone: 0.3, labelMode: 'playstation' });
    expect(last).toBe(0.3);
    expect(rig({ store }).m.settings).toMatchObject({ deadzone: 0.3, labelMode: 'playstation' });
    const bad: KeyValueStore = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    const rb = rig({ store: bad });
    expect(() => rb.m.updateSettings({ deadzone: 0.2 })).not.toThrow();
    expect(rb.m.settings.deadzone).toBe(0.2);
    const rn = rig({ store: null });
    expect(rn.m.settings.deadzone).toBe(0.18);
  });
});

describe('WebHID enhancement', () => {
  class Dev implements HidDeviceLike {
    vendorId = 0x057e;
    productId = 0x2009;
    productName = 'Pro Controller';
    opened = false;
    private ls = new Set<(e: HidInputReportEventLike) => void>();
    async open(): Promise<void> {
      this.opened = true;
    }
    async close(): Promise<void> {
      this.opened = false;
    }
    async sendReport(): Promise<void> {}
    addEventListener(_t: 'inputreport', l: (e: HidInputReportEventLike) => void): void {
      this.ls.add(l);
    }
    removeEventListener(_t: 'inputreport', l: (e: HidInputReportEventLike) => void): void {
      this.ls.delete(l);
    }
    emit(right: number): void {
      const b = new Uint8Array(60);
      b[2] = right;
      b[5] = 0;
      b[6] = 0x08;
      b[7] = 0x80;
      b[8] = 0;
      b[9] = 0x08;
      b[10] = 0x80;
      for (const l of this.ls) l({ reportId: 0x30, data: new DataView(b.buffer) });
    }
  }
  it('reports "unsupported" without navigator.hid and never throws', async () => {
    const r = rig({ hid: null });
    expect(r.m.hidStatus).toBe('unsupported');
    await r.m.requestHid();
    expect(r.m.hidStatus).toBe('unsupported');
  });
  it('connects, feeds the same pipeline, and hides the browser’s duplicate of the same Pro', async () => {
    const dev = new Dev();
    const hid: HidLike = { requestDevice: async () => [dev], getDevices: async () => [] };
    const r = rig({ hid });
    r.pads.plug(proStandard());
    r.frame();
    expect(r.m.assignment()[0]).toBe('pad:0');
    await r.m.requestHid();
    expect(r.m.hidStatus).toBe('connected');
    r.frame();
    expect(r.m.assignment()[0]).toBe('hid:0');
    dev.emit(0x01); // Y
    expect(r.tick()[0].held).toBe(Btn.STRIKE);
    expect(r.m.devices().find((d) => d.id === 'hid:0')!.hasRumble).toBe(true);
  });
  it('degrades silently when the user denies the chooser or the device is busy', async () => {
    const denied: HidLike = {
      requestDevice: async () => {
        throw Object.assign(new Error('nope'), { name: 'NotAllowedError' });
      },
      getDevices: async () => [],
    };
    const r = rig({ hid: denied });
    await r.m.requestHid();
    expect(r.m.hidStatus).toBe('denied');
    const none: HidLike = { requestDevice: async () => [], getDevices: async () => [] };
    const r2 = rig({ hid: none });
    await r2.m.requestHid();
    expect(r2.m.hidStatus).toBe('denied');
    const busy: HidLike = {
      requestDevice: async () => [
        Object.assign(new Dev(), {
          open: async () => {
            throw Object.assign(new Error('busy'), { name: 'NetworkError' });
          },
        }),
      ],
      getDevices: async () => [],
    };
    const r3 = rig({ hid: busy });
    await r3.m.requestHid();
    expect(r3.m.hidStatus).toBe('error');
    r3.pads.plug(proStandard());
    r3.frame();
    expect(r3.m.assignment()[0]).toBe('pad:0'); // the ordinary Gamepad path is untouched
  });
});
