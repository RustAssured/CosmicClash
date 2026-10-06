import { describe, expect, it } from 'vitest';
import { TuningRegistry } from '@/debug/tuning';
import { emptyDebugInput } from '@/input/types';
import { DebugOverlay } from './debugOverlay';

const view = { x0: 100, y0: 50, w: 640, h: 360 };

describe('debug overlay', () => {
  it('cycles off → panel → diagnostics → off, and draws nothing while off', () => {
    const o = new DebugOverlay(new TuningRegistry());
    const inp = { ...emptyDebugInput(), toggle: true };
    expect(o.draw(view)).toBeNull();
    o.handle(inp);
    expect(o.mode).toBe('panel');
    expect(o.draw(view)).not.toBeNull();
    o.handle(inp);
    expect(o.mode).toBe('diag');
    o.handle(inp);
    expect(o.mode).toBe('off');
  });

  it('the panel selects and adjusts knobs; diagnostics draw in screen space through the camera view', () => {
    const r = new TuningRegistry();
    const a = { v: 1 };
    const b = { v: 10 };
    r.register('t', [
      { key: 'a', label: 'A', min: 0, max: 2, step: 0.1, get: () => a.v, set: (v) => (a.v = v) },
      { key: 'b', label: 'B', min: 0, max: 100, step: 1, get: () => b.v, set: (v) => (b.v = v) },
    ]);
    let seen: [number, number] = [0, 0];
    r.registerDiagnostics('t', (d) => {
      seen = [d.sx(150), d.sy(80)];
      d.box(d.sx(150), d.sy(80), 10, 10, 0xffffffff);
    });
    const o = new DebugOverlay(r);
    o.handle({ ...emptyDebugInput(), toggle: true });
    o.handle({ ...emptyDebugInput(), adjust: 3 });
    expect(a.v).toBeCloseTo(1.3);
    o.handle({ ...emptyDebugInput(), select: 1, adjust: -10 });
    expect(b.v).toBe(0);
    o.handle({ ...emptyDebugInput(), reset: true });
    expect(b.v).toBe(10);
    // selection wraps
    o.handle({ ...emptyDebugInput(), select: 1 });
    expect(o.sel).toBe(0);
    const layer = o.draw(view)!;
    expect(seen).toEqual([50, 30]);
    expect(layer.pixels[30 * 640 + 50]).toBe(0xffffffff);
    // diagnostics-only mode does not adjust
    o.handle({ ...emptyDebugInput(), toggle: true, adjust: 5 });
    expect(a.v).toBeCloseTo(1.3);
  });
});
