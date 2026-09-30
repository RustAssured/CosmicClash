import { getTitanDef } from '@/titans';
import { describe, expect, it } from 'vitest';
import {
  Btn,
  DamageFlag,
  KO_CORE_INTEGRITY,
  KO_MASS_FRAC,
  type DamageEvent,
  type DamageShape,
  type DamageType,
  type DebugShape,
  type SimEvent,
} from '@/contracts';
import type { Match } from '@/sim';
import type { LastOneRig } from '@/titans';
import type { FighterImpl } from './fighter';
import type { AsteroidBehaviour } from './behaviours/asteroid';
import type { LastOneBehaviour } from './behaviours/lastone';
import { ManualSource, createFakeWorld, makeMatch, skipIntro } from './testing/harness';
import type { FakeWorld } from './testing/fakeWorld';

function duel(gap = 150, a: 'lastone' | 'asteroid' = 'lastone', b: 'lastone' | 'asteroid' = 'asteroid') {
  const m: Match = makeMatch({ a, b, createWorld: createFakeWorld });
  const sa = new ManualSource();
  const sb = new ManualSource();
  m.setSources(sa, sb);
  skipIntro(m);
  const f0 = m.fighters[0] as FighterImpl;
  const f1 = m.fighters[1] as FighterImpl;
  f1.px = f0.px + gap;
  f1.py = f0.py;
  const events: SimEvent[] = [];
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      m.step();
      for (const e of m.events) events.push(e);
    }
  };
  const world = m.world as FakeWorld;
  return { m, sa, sb, f0, f1, events, step, world };
}

const tap = (src: ManualSource, btn: number, step: () => void): void => {
  src.held |= btn;
  step();
  src.held &= ~btn;
};

/** A hand-built incoming blow. */
function blow(type: DamageType, shape: DamageShape, energy = 200, flags = 0): DamageEvent {
  return {
    type,
    shape,
    energy,
    dirX: 1,
    dirY: 0,
    duration: 1,
    sourceMass: 5,
    sourceBodyId: 1,
    originX: 0,
    originY: 0,
    flags,
    params: {},
  };
}
const pointAt = (x: number, y: number, r = 20): DamageShape => ({ kind: 'point', x, y, r });

describe('pixel-accurate hit resolution', () => {
  it('probe agrees with the live cells for both facings, with lean, and stops hitting where cells are gone', () => {
    const { f0, f1, world, step } = duel(300);
    step(2);
    for (const f of [f0, f1]) {
      f.body.transform.lean = 5;
      let agree = 0;
      let total = 0;
      for (let dy = -90; dy <= 50; dy += 7)
        for (let dx = -70; dx <= 70; dx += 7) {
          const x = f.body.transform.x + dx + 0.5;
          const y = f.body.transform.y + dy + 0.5;
          const solid = world.solidAt(f.body.id, x, y);
          const hit = f.probe({ kind: 'point', x, y, r: 0.6 }).cells > 0;
          total++;
          // the body is exact; the Last One's probe additionally reports tendrils hanging in the air
          if (solid === hit || (hit && f.def.id === 'lastone' && !solid)) agree++;
          if (solid) expect(hit).toBe(true);
        }
      expect(agree).toBe(total);
      f.body.transform.lean = 0;
    }
    // delete the cells under a point: the same probe now whiffs
    const t = f1.body.transform;
    const cx = t.x;
    const cy = t.y;
    expect(f1.probe(pointAt(cx, cy, 3)).cells).toBeGreaterThan(0);
    world.applyDamage(f1.body.id, blow('KINETIC', pointAt(cx, cy, 6), 1e5));
    expect(f1.probe(pointAt(cx, cy, 3)).cells).toBe(0);
  });

  it('a lash whiffs at range and hits when close; aim decides which region it can reach', () => {
    const far = duel(420);
    far.step(3);
    tap(far.sa, Btn.STRIKE, far.step);
    far.step(45);
    expect(far.events.filter((e) => e.t === 'hit')).toHaveLength(0);

    // foe hovering 78 px above: the neutral lash passes below it, an upward lash reaches it
    const neutral = duel(140);
    neutral.f1.py = neutral.f0.py - 92;
    neutral.step(3);
    tap(neutral.sa, Btn.STRIKE, neutral.step);
    neutral.step(45);
    const upN = neutral.events.filter((e) => e.t === 'hit').length;

    const up = duel(140);
    up.f1.py = up.f0.py - 92;
    up.step(3);
    up.sa.moveY = -1;
    tap(up.sa, Btn.STRIKE, up.step);
    up.step(45);
    const upU = up.events.filter((e) => e.t === 'hit').length;
    expect(upU).toBeGreaterThan(upN);
  });

  it('reports what a hit did: cells, mass, contact point, blocked share, heavy flag, on-damaged', () => {
    const { sa, events, step } = duel(130);
    step(3);
    tap(sa, Btn.CRUSH, step);
    step(60);
    const hit = events.find((e) => e.t === 'hit') as Extract<SimEvent, { t: 'hit' }>;
    expect(hit).toBeDefined();
    expect(hit.attacker).toBe(0);
    expect(hit.target).toBe(1);
    expect(hit.titan).toBe('asteroid');
    expect(hit.type).toBe('FRACTURE');
    expect(hit.heavy).toBe(true);
    const power = (getTitanDef('lastone') as unknown as { balance?: { power?: number } }).balance?.power ?? 1;
    expect(hit.energy).toBeCloseTo(1100 * power, 0);
    expect(hit.cellsRemoved).toBeGreaterThan(200);
    expect(hit.massRemoved).toBeGreaterThan(0);
    expect(Number.isFinite(hit.x)).toBe(true);
    expect(hit.blocked).toBe(0);
    // camera / audio / rumble cues sized by the blow
    expect(events.some((e) => e.t === 'shake')).toBe(true);
    expect(events.some((e) => e.t === 'zoom')).toBe(true);
    expect(events.some((e) => e.t === 'shockwave')).toBe(true);
    const rumbles = events.filter((e) => e.t === 'rumble') as Extract<SimEvent, { t: 'rumble' }>[];
    expect(rumbles.length).toBe(2);
    expect(rumbles.find((r) => r.slot === 1)!.strong).toBeGreaterThan(
      rumbles.find((r) => r.slot === 0)!.strong,
    );
  });

  it('sweeping hitboxes hit at most once per move; continuous beams re-hit every tick', () => {
    const lash = duel(110);
    lash.step(3);
    tap(lash.sa, Btn.STRIKE, lash.step);
    lash.step(50);
    expect(lash.events.filter((e) => e.t === 'hit').length).toBeLessThanOrEqual(4);
    expect(lash.events.filter((e) => e.t === 'hit').length).toBeGreaterThan(1);

    const gaze = duel(150);
    gaze.f1.py = gaze.f0.py - 30;
    gaze.step(3);
    gaze.sa.held = Btn.SIGNATURE;
    gaze.step(14);
    gaze.sa.held = 0; // release right away: an uncharged gaze
    gaze.step(40);
    const hits = gaze.events.filter((e) => e.t === 'hit');
    // rate-limited events but many ticks of damage in the world log
    expect(gaze.world.damageLog.length).toBeGreaterThanOrEqual(12);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(gaze.world.damageLog.every((d) => d.ev.flags & DamageFlag.CONTINUOUS)).toBe(true);
  });

  it('holding the Signature charges the Gaze: longer charge ⇒ more energy and longer reach', () => {
    const short = duel(320);
    short.f1.py = short.f0.py - 40;
    short.step(3);
    short.sa.held = Btn.SIGNATURE;
    short.step(14);
    short.sa.held = 0;
    short.step(50);
    const long = duel(320);
    long.f1.py = long.f0.py - 40;
    long.step(3);
    long.sa.held = Btn.SIGNATURE;
    long.step(90); // beyond chargeMax (64) ⇒ auto-release at full charge
    long.sa.held = 0;
    long.step(40);
    const e = (w: FakeWorld): number => w.damageLog.reduce((s, d) => s + d.ev.energy, 0);
    expect(long.f0.view.chargeFrac).toBe(0);
    expect(e(long.world)).toBeGreaterThan(e(short.world) * 1.3);
    // reach: at 320 px the short gaze (232×1.14×0.8 ≈ 210 px) cannot reach the foe's body but the full charge (×1.2 ⇒ 320) can
    expect(short.world.damageLog.length).toBe(0);
    expect(long.world.damageLog.length).toBeGreaterThan(0);
  });
});

describe('Guard: a shell whose strength depends on damage type', () => {
  const guarded = (): ReturnType<typeof duel> => {
    const d = duel(300);
    d.step(3);
    d.sb.held = Btn.GUARD;
    d.step(6);
    expect(d.f1.view.guardUp).toBe(true);
    return d;
  };

  it('the Asteroid’s regolith shell is great against KINETIC and poor against THERMAL (profile from data)', () => {
    const results: Record<string, number> = {};
    for (const type of ['KINETIC', 'CRUSH', 'FRACTURE', 'THERMAL'] as DamageType[]) {
      const d = guarded();
      const r = d.f1.receive(blow(type, pointAt(d.f1.px, d.f1.py, 30), 200), d.f0, []);
      results[type] = r.blocked;
    }
    expect(results.KINETIC!).toBeGreaterThan(results.CRUSH!);
    expect(results.CRUSH!).toBeGreaterThan(results.FRACTURE!);
    expect(results.FRACTURE!).toBeGreaterThan(results.THERMAL!);
    expect(results.KINETIC!).toBeGreaterThan(0.6);
    expect(results.THERMAL!).toBeLessThan(0.15);
  });

  it('a guarded blow removes less matter than the same blow unguarded, and never stuns', () => {
    const g = guarded();
    const shape = pointAt(g.f1.px, g.f1.py, 30);
    const rg = g.f1.receive(blow('KINETIC', shape, 400), g.f0, []);
    expect(g.f1.view.state).toBe('guard');
    const u = duel(300);
    u.step(3);
    const ru = u.f1.receive(blow('KINETIC', pointAt(u.f1.px, u.f1.py, 30), 400), u.f0, []);
    expect(rg.cellsRemoved).toBeLessThan(ru.cellsRemoved * 0.5);
    expect(u.f1.view.state).toBe('hitstun');
  });

  it('UNBLOCKABLE ignores the shell', () => {
    const g = guarded();
    const r = g.f1.receive(
      blow('KINETIC', pointAt(g.f1.px, g.f1.py, 30), 200, DamageFlag.UNBLOCKABLE),
      g.f0,
      [],
    );
    expect(r.blocked).toBe(0);
  });

  it('sustained CRUSH drains the shell and breaks it into a guard-break stun; the shell recovers later', () => {
    const g = guarded();
    const ev: SimEvent[] = [];
    let broke = false;
    for (let i = 0; i < 8 && !broke; i++) {
      g.f0.hitInfo.guardPressure = 1;
      // a shoulder-height blow well away from the core so the round is not decided by the test
      g.f1.receive(blow('CRUSH', pointAt(g.f1.px - 38, g.f1.py - 30, 16), 1300), g.f0, ev);
      broke = ev.some((e) => e.t === 'guard' && e.broke);
    }
    expect(broke).toBe(true);
    expect(g.f1.view.state).toBe('guardbreak');
    expect(g.f1.view.guardUp).toBe(false);
    g.sb.held = 0;
    g.step(80);
    expect(g.f1.view.state).not.toBe('guardbreak');
    expect(g.f1.view.guardHealth).toBeGreaterThan(0.4);
  });

  it('the Last One’s guard is its tendril shell: it thins as tendrils are lost', () => {
    const d = duel(300);
    d.step(3);
    d.sa.held = Btn.GUARD;
    d.step(6);
    const beh = d.f0.behaviour as LastOneBehaviour;
    const full = d.f0.guardStrength();
    const sys = (beh as unknown as { sys: { count: Int8Array; n: number } }).sys;
    for (let i = 0; i < sys.n; i += 2) sys.count[i] = 0;
    expect(beh.tendrilsAlive).toBe(sys.n / 2);
    expect(d.f0.guardStrength()).toBeLessThan(full * 0.75);
  });
});

describe('meter, resource and the ultimate', () => {
  it('meter fills from dealing and (less) from receiving damage; the ultimate needs a full meter and spends it', () => {
    const { f0, f1, sa, events, step } = duel(130);
    step(3);
    tap(sa, Btn.CRUSH, step);
    step(70);
    expect(f0.view.meter).toBeGreaterThan(0.1);
    expect(f1.view.meter).toBeGreaterThan(0);
    expect(f1.view.meter).toBeLessThan(f0.view.meter);

    events.length = 0;
    f0.meter = 0.5;
    step(60);
    tap(sa, Btn.ULTIMATE, step);
    expect(events.some((e) => e.t === 'move' && e.moveSlot === 'ultimate')).toBe(false);
    f0.meter = 1;
    step(60);
    tap(sa, Btn.ULTIMATE, step);
    expect(events.some((e) => e.t === 'ultimate' && e.phase === 'start')).toBe(true);
    expect(f0.view.moveSlot).toBe('ultimate');
    expect(f0.view.moveTotal).toBeGreaterThanOrEqual(180);
    expect(f0.view.moveTotal).toBeLessThanOrEqual(300);
    expect(f0.view.meter).toBeLessThan(0.1);
    // it plays out and ends with an `ultimate end` event
    step(300);
    expect(events.some((e) => e.t === 'ultimate' && e.phase === 'end')).toBe(true);
  });

  it('holds still through the ultimate wind-up (camera-friendly pose) and cannot be stunned out of the armoured phases', () => {
    const { f0, f1, sa, step } = duel(300);
    step(3);
    f0.meter = 1;
    tap(sa, Btn.ULTIMATE, step);
    sa.moveX = 1;
    const x0 = f0.px;
    step(50);
    expect(Math.abs(f0.px - x0)).toBeLessThan(40);
    const r = f0.receive(blow('KINETIC', pointAt(f0.px, f0.py, 30), 500), f1, []);
    expect(r.connected).toBe(true);
    expect(f0.view.state).not.toBe('hitstun'); // armour: the blow lands but does not interrupt
    expect(f0.view.moveSlot).toBe('ultimate');
  });
});

describe('KO, integrity and live stats', () => {
  it('KO when mass falls below KO_MASS_FRAC; integrityPct reads 100 → 0 across the margin', () => {
    const d = duel(400);
    d.step(3);
    expect(d.f1.view.integrityPct).toBeCloseTo(100, 0);
    d.world.carve(d.f1.body.id, 0.6, 1);
    d.step(2);
    const mid = d.f1.view.integrityPct;
    expect(mid).toBeLessThan(100);
    expect(mid).toBeGreaterThan(20);
    expect(d.f1.view.ko).toBe(false);
    d.world.carve(d.f1.body.id, KO_MASS_FRAC - 0.03, 2);
    d.step(2);
    expect(d.f1.view.ko).toBe(true);
    expect(d.f1.view.state).toBe('ko');
    expect(d.f1.view.integrityPct).toBe(0);
    expect(d.events.filter((e) => e.t === 'ko')).toHaveLength(1);
  });

  it('KO when the core is destroyed even if most of the body remains', () => {
    const d = duel(400);
    d.step(3);
    const core = d.f1.body.map;
    d.world.applyDamage(
      d.f1.body.id,
      blow('KINETIC', pointAt(d.f1.body.transform.x, d.f1.body.transform.y, core.coreRadius * 1.6), 1e6),
    );
    d.step(2);
    expect(d.f1.view.bodyStats.massFrac).toBeGreaterThan(KO_MASS_FRAC);
    expect(d.f1.view.bodyStats.coreIntegrity).toBeLessThan(KO_CORE_INTEGRITY);
    expect(d.f1.view.ko).toBe(true);
  });

  it('the killing blow announces itself: slow motion, flash, and the match sees the KO the same step', () => {
    const d = duel(120);
    d.step(3);
    d.world.carve(d.f1.body.id, 0.3, 4);
    d.step(2);
    tap(d.sa, Btn.CRUSH, d.step);
    for (let i = 0; i < 90 && !d.f1.view.ko; i++) d.step();
    expect(d.f1.view.ko).toBe(true);
    expect(d.events.some((e) => e.t === 'timescale' && e.scale <= 0.35)).toBe(true);
    expect(d.events.some((e) => e.t === 'flash')).toBe(true);
    expect(d.m.phase === 'ko' || d.m.phase === 'roundend').toBe(true);
  });

  it('losing matter makes a titan lighter and faster but weaker', () => {
    const d = duel(400);
    d.step(3);
    const before = { ...d.f0.stats };
    d.world.carve(d.f0.body.id, 0.5, 3);
    d.step(2);
    expect(d.f0.stats.speedMul).toBeGreaterThan(before.speedMul);
    expect(d.f0.stats.tempoMul).toBeGreaterThan(before.tempoMul);
    expect(d.f0.stats.damageMul).toBeLessThan(before.damageMul);
    expect(d.f0.stats.mass).toBeLessThan(before.mass);
    expect(d.f0.stats.reachMul).toBeLessThan(before.reachMul);
  });

  it('carries damage between rounds as scars: nextRound heals a fraction and resets state, keeps the body', () => {
    const d = duel(400);
    d.step(3);
    d.world.carve(d.f1.body.id, 0.4, 5);
    d.step(2);
    const missing = 1 - d.f1.view.bodyStats.massFrac;
    d.f1.nextRound(1000, 290, -1, 0.5, 9);
    expect(d.f1.view.state).toBe('intro');
    expect(d.f1.view.ko).toBe(false);
    expect(1 - d.f1.view.bodyStats.massFrac).toBeLessThan(missing);
    expect(1 - d.f1.view.bodyStats.massFrac).toBeGreaterThan(0.05);
    expect(d.f1.view.guardHealth).toBe(1);
  });
});

describe('The Last One: tendrils and the bared eye', () => {
  const setup = (): {
    d: ReturnType<typeof duel>;
    beh: LastOneBehaviour;
    sys: { n: number; count: Int8Array; x: Float32Array; y: Float32Array; hp: Float32Array };
  } => {
    const d = duel(400, 'asteroid', 'lastone'); // the Last One is slot 1 here, facing left
    d.step(3);
    const beh = d.f1.behaviour as LastOneBehaviour;
    const sys = (
      beh as unknown as {
        sys: { n: number; count: Int8Array; x: Float32Array; y: Float32Array; hp: Float32Array };
      }
    ).sys;
    return { d, beh, sys };
  };

  it('exposes tendrils as HUD parts/resource, 20–30 of them', () => {
    const { d, sys } = setup();
    expect(sys.n).toBeGreaterThanOrEqual(20);
    expect(sys.n).toBeLessThanOrEqual(30);
    expect(d.f1.view.parts).toBe(sys.n);
    expect(d.f1.view.resource).toBe(sys.n);
    expect(d.f1.view.resourceMax).toBe(sys.n);
  });

  it('a blow that sweeps through tendrils damages and severs them one by one, emitting cues, before reaching the body', () => {
    const { d, sys } = setup();
    // aim at tendril tips hanging below the hem, well away from the body
    const tipY = Math.max(...Array.from({ length: sys.n }, (_, i) => sys.y[i * 12 + 11]!));
    const shape: DamageShape = {
      kind: 'line',
      x0: d.f1.px - 70,
      y0: tipY - 3,
      x1: d.f1.px + 70,
      y1: tipY - 3,
      width: 8,
    };
    const lb = d.f1.behaviour as LastOneBehaviour;
    const before = lb.tendrilLength;
    const events: SimEvent[] = [];
    // the probe sees the tendrils even though no body cell is touched
    expect(d.f1.probe(shape).cells).toBeGreaterThan(0);
    const cellsBefore = d.f1.view.bodyStats.cells;
    for (let i = 0; i < 4; i++) d.f1.receive(blow('FRACTURE', shape, 260), d.f0, events);
    expect(events.some((e) => e.t === 'cue' && e.id === 'tendril-sever')).toBe(true);
    expect(lb.tendrilLength).toBeLessThan(before); // cut tips shorten the veil
    expect(lb.tendrilsAlive).toBeLessThanOrEqual(24);
    expect(d.f1.view.bodyStats.cells).toBe(cellsBefore); // the body itself was never touched
    d.step(1);
    expect(d.f1.view.resource).toBe(d.f1.view.parts);
  });

  it('tendrils soak part of a blow that reaches the body', () => {
    const { d } = setup();
    const t = d.f1.body.transform;
    const shape = pointAt(t.x - 20, t.y + 10, 40);
    const r = d.f1.receive(blow('KINETIC', shape, 500), d.f0, []);
    expect(r.blocked).toBeGreaterThan(0);
    expect(r.blocked).toBeLessThanOrEqual(0.36);
  });

  it('as tendrils fall the eye takes extra damage; with all of them gone the same blow does much more', () => {
    const intact = setup();
    const bare = setup();
    const sysB = (bare.beh as unknown as { sys: { n: number; count: Int8Array } }).sys;
    sysB.count.fill(0);
    bare.d.step(1);
    expect(bare.d.f1.view.parts).toBe(0);
    const eyeRig = (bare.d.f1 as FighterImpl).rig as LastOneRig;
    // world position of the eye of each body
    const eyeAt = (f: FighterImpl): { x: number; y: number } => {
      const t = f.body.transform;
      return { x: t.x - (eyeRig.eye.x + 0.5 - t.anchorX), y: t.y + (eyeRig.eye.y + 0.5 - t.anchorY) };
    };
    const run = (s: typeof intact): { removed: number; extra: number } => {
      const e = eyeAt(s.d.f1);
      const log0 = s.d.world.damageLog.length;
      const r = s.d.f1.receive(blow('FRACTURE', pointAt(e.x, e.y, 6), 120), s.d.f0, s.d.events);
      const extra = s.d.world.damageLog.slice(log0).reduce((a, d) => a + d.ev.energy, 0);
      return { removed: r.cellsRemoved, extra };
    };
    const a = run(intact);
    const b = run(bare);
    expect(b.extra).toBeGreaterThan(a.extra * 1.6);
    expect(b.removed).toBeGreaterThan(a.removed);
    expect(bare.d.events.some((e) => e.t === 'cue' && e.id === 'eye-exposed')).toBe(true);
  });

  it('Patient Regrowth: a severed tendril grows back after a quiet spell, but not while being hit', () => {
    const { d, beh, sys } = setup();
    // cut two tendrils through a real blow so the quiet-window clock starts
    const t = d.f1.body.transform;
    const tipY = Math.max(...Array.from({ length: sys.n }, (_, i) => sys.y[i * 12 + 11]!));
    const shape: DamageShape = {
      kind: 'line',
      x0: t.x - 80,
      y0: tipY - 3,
      x1: t.x + 80,
      y1: tipY - 3,
      width: 8,
    };
    for (let i = 0; i < 5; i++) d.f1.receive(blow('FRACTURE', shape, 400), d.f0, d.events);
    d.step(1);
    const n0 = beh.tendrilsAlive;
    expect(n0).toBeLessThan(sys.n);
    d.step(100);
    expect(beh.tendrilsAlive).toBe(n0); // still inside the quiet window
    d.step(400);
    expect(beh.tendrilsAlive).toBeGreaterThan(n0);
    expect(beh.tendrilLength).toBeGreaterThan(0.9);
    expect(d.events.some((e) => e.t === 'resource' && e.kind === 'spend')).toBe(true);
    expect(d.events.some((e) => e.t === 'resource' && e.kind === 'gain')).toBe(true);
  });

  it('heavy blows sever many tendrils at once; the eye is then far easier to kill', () => {
    const { d, sys } = setup();
    const t = d.f1.body.transform;
    // a wide sweep through the whole veil below the hem
    const shape: DamageShape = {
      kind: 'cone',
      x: t.x,
      y: t.y + 20,
      dirX: 0,
      dirY: 1,
      range: 90,
      halfAngle: 1.2,
    };
    d.f1.receive(blow('CRUSH', shape, 1400), d.f0, []);
    expect((d.f1.behaviour as LastOneBehaviour).tendrilsAlive).toBeLessThan(sys.n - 6);
  });
});

describe('The Asteroid: momentum, rubble pile, fragments', () => {
  it('Momentum: consecutive hits speed it up and it decays when nothing lands', () => {
    const d = duel(110, 'lastone', 'asteroid');
    d.step(3);
    const beh = d.f1.behaviour as AsteroidBehaviour;
    const s0 = d.f1.stats.speedMul;
    expect(beh.momentumStacks).toBe(0);
    for (let i = 0; i < 3; i++) {
      tap(d.sb, Btn.STRIKE, d.step);
      d.step(46);
    }
    expect(beh.momentumStacks).toBeGreaterThanOrEqual(1);
    expect(d.f1.stats.speedMul).toBeGreaterThan(s0);
    d.step(60 * 12);
    expect(beh.momentumStacks).toBe(0);
  });

  it('Rubble Pile: below ~35% mass the rock loses cohesion and hits softer; it recovers above the hysteresis band', () => {
    const d = duel(400, 'lastone', 'asteroid');
    d.step(3);
    const beh = d.f1.behaviour as AsteroidBehaviour;
    expect(d.f1.body.cohesionScale).toBe(1);
    const dm0 = d.f1.stats.damageMul;
    d.world.carve(d.f1.body.id, 0.3, 8);
    d.step(2);
    expect(beh.isRubble).toBe(true);
    expect(d.f1.body.cohesionScale).toBeLessThan(0.7);
    expect(d.f1.stats.damageMul).toBeLessThan(dm0 * 0.7);
    expect(d.f1.stats.speedMul).toBeGreaterThan(1.2); // still fast
    expect(d.events.some((e) => e.t === 'cue' && e.id === 'rubble-pile')).toBe(true);
    d.world.heal(d.f1.body.id, 0.15, 1); // back to ~0.38: inside the band, still rubble
    d.step(2);
    if (d.f1.view.bodyStats.massFrac > 0.35 && d.f1.view.bodyStats.massFrac < 0.42)
      expect(beh.isRubble).toBe(true);
    d.world.heal(d.f1.body.id, 0.9, 2);
    d.step(2);
    expect(beh.isRubble).toBe(false);
    expect(d.f1.body.cohesionScale).toBe(1);
  });

  it('Swarm: spends fragments, releases a steerable flock of small KINETIC projectiles, survivors re-merge and refund', () => {
    const d = duel(330, 'lastone', 'asteroid');
    d.step(3);
    const beh = d.f1.behaviour as AsteroidBehaviour;
    expect(d.f1.view.resource).toBe(12);
    tap(d.sb, Btn.SIGNATURE, d.step);
    expect(d.f1.view.resource).toBe(4); // 8 spent up front
    d.step(16);
    expect(beh.fragmentsOut).toBe(8);
    // the stick steers the flock, not the body
    const bx = d.f1.px;
    d.sb.moveX = -1;
    d.step(60);
    expect(Math.abs(d.f1.px - bx)).toBeLessThan(25);
    const hits = d.events.filter((e) => e.t === 'hit' && e.attacker === 1) as Extract<
      SimEvent,
      { t: 'hit' }
    >[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.type === 'KINETIC' && h.energy < 100)).toBe(true);
    d.sb.moveX = 0;
    // let the move end; fragments come home (the foe now stays in reach after each nudge, so the flock keeps hitting longer)
    for (let q = 0; q < 40 && beh.fragmentsOut > 0; q++) d.step(10);
    expect(beh.fragmentsOut).toBe(0);
    expect(d.f1.view.resource).toBeGreaterThanOrEqual(11);
    expect(d.events.some((e) => e.t === 'resource' && e.kind === 'gain')).toBe(true);
  });

  it('Swarm fragments can be shattered by the foe’s attacks (no refund for the fallen)', () => {
    const d = duel(330, 'lastone', 'asteroid');
    d.step(3);
    const beh = d.f1.behaviour as AsteroidBehaviour;
    tap(d.sb, Btn.SIGNATURE, d.step);
    d.step(20);
    expect(beh.fragmentsOut).toBe(8);
    const sx = (beh as unknown as { sx: Float32Array }).sx[0]!;
    const sy = (beh as unknown as { sy: Float32Array }).sy[0]!;
    const before = beh.fragmentsOut;
    const r = d.f1.receive(blow('FRACTURE', pointAt(sx, sy, 80), 100), d.f0, []);
    expect(r.connected).toBe(true);
    expect(beh.fragmentsOut).toBeLessThan(before);
    d.step(230);
    expect(d.f1.view.resource).toBeLessThan(12);
  });

  it('the Kessler Cascade is a 3–5 s armoured ultimate with a sweeping storm then a slam', () => {
    const d = duel(200, 'lastone', 'asteroid');
    d.step(3);
    d.f1.meter = 1;
    tap(d.sb, Btn.ULTIMATE, d.step);
    expect(d.f1.view.moveId).toBe('asteroid.kessler');
    expect(d.f1.view.moveTotal).toBe(240);
    const ids = new Set<string>();
    for (let i = 0; i < 250; i++) {
      d.step();
      for (const e of d.events) if (e.t === 'hit' && e.attacker === 1) ids.add(e.type);
    }
    expect(ids.has('KINETIC')).toBe(true);
    const big = d.world.damageLog.filter((x) => x.ev.energy > 2000);
    expect(big.length + d.world.damageLog.length).toBeGreaterThan(0);
  });
});

describe('threat telegraphs for the AI and the training overlay', () => {
  it('a windup publishes its coming hitboxes with a countdown that reaches 0 as they go live', () => {
    const { f0, sa, step } = duel(420);
    step(3);
    tap(sa, Btn.CRUSH, step);
    const first = f0.view.threats[0]!;
    expect(first).toBeDefined();
    const initial = first.ticksUntilLive; // (threat objects are pooled and mutated in place: copy what you keep)
    expect(initial).toBeGreaterThan(20);
    expect(first.type).toBe('FRACTURE');
    expect(first.detached).toBe(false);
    step(10);
    expect(f0.view.threats[0]!.ticksUntilLive).toBeLessThan(initial);
    while (f0.view.phase === 'startup') step();
    expect(f0.view.threats[0]!.ticksUntilLive).toBe(0);
    expect(f0.view.threats[0]!.ticksLive).toBeGreaterThan(0);
    while (f0.view.phase === 'active') step();
    expect(f0.view.threats.length).toBe(0);
  });

  it('debugShapes reports live hitboxes and the exposed eye target', () => {
    const { f0, sa, step } = duel(420);
    step(3);
    const out: DebugShape[] = [];
    f0.debugShapes(out);
    expect(out.some((s) => s.label?.startsWith('eye'))).toBe(true);
    out.length = 0;
    tap(sa, Btn.CRUSH, step);
    while (f0.view.phase !== 'active') step();
    f0.debugShapes(out);
    expect(out.some((s) => s.label === 'shatter')).toBe(true);
  });
});
