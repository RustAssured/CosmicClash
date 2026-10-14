import { describe, expect, it } from 'vitest';
import type { AudioEvent, AudioScene, SimEvent, TitanId } from '@/contracts';
import { TITAN_IDS } from '@/contracts';
import { clamp, clamp01 } from './dsp/math';
import { createAudioEngine, sanitizeEvent, sanitizeScene } from './engine';
import { LIMITER_CEILING, LimiterCore } from './worklets/limiter';
import {
  FakeAnalyser,
  FakeBufferSource,
  FakeContext,
  FakeGain,
  FakeNode,
  FakeOsc,
  asBase,
  takeViolations,
} from './testing/fakeContext';

/**
 * "Audio disappears after certain heavy moves (ultimates, catastrophic blows), then comes back later, or never" (WJ, Edge on a
 * Ryzen 5 5500U). What was found, and what these tests pin down:
 *
 *  0. THE AUDIO THREAD FELL BEHIND REAL TIME (measured with this engine in real-time Edge on the target laptop): a beam ultimate
 *     (one 'hit' slice per 5 ticks, all flagged heavy, each voiced with the full heavy chain: ~190 nodes, 15 source-seconds)
 *     ran the audio clock at 7–33 % of real time, an ultimate's burst at ~30–45 %. A late audio thread is an output that
 *     underruns (silence), and every tail then lasts 3–10× longer in wall time: a 3 s beam muted the game for ~8 s. → light
 *     slices throttled and never heavy, `crackle` granular (4 nodes instead of 5 per grain), a per-batch cap, and the LOAD
 *     GOVERNOR (`watchLoad`) that sheds new sounds while the audio clock runs slow.
 *  1. In Chromium ONE non-finite sample poisons a BiquadFilterNode for good (measured in headless Edge: a single NaN or Infinity
 *     sample into a 50 Hz high-pass, and every sample after it is NaN; a ConvolverNode stays NaN for its impulse response). The
 *     master's output high-pass, laptop EQ and weight stage are biquads: one bad sample anywhere in the mix = the game is mute
 *     until reload. The engine had no way back. → the GUARD (`watch` / `recover` in engine.ts, the limiter's report).
 *  2. Non-finite numbers from the game reached the voices: `clamp`/`clamp01` passed NaN straight through (`NaN < 0` and
 *     `NaN > 1` are both false), so a NaN position or amount became an AudioParam value, which throws half-way through a sound;
 *     in `update()` the throw escaped into the game's frame and skipped the score and the guard, and a NaN dt or intensity stuck
 *     in the score's and the bed's smoothing for good (the score silent for the rest of the session).
 *  3. The duck cancelled its own restore before computing the new values: a throw in between left the bed down.
 */

const SLOTS = [0, 1] as const;
/** Every cue id the sim emits (src/combat/**), plus ids of the newer titans' voices and a few keyword shapes. */
const CUE_IDS = [
  'node-dark',
  'harvest',
  'chain-latch',
  'chain-snap',
  'eye-exposed',
  'tendril-sever',
  'break-apart',
  'fuel-burn',
  'layer-blow',
  'collapse',
  'disk-shed',
  'consume',
  'hawking',
  'rubble-pile',
  'momentum',
  'fragment-lost',
  'moon-shatter',
  'moon-lost',
  'core-pulse',
  'crust-crack',
  'comet-call',
  'comet-sling',
  'comet-capture',
  'comet-spent',
  'comet-impact',
  'ring-capture',
  'ring-throw',
  'atmo-vent',
  'moons-drift',
  'crust-slab',
  'crust-armor',
  'core-out',
  'atmo-strip',
  'ocean-boil',
  'world-phase-2',
  'world-phase-3',
  'world-phase-4',
  'grab',
  'escape',
  'ring-break',
  'strand-sever',
  'cord-strain',
  'cord-sever',
  'cord-regrow',
  'false-birth',
  'false-birth-torn',
  'wrong-growth',
  'pseudo-organ',
  'loop-snap',
  'limb-shed',
  'crush',
] as const;
/** The inputs no game number should ever be, and some it might: zero, huge, negative, NaN, ±Infinity, denormal-small. */
const EXTREMES = [0, 1e9, -1e9, NaN, Infinity, -Infinity, 1e-30] as const;

/** One heavy burst for `titan` with every number set to `v`: ultimates, every heavy cue, catastrophic blows, KO, rings, matter. */
function burst(titan: TitanId, v: number): SimEvent[] {
  const ev: SimEvent[] = [];
  for (const slot of SLOTS) {
    ev.push({ t: 'ultimate', slot, titan, phase: 'start', x: v, y: v });
    for (const id of CUE_IDS) ev.push({ t: 'cue', slot, titan, id, x: v, y: v, amount: v });
    for (const moveSlot of ['crush', 'ultimate', 'signature'] as const) {
      ev.push({ t: 'move', slot, titan, moveId: `${titan}.x`, moveSlot, aim: 'forward', x: v, y: v });
      ev.push({ t: 'release', slot, titan, moveId: `${titan}.x`, moveSlot, x: v, y: v, power: v });
      for (const phase of ['start', 'hold', 'release'] as const)
        ev.push({ t: 'charge', slot, titan, moveId: `${titan}.x`, frac: v, phase });
    }
    ev.push({ t: 'surge', slot, titan, x: v, y: v, dirX: v, dirY: v });
    ev.push({ t: 'guard', slot, x: v, y: v, type: 'CRUSH', broke: true });
    for (const kind of [
      'detach',
      'ignite',
      'crack',
      'consume',
      'harvest',
      'impact',
      'evaporate',
      'boil',
    ] as const)
      ev.push({ t: 'matter', kind, x: v, y: v, mass: v, slot });
    ev.push({ t: 'resource', slot, kind: 'break', amount: v });
    ev.push({ t: 'ultimate', slot, titan, phase: 'end', x: v, y: v });
  }
  for (const type of ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'] as const)
    ev.push({
      t: 'hit',
      attacker: 0,
      target: 1,
      titan,
      x: v,
      y: v,
      dirX: v,
      dirY: v,
      type,
      energy: v,
      cellsRemoved: v,
      massRemoved: v,
      blocked: v,
      heavy: true,
      onDamaged: v,
    });
  ev.push({ t: 'shockwave', x: v, y: v, strength: v, radius: v, hue: v });
  ev.push({ t: 'hazard', kind: 'comet-enter', id: 1, x: v, y: v, vx: v, vy: v });
  ev.push({ t: 'timescale', scale: v, ticks: 4 });
  ev.push({ t: 'ko', slot: 1, x: v, y: v });
  return ev;
}

const sceneOf = (a: TitanId, b: TitanId, v = 0.5, x = 800): AudioScene => ({
  phase: 'fight',
  stage: 'nursery',
  intensity: v,
  listenerX: x,
  lowestIntegrity: v,
  timeScale: v,
  fighters: [
    { titan: a, x, speed: v, massFrac: v, charge: v, resource: v, meter: v, state: 'charge' },
    { titan: b, x, speed: v, massFrac: v, charge: v, resource: v, meter: v, state: 'active' },
  ],
});

const normalHit: AudioEvent = {
  t: 'hit',
  attacker: 0,
  target: 1,
  titan: 'asteroid',
  x: 800,
  y: 300,
  dirX: 1,
  dirY: 0,
  type: 'KINETIC',
  energy: 900,
  cellsRemoved: 40,
  massRemoved: 12,
  blocked: 0,
  heavy: false,
  onDamaged: 0,
};

async function ready(seed = 3): Promise<{ eng: ReturnType<typeof createAudioEngine>; ctx: FakeContext }> {
  const ctx = new FakeContext();
  const eng = createAudioEngine({ context: asBase(ctx), seed });
  await eng.unlock();
  takeViolations();
  return { eng, ctx };
}

/** Does `from` reach the speakers? */
function reaches(from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const o of from.outputs) if (o instanceof FakeNode && reaches(o, to, seen)) return true;
  return false;
}

/** Sources started and given no stop (they would play forever), among `nodes`. */
const unstopped = (nodes: FakeNode[]): FakeNode[] =>
  nodes.filter((n) => (n instanceof FakeOsc || n instanceof FakeBufferSource) && n.started && !n.stopped);

/** The bus gains every impact passes on its way out (the sfx fader, the master), and the bed's duck. */
function buses(
  eng: ReturnType<typeof createAudioEngine>,
  ctx: FakeContext,
): { sfx: FakeGain; duck: FakeGain; master: FakeGain } {
  const taps = eng.taps()!;
  const sfx = taps.sfx as unknown as FakeGain;
  const duck = taps.music as unknown as FakeGain;
  // the master fader is the gain whose output is the limiter (the fake has no AudioWorklet: a 4× oversampled shaper)
  const master = ctx.nodes.find(
    (n): n is FakeGain =>
      n instanceof FakeGain &&
      [...n.outputs].some(
        (o) =>
          o instanceof FakeNode &&
          o.kind === 'waveshaper' &&
          (o as unknown as { oversample: string }).oversample === '4x',
      ),
  )!;
  return { sfx, duck, master };
}

/** A normal blow after the storm is audible: it builds sources, they reach the speakers, and every bus gain on the way is up. */
function expectAudible(eng: ReturnType<typeof createAudioEngine>, ctx: FakeContext, when: number): void {
  const before = ctx.nodes.length;
  eng.handleAt([normalHit], when);
  const built = ctx.nodes.slice(before);
  const sources = built.filter((n) => n instanceof FakeOsc || n instanceof FakeBufferSource);
  expect(sources.length).toBeGreaterThan(3);
  expect(sources.some((s) => reaches(s, ctx.destination))).toBe(true);
  const { sfx, duck, master } = buses(eng, ctx);
  for (const p of [sfx.gain, master.gain]) {
    const v = p.valueAt(when + 0.05);
    expect(Number.isFinite(v) && v > 0.05, `${p.name} at ${v}`).toBe(true);
  }
  expect(Number.isFinite(duck.gain.valueAt(when + 0.05))).toBe(true);
}

describe('NaN stops at the clamps', () => {
  it('clamp and clamp01 map NaN to the low end (they passed it through before: NaN < lo and NaN > hi are both false)', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp(NaN, -1, 1)).toBe(-1);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp(-Infinity, 2, 3)).toBe(2);
    for (const v of [-2, -0.5, 0, 0.3, 1, 7]) {
      expect(clamp01(v)).toBe(v < 0 ? 0 : v > 1 ? 1 : v);
      expect(clamp(v, -1, 1)).toBe(v < -1 ? -1 : v > 1 ? 1 : v);
    }
  });
  it('the event and scene sanitisers replace only non-finite numbers, and copy only when they must', () => {
    const ok = { t: 'cue', slot: 0, titan: 'uri', id: 'break-apart', x: 10, y: 2, amount: 1 } as const;
    expect(sanitizeEvent(ok, 800)).toBe(ok);
    const bad = sanitizeEvent({ ...ok, x: NaN, amount: Infinity }, 800);
    expect(bad).toEqual({ ...ok, x: 800, amount: 0 });
    const s = sceneOf('uri', 'planet');
    expect(sanitizeScene(s)).toBe(s);
    const n = sanitizeScene(sceneOf('uri', 'planet', NaN, NaN));
    expect(n.intensity).toBe(0);
    expect(n.timeScale).toBe(1);
    expect(n.fighters![0].massFrac).toBe(1);
    expect(Number.isFinite(n.fighters![1].x)).toBe(true);
  });
});

describe('reproductions (each failed before the fix)', () => {
  it('a NaN position or amount on an ultimate / heavy cue no longer throws half-way through the sound (AudioParam rejects it)', async () => {
    // before: e.g. "blackhole ultimate: pan.setValueAtTime value must be finite, got NaN", "supernova cue: gain.linearRamp time
    // must be finite", "nexus cue harvest: frequency.exponentialRamp time must be finite" (and the fake did not yet check
    // `.value =`, which the real AudioParam rejects too: makeOut's pan.value = clamp(NaN) threw on every sound)
    for (const titan of TITAN_IDS as readonly TitanId[]) {
      const { eng } = await ready();
      // one event per second, so neither the polyphony cap nor the per-batch cap hides a handler
      let t = 1;
      for (const v of [NaN, Infinity, -Infinity]) for (const e of burst(titan, v)) eng.handleAt([e], t++);
      expect(takeViolations(), titan).toEqual([]);
    }
  });
  it('a NaN in the scene (or dt) no longer throws out of update() nor sticks in the score: the score keeps playing', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(sceneOf('cradle', 'supernova'), 1 / 60, 0.2);
    for (let i = 0; i < 30; i++) {
      ctx.currentTime += 1 / 60;
      expect(() =>
        eng.updateAt(sceneOf('cradle', 'supernova', NaN, NaN), NaN, ctx.currentTime + 0.15),
      ).not.toThrow();
    }
    expect(takeViolations()).toEqual([]);
    // back to sane numbers: the score still schedules (a sticky NaN intensity made stepSeconds NaN: nothing ever again)
    const before = ctx.nodes.length;
    for (let i = 0; i < 120; i++) {
      ctx.currentTime += 1 / 60;
      eng.updateAt(sceneOf('cradle', 'supernova', 0.9), 1 / 60, ctx.currentTime + 0.15);
    }
    expect(ctx.nodes.length - before).toBeGreaterThan(20);
    expect(takeViolations()).toEqual([]);
  });
  it('overlapping and interrupted ducks always come back up: the bed is at full level once the last hold is over', async () => {
    const { eng, ctx } = await ready();
    const { duck } = buses(eng, ctx);
    const heavy = { ...normalHit, energy: 6000, heavy: true } as AudioEvent;
    // a heavy blow, a KO hush inside it, a lighter blow inside the hush, a big ring, then another heavy blow at the same instant
    eng.handleAt([heavy], 1);
    eng.handleAt([{ t: 'ko', slot: 1, x: 800, y: 300 }], 1.1);
    eng.handleAt([heavy], 1.2);
    eng.handleAt([{ t: 'shockwave', x: 800, y: 300, strength: 1, radius: 400, hue: 0 }, heavy, heavy], 1.25);
    // the duck is down while it should be…
    expect(duck.gain.valueAt(1.3)).toBeLessThan(0.5);
    // …and back near 1 well after the longest hold (KO_HUSH_SEC 1.6 s, slow 0.5 s return)
    expect(duck.gain.valueAt(6)).toBeGreaterThan(0.95);
    expect(takeViolations()).toEqual([]);
  });
  it('a 500 ms stall: events scheduled in the past of the audio clock build valid automation and the bed still comes back', async () => {
    const { eng, ctx } = await ready();
    const s = sceneOf('blackhole', 'uri');
    eng.updateAt(s, 1 / 60, 0.2);
    for (let k = 0; k < 4; k++) {
      // the main thread froze for 500 ms: the clock ran on, and a backlog of ticks lands at once at a time already gone
      const stale = ctx.currentTime;
      ctx.currentTime += 0.5;
      eng.handleAt(burst('blackhole', 1), stale);
      eng.handleAt(burst('uri', 1), stale + 0.005);
      eng.updateAt(s, 0.5, ctx.currentTime + 0.15);
    }
    expect(takeViolations()).toEqual([]);
    const { duck } = buses(eng, ctx);
    expect(duck.gain.valueAt(ctx.currentTime + 4)).toBeGreaterThan(0.95);
  });
});

describe('the guard: a poisoned or dead output is rebuilt', () => {
  it('NaN on the master (a biquad gone NaN) rebuilds the graph: old graph off the speakers, a normal blow audible again', async () => {
    const { eng, ctx } = await ready();
    const s = sceneOf('lastone', 'planet');
    eng.updateAt(s, 1 / 60, 0.2);
    const oldOut = [...ctx.destination.inputs];
    expect(oldOut).toHaveLength(1);
    // the mix and the output go NaN, as they do in Chromium when one NaN sample reaches the master's high-pass
    for (const a of ctx.nodes.filter((n): n is FakeAnalyser => n instanceof FakeAnalyser))
      a.feed = (b) => b.fill(NaN);
    ctx.currentTime += 1 / 60;
    eng.updateAt(s, 1 / 60, ctx.currentTime + 0.15);
    expect(eng.recoveryCount).toBe(1);
    // the old output is gone from the speakers, a new chain is there
    const newOut = [...ctx.destination.inputs];
    expect(newOut).toHaveLength(1);
    expect(newOut[0]).not.toBe(oldOut[0]);
    // the beds and the score start over on the new buses
    ctx.currentTime += 1 / 60;
    eng.updateAt(s, 1 / 60, ctx.currentTime + 0.15);
    expectAudible(eng, ctx, ctx.currentTime + 0.01);
    expect(takeViolations()).toEqual([]);
    // rate-limited: the NaN windows of the OLD analysers are not read again, and the new ones are clean
    ctx.currentTime += 1 / 60;
    eng.updateAt(s, 1 / 60, ctx.currentTime + 0.15);
    expect(eng.recoveryCount).toBe(1);
  });
  it('a silent output under a live mix (a dead limiter, a gain stuck at 0) is rebuilt after ~0.75 s of frames, not before', async () => {
    const { eng, ctx } = await ready();
    const s = sceneOf('nexus', 'cradle');
    eng.updateAt(s, 1 / 60, 0.2);
    const an = ctx.nodes.filter((n): n is FakeAnalyser => n instanceof FakeAnalyser);
    // build order: the pre-dynamics analyser first, then the output's
    an[0]!.feed = (b) => b.fill(0.2);
    for (let i = 0; i < 30; i++) {
      ctx.currentTime += 1 / 60;
      eng.updateAt(s, 1 / 60, ctx.currentTime + 0.15);
    }
    expect(eng.recoveryCount).toBe(0);
    for (let i = 0; i < 30; i++) {
      ctx.currentTime += 1 / 60;
      eng.updateAt(s, 1 / 60, ctx.currentTime + 0.15);
    }
    expect(eng.recoveryCount).toBe(1);
    expectAudible(eng, ctx, ctx.currentTime + 0.01);
    // a muted master is a choice, not a fault
    const q = await ready();
    q.eng.setVolumes({ master: 0 });
    q.eng.updateAt(s, 1 / 60, 0.2);
    q.ctx.nodes.filter((n): n is FakeAnalyser => n instanceof FakeAnalyser)[0]!.feed = (b) => b.fill(0.2);
    for (let i = 0; i < 120; i++) {
      q.ctx.currentTime += 1 / 60;
      q.eng.updateAt(s, 1 / 60, q.ctx.currentTime + 0.15);
    }
    expect(q.eng.recoveryCount).toBe(0);
  });
});

describe('the limiter never passes, nor keeps, a non-finite sample', () => {
  const phases = [
    [0, 0, 1, 0, 0],
    [0.1, -0.2, 0.9, 0.3, -0.1],
  ];
  it('NaN / ±Infinity in: silence out for that sample, counted, and the very next samples are limited normally', () => {
    const lim = new LimiterCore(2, 48000, 0.0025, LIMITER_CEILING, 0.12, phases);
    const n = 4800;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(i / 7);
    x[1000] = NaN;
    x[1001] = Infinity;
    x[2000] = -Infinity;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    lim.process([x, x], [outL, outR], n);
    for (const v of outL) expect(Number.isFinite(v)).toBe(true);
    expect(lim.takeBad()).toBe(6); // 3 samples × 2 channels
    expect(lim.takeBad()).toBe(0);
    // unity gain afterwards: nothing in it was ever loud
    expect(lim.takeMinGain()).toBeGreaterThan(0.99);
    const tail = outL.subarray(3000);
    let pk = 0;
    for (const v of tail) pk = Math.max(pk, Math.abs(v));
    expect(pk).toBeGreaterThan(0.45);
  });
});

describe('the audio thread is never handed more than it can render', () => {
  /** A beam ultimate's damage: the sim emits a 'hit' every 5 ticks, flagged heavy (the move is an ultimate), of tiny energy. */
  const slice = (attacker: 0 | 1 = 0): AudioEvent => ({
    ...normalHit,
    attacker,
    target: attacker ? 0 : 1,
    type: 'THERMAL',
    energy: 60,
    heavy: true,
  });
  it('a beam ultimate: light slices sound at most every LIGHT_HIT_REPEAT, never with the heavy chain', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(sceneOf('supernova', 'planet'), 1 / 60, 0.2);
    const n0 = ctx.nodes.length;
    for (let i = 0; i < 12; i++) eng.handleAt([slice()], 1 + i / 12); // one second of beam
    const perSecond = ctx.nodes.length - n0;
    // before: 12 × ~190 nodes (a heavy impact chain, embers of one five-node burst per grain) ≈ 2,300 nodes a second
    expect(perSecond).toBeLessThan(600);
    // a REAL heavy blow still gets its rumble and its second drop
    const n1 = ctx.nodes.length;
    eng.handleAt([{ ...normalHit, energy: 3000, heavy: true }], 3);
    expect(ctx.nodes.length - n1).toBeGreaterThan(100);
    // and the other fighter's slices are not throttled by this one's
    const n2 = ctx.nodes.length;
    eng.handleAt([slice(0), slice(1)], 4);
    const both = ctx.nodes.length - n2;
    const n3 = ctx.nodes.length;
    eng.handleAt([slice(0)], 4.5);
    expect(both).toBeGreaterThan(1.5 * (ctx.nodes.length - n3));
    expect(takeViolations()).toEqual([]);
  });
  it('one frame batch gets a bounded number of low-priority sounds (an ultimate lands with its cues and matter at once)', async () => {
    const kinds = ['detach', 'ignite', 'crack', 'consume', 'harvest', 'impact', 'evaporate', 'boil'] as const;
    const matter = (n: number): AudioEvent[] =>
      [-1, 0, 1]
        .flatMap((slot) =>
          kinds.map((kind) => ({ t: 'matter', kind, x: 800, y: 300, mass: 500, slot }) as AudioEvent),
        )
        .slice(0, n);
    const built = async (n: number): Promise<number> => {
      const { eng, ctx } = await ready();
      eng.updateAt(sceneOf('uri', 'planet'), 1 / 60, 0.2);
      const n0 = ctx.nodes.length;
      eng.handleAt(matter(n), 1);
      return ctx.nodes.length - n0;
    };
    expect(await built(24)).toBe(await built(10));
    expect(await built(10)).toBeGreaterThan(await built(5));
  });
  it('the load governor sheds new sounds while the audio clock runs slower than the wall clock, and lets them back after', async () => {
    let wall = 0;
    const ctx = new FakeContext();
    const eng = createAudioEngine({ context: asBase(ctx), seed: 3, governor: true, wallClock: () => wall });
    await eng.unlock();
    const s = sceneOf('blackhole', 'nexus');
    const frame = (audioSpeed: number): void => {
      wall += 1000 / 60;
      ctx.currentTime += audioSpeed / 60;
      eng.update(s, 1 / 60);
    };
    const cue = (id: string): number => {
      const n0 = ctx.nodes.length;
      eng.handle([{ t: 'cue', slot: 0, titan: 'blackhole', id, x: 800, y: 300, amount: 1 }]);
      return ctx.nodes.length - n0;
    };
    for (let i = 0; i < 60; i++) frame(1);
    expect(eng.renderSpeed).toBeCloseTo(1, 1);
    expect(cue('disk-shed')).toBeGreaterThan(5);
    // the audio thread falls to 30 % of real time (measured in Edge under a beam ultimate before the fix: 7–33 %)
    for (let i = 0; i < 40; i++) frame(0.3);
    expect(eng.renderSpeed).toBeLessThan(0.5);
    expect(cue('collapse')).toBe(0); // a cue (prio 0) is shed
    const n0 = ctx.nodes.length;
    eng.handle([{ t: 'ko', slot: 1, x: 800, y: 300 }]); // a KO (critical) still plays
    expect(ctx.nodes.length - n0).toBeGreaterThan(10);
    // a trickle of blows gets through, a flood does not
    const n1 = ctx.nodes.length;
    for (let i = 0; i < 20; i++)
      eng.handle([{ ...normalHit, energy: 3000, heavy: true, attacker: (i % 2) as 0 | 1 }]);
    const flood = ctx.nodes.length - n1;
    const one = await (async () => {
      const q = await ready();
      const m0 = q.ctx.nodes.length;
      q.eng.handleAt([{ ...normalHit, energy: 3000, heavy: true }], 0.01);
      return q.ctx.nodes.length - m0;
    })();
    expect(flood).toBeLessThan(8 * one);
    // caught up: after the hold, sounds come back
    for (let i = 0; i < 150; i++) frame(1);
    expect(eng.renderSpeed).toBeCloseTo(1, 1);
    expect(cue('hawking')).toBeGreaterThan(5);
    expect(takeViolations()).toEqual([]);
  });
  it('a main-thread stall is not mistaken for an overloaded audio thread (both clocks run on)', async () => {
    let wall = 0;
    const ctx = new FakeContext();
    const eng = createAudioEngine({ context: asBase(ctx), seed: 3, governor: true, wallClock: () => wall });
    await eng.unlock();
    const s = sceneOf('uri', 'cradle');
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < 20; i++) {
        wall += 1000 / 60;
        ctx.currentTime += 1 / 60;
        eng.update(s, 1 / 60);
      }
      // 500 ms with no frame at all
      wall += 500;
      ctx.currentTime += 0.5;
      eng.update(s, 0.5);
      expect(eng.renderSpeed).toBeGreaterThan(0.9);
    }
    const n0 = ctx.nodes.length;
    eng.handle([{ t: 'cue', slot: 0, titan: 'uri', id: 'break-apart', x: 800, y: 300, amount: 1 }]);
    expect(ctx.nodes.length - n0).toBeGreaterThan(5);
  });
});

describe('STRESS: every titan, every heavy cue, extreme inputs, 500 ms stalls', () => {
  it('the master stays finite, sources are released, ducks come back, and a normal blow afterwards is audible', async () => {
    const titans = TITAN_IDS as readonly TitanId[];
    for (const [i, titan] of titans.entries()) {
      const foe = titans[(i + 1) % titans.length]!;
      const { eng, ctx } = await ready(11 + i);
      const sane = sceneOf(titan, foe);
      eng.updateAt(sane, 1 / 60, 0.2);
      for (const [k, v] of EXTREMES.entries()) {
        // a frame of normal play, then a stall: the clock jumps 500 ms and the heavy burst lands at the stale time
        ctx.currentTime += 1 / 60;
        eng.updateAt(k % 2 ? sceneOf(titan, foe, v, v) : sane, k % 2 ? v : 1 / 60, ctx.currentTime + 0.15);
        const stale = ctx.currentTime;
        ctx.currentTime += 0.5;
        eng.handleAt(burst(titan, v), stale);
        eng.handleAt(burst(foe, v), ctx.currentTime + 0.006);
        eng.updateAt(sceneOf(titan, foe, v, v), 0.5, ctx.currentTime + 0.15);
      }
      expect(takeViolations(), titan).toEqual([]);
      // the master fader and every bus gain hold finite values (nothing scheduled a NaN onto them)
      const { master, sfx, duck } = buses(eng, ctx);
      for (const p of [master.gain, sfx.gain, duck.gain])
        for (const e of p.events)
          expect(Number.isFinite(e.v) && Number.isFinite(e.t), `${titan} ${p.name}`).toBe(true);
      // let the storm ring out: 12 s of frames with the clock running
      for (let f = 0; f < 12 * 30; f++) {
        ctx.currentTime += 1 / 30;
        eng.updateAt(sane, 1 / 30, ctx.currentTime + 0.15);
      }
      // released: no one-shot source plays on (the titans' beds and the score's drone are the only endless ones, and they are
      // registered as such; a stop() of the scene releases them)
      eng.updateAt({ ...sane, phase: 'menu', fighters: null }, 1 / 30, ctx.currentTime + 0.15);
      const live = unstopped(ctx.nodes).filter((n) => !isScoreDrone(n));
      expect(live, titan).toEqual([]);
      // no source lasts longer than 12 s or starts in the far future (an unclamped 1e9 once scheduled a noise burst for three
      // years: it holds its nodes in the graph all that time)
      const late = ctx.nodes.filter(
        (n) =>
          (n instanceof FakeOsc || n instanceof FakeBufferSource) &&
          n.stopped &&
          (n.startAt > ctx.currentTime || n.stopAt - n.startAt > 12),
      );
      expect(
        late.map((n) => `${n.kind} ${n.startAt.toFixed(2)}→${n.stopAt.toFixed(2)}`),
        `${titan} at ${ctx.currentTime.toFixed(2)}`,
      ).toEqual([]);
      // the duck is back up and the polyphony cap is free again: a normal blow is built and heard
      expect(duck.gain.valueAt(ctx.currentTime)).toBeGreaterThan(0.95);
      expectAudible(eng, ctx, ctx.currentTime + 0.006);
      expect(eng.recoveryCount, titan).toBe(0); // the fake renders no audio: nothing to recover from
      expect(takeViolations(), titan).toEqual([]);
      // coverage: every event of every extreme burst ALONE (one a second, so no cap hides a handler): valid automation, and no
      // source lasts longer than 12 s
      const q = await ready(29 + i);
      q.eng.updateAt(sane, 1 / 60, 0.2);
      let t = 1;
      for (const v of EXTREMES)
        for (const e of [...burst(titan, v), ...burst(foe, v)]) q.eng.handleAt([e], t++);
      expect(takeViolations(), titan).toEqual([]);
      const long = q.ctx.nodes.filter(
        (n) =>
          (n instanceof FakeOsc || n instanceof FakeBufferSource) && n.stopped && n.stopAt - n.startAt > 12,
      );
      expect(
        long.map((n) => `${n.kind} ${n.startAt.toFixed(2)}→${n.stopAt.toFixed(2)}`),
        titan,
      ).toEqual([]);
    }
  }, 120_000);
});

/** The score's drone and pad oscillators run for the engine's whole life (started at creation, stopped only by dispose()). */
function isScoreDrone(n: FakeNode): boolean {
  return n instanceof FakeOsc && n.startAt <= 0.25 && !n.stopped;
}
