import { describe, expect, it } from 'vitest';
import {
  Btn,
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type DamageShape,
  type MatchConfig,
  type OverlapResult,
  type TitanId,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource, createAiSource } from '@/sim';
import { getTitanDef, mouthBossDef, mouthDef, isMouthDef, setMouthUnlocked, isMouthUnlocked } from '@/titans';
import { createAI } from '@/ai';
import { createFighter } from '../index';
import { MouthCore, type MouthStepOut } from './core';
import { MouthHurt } from './hurt';
import { arenaForMatch, mouthArena } from './arena';
import { MouthFighter } from './fighter';
import { MouthGeom } from './geom';

/**
 * The Mouth (D37): the crane against the locked oracle's beats (Gate 3B), the hurt capsules and damage model (3D), the
 * fighter in a real Match (3E), the boss variant and the unlock hook.
 */

const SCREEN = { minX: 0, maxX: 640, minY: 0, maxY: 360, restY: 180, softWall: 0 };
const out: MouthStepOut = { impact: null, coiling: false, ended: false };

/** The oracle's start: left wall middle, head at (300, 180), opp (470, 170), 30 warm-up steps. */
function oracleCore(grab: boolean | null = true): MouthCore {
  let s = 0x5a17c0de;
  const core = new MouthCore({
    arena: SCREEN,
    rand: () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    },
  });
  core.s = core.per - 180;
  core.oppX = 470;
  core.oppY = 170;
  core.oppR = 14;
  core.grabCheck = grab === null ? null : () => grab;
  core.hdX = 300;
  core.hdY = 180;
  for (let k = 0; k < 30; k++) core.step(1 / 60, out);
  return core;
}

/** Steps from the command until the beat whose impact fires (the oracle's frame numbers, Gate 3B). */
function stepsToImpact(move: 'bite' | 'sweep' | 'coil', v: number): number {
  const core = oracleCore();
  core.variant = v;
  core.begin(move);
  for (let i = 1; i < 300; i++) {
    core.step(1 / 60, out);
    if (out.impact) return i;
  }
  return -1;
}

describe('the Mouth: the crane against the locked oracle (Gate 3B)', () => {
  it('bites on the oracle frame for each height (straight 35, high 36, low 33 steps)', () => {
    // tools/mouth/parity.ts --feel=1 reads the oracle's own beats: bite@45 / 46 / 43 for a command at frame 10
    expect(stepsToImpact('bite', 0)).toBe(35);
    expect(stepsToImpact('bite', -1)).toBe(36);
    expect(stepsToImpact('bite', 1)).toBe(33);
  });

  it('sweeps and crushes on the oracle frames (sweep bite 49, crush 64 steps)', () => {
    expect(stepsToImpact('sweep', 0)).toBe(49);
    expect(stepsToImpact('coil', 0)).toBe(64);
  });

  it('a coil that grabs nothing skips coil and crush and recovers (Gate 3A §3)', () => {
    const core = oracleCore(false);
    core.begin('coil');
    const beats = new Set<string>();
    for (let i = 0; i < 200 && (i === 0 || core.move); i++) {
      core.step(1 / 60, out);
      beats.add(core.beat().name);
    }
    expect(beats.has('coil')).toBe(false);
    expect(beats.has('crush')).toBe(false);
    expect(beats.has('release')).toBe(true);
  });

  it('slides heavily along the perimeter and slower at a corner', () => {
    const core = oracleCore();
    const s0 = core.s;
    core.slideIn = 1;
    for (let i = 0; i < 30; i++) core.step(1 / 60, out);
    const early = core.sv;
    for (let i = 0; i < 120; i++) core.step(1 / 60, out);
    expect(early).toBeLessThan(core.sv); // it takes a moment to get going
    expect(core.sv).toBeLessThanOrEqual(243 + 1e-6);
    expect((core.s - s0 + core.per) % core.per > 200).toBe(true);
  });

  it('keeps the head out of its own coils (the keep-out band, Gate 3A §4)', () => {
    const core = oracleCore();
    // a foe hugging the wall right by the anchor: the idle head would tuck into the coils
    core.oppX = 20;
    core.oppY = 182;
    for (let i = 0; i < 240; i++) core.step(1 / 60, out);
    const p = core.keepOut(core.I.Hx, core.I.Hy);
    expect(Math.hypot(p[0]! - core.I.Hx, p[1]! - core.I.Hy)).toBeLessThan(1);
  });
});

describe('the Mouth: hurtboxes and damage (Gate 3A §2, §5; 3D)', () => {
  const probe = (h: MouthHurt, shape: DamageShape): OverlapResult =>
    h.probe(shape, { cells: 0, x: NaN, y: NaN, nearestX: NaN, nearestY: NaN, coverage: 0 });

  it('names the head, the neck and nothing beside them', () => {
    const core = oracleCore();
    const h = new MouthHurt();
    h.refresh(core);
    expect(probe(h, { kind: 'point', x: core.hdX, y: core.hdY, r: 10 }).cells).toBeGreaterThan(0);
    expect(h.hit.part).toBe('head');
    const nk = core.neck;
    const i = 6 * 4;
    expect(probe(h, { kind: 'point', x: nk[i]!, y: nk[i + 1]!, r: 6 }).cells).toBeGreaterThan(0);
    expect(h.hit.part).toBe('neck');
    expect(probe(h, { kind: 'point', x: 620, y: 20, r: 6 }).cells).toBe(0);
  });

  it('every hit chips the current jaw-ring; a ring breaks with its quarter', () => {
    const core = oracleCore();
    expect([0, 1, 2, 3].map((g) => core.ringHealth(g))).toEqual([1, 1, 1, 1]);
    core.hit('coil', 1, 0, 0);
    expect(core.dmg.ringGaps[0]!.length).toBe(1);
    while (core.dmg.hp > 74) core.hit('head', 1, 0, 0);
    expect(core.ringHealth(0)).toBe(0);
    expect(core.ringHealth(1)).toBeGreaterThan(0.9);
  });

  it('a stretched neck takes ×1.6 (the punish window)', () => {
    const a = oracleCore();
    const lostRest = a.hit('neck', 1, 0.5, 0);
    const b = oracleCore();
    b.begin('bite');
    while (!b.stretched()) b.step(1 / 60, out);
    const lostStretched = b.hit('neck', 1, 0.5, 0);
    expect(lostStretched / lostRest).toBeCloseTo(1.6, 5);
  });

  it('three cut strands at the knockout sever the head; otherwise it is dragged back', () => {
    const drag = oracleCore();
    while (!drag.dmg.ko) drag.hit('head', 2, 0, 0);
    expect(drag.dmg.ko!.type).toBe('drag');
    const sev = oracleCore();
    for (let k = 0; k < 40 && !sev.dmg.ko; k++) sev.hit('neck', 2, 0.6, 0);
    expect(sev.dmg.ko).not.toBeNull();
    if (sev.dmg.severF.filter((f) => f < 1).length >= 3) expect(sev.dmg.ko!.type).toBe('sever');
  });

  it('the boss has twice the health and an enraged last ring', () => {
    const b = new MouthCore({ arena: SCREEN, boss: true, rand: () => 0.5 });
    expect(b.dmg.hpMax).toBe(200);
    expect(b.enraged()).toBe(false);
    b.dmg.hp = 40;
    expect(b.enraged()).toBe(true);
    expect(mouthBossDef().art.params['boss']).toBe(true);
    expect(isMouthDef(mouthBossDef())).toBe(true);
  });
});

describe('the Mouth in the game (3E)', () => {
  it('is a locked boss: built on request, unlocked by the hook', () => {
    expect(getTitanDef('mouth').id).toBe('mouth');
    expect(mouthDef().unboundSlots).toEqual(['surge', 'guard', 'ultimate']);
    expect(isMouthUnlocked()).toBe(false);
    setMouthUnlocked(true, false);
    expect(isMouthUnlocked()).toBe(true);
    setMouthUnlocked(false, false);
  });

  it('plays in arena B: the stage width, 360 px tall', () => {
    const a = mouthArena(DEFAULT_ARENA);
    expect(a.maxY - a.minY).toBe(360);
    expect(a.maxX - a.minX).toBe(DEFAULT_ARENA.maxX - DEFAULT_ARENA.minX);
    expect(arenaForMatch(DEFAULT_ARENA, ['planet', 'asteroid'])).toBe(DEFAULT_ARENA);
  });

  const play = (foe: TitanId, ticks: number, ai: boolean): { hash: number; dealt: number; taken: number } => {
    const cfg: MatchConfig = {
      seed: 11,
      stage: 'nursery',
      mode: 'aivai',
      footwork: 'orbit',
      slots: [
        { titan: 'mouth', controller: 'ai', aiLevel: 4 },
        { titan: foe, controller: 'ai', aiLevel: 4 },
      ],
    };
    const m = createMatch(cfg, {
      createWorld: createMatterWorld,
      createFighter,
      getTitanDef,
      arena: arenaForMatch(DEFAULT_ARENA, ['mouth', foe]),
      lighting: DEFAULT_LIGHTING,
    });
    if (ai)
      m.setSources(
        createAiSource(m, 0, createAI(4, getTitanDef('mouth'), 1)),
        createAiSource(m, 1, createAI(4, getTitanDef(foe), 2)),
      );
    else
      m.setSources(
        createScriptSource(
          [0, 60, 120, 200].map((t, i) => ({
            tick: t,
            buttons: [Btn.STRIKE, Btn.CRUSH, Btn.SIGNATURE, Btn.STRIKE][i]!,
            hold: 2,
            moveX: 0,
            moveY: 0,
            moveTicks: 0,
          })),
          120,
        ),
        null,
      );
    let dealt = 0;
    let taken = 0;
    for (let i = 0; i < ticks; i++) {
      m.step();
      for (const e of m.events)
        if (e.t === 'hit') {
          if (e.attacker === 0) dealt++;
          else taken++;
        }
      const v = m.fighters[0].view;
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    }
    expect(m.fighters[0]).toBeInstanceOf(MouthFighter);
    return { hash: m.hash(), dealt, taken };
  };

  it('bites a foe in a real match (scripted), deterministically', () => {
    const a = play('planet', 600, false);
    const b = play('planet', 600, false);
    expect(a.dealt).toBeGreaterThan(0);
    expect(a.hash).toBe(b.hash);
  });

  it('fights the AI and is fought by it (both sides land blows)', () => {
    const r = play('asteroid', 2400, true);
    expect(r.dealt).toBeGreaterThan(0);
    expect(r.taken).toBeGreaterThan(0);
  });

  it('lays itself out for the GPU within the draw list budget', () => {
    const core = oracleCore();
    const g = new MouthGeom();
    const L = g.build(core, { sky: 1, tell: true });
    expect(L.nTubes).toBeGreaterThan(500);
    expect(L.nTubes).toBeLessThan(6000);
    expect(L.nStamps).toBeGreaterThan(500);
    expect(L.nAnn).toBe(7);
    for (let i = 0; i < L.nTubes * 16; i++) expect(Number.isFinite(L.tubes[i]!)).toBe(true);
  });
});

describe('debris against the Mouth (setCapsules, Gate 3A §2)', () => {
  it('a fast chunk bounces off a capsule and queues an impact for its owner', () => {
    const w = createMatterWorld(3);
    w.setArena(DEFAULT_ARENA);
    w.setCapsules!(1, [700, 300, 900, 300, 30, 2], 1);
    const px = new Uint32Array(36).fill(0xff808080);
    const id = w.spawnChunk({ pixels: px, w: 6, h: 6, x: 800, y: 200, vx: 0, vy: 600, spin: 0, mass: 8 });
    const st = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      spin: 0,
      mass: 0,
      radius: 0,
      mode: 0,
      owner: 0,
      origin: 0,
      temp: 0,
    };
    let bounced = false;
    for (let i = 0; i < 40; i++) {
      w.tick();
      w.chunkState(id, st);
      if (st.vy < 0) bounced = true;
    }
    expect(bounced).toBe(true);
    const hits: number[] = [];
    expect(w.drainCapsuleHits!(1, hits)).toBeGreaterThan(0);
    expect(hits[3]).toBe(2);
  });
});
