import { Rng } from '@/contracts';
import { generateImpulseResponse } from '@/audio/dsp/ir';
import { limiterCurve, midiToHz } from '@/audio/dsp/math';
import { boom, catastrophe, lowBell, roar, rumble, swell } from '@/audio/voices/epic';
import { GLASS, makeOut, noiseHit, partials, riser, tone, thump } from '@/audio/voices/synth';
import type { VoiceCtx } from '@/audio/voices/types';
import { CUE, type CueEvent } from '../../tools/press/sixty/cue';

/**
 * "WHAT'S LEFT" score worker (tools/press/sixty): the trailer's 60 s cue, played on the game's own instruments (the score's
 * taiko and heartbeat recipes, src/audio/voices synth + epic) into an OfflineAudioContext, through a hall built with the
 * engine's own impulse response and a limiter. The cue sheet is tools/press/sixty/cue.ts. Returns a 48 kHz stereo WAV.
 */
const SR = 48000;
const ROOT = 38; // D2, Phrygian: D Eb F G A Bb C
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const deg = (d: number, oct = 0): number => midiToHz(ROOT + 12 * (oct + Math.floor(d / 7)) + PHRYGIAN[((d % 7) + 7) % 7]!);

function wav(buf: AudioBuffer): string {
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * 4));
  const w = (o: number, s: string): void => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + n * 4, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, SR, true);
  out.setUint32(28, SR * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, n * 4, true);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i]!)) * 32767, true);
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i]!)) * 32767, true);
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(seconds = 60): Promise<{ wav: string; peak: number }> {
  const ac = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  // master: dry + hall → limiter → out
  const master = ac.createGain();
  master.gain.value = 0.9;
  const lim = ac.createWaveShaper();
  lim.curve = limiterCurve() as Float32Array<ArrayBuffer>;
  master.connect(lim);
  lim.connect(ac.destination);
  const dry = ac.createGain();
  dry.connect(master);
  const wet = ac.createGain();
  const [l, r] = generateImpulseResponse(SR, { decay: 4.2, preDelay: 0.03, seed: 60 });
  const ir = ac.createBuffer(2, l.length, SR);
  ir.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
  ir.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 110;
  const conv = ac.createConvolver();
  conv.normalize = false;
  conv.buffer = ir;
  const ret = ac.createGain();
  ret.gain.value = 0.32;
  wet.connect(hp);
  hp.connect(conv);
  conv.connect(ret);
  ret.connect(master);
  // shared noise, as the engine builds it
  const N = SR * 2;
  const white = ac.createBuffer(1, N, SR);
  const brown = ac.createBuffer(1, N, SR);
  const wd = white.getChannelData(0);
  const bd = brown.getChannelData(0);
  const nr = new Rng(6060);
  let last = 0;
  for (let i = 0; i < N; i++) {
    const x = nr.next() * 2 - 1;
    wd[i] = x;
    last = (last + 0.02 * x) / 1.02;
    bd[i] = last * 3.5;
  }
  const vr = new Rng(77);
  const c: VoiceCtx = {
    ac,
    dry,
    wet,
    noise: white,
    brown,
    rand: () => vr.next(),
    panOf: () => 0,
    take: () => true,
    release: () => {},
    timeScale: 1,
  };
  for (const e of CUE) play(c, e);
  const out = await ac.startRendering();
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) for (const v of out.getChannelData(ch)) peak = Math.max(peak, Math.abs(v));
  return { wav: wav(out), peak };
}

/** A sustained pad: detuned saws through a slowly opening low-pass (the drone under the intro and the hunt). */
function pad(c: VoiceCtx, t: number, dur: number, hz: number[], gain: number, lp0: number, lp1: number, wetAmt = 0.6): void {
  const ac = c.ac;
  const o = makeOut(c, 0, wetAmt);
  const f = ac.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.9;
  f.frequency.setValueAtTime(lp0, t);
  f.frequency.exponentialRampToValueAtTime(lp1, t + dur * 0.85);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(2.5, dur * 0.4));
  g.gain.setValueAtTime(gain, t + dur * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  f.connect(g);
  g.connect(o.input);
  for (const h of hz)
    for (const det of [-9, 0, 8]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = h;
      osc.detune.value = det;
      osc.connect(f);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
}

/** The score's taiko (src/audio/score/engine.ts `taiko`), on the cue's key. */
function taiko(c: VoiceCtx, t: number, v: number, hz: number, pan = 0): void {
  const o = makeOut(c, pan, 0.5);
  tone(c, o, t, { f0: hz * 1.9, f1: hz, dur: 0.55, gain: 0.3 * v, attack: 0.002, glide: 0.09 });
  tone(c, o, t, { f0: hz, f1: hz * 0.5, dur: 0.3, gain: 0.12 * v, type: 'triangle', attack: 0.002 });
  noiseHit(c, o, t, { dur: 0.09, gain: 0.16 * v, filter: { type: 'bandpass', f0: 260, q: 1.1 }, attack: 0.001 });
}

/** The score's heartbeat: lub, then a softer dub. `wrong` detunes it down and drags the dub (the sting's third heart). */
function heart(c: VoiceCtx, t: number, v: number, pan: number, wrong = false): void {
  const o = makeOut(c, pan, 0.12);
  const k = wrong ? 0.82 : 1;
  thump(c, o, t, midiToHz(ROOT + 12) * k, midiToHz(ROOT) * k, 0.26, 0.5 * v);
  thump(c, o, t + (wrong ? 0.34 : 0.2), midiToHz(ROOT + 12) * k * 0.94, midiToHz(ROOT) * k, 0.22, 0.32 * v);
}

/** A rising Shepard-ish tension: saws an octave apart gliding up, the top fading out as the bottom fades in. */
function shepard(c: VoiceCtx, t: number, dur: number, gain: number): void {
  const ac = c.ac;
  const o = makeOut(c, 0, 0.5);
  const f = ac.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(600, t);
  f.frequency.exponentialRampToValueAtTime(3200, t + dur);
  f.connect(o.input);
  for (let k = 0; k < 4; k++) {
    const h = deg(0, k - 1);
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(h, t);
    osc.frequency.exponentialRampToValueAtTime(h * 2, t + dur);
    const g = ac.createGain();
    const peak = gain * (k === 0 ? 0.6 : k === 3 ? 0.35 : 1) * 0.25;
    g.gain.setValueAtTime(k === 0 ? 0.0001 : peak * 0.3, t);
    g.gain.exponentialRampToValueAtTime(k === 3 ? 0.0001 : peak, t + dur);
    g.gain.setValueAtTime(0, t + dur + 0.005);
    osc.connect(g);
    g.connect(f);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

function play(c: VoiceCtx, e: CueEvent): void {
  const t = e.t;
  const v = e.v ?? 1;
  switch (e.k) {
    case 'heart':
      heart(c, t, v, e.pan ?? 0, e.wrong);
      break;
    case 'taiko':
      taiko(c, t, v, deg(e.d ?? 0, e.oct ?? 0), e.pan ?? 0);
      break;
    case 'sub': {
      const o = makeOut(c, 0, 0);
      thump(c, o, t, deg(0, 1), deg(0, -1), 0.42, 0.34 * v);
      break;
    }
    case 'perc': {
      const o = makeOut(c, e.pan ?? 0, 0.3);
      noiseHit(c, o, t, {
        dur: 0.07,
        gain: 0.07 * v,
        filter: { type: 'bandpass', f0: 1100, q: 1.2 },
        filter2: { type: 'lowpass', f0: 2600 },
        attack: 0.002,
      });
      break;
    }
    case 'bell': {
      const o = makeOut(c, e.pan ?? 0, 0.8);
      partials(c, o, t, deg(e.d ?? 0, e.oct ?? 2), GLASS, { decay: e.dur ?? 3, gain: 0.07 * v, shimmer: 0.3, maxHz: 2600 });
      break;
    }
    case 'lowbell': {
      const o = makeOut(c, 0, 0.7);
      lowBell(c, o, t, deg(e.d ?? 0, e.oct ?? 0), GLASS, { decay: e.dur ?? 5, gain: 0.25 * v });
      break;
    }
    case 'boom': {
      const o = makeOut(c, 0, 0.15);
      boom(c, o, t, { f0: deg(0, 0) * 1.5, f1: deg(0, -1), dur: e.dur ?? 1.4, gain: 0.7 * v, drive: 3.2 });
      break;
    }
    case 'braam': {
      const o = makeOut(c, 0, 0.45);
      for (const [d, oct, g] of [
        [0, -1, 1],
        [0, 0, 0.7],
        [4, -1, 0.5],
      ] as const)
        roar(c, o, t, {
          f: deg(d, oct),
          dur: e.dur ?? 2.2,
          gain: 0.5 * v * g,
          attack: 0.03,
          lp0: 2400,
          lp1: 380,
          detune: 14,
          noise: 0.2,
        });
      break;
    }
    case 'pad':
      pad(c, t, e.dur ?? 8, (e.chord ?? [0, 4]).map((d) => deg(d, e.oct ?? -1)), 0.05 * v, e.lp0 ?? 180, e.lp1 ?? 900);
      break;
    case 'drone': {
      const o = makeOut(c, 0, 0.5);
      swell(c, o, t, { dur: e.dur ?? 8, gain: 0.5 * v, f0: 90, f1: 420, sub: 0.6, subHz: deg(0, -1) });
      break;
    }
    case 'rumble': {
      const o = makeOut(c, 0, 0.4);
      rumble(c, o, t, { dur: e.dur ?? 4, gain: 0.35 * v, f0: 500, f1: 90, rate: 0.8, attack: 0.05 });
      break;
    }
    case 'riser': {
      const o = makeOut(c, 0, 0.5);
      riser(c, o, t, e.dur ?? 2, 0.18 * v, 300, 5200);
      break;
    }
    case 'shepard':
      shepard(c, t, e.dur ?? 4, v);
      break;
    case 'impact': {
      const sub = makeOut(c, 0, 0.1);
      const o = makeOut(c, 0, 0.6);
      catastrophe(c, sub, o, t, { pre: 0, size: 1, gain: v, f0: deg(0, -1) * 1.4 });
      break;
    }
    case 'suck': {
      const o = makeOut(c, 0, 0.5);
      noiseHit(c, o, t, { dur: e.dur ?? 0.9, gain: 0.3 * v, kind: 'brown', filter: { type: 'lowpass', f0: 4000, f1: 140, q: 1.4 }, attack: e.dur ?? 0.9 });
      break;
    }
  }
}

declare global {
  interface Window {
    __sixty?: { render: typeof render };
  }
}
window.__sixty = { render };
