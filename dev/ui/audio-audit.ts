import { Rng, TITAN_IDS, type AudioEvent, type DamageType, type TitanId } from '@/contracts';
import { CUE_TRIM, MOVE_TRIM, SURGE_TRIM, createAudioEngine, laptopVoicing } from '@/audio/engine';
import { bandEnergies, peak, rms, spectralCentroid, toDb } from '@/audio/dsp/analysis';
import { createTitanVoice } from '@/audio/voices/index';
import {
  playCueGeneric,
  playGuard,
  playImpact,
  playKo,
  playMatter,
  playShockwave,
  playTypeLayer,
  playUltimate,
} from '@/audio/voices/sfx';
import { cometEnter, cometWarn } from '@/audio/voices/materials';
import type { HitEvent, VoiceCtx } from '@/audio/voices/types';
import { getTitanDef } from '@/titans';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';

/**
 * The "whistle audit" (D34: drop high-pitched sounds and whistles): every sound source the engine can make, rendered ALONE through
 * a bare voice context (dry, no reverb, no limiter, the engine's per-class trims applied), and measured for where its energy
 * lives. `hiDb` is the absolute level of the part above 2 kHz (hiss, sizzle, glitter, high pings); `brightDb` the part above 1 kHz
 * (where the whistles and sine pings sit: 0.8–1.6 kHz); `*Share` the share of the sound's power in each band: `sub` below 80 Hz,
 * `low` the 80–250 Hz "laptop weight" band, `mid` 250 Hz–1 kHz, `upper` 1–2 kHz, `hi` above 2 kHz. Sorted by `brightDb`.
 */
export interface AuditRow {
  source: string;
  peakDb: number;
  rmsDb: number;
  centroidHz: number;
  subShare: number;
  lowShare: number;
  midShare: number;
  upperShare: number;
  hiShare: number;
  /** Level (dBFS, mean square over the sound's first `seconds`) of the band above 1 kHz. */
  brightDb: number;
  /** The same, above 2 kHz. */
  hiDb: number;
}
export interface AuditReport {
  rows: AuditRow[];
  /** Power-weighted share above 2 kHz (and above 1 kHz, and 80–250 Hz) across every source (each source counted once). */
  totalHiShare: number;
  totalBrightShare: number;
  totalLowShare: number;
}

const SR = 44100;
const EDGES = [20, 80, 250, 1000, 2000, 22050];

/** Render `play(c)` through a bare voice context; `drive` (optional) is called every 1/30 s of audio time (continuous voices). */
async function renderBare(
  seconds: number,
  play: (c: VoiceCtx) => void,
  drive?: (c: VoiceCtx, t: number) => void,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
  const rng = new Rng(17);
  const noise = ctx.createBuffer(1, SR * 2, SR);
  const brown = ctx.createBuffer(1, SR * 2, SR);
  const w = noise.getChannelData(0);
  const b = brown.getChannelData(0);
  let last = 0;
  for (let i = 0; i < w.length; i++) {
    const x = rng.next() * 2 - 1;
    w[i] = x;
    last = (last + 0.02 * x) / 1.02;
    b[i] = last * 3.5;
  }
  // the engine's output high-pass (50 Hz, 4th order) so the sub band is what a player could hear at all
  const hp1 = ctx.createBiquadFilter();
  const hp2 = ctx.createBiquadFilter();
  hp1.type = hp2.type = 'highpass';
  hp1.frequency.value = hp2.frequency.value = 50;
  hp1.Q.value = 0.5412;
  hp2.Q.value = 1.3066;
  hp1.connect(hp2);
  hp2.connect(ctx.destination);
  const dry = ctx.createGain();
  // through the engine's own laptop voicing and weight stage, as in a fight
  laptopVoicing(ctx, dry, hp1);
  const wet = ctx.createGain();
  wet.gain.value = 0;
  wet.connect(ctx.destination);
  const c: VoiceCtx = {
    ac: ctx,
    dry,
    wet,
    noise,
    brown,
    rand: () => rng.next(),
    panOf: () => 0,
    take: () => true,
    release: () => undefined,
    timeScale: 1,
  };
  play(c);
  if (drive) {
    drive(c, 0);
    for (let t = 1 / 30; t < seconds - 1 / 30; t += 1 / 30) {
      const at = t;
      void ctx.suspend(at).then(() => {
        drive(c, at);
        void ctx.resume();
      });
    }
  }
  return (await ctx.startRendering()).getChannelData(0);
}

function measure(source: string, x: Float32Array, seconds: number, gain = 1): AuditRow {
  const n = Math.min(x.length, Math.ceil(SR * seconds));
  if (gain !== 1) for (let i = 0; i < x.length; i++) x[i] = x[i]! * gain;
  const ms = rms(x, 0, n) ** 2;
  const [sub, low, mid, upper, hi] = bandEnergies(x, SR, EDGES, 0, n, 4096);
  const db = (share: number): number => +(10 * Math.log10(Math.max(1e-18, ms * share))).toFixed(1);
  return {
    source,
    peakDb: +toDb(peak(x)).toFixed(1),
    rmsDb: +toDb(Math.sqrt(ms)).toFixed(1),
    centroidHz: Math.round(spectralCentroid(x, SR, 0, Math.min(n, 32768), 60)),
    subShare: +sub!.toFixed(3),
    lowShare: +low!.toFixed(3),
    midShare: +mid!.toFixed(3),
    upperShare: +upper!.toFixed(3),
    hiShare: +hi!.toFixed(3),
    brightDb: db(upper! + hi!),
    hiDb: db(hi!),
  };
}

const hitEv = (titan: TitanId, over: Partial<HitEvent> = {}): HitEvent => ({
  t: 'hit',
  attacker: 0,
  target: 1,
  titan,
  x: 800,
  y: 300,
  dirX: 1,
  dirY: 0,
  type: 'KINETIC',
  energy: 1400,
  cellsRemoved: 40,
  massRemoved: 12,
  blocked: 0,
  heavy: false,
  onDamaged: 0,
  ...over,
});

/** The exact cue ids each titan emits (src/combat/behaviours). */
const CUES: Readonly<Record<TitanId, readonly string[]>> = {
  // the colossus (The Last One, D36) emits no cues of its own
  colossus: [],
  // the Mouth (D37): its cues (src/combat/mouth/fighter.ts)
  mouth: ['ring-break', 'strand-sever', 'grab', 'escape'],
  lastone: ['tendril-sever', 'eye-exposed'],
  asteroid: ['rubble-pile', 'momentum', 'fragment-lost'],
  nexus: ['node-dark', 'harvest', 'chain-latch', 'chain-snap'],
  blackhole: ['disk-shed', 'consume', 'hawking'],
  supernova: ['fuel-burn', 'layer-blow', 'collapse'],
  planet: [
    'world-phase-2',
    'moon-shatter',
    'moon-lost',
    'core-pulse',
    'crust-crack',
    'comet-call',
    'comet-sling',
    'comet-capture',
    'comet-spent',
    'ring-capture',
    'ring-throw',
    'atmo-vent',
    'moons-drift',
    'crust-slab',
    'core-out',
    'atmo-strip',
    'ocean-boil',
  ],
  uri: ['break-apart'],
};
const TYPES: readonly DamageType[] = ['FRACTURE', 'KINETIC', 'CRUSH', 'THERMAL', 'TIDAL', 'ASSIMILATION'];

export async function runAudit(only?: readonly string[]): Promise<AuditReport> {
  await loadUriAsset(uriBinUrl);
  const rows: AuditRow[] = [];
  const keep = (name: string): boolean => !only?.length || only.some((o) => name.startsWith(o));
  const one = async (name: string, seconds: number, play: (c: VoiceCtx) => void, gain = 1): Promise<void> => {
    if (!keep(name)) return;
    rows.push(measure(name, await renderBare(seconds, play), seconds, gain));
  };

  // ---- shared, titan-neutral layers
  for (const mag of [0.35, 0.9])
    await one(`shared impact mag ${mag}`, 2.5, (c) =>
      playImpact(c, 0.02, hitEv('asteroid', { heavy: mag > 0.6 }), mag, 0),
    );
  for (const type of TYPES) await one(`shared type ${type}`, 2, (c) => playTypeLayer(c, 0.02, type, 0.6, 0));
  for (const broke of [false, true])
    await one(`shared guard ${broke ? 'breaks' : 'holds'}`, 2, (c) =>
      playGuard(c, 0.02, { t: 'guard', slot: 0, x: 800, y: 300, type: 'KINETIC', broke }, 0),
    );
  await one('shared shockwave', 2.5, (c) => playShockwave(c, 0.02, 1, 260, 0));
  await one('shared ko', 4, (c) => playKo(c, 0.02, { t: 'ko', slot: 0, x: 800, y: 300 }, 0));
  for (const kind of [
    'detach',
    'crack',
    'ignite',
    'consume',
    'harvest',
    'impact',
    'evaporate',
    'boil',
  ] as const)
    await one(`shared matter ${kind}`, 2, (c) =>
      playMatter(c, 0.02, { t: 'matter', kind, x: 800, y: 300, mass: 300, slot: 0 }, 0),
    );
  for (const phase of ['start', 'end'] as const)
    await one(`shared ultimate ${phase}`, 4, (c) =>
      playUltimate(c, 0.02, { t: 'ultimate', slot: 0, titan: 'asteroid', phase, x: 800, y: 300 }, 0),
    );
  await one('shared cue generic', 1.5, (c) => playCueGeneric(c, 0.02, 0.8, 0));
  await one('arena comet warn', 2.5, (c) => cometWarn(c, 0.02, 0, 1.5));
  await one('arena comet enter', 2.5, (c) => cometEnter(c, 0.02, 0, 1, 260));

  // ---- each titan's own voice
  for (const T of TITAN_IDS) {
    const def = getTitanDef(T);
    const voice = (): ReturnType<typeof createTitanVoice> => createTitanVoice(T);
    for (const m of def.moves) {
      const trim = MOVE_TRIM[m.slot] ?? 2;
      const mv = {
        t: 'move',
        slot: 0,
        titan: T,
        moveId: m.id,
        moveSlot: m.slot,
        aim: 'forward',
        x: 800,
        y: 300,
      };
      const rel = {
        t: 'release',
        slot: 0,
        titan: T,
        moveId: m.id,
        moveSlot: m.slot,
        x: 800,
        y: 300,
        power: 0.85,
      };
      await one(
        `${T} windup ${m.id}`,
        2,
        (c) => voice().onMove?.(c, 0.02, mv as Extract<AudioEvent, { t: 'move' }>),
        trim,
      );
      await one(`${T} release ${m.id}`, 2.5, (c) =>
        voice().onRelease?.(c, 0.02, rel as Extract<AudioEvent, { t: 'release' }>),
      );
      if (m.frame.chargeMax > 0 || /gaze|lastlight/.test(m.id))
        await one(`${T} charge ${m.id}`, 2, (c) => {
          const v = voice();
          const ch = (phase: 'start' | 'hold' | 'release', frac: number, at: number): void =>
            v.onCharge?.(c, at, { t: 'charge', slot: 0, titan: T, moveId: m.id, frac, phase });
          ch('start', 0, 0.02);
          for (let i = 1; i <= 50; i++) ch('hold', i / 50, 0.02 + i / 30);
          ch('release', 1, 1.75);
        });
    }
    await one(
      `${T} surge`,
      2,
      (c) => voice().onSurge?.(c, 0.02, { t: 'surge', slot: 0, titan: T, x: 800, y: 300, dirX: 1, dirY: 0 }),
      SURGE_TRIM,
    );
    const own = def.destruction as DamageType;
    for (const mag of [0.35, 0.9]) {
      await one(`${T} hit dealt mag ${mag}`, 2, (c) =>
        voice().onHitDealt?.(c, 0.02, hitEv('asteroid', { type: own, heavy: mag > 0.6 }), mag),
      );
      await one(`${T} hit taken mag ${mag}`, 2.5, (c) =>
        voice().onHitTaken?.(c, 0.02, hitEv(T, { heavy: mag > 0.6, onDamaged: mag > 0.6 ? 0.6 : 0 }), mag),
      );
    }
    for (const broke of [false, true])
      await one(`${T} guard ${broke ? 'breaks' : 'holds'}`, 2, (c) =>
        voice().onGuard?.(c, 0.02, { t: 'guard', slot: 0, x: 800, y: 300, type: 'KINETIC', broke }),
      );
    await one(`${T} ko`, 5, (c) => voice().onKo?.(c, 0.02, { t: 'ko', slot: 0, x: 800, y: 300 }));
    for (const phase of ['start', 'end'] as const)
      await one(`${T} ultimate ${phase}`, 4, (c) =>
        voice().onUltimate?.(c, 0.02, { t: 'ultimate', slot: 0, titan: T, phase, x: 800, y: 300 }),
      );
    for (const id of CUES[T])
      await one(
        `${T} cue ${id}`,
        3,
        (c) => voice().onCue?.(c, 0.02, { t: 'cue', slot: 0, titan: T, id, x: 800, y: 300, amount: 0.8 }),
        CUE_TRIM[T] ?? 1,
      );
    for (const kind of [
      'detach',
      'crack',
      'ignite',
      'consume',
      'harvest',
      'impact',
      'evaporate',
      'boil',
    ] as const)
      await one(`${T} matter ${kind}`, 2, (c) => {
        voice().onMatter?.(c, 0.02, { t: 'matter', kind, x: 800, y: 300, mass: 300, slot: 0 });
      });
    // the continuous voice, moving, at mid mass, then thin (the black hole's Hawking state)
    for (const [label, massFrac, speed] of [
      ['moving', 1, 400],
      ['thin', 0.15, 120],
    ] as const) {
      if (!keep(`${T} bed ${label}`)) continue;
      const v = voice();
      const x = await renderBare(
        4,
        () => undefined,
        (c) =>
          v.update?.(
            c,
            { titan: T, x: 800, speed, massFrac, charge: 0, resource: 0.6, meter: 0.3, state: 'move' },
            0,
            1 / 30,
          ),
      );
      rows.push(measure(`${T} bed ${label}`, x.subarray(SR), 3));
    }
  }

  // ---- round / UI through the real engine (music muted, no fighters)
  for (const ev of [
    { t: 'round', phase: 'intro', round: 1, winner: -1 },
    { t: 'round', phase: 'fight', round: 1, winner: -1 },
    { t: 'round', phase: 'end', round: 1, winner: 0 },
    { t: 'ui', id: 'start' },
    { t: 'ui', id: 'move' },
  ] as AudioEvent[]) {
    const name = `engine ${ev.t} ${'phase' in ev ? ev.phase : 'id' in ev ? ev.id : ''}`;
    if (!keep(name)) continue;
    const ctx = new OfflineAudioContext(1, SR * 3, SR);
    const eng = createAudioEngine({ context: ctx, seed: 3, unsafeBypassLimiter: true });
    await eng.unlock();
    eng.setVolumes({ music: 0 });
    eng.handleAt([ev], 0.02);
    rows.push(measure(name, (await ctx.startRendering()).getChannelData(0), 3));
  }

  // a handler a voice leaves out renders silence (the engine plays the shared sound instead, measured above)
  const heard = rows.filter((r) => r.rmsDb > -100);
  let all = 0;
  let hi = 0;
  let bright = 0;
  let low = 0;
  for (const r of heard) {
    const p = Math.pow(10, r.rmsDb / 10);
    all += p;
    hi += p * r.hiShare;
    bright += p * (r.hiShare + r.upperShare);
    low += p * r.lowShare;
  }
  heard.sort((a, b) => b.brightDb - a.brightDb);
  return {
    rows: heard,
    totalHiShare: +(hi / all).toFixed(3),
    totalBrightShare: +(bright / all).toFixed(3),
    totalLowShare: +(low / all).toFixed(3),
  };
}
