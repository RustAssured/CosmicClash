import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  parseScript,
  type DamageEvent,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef, witnessDef } from '@/titans';
import { createFighter } from './index';
import type { FighterImpl } from './fighter';
import type { WitnessBehaviour } from './behaviours/witness';
import { skipIntro } from './testing/harness';

/** A real match where the Last One is played as the Witness (what `witness=1` selects). */
function witnessMatch(
  seed = 7,
  foe: TitanId = 'planet',
): { m: Match; w: FighterImpl; beh: WitnessBehaviour } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: 'lastone', controller: 'human' },
      { titan: foe, controller: 'human' },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef: (id) => (id === 'lastone' ? witnessDef(getTitanDef('lastone')) : getTitanDef(id)),
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  const w = m.fighters[0] as FighterImpl;
  return { m, w, beh: w.behaviour as unknown as WitnessBehaviour };
}

describe('the Witness in game (witness=1)', () => {
  it('its primary body is the eye cradle; every other region is a registered region body placed by the rig', () => {
    const { m, w, beh } = witnessMatch();
    expect(w.def.name).toBe('The Witness');
    expect(beh.regionBodies.length).toBeGreaterThanOrEqual(20);
    expect(w.regions.length).toBe(beh.regionBodies.length);
    // regions sit around the eye, not at the world origin
    for (const b of beh.regionBodies) {
      expect(Math.abs(b.transform.x - w.body.transform.x)).toBeLessThan(140);
      expect(Math.abs(b.transform.y - w.body.transform.y)).toBeLessThan(140);
    }
    // aggregated mass: the whole Witness, not just the eye
    const eyeOnly = m.world.stats(w.body.id).initialMass;
    expect(w.view.bodyStats.initialMass).toBeGreaterThan(eyeOnly * 3);
  });

  it('a turn rotates the regions through quantised steps, and they lag the eye', () => {
    const { m, w, beh } = witnessMatch();
    const steps0 = beh.regionBodies.map((b) => b.transform.rot ?? 0);
    // twist the fighter's angular state as a move would
    for (let t = 0; t < 30; t++) {
      w.ang.angle = 0.4;
      m.step();
    }
    const steps1 = beh.regionBodies.map((b) => b.transform.rot ?? 0);
    expect(steps1.some((s, i) => s !== steps0[i])).toBe(true);
    // the carapace (stiff) has turned further than the slowest arm tip segment
    const rig = beh.rig.rig;
    const armTips = beh.rig.arms.map((a) => rig.a[a.bodies[a.bodies.length - 1]!]!);
    expect(rig.a[beh.rig.carapace]!).toBeGreaterThan(Math.min(...armTips));
  });

  it('a blow is routed front to back: a light blow on the carapace does not reach the abyss behind it', () => {
    const { m, w, beh } = witnessMatch();
    m.step();
    const regions = beh.regionBodies;
    const before = regions.map((b) => m.world.stats(b.id).cells);
    const t = w.body.transform;
    // a point blow on the lower carapace, below the eye (in front of channels / lattice / abyss)
    const ev: DamageEvent = {
      type: 'KINETIC',
      shape: { kind: 'point', x: t.x, y: t.y + 40, r: 4 },
      energy: 160,
      dirX: 0,
      dirY: -1,
      duration: 1,
      sourceMass: 5,
      sourceBodyId: -1,
      originX: t.x,
      originY: t.y + 80,
      flags: 0,
      params: {},
    };
    const r = w.receive(ev, m.fighters[1]!, []);
    expect(r.cellsRemoved).toBeGreaterThan(0);
    const after = regions.map((b) => m.world.stats(b.id).cells);
    const lost = before.map((c, i) => c - after[i]!);
    const bodyIndex = (key: string): number => {
      const W = (w.rig as { body: { regions: { key: string }[] } }).body;
      return W.regions.findIndex((q) => q.key === key) - 1;
    };
    expect(lost[bodyIndex('carapace')]!).toBeGreaterThan(0);
    expect(lost[bodyIndex('abyss')]!).toBeLessThanOrEqual(lost[bodyIndex('carapace')]!);
  });

  it('a blow sways the structure and the load reaches the arms later: the carapace peaks first, no part flung past 1 rad', () => {
    // the response to the blow = the struck run minus an unstruck control run (idle sway and settling cancel out)
    const run = (struck: boolean): { w: number[][]; worst: number; beh: WitnessBehaviour } => {
      const { m, w, beh } = witnessMatch();
      m.step();
      if (struck) {
        const t = w.body.transform;
        const ev: DamageEvent = {
          type: 'KINETIC',
          shape: { kind: 'point', x: t.x + 30, y: t.y - 20, r: 6 },
          energy: 1100,
          dirX: 0,
          dirY: 1,
          duration: 1,
          sourceMass: 8,
          sourceBodyId: -1,
          originX: t.x + 30,
          originY: t.y - 80,
          flags: 0,
          params: {},
        };
        w.receive(ev, m.fighters[1]!, []);
      }
      const rig = beh.rig.rig;
      const out: number[][] = [];
      let worst = 0;
      // sampled per RIG step (hit-stop freezes the struck fighter for a few ticks: compare like with like)
      let last = rig.tick;
      for (let k = 0; k < 140 && out.length < 110; k++) {
        m.step();
        if (rig.tick === last) continue;
        last = rig.tick;
        out.push(Array.from(rig.a.subarray(0, rig.n)));
        for (let i = 0; i < rig.n; i++) worst = Math.max(worst, Math.abs(rig.a[i]! - rig.a[beh.rig.eye]!));
      }
      return { w: out, worst, beh };
    };
    const hit = run(true);
    const ctl = run(false);
    // when each part moves: the deviation-weighted mean time of its angle response (ticks after the blow)
    const centroid = (bodies: number[]): { at: number; peak: number } => {
      let sw = 0;
      let st = 0;
      let peak = 0;
      hit.w.forEach((as, k) => {
        for (const b of bodies) {
          const d = Math.abs(as[b]! - ctl.w[k]![b]!);
          sw += d;
          st += d * k;
          peak = Math.max(peak, d);
        }
      });
      return { at: st / Math.max(1e-9, sw), peak };
    };
    const wr = hit.beh.rig;
    const car = centroid([wr.carapace]);
    const arms = centroid(wr.arms.map((a) => a.bodies[0]!));
    const halo = centroid(wr.halo);
    // a visible sway of the whole structure (≥ 0.08 rad ≈ 4.6°), carapace first, the halo and the arms trailing it
    expect(car.peak).toBeGreaterThan(0.08);
    expect(arms.at).toBeGreaterThan(car.at + 10);
    expect(halo.at).toBeGreaterThan(car.at + 5);
    expect(hit.worst).toBeLessThan(1);
  });
  it('HALO SHARDS: every live arc sheds a shard; broken arcs shed none (and the Guard shell weakens with them)', () => {
    const shards = (broken: number): { hits: number; guard: number } => {
      const { m, w, beh } = witnessMatch(7, 'asteroid');
      (m.fighters[1] as unknown as { px: number }).px = w.px + 150;
      for (let k = 0; k < broken; k++) beh.debugSever(`halo${k}`);
      m.setSources(
        createScriptSource(parseScript('4:strike'), m.tick + 1),
        createScriptSource([], m.tick + 1),
      );
      let mask = 0;
      for (let t = 0; t < 90; t++) {
        m.step();
        mask |= (beh as unknown as { kit: { hitMask: number } }).kit.hitMask;
      }
      let hits = 0;
      for (let b = 16; b < 24; b++) if (mask & (1 << b)) hits++;
      return { hits, guard: beh.guardMultiplier() };
    };
    const whole = shards(0);
    const broken = shards(3);
    expect(whole.hits).toBeGreaterThanOrEqual(4);
    expect(broken.hits).toBeLessThanOrEqual(2);
    expect(whole.guard).toBeCloseTo(1, 5);
    expect(broken.guard).toBeCloseTo(0.25 + 0.75 * (2 / 5), 5);
  });

  it('SWEEPING ARCHITECTURE: severed arms shorten the reach (fewer blades land)', () => {
    // counted by the blades that connect (the kit's per-blade hit bits): damage alone also counts the lunge's body contact
    // and the severed arms' debris
    const sweep = (sever: string[]): number => {
      const { m, w, beh } = witnessMatch(7, 'asteroid');
      (m.fighters[1] as unknown as { px: number }).px = w.px + 120;
      for (const k of sever) beh.debugSever(k);
      m.setSources(
        createScriptSource(parseScript('4:crush'), m.tick + 1),
        createScriptSource([], m.tick + 1),
      );
      let mask = 0;
      for (let t = 0; t < 150; t++) {
        m.step();
        mask |= (beh as unknown as { kit: { hitMask: number } }).kit.hitMask;
      }
      let blades = 0;
      for (let b = 8; b < 12; b++) if (mask & (1 << b)) blades++;
      return blades;
    };
    // the two front arms (0 and 2) do the sweeping: cut one to its root segment and lose the other, then lose both
    const whole = sweep([]);
    const stub = sweep(['arm0.1', 'arm2.0']);
    const none = sweep(['arm0.0', 'arm2.0']);
    expect(whole).toBeGreaterThanOrEqual(2);
    expect(stub).toBeLessThan(whole);
    expect(none).toBe(0);
  });
  it('FRACTURE GAZE: breaking the carapace open opens inner eyes, and every open eye adds a beam (more damage)', () => {
    const gaze = (openUp: boolean): { eyes: number; dealt: number } => {
      const { m, w, beh } = witnessMatch(7, 'asteroid');
      const foe = m.fighters[1] as FighterImpl;
      (foe as unknown as { px: number }).px = w.px + 150;
      m.step();
      expect(beh.openEyes).toBe(0);
      if (openUp) {
        // heavy blows on the carapace right over the inner eyes (they sit behind it, below the main eye)
        const B = beh as unknown as {
          eyes: { inner: boolean; bx: number; by: number }[];
          eyeCentre(): { x: number; y: number };
        };
        const spots = B.eyes.filter((s) => s.inner);
        const carapace = beh.regionBodies[0]!.id;
        for (let k = 0; k < 60 && beh.openEyes < 2; k++) {
          const s = spots[k % spots.length]!;
          const e = B.eyeCentre();
          const ev: DamageEvent = {
            type: 'KINETIC',
            shape: { kind: 'point', x: e.x + s.bx, y: e.y + s.by, r: 6 },
            energy: 3000,
            dirX: 0,
            dirY: -1,
            duration: 1,
            sourceMass: 8,
            sourceBodyId: -1,
            originX: e.x + s.bx,
            originY: e.y + s.by + 60,
            flags: 0,
            params: {},
          };
          w.world.applyDamage(carapace, ev);
          m.step();
        }
      }
      const eyes = beh.openEyes;
      m.setSources(
        createScriptSource(parseScript('2:sig*60'), m.tick + 1),
        createScriptSource([], m.tick + 1),
      );
      const i0 = foe.view.integrityPct;
      for (let t = 0; t < 150; t++) m.step();
      return { eyes, dealt: i0 - foe.view.integrityPct };
    };
    const closed = gaze(false);
    const open = gaze(true);
    expect(closed.eyes).toBe(0);
    expect(open.eyes).toBeGreaterThanOrEqual(2);
    expect(closed.dealt).toBeGreaterThan(1);
    expect(open.dealt).toBeGreaterThan(closed.dealt * 1.3);
  });
  it('on KO the structure fails over 2–4 s: the halo drifts off, the arms fall, the eye goes out last', () => {
    const { m, w, beh } = witnessMatch();
    m.step();
    (w as unknown as { enterKo(): void }).enterKo();
    const halos = beh.rig.halo.length;
    let haloGoneAt = -1;
    let armsGoneAt = -1;
    let lightOutAt = -1;
    const regions = w.regions.length;
    for (let k = 1; k <= 240; k++) {
      m.step();
      const kinds = (beh as unknown as { regions: { kind: string; lost: boolean }[] }).regions;
      if (haloGoneAt < 0 && kinds.filter((r) => r.kind === 'halo' && r.lost).length === halos) haloGoneAt = k;
      if (armsGoneAt < 0 && kinds.filter((r) => r.kind === 'arm').every((r) => r.lost)) armsGoneAt = k;
      if (lightOutAt < 0 && beh.eyeLight <= 0) lightOutAt = k;
    }
    expect(haloGoneAt).toBeGreaterThan(60);
    expect(armsGoneAt).toBeGreaterThan(60);
    expect(lightOutAt).toBeGreaterThan(Math.max(haloGoneAt, armsGoneAt));
    expect(lightOutAt / 60).toBeGreaterThanOrEqual(2);
    expect(lightOutAt / 60).toBeLessThanOrEqual(4);
    expect(w.regions.length).toBeLessThan(regions);
  });

  it('a root that jumps hundreds of px carries the structure rigidly (nothing flung, nothing severed)', () => {
    const { m, w, beh } = witnessMatch();
    for (let k = 0; k < 10; k++) m.step();
    const regions = w.regions.length;
    w.px += 300;
    w.py -= 120;
    const rig = beh.rig.rig;
    // the tick of the jump: dragged through the joints the parts would leave at hundreds of px/s and rad/s
    m.step();
    let jumpW = 0;
    for (let i = 0; i < rig.n; i++) jumpW = Math.max(jumpW, Math.abs(rig.w[i]!));
    let jumpV = 0;
    for (let i = 0; i < rig.n; i++) jumpV = Math.max(jumpV, Math.hypot(rig.vx[i]!, rig.vy[i]!));
    for (let k = 0; k < 30; k++) m.step();
    expect(beh.jumps).toBeGreaterThanOrEqual(1);
    expect(jumpW).toBeLessThan(0.2);
    expect(jumpV).toBeLessThan(60);
    expect(w.regions.length).toBe(regions);
  });

  it('is deterministic (world + rig hashes)', () => {
    const run = (): number => {
      const { m, w } = witnessMatch(11);
      for (let t = 0; t < 120; t++) {
        w.ang.angle = Math.sin(t * 0.05) * 0.3;
        m.step();
      }
      return (m.world.hash() ^ w.stateHash(0)) >>> 0;
    };
    expect(run()).toBe(run());
  });

  it('the moves are deterministic (shards, sweeps, fracture marks, severs)', () => {
    const run = (): number => {
      const { m, w } = witnessMatch(5, 'asteroid');
      (m.fighters[1] as unknown as { px: number }).px = w.px + 130;
      w.debugSetMeter(1);
      m.setSources(
        createScriptSource(parseScript('4:strike,70:crush,160:sig*40,230:ult'), m.tick + 1),
        createScriptSource(parseScript('40:crush,120:strike'), m.tick + 1),
      );
      for (let t = 0; t < 320; t++) m.step();
      return (m.world.hash() ^ w.stateHash(0)) >>> 0;
    };
    expect(run()).toBe(run());
  });
});
