import { describe, expect, it } from 'vitest';
import trailer from './timeline.json';
import p0 from './gates/p0.json';
import { blockSize, composeFrame, sampleCamera } from './camera';
import { BAR_H, SCOPE_H, bars, drawOverlay } from './overlay';
import { checkTimeline, frameCount, keyValue, sceneTime, shotAt, type Shot } from './timeline';
import { NATIVE_H, NATIVE_W } from './types';

const shot = (o: Partial<Shot>): Shot => ({
  id: 's',
  comment: 'c',
  start: 0,
  end: 5,
  stage: 'nursery',
  ...o,
});

describe('cinema timeline', () => {
  it('the trailer and the gate timelines are valid: contiguous shots, a comment on every shot', () => {
    const tl = checkTimeline(trailer);
    expect(tl.shots.every((s) => s.comment.length > 10)).toBe(true);
    expect(frameCount(tl)).toBe(95 * 60);
    expect(frameCount(checkTimeline(p0))).toBe(300);
  });

  it('rejects a gap between shots and a shot without a comment', () => {
    const base = { comment: 'x', fps: 60 };
    expect(() =>
      checkTimeline({ ...base, shots: [shot({ end: 1 }), shot({ id: 't', start: 2, end: 3 })] }),
    ).toThrow(/starts at 2/);
    expect(() => checkTimeline({ ...base, shots: [shot({ comment: ' ' })] })).toThrow(/comment/);
  });

  it('finds the shot at a time and integrates the time remap (slow motion, freeze)', () => {
    const tl = checkTimeline(p0);
    expect(shotAt(tl, 2.99).id).toBe('p0-fight');
    expect(shotAt(tl, 3).id).toBe('p0-space');
    const s = shot({
      time: [
        [0, 1],
        [1, 0.25],
        [2, 0],
      ],
    });
    expect(sceneTime(s, 0.5)).toBeCloseTo(0.5);
    expect(sceneTime(s, 1.5)).toBeCloseTo(1.125);
    expect(sceneTime(s, 4)).toBeCloseTo(1.25);
    expect(
      keyValue(
        [
          [0, 0],
          [1, 10],
        ],
        0.5,
        -1,
      ),
    ).toBe(5);
  });
});

describe('cine camera: whole-pixel blocks only', () => {
  it('a zoom is drawn in whole output blocks, exponential between keys', () => {
    expect(blockSize(1, 3)).toBe(3);
    expect(blockSize(2, 3)).toBe(6);
    expect(blockSize(1.5, 6)).toBe(9);
    const c = sampleCamera(
      [
        { t: 0, zoom: 1 },
        { t: 1, zoom: 4 },
      ],
      0.5,
    );
    expect(c.zoom).toBeCloseTo(2);
  });

  it('every native pixel becomes an exact b×b block (no resampling) at rest and mid-zoom', () => {
    const scene = new Uint32Array(NATIVE_W * NATIVE_H);
    for (let i = 0; i < scene.length; i++) scene[i] = (0xff000000 | ((i * 2654435761) & 0xffffff)) >>> 0;
    for (const [zoom, s] of [
      [1, 3],
      [2, 3],
      [1.34, 3],
      [8, 6],
    ] as const) {
      const b = blockSize(zoom, s);
      const W = NATIVE_W * s;
      const H = NATIVE_H * s;
      const o = composeFrame(scene, null, zoom, [NATIVE_W / 2, NATIVE_H / 2], s);
      // runs of equal colour along a row and a column are all exactly b long (except the clipped first and last)
      const runs = (at: (k: number) => number, n: number): number[] => {
        const r: number[] = [];
        let len = 1;
        for (let k = 1; k < n; k++) {
          if (at(k) === at(k - 1)) len++;
          else {
            r.push(len);
            len = 1;
          }
        }
        r.push(len);
        return r.slice(1, -1);
      };
      const px = (x: number, y: number): number =>
        o[(y * W + x) * 3]! | (o[(y * W + x) * 3 + 1]! << 8) | (o[(y * W + x) * 3 + 2]! << 16);
      expect(new Set(runs((k) => px(k, H >> 1), W))).toEqual(new Set([b]));
      expect(new Set(runs((k) => px(W >> 1, k), H))).toEqual(new Set([b]));
    }
  });
});

describe('cine camera: dutch quarter turns move pixels, never resample', () => {
  it('a 90° turn shows native column x as a screen row, in exact blocks', () => {
    const scene = new Uint32Array(NATIVE_W * NATIVE_H);
    for (let y = 0; y < NATIVE_H; y++)
      for (let x = 0; x < NATIVE_W; x++) scene[y * NATIVE_W + x] = (0xff000000 | (x << 8) | y) >>> 0;
    const s = 3;
    const W = NATIVE_W * s;
    const o = composeFrame(scene, null, 2, [320, 180], s, undefined, false, 1);
    const at = (x: number, y: number): [number, number] => [o[(y * W + x) * 3 + 1]!, o[(y * W + x) * 3]!];
    // moving right on screen walks native y upward (decreasing), x constant; moving down walks native x up
    const [x0, y0] = at(W / 2 + 3, 540 + 3);
    const [x1, y1] = at(W / 2 + 3 + 6, 540 + 3);
    const [x2, y2] = at(W / 2 + 3, 540 + 3 + 6);
    expect(x1).toBe(x0);
    expect(y1).toBe(y0 - 1);
    expect(x2).toBe(x0 + 1);
    expect(y2).toBe(y0);
  });
});

describe('letterbox and cards', () => {
  it('closed bars leave a 640×268 picture; open bars none; the bars shake with the camera', () => {
    expect(BAR_H * 2 + SCOPE_H).toBe(NATIVE_H);
    expect(bars(0)).toEqual({ top: 46, bottom: 46 });
    expect(bars(1)).toEqual({ top: 0, bottom: 0 });
    const s = bars(0, 3);
    expect(s.top + s.bottom).toBe(92);
    expect(s.top).toBe(49);
  });

  it('a card is the pixel font at its scale with a 1-px dark outline and no partial alpha', () => {
    const cv = drawOverlay(
      shot({ cards: [{ t: [0, 1], text: 'HUNGER.', scale: 3 }], letterbox: [[0, 1]] }),
      0.5,
      0,
    );
    const a = new Set<number>();
    let ink = 0;
    let outline = 0;
    for (const p of cv.pixels) {
      a.add(p >>> 24);
      if (p === 0xfff0ece8) ink++;
      if (p === 0xff0a0606) outline++;
    }
    expect([...a].sort()).toEqual([0, 255]);
    expect(ink % 9).toBe(0); // whole 3×3 glyph cells
    expect(outline).toBeGreaterThan(0);
    // the outline is one native pixel: no outline pixel has another outline pixel two steps out with no ink between
    const card = drawOverlay(
      shot({ cards: [{ t: [0, 1], text: 'I', scale: 3 }], letterbox: [[0, 1]] }),
      0.5,
      0,
    ).pixels;
    const row = Array.from({ length: NATIVE_W }, (_, x) => card[180 * NATIVE_W + x]!).filter((p) => p >>> 24);
    expect(row.length).toBeGreaterThan(0);
    expect(row[0]).toBe(0xff0a0606);
    expect(row[1]).toBe(0xfff0ece8);
  });
});
