import { describe, expect, it } from 'vitest';
import type { FrameFx, GravitySource, MatchApi, SimEvent } from '@/contracts';
import { createMatch } from '@/sim';
import { fakeDeps } from '@/sim/testing/fakes';
import { FxState, IMPACT_SLOTS, ONSET_GAP, buildAudioScene } from './fx';

const mkMatch = (): MatchApi =>
  createMatch(
    {
      seed: 1,
      stage: 'nursery',
      mode: 'versus',
      slots: [
        { titan: 'lastone', controller: 'dummy' },
        { titan: 'asteroid', controller: 'dummy' },
      ],
    },
    fakeDeps(),
  );

/** The same match seen at another sim time scale (KO slow motion). */
const atScale = (m: MatchApi, timeScale: number): MatchApi =>
  Object.create(m, { timeScale: { value: timeScale } }) as MatchApi;

const heavyHit = (x = 300, y = 200, energy = 2600): SimEvent => ({
  t: 'hit',
  attacker: 0,
  target: 1,
  titan: 'asteroid',
  x,
  y,
  dirX: 1,
  dirY: 0,
  type: 'KINETIC',
  energy,
  cellsRemoved: 80,
  massRemoved: 40,
  blocked: 0,
  heavy: true,
  onDamaged: 0,
});

const impactLights = (fx: FxState): NonNullable<ReturnType<FxState['sample']>['lights']> =>
  (fx.sample(0).lights ?? []).filter((l) => l.kind === 'impact');

describe('FxState', () => {
  it('spawns a shockwave that expands, fades and expires', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick([{ t: 'shockwave', x: 100, y: 50, strength: 0.8, radius: 200, hue: -1 }], m);
    const a = fx.sample(0);
    expect(a.shockwaves).toHaveLength(1);
    const r0 = a.shockwaves[0]!.radius;
    for (let i = 0; i < 20; i++) fx.tick([], m);
    const b = fx.sample(0);
    expect(b.shockwaves[0]!.radius).toBeGreaterThan(r0);
    expect(b.shockwaves[0]!.strength).toBeLessThan(0.8);
    for (let i = 0; i < 200; i++) fx.tick([], m);
    expect(fx.sample(0).shockwaves).toHaveLength(0);
    expect(fx.sample(0).impulses).toHaveLength(0);
  });

  it('a KO is a LOCAL impact light + refraction at the KO point that decays; intensity stays in 0..1', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick([{ t: 'ko', slot: 1, x: 410, y: 220 } as SimEvent], m);
    const a = fx.sample(0);
    expect(a.flash).toBeGreaterThan(0.5);
    expect(a.aberration).toBeGreaterThan(0.5);
    const lit = (a.lights ?? []).filter((l) => l.kind === 'impact');
    expect(lit).toHaveLength(1);
    expect(lit[0]!.x).toBe(410);
    expect(lit[0]!.y).toBe(220);
    expect(lit[0]!.radius).toBeLessThanOrEqual(220); // local, not the frame
    for (let i = 0; i < 120; i++) fx.tick([], m);
    const b = fx.sample(0);
    expect(b.flash).toBeLessThan(0.01);
    expect(b.aberration).toBeLessThan(0.01);
    expect((b.lights ?? []).some((l) => l.kind === 'impact')).toBe(false);
    expect(b.intensity).toBeGreaterThanOrEqual(0);
    expect(b.intensity).toBeLessThanOrEqual(1);
  });

  it('a flash event with x,y becomes an impact light there (never a wash)', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick([{ t: 'flash', amount: 0.7, x: 123, y: 45 }], m);
    const lit = impactLights(fx);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.x).toBe(123);
    expect(lit[0]!.y).toBe(45);
    expect(lit[0]!.slot).toBe(-1);
  });

  it('gates impact-light onsets to at most 3 per second of wall time', () => {
    const fx = new FxState();
    const m = mkMatch();
    let onsets = 0;
    let prevMax = 0;
    // a heavy hit EVERY 4 ticks (15/s) for 3 s: count the frames on which a light got brighter than the frame before
    for (let t = 0; t < 180; t++) {
      fx.tick(t % 4 === 0 ? [heavyHit(300 + (t % 7) * 10)] : [], m);
      const max = Math.max(0, ...impactLights(fx).map((l) => l.intensity));
      if (max > prevMax + 1e-6) onsets++;
      prevMax = max;
    }
    expect(ONSET_GAP).toBeGreaterThanOrEqual(1 / 3);
    expect(onsets).toBeLessThanOrEqual(3 * 3 + 1);
    expect(onsets).toBeGreaterThanOrEqual(3 * 2);
    expect(impactLights(fx).length).toBeLessThanOrEqual(IMPACT_SLOTS);
  });

  it('merges a hit, its flash and its KO on one tick into ONE light', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick(
      [heavyHit(200, 150), { t: 'flash', amount: 0.7, x: 205, y: 150 }, { t: 'ko', slot: 1, x: 200, y: 150 }],
      m,
    );
    expect(impactLights(fx)).toHaveLength(1);
  });

  it('impact lights decay in WALL time: KO slow motion does not stretch them', () => {
    const run = (scale: number): number => {
      const fx = new FxState();
      const m = atScale(mkMatch(), scale);
      fx.tick([heavyHit()], m);
      const ticks = Math.round(0.2 * 60 * scale); // 200 ms of wall time (12 ticks at full speed, 6 at half)
      for (let i = 0; i < ticks; i++) fx.tick([], m);
      return Math.max(0, ...impactLights(fx).map((l) => l.intensity));
    };
    const normal = run(1);
    const slow = run(0.5);
    expect(normal).toBeGreaterThan(0.05);
    expect(Math.abs(slow - normal)).toBeLessThan(1e-6);
  });

  it('the comfort setting scales impact lights and refraction down', () => {
    const peak = (scale: number): { light: number; refr: number } => {
      const fx = new FxState();
      fx.flashScale = scale;
      fx.tick([{ t: 'ko', slot: 1, x: 0, y: 0 } as SimEvent], mkMatch());
      const s = fx.sample(0);
      return { light: Math.max(...impactLights(fx).map((l) => l.intensity)), refr: s.aberration };
    };
    const full = peak(1);
    const off = peak(0);
    expect(off.light).toBeLessThan(full.light * 0.5);
    expect(off.refr).toBe(0);
  });

  it('slew-limits the intensity the renderer sees (a KO cannot step the stage brightness)', () => {
    const fx = new FxState();
    const m = mkMatch();
    const before = fx.sample(0).intensity;
    fx.tick([{ t: 'ko', slot: 1, x: 0, y: 0 } as SimEvent], m);
    const after = fx.sample(0).intensity;
    expect(fx.intensity() - before).toBeGreaterThan(0.3); // the fight did heat up…
    expect(after - before).toBeLessThanOrEqual(0.5 / 60 + 1e-9); // …but one tick moves the renderer's copy ≤ 0.5/s
  });

  it('never exceeds its ring budget and reports lensing from fighter views', () => {
    const fx = new FxState();
    const m = mkMatch();
    m.fighters[1].view.lensRadius = 40;
    m.fighters[1].view.lensStrength = 1;
    for (let i = 0; i < 40; i++)
      fx.tick([{ t: 'shockwave', x: i, y: 0, strength: 1, radius: 100, hue: -1 }], m);
    const s = fx.sample(0.5);
    expect(s.shockwaves.length).toBeLessThanOrEqual(10);
    expect(s.lenses).toHaveLength(1);
    expect(s.lenses[0]!.horizonR).toBe(40);
  });

  it('builds an audio scene', () => {
    const m = mkMatch();
    const sc = buildAudioScene(m, 'fight', 0.5, 320);
    expect(sc.fighters).toHaveLength(2);
    expect(sc.fighters![0].titan).toBe('lastone');
    expect(sc.lowestIntegrity).toBe(1);
  });
});

describe('FxState arena comets', () => {
  it('turns a warning into a glint, follows the live chunk (and its capture), and drops it on retire', () => {
    const fx = new FxState();
    const base = mkMatch();
    // the world's chunk 7: moving right, then captured by slot 1
    const chunk = { x: 100, y: 200, vx: 180, vy: -20, radius: 11, mode: 0, owner: -1 };
    const world = Object.create(base.world, {
      chunkState: {
        value: (id: number, out: typeof chunk): boolean =>
          id === 7 ? (Object.assign(out, chunk), true) : false,
      },
    }) as MatchApi['world'];
    const m = Object.create(base, {
      world: { value: world },
      arena: {
        value: {
          ...base.arena,
          comets: { every: [300, 300], warn: 30, speed: [180, 180], mass: 90, maxLive: 2 },
        },
      },
    }) as MatchApi;
    const comets = (): NonNullable<FrameFx['comets']> => fx.sample(0).comets ?? [];

    fx.tick([{ t: 'hazard', kind: 'comet-warn', id: -1, x: -40, y: 210, vx: 180, vy: -20 }], m);
    for (let i = 0; i < 14; i++) fx.tick([], m);
    expect(comets()).toHaveLength(1);
    expect(comets()[0]!.warn).toBeCloseTo(15 / 30, 5);
    expect(comets()[0]!.x).toBe(-40);

    // enter: the warning is replaced by the live comet, read back from the chunk every tick
    fx.tick([{ t: 'hazard', kind: 'comet-enter', id: 7, x: -40, y: 210, vx: 180, vy: -20 }], m);
    expect(comets()).toHaveLength(1);
    expect(comets()[0]).toMatchObject({ x: 100, y: 200, vx: 180, r: 11, warn: 0, captured: 0 });
    // sub-tick extrapolation by the render alpha
    expect(fx.sample(0.5).comets![0]!.x).toBeCloseTo(100 + (180 * 0.5) / 60, 5);
    chunk.x = 160;
    chunk.mode = 1;
    chunk.owner = 1;
    fx.tick([], m);
    expect(comets()[0]).toMatchObject({ x: 160, captured: 1 });

    fx.tick([{ t: 'hazard', kind: 'comet-retire', id: 7, x: 700, y: 180, vx: 180, vy: -20 }], m);
    expect(comets()).toHaveLength(0);
  });

  it('drops a comet whose chunk is gone and a warning whose comet never came', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick([{ t: 'hazard', kind: 'comet-enter', id: 99, x: 0, y: 0, vx: 1, vy: 0 }], m);
    expect(fx.sample(0).comets).toHaveLength(0);
    fx.tick([{ t: 'hazard', kind: 'comet-warn', id: -1, x: 0, y: 0, vx: 1, vy: 0 }], m);
    for (let i = 0; i < 90 + 31; i++) fx.tick([], m);
    expect(fx.sample(0).comets).toHaveLength(0);
  });
});

describe('FxState gravity wells', () => {
  it("publishes each slot's gravity source as a well, pull mapped to 0..1, and drops it when the source goes", () => {
    const fx = new FxState();
    const base = mkMatch();
    const src: (GravitySource | null)[] = [null, { x: 500, y: 300, strength: 150, radius: 340 }];
    const world = Object.create(base.world, {
      gravitySourceOf: { value: (s: 0 | 1): GravitySource | null => src[s] ?? null },
    }) as MatchApi['world'];
    const m = Object.create(base, { world: { value: world } }) as MatchApi;
    fx.tick([], m);
    expect(fx.sample(0).wells).toEqual([{ x: 500, y: 300, radius: 340, strength: 0.5 }]);
    src[0] = { x: 100, y: 200, strength: 900, radius: 200 };
    fx.tick([], m);
    expect(fx.sample(0).wells!.map((w) => w.strength)).toEqual([1, 0.5]);
    src[0] = src[1] = null;
    fx.tick([], m);
    expect(fx.sample(0).wells).toHaveLength(0);
  });
});
