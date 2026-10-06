import { describe, expect, it } from 'vitest';
import { TuningRegistry, type TuningKnob } from './tuning';

const knob = (box: { v: number }, sets: number[], o: Partial<TuningKnob> = {}): TuningKnob => ({
  key: 'k',
  label: 'K',
  min: 0,
  max: 1,
  step: 0.1,
  get: () => box.v,
  set: (v) => {
    sets.push(v);
    box.v = v;
  },
  ...o,
});

describe('debug tuning registry', () => {
  it('registering never changes a value; only a player adjust or reset does, and every change is counted', () => {
    const r = new TuningRegistry();
    const box = { v: 0.5 };
    const sets: number[] = [];
    r.register('a', [knob(box, sets)]);
    expect(sets).toEqual([]);
    expect(r.edits).toBe(0);
    r.adjust(0, 2);
    expect(box.v).toBeCloseTo(0.7);
    r.adjust(0, 99);
    expect(box.v).toBe(1); // clamped
    r.adjust(0, 0); // no change: not counted
    r.reset(0);
    expect(box.v).toBe(0.5);
    expect(r.edits).toBe(3);
    expect(r.changes.map((c) => c.value)).toEqual([0.7, 1, 0.5]);
  });

  it('values stay on the step grid from min after many presses', () => {
    const r = new TuningRegistry();
    const box = { v: 0.3 };
    r.register('a', [knob(box, [], { min: 0.3, max: 3, step: 0.05 })]);
    for (let i = 0; i < 37; i++) r.adjust(0, 1);
    expect(box.v).toBe(2.15);
  });

  it('re-registering an owner replaces it; prefixes drop a whole match; diagnostics go with their owner', () => {
    const r = new TuningRegistry();
    const box = { v: 0 };
    r.register('match.p1.x', [knob(box, [])]);
    r.register('match.p1.x', [knob(box, []), knob(box, [], { key: 'k2' })]);
    r.register('other', [knob(box, [])]);
    r.registerDiagnostics('match.p1.x', () => undefined);
    expect(r.list().length).toBe(3);
    r.unregisterPrefix('match.');
    expect(r.list().map((e) => e.owner)).toEqual(['other']);
    expect([...r.diagnostics()].length).toBe(0);
  });
});
