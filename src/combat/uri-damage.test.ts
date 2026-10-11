import { describe, expect, it } from 'vitest';
import {
  ANALYTIC_PACE_EXP,
  ANGLE_STEPS,
  DEFAULT_ARENA,
  ROUND_LENGTH_PACE,
  DEFAULT_LIGHTING,
  parseScript,
  type BlowWeight,
  type DamageEvent,
  type MatchConfig,
  type MatterBody,
  type RenderLayer,
  type TitanId,
} from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef, URI_ID, URI_MATERIALS, uriDef } from '@/titans';
import { URI_ORDER, type UriPartKey } from '@/titans/uri/rig';
import { createFighter } from './index';
import type { FighterImpl } from './fighter';
import { URI_HIT_POWER, uriNeckCells, type UriBehaviour } from './behaviours/uri';
import { makeDamageSum } from './damageSum';
import { skipIntro } from './testing/harness';

/** Gate 2C: 우리's damage and breaking (URI_SPEC §7, TUNING "Damage", the oracle's 30_breaking_compose.js). */

const HAB = URI_MATERIALS.findIndex((m) => m.key === 'habitat') + 1;
const CRK = URI_MATERIALS.findIndex((m) => m.key === 'crack') + 1;

function uriMatch(dx = 260, seed = 7): { m: Match; u: FighterImpl; beh: UriBehaviour; w: MatterWorldEx } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: URI_ID, controller: 'human' },
      { titan: 'planet', controller: 'human' },
    ],
    // the oracle's numbers (the loop loses 3 × power a blow) hold at D34's pace, ROUND LENGTH Short (S11); the longer
    // lengths scale them (the first test below)
    pace: ROUND_LENGTH_PACE.short,
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef: (id: TitanId) => (id === URI_ID ? uriDef() : getTitanDef(id)),
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  const u = m.fighters[0] as FighterImpl;
  const foe = m.fighters[1] as unknown as { px: number; py: number };
  foe.px = u.px + dx;
  foe.py = u.py;
  for (let k = 0; k < 4; k++) m.step();
  return { m, u, beh: u.behaviour as unknown as UriBehaviour, w: m.world as MatterWorldEx };
}

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World centre of a body's map cell (its transform: anchor, rotation step). */
function cellWorld(b: MatterBody, i: number): [number, number] {
  const t = b.transform;
  const x = (i % b.map.w) + 0.5 - t.anchorX;
  const y = Math.floor(i / b.map.w) + 0.5 - t.anchorY;
  const a = ((t.rot ?? 0) * 2 * Math.PI) / ANGLE_STEPS;
  return [t.x + x * Math.cos(a) - y * Math.sin(a), t.y + x * Math.sin(a) + y * Math.cos(a)];
}

function liveCells(b: MatterBody): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.map.material.length; i++) if (b.map.material[i]) out.push(i);
  return out;
}

function woundCells(b: MatterBody): number {
  let n = 0;
  for (const v of b.map.material) if (v === HAB || v === CRK) n++;
  return n;
}

/** A blow of `weight` at world (x, y), routed by the behaviour as the fighter would. */
function blow(beh: UriBehaviour, x: number, y: number, weight: BlowWeight): ReturnType<typeof makeDamageSum> {
  const ev: DamageEvent = {
    type: 'KINETIC',
    shape: { kind: 'point', x, y, r: 3 },
    energy: 400,
    dirX: 1,
    dirY: 0,
    duration: 1,
    sourceMass: 4,
    sourceBodyId: -1,
    originX: x,
    originY: y,
    flags: 0,
    params: {},
    weight,
  };
  const out = makeDamageSum();
  expect(beh.routeDamage(ev, out)).toBe(true);
  return out;
}

const front = (
  u: FighterImpl,
): RenderLayer & { uriLive?: { hotX: number; hotY: number; coldX: number; hp: number } } =>
  u.renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 1).find((L) => L.id.startsWith('uri-front'))!;

describe('우리 damage and breaking (Gate 2C)', () => {
  it('the loop pays less a blow at the longer ROUND LENGTHs: × (pace / Short pace) ^ 0.7 (S11)', () => {
    for (const pace of [ROUND_LENGTH_PACE.normal, ROUND_LENGTH_PACE.long]) {
      const { u, beh } = uriMatch();
      u.pace = pace;
      const b = beh.bodyOf('chamber');
      const [x, y] = cellWorld(b, liveCells(b)[0]!);
      blow(beh, x, y, 'heavy');
      const k = Math.pow(pace / ROUND_LENGTH_PACE.short, ANALYTIC_PACE_EXP);
      expect(beh.loop).toBeCloseTo(100 - 3 * URI_HIT_POWER.heavy * k, 9);
    }
  });

  it('20 random hits tear chunks off and leave glowing wounds that ride the moving parts; the loop loses 3 × power each', () => {
    const { m, u, beh, w } = uriMatch();
    const rnd = mulberry(2024);
    const keys: UriPartKey[] = ['chamber', 'domeL', 'domeR', 'uaL', 'uaR', 'faL', 'faR', 'pelvis', 'moon'];
    const wounds0 = new Map(URI_ORDER.map((k) => [k, woundCells(beh.bodyOf(k))]));
    const chunks0 = w.core.chunks.count;
    let removed = 0;
    let hp = 100;
    m.setSources(
      createScriptSource(parseScript('2:strike 60:crush'), m.tick + 1),
      createScriptSource([], m.tick + 1),
    );
    for (let h = 0; h < 20; h++) {
      const k = keys[Math.floor(rnd() * keys.length)]!;
      if (beh.isLost(k)) continue;
      const b = beh.bodyOf(k);
      const live = liveCells(b);
      const [x, y] = cellWorld(b, live[Math.floor(rnd() * live.length)]!);
      const out = blow(beh, x, y, 'medium');
      removed += out.cellsRemoved;
      hp -= 3 * URI_HIT_POWER.medium;
      expect(beh.loop).toBeCloseTo(hp, 9);
      for (let s = 0; s < 3; s++) m.step(); // the parts move between hits (a strike, then a crush)
    }
    expect(beh.brokenApart).toBe(false);
    expect(removed).toBeGreaterThan(200);
    expect(w.core.chunks.count - chunks0).toBeGreaterThanOrEqual(20);
    let newWounds = 0;
    for (const k of URI_ORDER) if (!beh.isLost(k)) newWounds += woundCells(beh.bodyOf(k)) - wounds0.get(k)!;
    expect(newWounds).toBeGreaterThan(20);
    // the wounds are in the parts' own matter: they move with them and stay lit
    const before = new Map(URI_ORDER.map((k) => [k, beh.isLost(k) ? 0 : woundCells(beh.bodyOf(k))]));
    for (let s = 0; s < 60; s++) m.step();
    // (a few may be chipped by the debris flying off: matter, not the behaviour)
    for (const k of URI_ORDER)
      if (!beh.isLost(k)) expect(woundCells(beh.bodyOf(k)), k).toBeGreaterThanOrEqual(before.get(k)! * 0.95);
    // the HUD's integrity is the loop
    expect(u.view.integrityPct).toBeCloseTo(hp, 9);
  });

  it('a severed wrist neck: the fist drifts away whole, as one piece', () => {
    const { m, beh, w } = uriMatch();
    const fist = beh.bodyOf('fistR');
    const neck = uriNeckCells('fistR', fist.map)!;
    expect(neck.length).toBeGreaterThan(50);
    // cut the neck (no blow: the cells go as one piece of their own)
    const cut = Int32Array.from(Array.from(neck).filter((_, i) => i % 3 !== 0));
    expect(w.tearCells(fist.id, cut, cut.length, 0, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(w.liveFraction(fist.id, neck)).toBeLessThan(0.38);
    const mass = w.stats(fist.id).mass;
    const ids0 = new Set(w.core.chunks.list.filter((c) => c.alive).map((c) => c.id));
    // a light blow on the fist away from the wrist: the struck chunk tears, then the neck gives
    const live = liveCells(fist).filter((i) => !neck.includes(i));
    const [x, y] = cellWorld(fist, live[live.length >> 1]!);
    blow(beh, x, y, 'light');
    expect(beh.isLost('fistR')).toBe(true);
    expect(beh.isLost('faR')).toBe(false);
    expect(w.getBody(fist.id)).toBeUndefined();
    // the struck chunk and its neighbours (power 1.1 > 1: up to 2.2 chunks, the oracle's hitAt) and ONE piece for the rest
    const made = w.core.chunks.list.filter((c) => c.alive && !ids0.has(c.id));
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(made.length).toBeLessThanOrEqual(3);
    const whole = made.reduce((a, c) => (c.mass > a.mass ? c : a));
    expect(whole.mass).toBeGreaterThan(mass * 0.7);
    // it drifts slowly (the oracle: |vx| ≤ 0.6, vy 0.3–0.6 px a frame) and downward
    expect(Math.abs(whole.vx)).toBeLessThanOrEqual(36 + 1e-9);
    expect(whole.vy).toBeGreaterThanOrEqual(18 - 1e-9);
    expect(whole.vy).toBeLessThanOrEqual(36 + 1e-9);
    const y0 = whole.y;
    for (let s = 0; s < 30; s++) m.step();
    expect(whole.y).toBeGreaterThan(y0);
  });

  it('loop 0 breaks it apart: every part flies into its chunks around the two cores, which stay where they were', () => {
    const { m, u, beh, w } = uriMatch();
    (beh as unknown as { kin: { hp: number } }).kin.hp = 2;
    const L0 = front(u).uriLive!;
    const hot0: [number, number] = [L0.hotX, L0.hotY];
    const chunks0 = w.core.chunks.count;
    const b = beh.bodyOf('chamber');
    const [x, y] = cellWorld(b, liveCells(b)[100]!);
    blow(beh, x, y, 'heavy');
    expect(beh.loop).toBe(0);
    expect(beh.brokenApart).toBe(true);
    for (let s = 0; s < 12; s++) m.step();
    for (const k of URI_ORDER) if (k !== 'pelvis') expect(beh.isLost(k), k).toBe(true);
    expect(w.stats(u.body.id).cells).toBe(0);
    expect(w.core.chunks.count - chunks0).toBeGreaterThan(100);
    expect(u.ko).toBe(true);
    // the cores never leave their place (the fighter's root tumbles away under them)
    const L1 = front(u).uriLive!;
    expect(L1.hotX).toBeCloseTo(hot0[0], 0);
    expect(L1.hotY).toBeCloseTo(hot0[1], 0);
    expect(L1.hp).toBe(0);
  });

  it('the cores never change sides, whatever side the opponent is on and through every move', () => {
    for (const dx of [260, -260]) {
      const { m, u } = uriMatch(dx);
      const side0 = Math.sign(front(u).uriLive!.hotX - front(u).uriLive!.coldX);
      expect(side0).not.toBe(0);
      m.setSources(
        createScriptSource(parseScript('2:strike 70:crush 150:signature 260:ultimate'), m.tick + 1),
        createScriptSource([], m.tick + 1),
      );
      for (let t = 0; t < 420; t++) {
        m.step();
        const L = front(u).uriLive!;
        expect(Math.sign(L.hotX - L.coldX)).toBe(side0);
      }
    }
  });

  it('is deterministic through hits, a neck failure and the break-apart (world + behaviour hash)', () => {
    const run = (): number => {
      const { m, u, beh } = uriMatch(240, 11);
      const rnd = mulberry(5);
      for (let h = 0; h < 40 && !beh.brokenApart; h++) {
        const k = (['fistL', 'faL', 'uaL', 'chamber', 'moon', 'pyR'] as UriPartKey[])[Math.floor(rnd() * 6)]!;
        if (beh.isLost(k)) continue;
        const b = beh.bodyOf(k);
        const live = liveCells(b);
        const [x, y] = cellWorld(b, live[Math.floor(rnd() * live.length)]!);
        blow(beh, x, y, 'heavy');
        m.step();
      }
      for (let t = 0; t < 30; t++) m.step();
      return (m.world.hash() ^ u.stateHash(0)) >>> 0;
    };
    expect(run()).toBe(run());
  });
});
