import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, makeLayer, type FrameFx, type MatchApi, type SimEvent } from '@/contracts';
import { Telemetry, coverage } from './telemetry';

const view = { x0: 100, y0: 50, w: LOGICAL_W, h: LOGICAL_H };

describe('telemetry FX coverage', () => {
  it('counts only effect layers (screen z ≥ 10, additive world glows), never titans or UI', () => {
    const fx = makeLayer('fx-front', 'screen', 10, LOGICAL_W, LOGICAL_H);
    const ui = makeLayer('ui', 'screen', 100, LOGICAL_W, LOGICAL_H);
    const titan = makeLayer('titan-0', 'world', 0, 64, 64);
    for (const L of [fx, ui, titan]) L.visible = true;
    titan.pixels.fill(0xffffffff);
    ui.pixels.fill(0xffffffff);
    // world box centred at (200, 150), half-size 10 → screen x 90..109, y 90..109; fill its left half
    for (let y = 90; y < 110; y++) for (let x = 90; x < 100; x++) fx.pixels[y * LOGICAL_W + x] = 0xff00ffff;
    expect(coverage([fx, ui, titan], view, 200, 150, 10)).toBeCloseTo(0.5, 5);
    expect(coverage([ui, titan], view, 200, 150, 10)).toBe(0);
  });
});

/** A two-fighter stand-in exposing just what Telemetry reads. */
function fakeMatch(): MatchApi & { tick: number; phase: string; round: number } {
  const view = (slot: 0 | 1) => ({
    slot,
    vx: 0,
    vy: 0,
    state: 'idle',
    bodyStats: { mass: 1000 },
  });
  return {
    tick: 0,
    phase: 'fight',
    round: 1,
    fighters: [{ view: view(0) }, { view: view(1) }],
  } as unknown as MatchApi & { tick: number; phase: string; round: number };
}

const noFx = { flash: 0 } as FrameFx;

describe('telemetry accounting', () => {
  it('records rounds, contacts and the wound sequence of a heavy hit', () => {
    const t = new Telemetry();
    const m = fakeMatch();
    const step = (ev: SimEvent[]): void => {
      m.tick++;
      t.afterTick(m, ev, 1);
    };
    step([{ t: 'round', phase: 'fight', round: 1, winner: -1 }]);
    step([
      {
        t: 'move',
        slot: 0,
        titan: 'lastone',
        moveId: 'x',
        moveSlot: 'crush',
        aim: 'forward',
        x: 0,
        y: 0,
      },
    ]);
    const hit: SimEvent = {
      t: 'hit',
      attacker: 0,
      target: 1,
      titan: 'planet',
      x: 0,
      y: 0,
      dirX: 1,
      dirY: 0,
      type: 'CRUSH',
      energy: 900,
      cellsRemoved: 0,
      massRemoved: 0,
      blocked: 0,
      heavy: true,
      onDamaged: 0,
    };
    step([hit]);
    t.afterDraw(1000, [], noFx, view, 0, null);
    // the target loses 300 mass on the next tick, a slab detaches 6 ticks after the hit
    (m.fighters[1].view.bodyStats as { mass: number }).mass = 700;
    step([]);
    step([]);
    for (let i = 0; i < 4; i++) step([]);
    step([{ t: 'matter', kind: 'detach', x: 0, y: 0, mass: 40, slot: 1 }]);
    for (let i = 0; i < 4; i++) t.afterDraw(1000 + 16.7 * (i + 1), [], noFx, view, 0, null);
    step([{ t: 'round', phase: 'ko', round: 1, winner: 0 }]);
    const r = t.report();
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.hits).toBe(1);
    expect(r.rounds[0]!.contacts).toBe(1);
    const w = r.wounds[0]!;
    expect(w.instantMass).toBe(300);
    expect(w.shearMs).toBe(Math.round((7 * 1000) / 60));
    expect(w.firstSlabMass).toBe(40);
    expect(w.fxClearMs).toBeGreaterThanOrEqual(0);
  });
});
