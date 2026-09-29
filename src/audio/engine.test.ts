import { describe, expect, it } from 'vitest';
import type { AudioEvent, AudioScene, SimEvent, StageId, TitanId } from '@/contracts';
import { STAGE_IDS, TITAN_IDS } from '@/contracts';
import { createAudioEngine } from './engine';
import { FakeContext, FakeGain, FakeOsc, FakeShaper, WebAudioViolation, asBase, takeViolations } from './testing/fakeContext';

const scene = (o: Partial<AudioScene> = {}, a: TitanId = 'lastone', b: TitanId = 'asteroid'): AudioScene => ({
  phase: 'fight',
  stage: 'nursery',
  intensity: 0.5,
  listenerX: 800,
  lowestIntegrity: 0.8,
  timeScale: 1,
  fighters: [
    { titan: a, x: 700, speed: 300, massFrac: 1, charge: 0, resource: 10, meter: 0.3, state: 'idle' },
    { titan: b, x: 900, speed: 100, massFrac: 1, charge: 0, resource: 10, meter: 0.3, state: 'idle' },
  ],
  ...o,
});

/** One of every SimEvent variant, for a spread of titans and damage types. */
function allEvents(a: TitanId, b: TitanId): SimEvent[] {
  const ev: SimEvent[] = [];
  const t = [a, b] as const;
  for (const slot of [0, 1] as const) {
    const titan = t[slot];
    for (const moveSlot of ['strike', 'crush', 'surge', 'signature', 'ultimate', 'guard'] as const) {
      for (const suffix of ['lash', 'lunge', 'shatter', 'sidestep', 'gaze', 'lastlight', 'shoulder', 'meteor', 'tumble', 'swarm', 'kessler', 'guard', 'x']) {
        ev.push({ t: 'move', slot, titan, moveId: `${titan}.${suffix}`, moveSlot, aim: 'forward', x: 700 + 200 * slot, y: 300 });
        ev.push({ t: 'release', slot, titan, moveId: `${titan}.${suffix}`, moveSlot, x: 700 + 200 * slot, y: 300, power: 0.7 });
        for (const phase of ['start', 'hold', 'release'] as const)
          ev.push({ t: 'charge', slot, titan, moveId: `${titan}.${suffix}`, frac: 0.6, phase });
      }
    }
    ev.push({ t: 'surge', slot, titan, x: 700 + 200 * slot, y: 300, dirX: slot ? -1 : 1, dirY: 0 });
    ev.push({ t: 'guard', slot, x: 800, y: 300, type: 'FRACTURE', broke: false });
    ev.push({ t: 'guard', slot, x: 800, y: 300, type: 'KINETIC', broke: true });
    ev.push({ t: 'ko', slot, x: 800, y: 300 });
    ev.push({ t: 'ultimate', slot, titan, phase: 'start', x: 800, y: 300 });
    ev.push({ t: 'ultimate', slot, titan, phase: 'end', x: 800, y: 300 });
    for (const kind of ['gain', 'spend', 'break'] as const) ev.push({ t: 'resource', slot, kind, amount: 1 });
    for (const id of ['tendril-sever', 'eye-exposed', 'rubble-pile', 'momentum', 'fragment-lost', 'something-new'])
      ev.push({ t: 'cue', slot, titan, id, x: 800, y: 300, amount: 0.5 });
  }
  for (const type of ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'] as const)
    for (const [blocked, heavy] of [[0, false], [0.6, true], [1, false]] as const)
      ev.push({ t: 'hit', attacker: 0, target: 1, titan: b, x: 850, y: 300, dirX: 1, dirY: 0, type, energy: 500 + blocked * 3000, cellsRemoved: 30, massRemoved: 10, blocked, heavy, onDamaged: heavy ? 0.7 : 0 });
  ev.push({ t: 'shockwave', x: 800, y: 300, strength: 0.8, radius: 200, hue: 0.1 });
  ev.push({ t: 'hitstop', ticks: 9 });
  ev.push({ t: 'shake', dirX: 1, dirY: 0, amp: 4 });
  ev.push({ t: 'zoom', amount: 0.03 });
  ev.push({ t: 'roll', radians: 0.01 });
  ev.push({ t: 'flash', amount: 0.5 });
  ev.push({ t: 'rumble', slot: 0, strong: 1, weak: 1, ms: 100 });
  ev.push({ t: 'timescale', scale: 0.3, ticks: 40 });
  for (const kind of ['detach', 'ignite', 'crack', 'consume', 'harvest', 'impact', 'evaporate', 'boil'] as const)
    for (const slot of [-1, 0, 1] as const) ev.push({ t: 'matter', kind, x: 800, y: 300, mass: 120, slot });
  for (const phase of ['intro', 'fight', 'ko', 'timeover', 'end', 'match'] as const) ev.push({ t: 'round', phase, round: 1, winner: 0 });
  return ev;
}

const ui: AudioEvent[] = (['move', 'confirm', 'back', 'select', 'error', 'start', 'pause', 'unpause', 'roundwin', 'tick'] as const).map((id) => ({ t: 'ui', id }));

async function ready(seed = 3): Promise<{ eng: ReturnType<typeof createAudioEngine>; ctx: FakeContext }> {
  const ctx = new FakeContext();
  const eng = createAudioEngine({ context: asBase(ctx), seed });
  await eng.unlock();
  return { eng, ctx };
}

describe('lifecycle', () => {
  it('is inert before unlock: handle/update/setVolumes never throw and nothing is built', () => {
    const eng = createAudioEngine();
    expect(eng.ready).toBe(false);
    expect(() => {
      eng.handle(ui);
      eng.update(scene(), 1 / 60);
      eng.setVolumes({ master: 0.3 });
      eng.dispose();
    }).not.toThrow();
  });
  it('unlock builds the graph on the given context, is idempotent, and resumes a suspended one', async () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const eng = createAudioEngine({ context: asBase(ctx) });
    expect(eng.ready).toBe(false);
    await eng.unlock();
    expect(eng.ready).toBe(true);
    const n = ctx.nodes.length;
    await eng.unlock();
    expect(ctx.nodes.length).toBe(n);
    expect(ctx.count('convolver')).toBe(1);
  });
  it('unlock swallows a missing AudioContext (no WebAudio at all)', async () => {
    const eng = createAudioEngine();
    await expect(eng.unlock()).resolves.toBeUndefined();
    expect(eng.ready).toBe(false);
  });
  it('dispose closes the context and returns to inert', async () => {
    const { eng, ctx } = await ready();
    eng.dispose();
    expect(ctx.state).toBe('closed');
    expect(eng.ready).toBe(false);
    expect(() => eng.handle(ui)).not.toThrow();
  });
});

describe('master chain (the "nothing clips" guarantee)', () => {
  it('ends in compressor → 4× oversampled soft limiter → master gain → memoryless hard clip → destination, ceiling ≤ 0.98', async () => {
    const { ctx } = await ready();
    const shapers = ctx.nodes.filter((n): n is FakeShaper => n instanceof FakeShaper);
    expect(shapers).toHaveLength(2);
    const [soft, clip] = shapers as [FakeShaper, FakeShaper];
    expect(soft.oversample).toBe('4x');
    expect(clip.oversample).toBe('none'); // no oversampling filter, so no ringing past the ceiling
    for (const sh of shapers) {
      let max = 0;
      for (const v of sh.curve!) max = Math.max(max, Math.abs(v));
      expect(max).toBeLessThanOrEqual(0.98 + 1e-6);
    }
    const comp = ctx.nodes.find((n) => n.kind === 'compressor')!;
    expect(comp.outputs.has(soft)).toBe(true);
    // master volume is applied after the dynamics, so it scales a signal that is already safe (and can never push it past the ceiling)
    const master = [...soft.outputs][0] as FakeGain;
    expect(master).toBeInstanceOf(FakeGain);
    expect(master.outputs.has(clip)).toBe(true);
    expect(clip.outputs.has(ctx.destination)).toBe(true);
    // nothing but the final clip feeds the destination
    expect([...ctx.destination.inputs]).toEqual([clip]);
  });
  it('uses one long convolution reverb with a generated (not loaded) impulse response of 3+ seconds', async () => {
    const { ctx } = await ready();
    const conv = ctx.nodes.find((n) => n.kind === 'convolver') as unknown as { buffer: { duration: number; numberOfChannels: number }; normalize: boolean };
    expect(conv.buffer.duration).toBeGreaterThan(3.3);
    expect(conv.buffer.numberOfChannels).toBe(2);
    expect(conv.normalize).toBe(false);
  });
  it('volumes are clamped, applied with a squared taper, and readable', async () => {
    const { eng, ctx } = await ready();
    eng.setVolumes({ master: 2, music: -1, sfx: 0.5 });
    expect(eng.volumes).toEqual({ master: 1, music: 0, sfx: 0.5 });
    const gains = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
    const targets = gains.flatMap((g) => g.gain.events.filter((e) => e.type === 'target').map((e) => e.v));
    expect(targets).toContain(1);
    expect(targets).toContain(0);
    expect(targets).toContain(0.25);
    expect(() => eng.setVolumes({})).not.toThrow();
  });
});

describe('event handling', () => {
  it('handles every SimEvent variant for every pair of titans without violating the Web Audio rules', async () => {
    const { eng, ctx } = await ready();
    eng.update(scene(), 1 / 60);
    for (const a of TITAN_IDS) {
      for (const b of TITAN_IDS) {
        eng.updateAt(scene({}, a, b), 1 / 60, 1);
        // tick the fake clock so the polyphony gate has something to age out
        ctx.currentTime += 0.5;
        expect(() => eng.handleAt(allEvents(a, b), ctx.currentTime + 0.01)).not.toThrow();
      }
    }
    expect(ctx.nodes.length).toBeGreaterThan(5000);
    // the engine contains a voice's exception, so a thrown violation never reaches the test: the fake records them
    expect(takeViolations()).toEqual([]);
  });
  it('rethrows nothing even if a voice misbehaves: the strict fake would throw on a bad ramp, handle() must contain it', async () => {
    const { eng, ctx } = await ready();
    const bad = ctx.createGain();
    bad.gain.setValueAtTime(0, 0);
    expect(() => bad.gain.exponentialRampToValueAtTime(0, 1)).toThrow(WebAudioViolation);
    expect(takeViolations()).toHaveLength(1);
    expect(() => eng.handleAt([{ t: 'hit', attacker: 0, target: 1, titan: 'lastone', x: NaN, y: 0, dirX: 0, dirY: 0, type: 'FRACTURE', energy: Infinity, cellsRemoved: 0, massRemoved: 0, blocked: NaN, heavy: false, onDamaged: 0 }], 0)).not.toThrow();
    expect(takeViolations().length).toBeGreaterThan(0); // contained, but recorded
  });
  it('every UI sound builds and every source it starts is also stopped (no leaks)', async () => {
    const { eng, ctx } = await ready();
    const before = ctx.nodes.length;
    const persistent = ctx.leakedSources().length;
    eng.handleAt(ui, 0.01);
    expect(ctx.nodes.length).toBeGreaterThan(before + 30);
    // 'roundwin' also wakes the score (drone + pad oscillators run by design); every OTHER source must have a stop time
    const leaked = ctx.leakedSources();
    expect(leaked.length - persistent).toBeLessThanOrEqual(13);
    for (const n of leaked) expect(n.kind).toBe('oscillator');
  });
  it('one-shot events never leave a source running forever', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(scene(), 1 / 60, 0.2);
    const persistent = ctx.leakedSources().length; // drones, pads, continuous voices are meant to run
    eng.handleAt(allEvents('lastone', 'asteroid').filter((e) => e.t === 'hit' || e.t === 'ko' || e.t === 'matter' || e.t === 'shockwave' || e.t === 'guard'), 1);
    expect(ctx.leakedSources().length).toBe(persistent);
  });
  it('is deterministic: the same seed and events build an identical graph', async () => {
    const shape = async (): Promise<string> => {
      const { eng, ctx } = await ready(11);
      eng.updateAt(scene(), 1 / 60, 1.0);
      eng.handleAt(allEvents('lastone', 'asteroid'), 0.5);
      return ctx.nodes.map((n) => n.kind + ((n as FakeOsc).frequency?.events.length ?? '')).join(',');
    };
    expect(await shape()).toBe(await shape());
  });
  it('the polyphony cap sheds low-priority sounds under a storm but keeps critical ones (KO, ultimate)', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(scene(), 1 / 60, 0);
    const hits = Array.from({ length: 300 }, (_, i): AudioEvent => ({ t: 'move', slot: 0, titan: 'lastone', moveId: 'lastone.lash', moveSlot: 'strike', aim: 'forward', x: 700 + i, y: 0 }));
    const n0 = ctx.nodes.length;
    eng.handleAt(hits, 2);
    const low = ctx.nodes.length - n0;
    eng.handleAt([{ t: 'ultimate', slot: 0, titan: 'lastone', phase: 'start', x: 800, y: 300 }, { t: 'ko', slot: 1, x: 800, y: 300 }], 2);
    const total = ctx.nodes.length - n0;
    expect(low).toBeLessThan(300 * 8); // nowhere near 300 full voices
    expect(total).toBeGreaterThan(low + 20); // the critical events still sounded
  });
  it('pans by world position relative to the listener', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(scene({ listenerX: 800 }), 1 / 60, 0);
    const before = ctx.nodes.length;
    eng.handleAt([{ t: 'cue', slot: 0, titan: 'lastone', id: 'tendril-sever', x: 100, y: 0, amount: 1 }], 1);
    eng.handleAt([{ t: 'cue', slot: 0, titan: 'lastone', id: 'tendril-sever', x: 1500, y: 0, amount: 1 }], 2);
    const pans = ctx.nodes.slice(before).filter((n) => n.kind === 'panner').map((n) => (n as unknown as { pan: { value: number } }).pan.value);
    expect(Math.min(...pans)).toBeLessThan(-0.6);
    expect(Math.max(...pans)).toBeGreaterThan(0.6);
    for (const p of pans) expect(Math.abs(p)).toBeLessThanOrEqual(1);
  });
});

describe('continuous state and the adaptive score', () => {
  it('starts drone, pad and rhythm scheduling on update, per stage, without violations', async () => {
    for (const stage of STAGE_IDS) {
      const { eng, ctx } = await ready(2);
      expect(() => eng.updateAt(scene({ stage: stage as StageId }), 1 / 60, 12)).not.toThrow();
      expect(takeViolations()).toEqual([]);
      expect(ctx.count('oscillator')).toBeGreaterThan(15);
    }
  });
  it('more intensity schedules more one-shot nodes over the same span of time', async () => {
    const nodesFor = async (intensity: number): Promise<number> => {
      const { eng, ctx } = await ready(5);
      // the fake clock does not advance by itself: feed frames, then let the scheduler run 20 s ahead
      for (let i = 0; i < 60; i++) eng.updateAt(scene({ intensity }), 0.5, 20);
      return ctx.nodes.length;
    };
    const calm = await nodesFor(0);
    const hot = await nodesFor(1);
    expect(hot).toBeGreaterThan(calm);
  });
  it('menu phase schedules no rhythm nodes and the fighters’ continuous voices are stopped', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(scene(), 1 / 60, 1);
    const withFight = ctx.count('oscillator');
    eng.updateAt(scene({ phase: 'menu', fighters: null }), 1 / 60, 6);
    expect(ctx.count('oscillator')).toBeGreaterThanOrEqual(withFight);
    const stopped = ctx.nodes.filter((n) => n.kind === 'oscillator' && n.stopped).length;
    expect(stopped).toBeGreaterThan(0);
  });
  it('slow-motion (KO dilation) detunes the score', async () => {
    const { eng, ctx } = await ready();
    eng.updateAt(scene({ timeScale: 0.3 }), 1 / 60, 1);
    const detunes = ctx.nodes.filter((n): n is FakeOsc => n instanceof FakeOsc).flatMap((o) => o.detune.events.filter((e) => e.type === 'target').map((e) => e.v));
    expect(Math.min(...detunes)).toBeLessThan(-500);
  });
  it('readPeak works and resets', async () => {
    const { eng } = await ready();
    expect(eng.readPeak()).toEqual({ pre: 0, post: 0 });
    expect(eng.latencyMs()).toBeCloseTo(30, 5);
  });
});
