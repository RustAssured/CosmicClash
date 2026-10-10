import {
  ROUND_INTRO_TICKS,
  type AudioScene,
  type Difficulty,
  type MatchConfig,
  type SimEvent,
  type StageId,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { FxState, buildAudioScene } from '@/app/fx';
import { createAudioEngine } from '@/audio/engine';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { TITAN_SKY } from '@/render';
import { createAiSource, createMatch, type Match } from '@/sim';
import { STAGES } from '@/stages';
import { getTitanDef, witnessDef } from '@/titans';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';

/**
 * PRESS KIT worker (tools/press): the game's harness match, rebuilt headless exactly as `App.buildSession` builds it for
 * `?mode=aivai&a&b&stage&seed&ai` (Witness on, orbital footwork, the stage's arena, the one titan sky, AI seeds
 * `seed·7 + slot`, the intro fast-forwarded), so its ticks are the ticks the game draws (checked by hash).
 *  - `scan`: the notable moments of a long run (blow weights, KOs, cues, ultimates) by tick, for picking shots;
 *  - `audio`: the game's own sound for ticks [t0, t1) rendered offline (OfflineAudioContext, the real engine fed the way the
 *    app feeds it), with each tick's audio time, so video frames rendered one tick each can be retimed onto it.
 */
export interface PressCfg {
  a: TitanId;
  b: TitanId;
  stage: StageId;
  seed: number;
  ai: number;
}

export interface Moment {
  tick: number;
  /** 'hit' | 'ko' | 'cue' | 'ult' | 'round' | 'detach' | 'timescale' */
  k: string;
  /** Details: hit weight / cue id / round phase … */
  d: string;
  slot: number;
  titan: TitanId | '';
  x: number;
  y: number;
  v: number;
}

export interface ScanResult {
  moments: Moment[];
  hashes: [number, number][];
  endTick: number;
  phaseAt: [number, string][];
}

export interface AudioResult {
  wav: string;
  /** Audio seconds (from the clip's start) at which each tick t0 + i ran. */
  times: number[];
  seconds: number;
}

const TICK = 1 / 60;
const SR = 48000;

let uriReady: Promise<void> | null = null;

function buildMatch(c: PressCfg): Match {
  const config: MatchConfig = {
    seed: c.seed,
    stage: c.stage,
    mode: 'aivai',
    slots: [
      { titan: c.a, controller: 'ai', aiLevel: c.ai as Difficulty },
      { titan: c.b, controller: 'ai', aiLevel: c.ai as Difficulty },
    ],
    startState: 'intact',
    infinite: false,
    startGap: 380,
    footwork: 'orbit',
    zdepth: false,
    witness: true,
  };
  const defOf = (id: TitanId): TitanDef =>
    config.witness && id === 'lastone' ? witnessDef(getTitanDef(id)) : getTitanDef(id);
  const m = createMatch(config, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: STAGES[c.stage].arena,
    lighting: TITAN_SKY,
  });
  const src = (slot: 0 | 1): ReturnType<typeof createAiSource> =>
    createAiSource(
      m,
      slot,
      createAI(c.ai as Difficulty, defOf(config.slots[slot].titan), c.seed * 7 + slot, { footwork: 'orbit' }),
    );
  m.setSources(src(0), src(1));
  for (let i = 0; i < ROUND_INTRO_TICKS + 1; i++) m.step();
  return m;
}

async function ready(c: PressCfg): Promise<void> {
  if (c.a === 'uri' || c.b === 'uri') await (uriReady ??= loadUriAsset(uriBinUrl));
}

function momentsOf(ev: readonly SimEvent[], tick: number, out: Moment[]): void {
  for (const e of ev) {
    if (e.t === 'hit') {
      const w = e.weight ?? (e.heavy ? 'heavy' : 'medium');
      if (w === 'heavy' || w === 'catastrophic')
        out.push({ tick, k: 'hit', d: w, slot: e.attacker, titan: e.titan, x: e.x, y: e.y, v: e.energy });
    } else if (e.t === 'ko') out.push({ tick, k: 'ko', d: '', slot: e.slot, titan: '', x: e.x, y: e.y, v: 1 });
    else if (e.t === 'cue')
      out.push({ tick, k: 'cue', d: e.id, slot: e.slot, titan: e.titan, x: e.x, y: e.y, v: e.amount });
    else if (e.t === 'ultimate' && e.phase === 'start')
      out.push({ tick, k: 'ult', d: '', slot: e.slot, titan: e.titan, x: e.x, y: e.y, v: 1 });
    else if (e.t === 'round')
      out.push({ tick, k: 'round', d: `${e.phase}:${e.round}:${e.winner}`, slot: -1, titan: '', x: 0, y: 0, v: 0 });
    else if (e.t === 'matter' && e.kind === 'detach' && e.mass >= 40)
      out.push({ tick, k: 'detach', d: '', slot: e.slot, titan: '', x: e.x, y: e.y, v: e.mass });
    else if (e.t === 'flash' && e.amount >= 0.5)
      out.push({ tick, k: 'flash', d: '', slot: -1, titan: '', x: e.x ?? 0, y: e.y ?? 0, v: e.amount });
  }
}

async function scan(c: PressCfg, maxTicks: number): Promise<ScanResult> {
  await ready(c);
  const m = buildMatch(c);
  const moments: Moment[] = [];
  const hashes: [number, number][] = [];
  const phaseAt: [number, string][] = [];
  let phase = '';
  for (let i = 0; i < maxTicks && m.phase !== 'matchend'; i++) {
    m.step();
    momentsOf(m.events, m.tick, moments);
    if (m.tick % 300 === 0) hashes.push([m.tick, m.hash()]);
    if (m.phase !== phase) phaseAt.push([m.tick, (phase = m.phase)]);
  }
  return { moments, hashes, endTick: m.tick, phaseAt };
}

/** Advance a fresh match to tick `t` (silently, FxState kept in step for the audio's intensity). */
function matchAt(c: PressCfg, t: number, fx: FxState): Match {
  const m = buildMatch(c);
  fx.reset();
  while (m.tick < t && m.phase !== 'matchend') {
    m.step();
    fx.tick(m.events, m);
  }
  return m;
}

async function audio(c: PressCfg, t0: number, t1: number, prerollSec: number): Promise<AudioResult> {
  await ready(c);
  const pre = Math.round(prerollSec * 60);
  const start = Math.max(0, t0 - pre);
  // dry pass: the clip's length in audio time (KO slow motion and move time-scales stretch ticks, as in play)
  let seconds = 0;
  let clipStart = 0;
  {
    const fx = new FxState();
    const m = matchAt(c, start, fx);
    while (m.tick < t1 && m.phase !== 'matchend') {
      if (m.tick + 1 === t0) clipStart = seconds;
      m.step();
      seconds += TICK / Math.max(0.05, m.timeScale || 1);
    }
  }
  const total = seconds + 0.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * total), SR);
  const eng = createAudioEngine({ context: ctx, seed: c.seed });
  await eng.unlock();
  const fx = new FxState();
  const m = matchAt(c, start, fx);
  const times: number[] = [];
  let tickAt = 0;
  const step = (now: number): void => {
    while (tickAt <= now + TICK && m.tick < t1 && m.phase !== 'matchend') {
      m.step();
      const ev = m.events;
      fx.tick(ev, m);
      if (m.tick >= t0) times.push(+(tickAt - clipStart).toFixed(5));
      if (ev.length) eng.handleAt(ev, tickAt + 0.006);
      tickAt += TICK / Math.max(0.05, m.timeScale || 1);
    }
    const phase: AudioScene['phase'] = m.phase === 'matchend' ? 'results' : 'fight';
    const mid = (m.fighters[0].view.x + m.fighters[1].view.x) / 2;
    eng.updateAt(buildAudioScene(m, phase, fx.intensity(), mid), TICK, now + 0.15);
  };
  step(0);
  for (let t = TICK; t < total - TICK; t += TICK) {
    const at = t;
    void ctx.suspend(at).then(() => {
      step(at);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  return { wav: wavBase64(buf, clipStart, seconds - clipStart + 0.25), times, seconds: seconds - clipStart };
}

/** Stereo 16-bit WAV of [from, from + len) seconds, base64. */
function wavBase64(buf: AudioBuffer, from: number, len: number): string {
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const i0 = Math.max(0, Math.round(from * buf.sampleRate));
  const n = Math.min(l.length - i0, Math.round(len * buf.sampleRate));
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 4, true);
  const s16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, s16(l[i0 + i]!), true);
    dv.setInt16(46 + i * 4, s16(r[i0 + i]!), true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(bin);
}

declare global {
  interface Window {
    __press?: {
      scan: typeof scan;
      audio: typeof audio;
    };
  }
}
window.__press = { scan, audio };
