import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEG,
  LOGICAL_H,
  LOGICAL_W,
  MAX_FIGHTER_DX,
  type CameraApi,
  type CameraTargets,
  type SimEvent,
} from '@/contracts';
import { createCamera } from './camera';

const target = (x: number, y = 290, hw = 90, hh = 75) => ({ x, y, hw, hh });
const targets = (ax: number, bx: number, extra: Partial<CameraTargets> = {}): CameraTargets => ({
  a: target(ax),
  b: target(bx),
  arena: DEFAULT_ARENA,
  ...extra,
});
const run = (cam: CameraApi, t: CameraTargets, ticks: number, events: readonly SimEvent[] = []): void => {
  for (let i = 0; i < ticks; i++) cam.tick(t, i === 0 ? events : []);
};
const shake = (amp: number, dirX = 1, dirY = 0): SimEvent => ({ t: 'shake', dirX, dirY, amp });

describe('camera framing', () => {
  it('converges to the fighters midpoint and stays inside the arena', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    run(cam, targets(500, 700), 240);
    const s = cam.sample(0);
    expect(Math.abs(s.state.x - 600)).toBeLessThan(1);
    expect(s.view.x0).toBe(Math.round(600 - LOGICAL_W / 2));
  });

  it('arrives LATE: heavy dolly, not a webcam', () => {
    const cam = createCamera();
    cam.reset(400, 290);
    run(cam, targets(1100, 1200), 12); // 0.2 s
    const x = cam.sample(0).state.x;
    const travelled = (x - 400) / (1150 - 400);
    expect(travelled).toBeGreaterThan(0.02);
    expect(travelled).toBeLessThan(0.45);
  });

  it('horizontal follow is snappier than vertical', () => {
    const cam = createCamera();
    cam.reset(800, 200);
    run(cam, { a: target(1000, 330), b: target(1100, 330), arena: DEFAULT_ARENA }, 30);
    const s = cam.sample(0).state;
    const fx = (s.x - 800) / (1050 - 800);
    const fy = (s.y - 200) / (330 - 200);
    expect(fx).toBeGreaterThan(fy);
  });

  it('never leaves the arena, even when the targets do', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    run(cam, targets(-500, 100), 400);
    let v = cam.sample(0.5).view;
    expect(v.x0).toBeGreaterThanOrEqual(DEFAULT_ARENA.minX);
    run(cam, targets(1700, 2200), 400);
    v = cam.sample(0.5).view;
    expect(v.x0 + v.w).toBeLessThanOrEqual(DEFAULT_ARENA.maxX);
    run(cam, { a: target(800, -300), b: target(900, -400), arena: DEFAULT_ARENA }, 400);
    v = cam.sample(0.5).view;
    expect(v.y0).toBeGreaterThanOrEqual(DEFAULT_ARENA.minY);
    run(cam, { a: target(800, 900), b: target(900, 1000), arena: DEFAULT_ARENA }, 400);
    v = cam.sample(0.5).view;
    expect(v.y0 + v.h).toBeLessThanOrEqual(DEFAULT_ARENA.maxY);
  });

  it('keeps both tethered fighters in frame at maximum separation', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    const ax = 800 - MAX_FIGHTER_DX / 2;
    const bx = 800 + MAX_FIGHTER_DX / 2;
    run(cam, targets(ax, bx), 300);
    const v = cam.sample(0).view;
    expect(v.x0).toBeLessThanOrEqual(ax - 90 + 1);
    expect(v.x0 + v.w).toBeGreaterThanOrEqual(bx + 90 - 1);
  });

  it('leans toward the fighter that is moving', () => {
    const still = createCamera();
    const moving = createCamera();
    still.reset(800, 290);
    moving.reset(800, 290);
    // fighter B sprints right while A stands; compare with both standing at the same end positions
    for (let i = 0; i < 40; i++) {
      moving.tick({ a: target(600), b: target(800 + i * 6), arena: DEFAULT_ARENA }, []);
      still.tick({ a: target(600), b: target(800 + 39 * 6), arena: DEFAULT_ARENA }, []);
    }
    // The moving-B camera has weighted B more, so it sits further right than an unweighted midpoint would.
    const mid = (600 + 800 + 39 * 6) / 2;
    expect(moving.sample(0).state.x).toBeGreaterThan(still.sample(0).state.x - 60);
    expect(mid).toBeGreaterThan(0);
  });

  it('director focus pulls the framing and applies a zoom bias within the 6% cap', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    run(cam, targets(700, 900, { focus: { x: 1000, y: 250, weight: 1, zoom: 0.05 } }), 240);
    const s = cam.sample(0).state;
    expect(s.x).toBeGreaterThan(950);
    expect(s.zoom).toBeGreaterThan(1.03);
    expect(s.zoom).toBeLessThanOrEqual(1.06 + 1e-9);
  });
});

describe('camera impulses', () => {
  it('shake is integer-snapped in both state and view, so pixels never shimmer', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    run(cam, targets(700, 900), 60);
    cam.tick(targets(700, 900), [shake(9)]);
    for (let i = 0; i < 40; i++) {
      cam.tick(targets(700, 900), []);
      for (const a of [0, 0.3, 0.77]) {
        const s = cam.sample(a);
        expect(Number.isInteger(s.state.shakeX)).toBe(true);
        expect(Number.isInteger(s.state.shakeY)).toBe(true);
        expect(Number.isInteger(s.view.x0)).toBe(true);
        expect(Number.isInteger(s.view.y0)).toBe(true);
        expect(s.view.w).toBe(LOGICAL_W);
        expect(s.view.h).toBe(LOGICAL_H);
      }
    }
  });

  it('shake is directionally biased, low-frequency and decays within ~0.5 s', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    run(cam, targets(700, 900), 120);
    cam.tick(targets(700, 900), [shake(10, 1, 0)]);
    let peakX = 0;
    let peakY = 0;
    const xs: number[] = [];
    for (let i = 0; i < 90; i++) {
      cam.tick(targets(700, 900), []);
      const s = cam.sample(0).state;
      xs.push(s.shakeX);
      peakX = Math.max(peakX, Math.abs(s.shakeX));
      peakY = Math.max(peakY, Math.abs(s.shakeY));
    }
    expect(peakX).toBeGreaterThan(4);
    expect(peakX).toBeGreaterThan(peakY * 1.5); // biased along the blow
    // Low frequency: sign changes per second ≲ 2×9 Hz
    let flips = 0;
    for (let i = 1; i < 60; i++)
      if (Math.sign(xs[i]!) !== 0 && Math.sign(xs[i]!) !== Math.sign(xs[i - 1]!)) flips++;
    expect(flips).toBeLessThanOrEqual(2 * 9 + 2);
    // decayed to nothing
    expect(Math.abs(xs[89]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(xs[60]!)).toBeLessThanOrEqual(1);
  });

  it('zoom pulses peak at ≤ 1.06 and ease back within ~0.4 s', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    run(cam, targets(700, 900), 30);
    cam.tick(targets(700, 900), [
      { t: 'zoom', amount: 0.05 },
      { t: 'zoom', amount: 0.05 },
    ]);
    let peak = 1;
    for (let i = 0; i < 60; i++) {
      cam.tick(targets(700, 900), []);
      peak = Math.max(peak, cam.sample(0).state.zoom);
      expect(cam.sample(0).state.zoom).toBeLessThanOrEqual(1.06 + 1e-9);
    }
    expect(peak).toBeGreaterThan(1.03);
    expect(cam.sample(0).state.zoom).toBeLessThan(1.002);
  });

  it('roll never exceeds 1.5 degrees no matter how many kicks arrive', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    const kicks: SimEvent[] = Array.from({ length: 50 }, () => ({ t: 'roll', radians: 0.02 }));
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      cam.tick(targets(700, 900), i === 0 ? kicks : []);
      peak = Math.max(peak, Math.abs(cam.sample(0.5).state.roll));
    }
    expect(peak).toBeLessThanOrEqual(1.5 * DEG + 1e-9);
    expect(peak).toBeGreaterThan(1.0 * DEG);
    expect(Math.abs(cam.sample(0).state.roll)).toBeLessThan(0.1 * DEG);
  });

  it('a heavy hit with no shake event still shakes (defensive), a light hit with a shake event does not double up', () => {
    const hit = (heavy: boolean, energy: number): SimEvent => ({
      t: 'hit',
      attacker: 0,
      target: 1,
      titan: 'lastone',
      x: 900,
      y: 290,
      dirX: 1,
      dirY: 0,
      type: 'CRUSH',
      energy,
      cellsRemoved: 10,
      massRemoved: 1,
      blocked: 0,
      heavy,
      onDamaged: 0,
    });
    const peakOf = (events: SimEvent[]): number => {
      const cam = createCamera();
      cam.reset(800, 290);
      run(cam, targets(700, 900), 60);
      cam.tick(targets(700, 900), events);
      let p = 0;
      for (let i = 0; i < 40; i++) {
        cam.tick(targets(700, 900), []);
        p = Math.max(p, Math.abs(cam.sample(0).state.shakeX));
      }
      return p;
    };
    expect(peakOf([hit(true, 2000)])).toBeGreaterThan(5);
    expect(peakOf([hit(true, 2000), shake(2)])).toBeLessThan(peakOf([hit(true, 2000)]));
    expect(peakOf([hit(false, 200)])).toBeLessThan(peakOf([hit(true, 2000)]));
  });

  it('a KO blow kicks shake, zoom and roll', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    cam.tick(targets(700, 900), [{ t: 'ko', slot: 1, x: 900, y: 290 }]);
    const s = cam.sample(1).state; // alpha 1 = the tick just simulated
    expect(s.zoom).toBeGreaterThan(1.02);
    expect(Math.abs(s.roll)).toBeGreaterThan(0);
  });
});

describe('camera determinism & interpolation', () => {
  it('identical inputs give identical outputs', () => {
    const drive = (): number[] => {
      const cam = createCamera();
      cam.reset(800, 290);
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        const ev: SimEvent[] = i % 47 === 3 ? [shake(6, Math.cos(i), Math.sin(i))] : [];
        cam.tick(
          {
            a: target(600 + 100 * Math.sin(i / 30)),
            b: target(1000 + 60 * Math.cos(i / 25)),
            arena: DEFAULT_ARENA,
          },
          ev,
        );
        const s = cam.sample((i % 5) / 5);
        out.push(s.state.x, s.state.y, s.state.zoom, s.state.roll, s.view.x0, s.view.y0);
      }
      return out;
    };
    expect(drive()).toEqual(drive());
  });

  it('never produces NaN, even with zero-size or coincident targets', () => {
    const cam = createCamera();
    cam.reset(800, 290);
    for (let i = 0; i < 100; i++) {
      cam.tick(
        { a: { x: 800, y: 290, hw: 0, hh: 0 }, b: { x: 800, y: 290, hw: 0, hh: 0 }, arena: DEFAULT_ARENA },
        [shake(0, 0, 0)],
      );
      const s = cam.sample(0.5);
      for (const v of [s.state.x, s.state.y, s.state.zoom, s.state.roll, s.view.x0, s.view.y0]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('sample(alpha) interpolates between the previous and current tick', () => {
    const cam = createCamera();
    cam.reset(400, 290);
    run(cam, targets(1100, 1200), 20);
    const x0 = cam.sample(1).state.x; // the current pose before the next tick
    cam.tick(targets(1100, 1200), []);
    const a = cam.sample(0).state.x;
    const b = cam.sample(0.999).state.x;
    const mid = cam.sample(0.5).state.x;
    expect(a).toBeCloseTo(x0, 9);
    expect(mid).toBeGreaterThan(a);
    expect(mid).toBeLessThan(b);
    expect(mid).toBeCloseTo((a + b) / 2, 1);
  });

  it('reset snaps to the requested position with no residual motion', () => {
    const cam = createCamera();
    cam.reset(400, 290);
    run(cam, targets(1100, 1200), 30, [shake(10)]);
    cam.reset(800, 290);
    const s = cam.sample(0.5);
    expect(s.state.x).toBe(800);
    expect(s.state.shakeX).toBe(0);
    expect(s.state.zoom).toBe(1);
    run(cam, targets(800, 800), 30);
    expect(cam.sample(0).state.x).toBeCloseTo(800, 3);
  });
});
