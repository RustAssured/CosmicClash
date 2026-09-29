import { describe, expect, it } from 'vitest';
import { planUpload, StaleRegistry, type CachedLayerState } from './layerCache';

const mk = (w = 64, h = 64) => ({
  version: 1,
  w,
  h,
  pixels: new Uint32Array(w * h),
  emissive: undefined as Uint8Array | undefined,
  dirty: null as { x0: number; y0: number; x1: number; y1: number } | null,
});
const cachedOf = (l: ReturnType<typeof mk>): CachedLayerState => ({
  version: l.version,
  w: l.w,
  h: l.h,
  pixels: l.pixels,
  emissive: l.emissive,
});

describe('planUpload', () => {
  it('creates a texture the first time', () => {
    expect(planUpload(undefined, mk())).toEqual({ kind: 'create' });
  });

  it('does nothing while the version is unchanged (never re-uploads unchanged layers)', () => {
    const l = mk();
    expect(planUpload(cachedOf(l), l)).toEqual({ kind: 'none' });
    l.dirty = { x0: 0, y0: 0, x1: 64, y1: 64 }; // stale dirty rect must not force an upload
    expect(planUpload(cachedOf(l), l)).toEqual({ kind: 'none' });
  });

  it('uploads only the dirty rect when a small region changed', () => {
    const l = mk();
    const c = cachedOf(l);
    l.version = 2;
    l.dirty = { x0: 4, y0: 5, x1: 20, y1: 21 };
    expect(planUpload(c, l)).toEqual({ kind: 'rect', x0: 4, y0: 5, x1: 20, y1: 21 });
  });

  it('clamps the dirty rect to the layer and falls back to a full upload for big or degenerate rects', () => {
    const l = mk();
    const c = cachedOf(l);
    l.version = 2;
    l.dirty = { x0: -10, y0: -10, x1: 12, y1: 12 };
    expect(planUpload(c, l)).toEqual({ kind: 'rect', x0: 0, y0: 0, x1: 12, y1: 12 });
    l.dirty = { x0: 0, y0: 0, x1: 60, y1: 60 };
    expect(planUpload(c, l)).toEqual({ kind: 'full' });
    l.dirty = { x0: 30, y0: 30, x1: 30, y1: 40 };
    expect(planUpload(c, l)).toEqual({ kind: 'full' });
    l.dirty = null;
    expect(planUpload(c, l)).toEqual({ kind: 'full' });
  });

  it('recreates when size or backing arrays change', () => {
    const l = mk();
    const c = cachedOf(l);
    l.version = 2;
    expect(planUpload(c, { ...l, w: 32, pixels: new Uint32Array(32 * 64) })).toEqual({ kind: 'create' });
    expect(planUpload(c, { ...l, pixels: new Uint32Array(64 * 64) })).toEqual({ kind: 'create' });
    expect(planUpload(c, { ...l, emissive: new Uint8Array(64 * 64) })).toEqual({ kind: 'create' });
  });
});

describe('StaleRegistry', () => {
  it('sweeps entries that were not touched recently and returns them for disposal', () => {
    const r = new StaleRegistry<string>();
    r.set('a', 'A', 0);
    r.set('b', 'B', 0);
    r.get('a', 90);
    const freed = r.sweep(100, 60);
    expect(freed).toEqual(['B']);
    expect(r.size).toBe(1);
    expect(r.get('a', 100)).toBe('A');
  });

  it('clear returns everything', () => {
    const r = new StaleRegistry<number>();
    r.set('x', 1, 0);
    r.set('y', 2, 0);
    expect(r.clear().sort()).toEqual([1, 2]);
    expect(r.size).toBe(0);
  });
});
