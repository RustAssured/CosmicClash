/**
 * ADEUK: TITANS: the prologue's ambient soundscape (opt-in, plain WebAudio, no files, no dependencies).
 *
 * A vast, low drone that slowly evolves:
 *  - a choir of detuned low saws on D (A1 D2 A2 D3), with a filter that breathes;
 *  - a deep wind of brown noise that heaves;
 *  - a tanh saturator, so laptop speakers hear the harmonics of a fundamental they cannot play.
 * Every 20–45 s, light from a collision far away arrives: first a faint, dark flash, and then, 1.5–3 s later (the light-travel
 * delay of the prologue's first beat), the sound itself: a deep, distant boom with a long rumble in a dark space.
 * Nothing is tonal above ~1 kHz, so there are no whistles. The level is about −23 LUFS (measured offline).
 *
 *   import { start, stop } from './ambient.js';
 *   button.onclick = () => (playing ? stop() : start());   // start() only from a user gesture (autoplay rules)
 *
 * `build(ctx, destination)` is the same graph for an OfflineAudioContext (measurement); it returns { stop(at) }.
 */

const FADE_IN = 4;
const FADE_OUT = 1.8;
/** Output level (linear) before the fade; calibrated to about −23 LUFS integrated over a minute with two arrivals. */
const LEVEL = 0.8;

let ctx = null;
let live = null;

function noiseBuffer(ac, seconds, brown) {
  const n = Math.floor(ac.sampleRate * seconds);
  const b = ac.createBuffer(1, n, ac.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return b;
}

function saturator(ac, drive) {
  const s = ac.createWaveShaper();
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(drive * ((i / (n - 1)) * 2 - 1)) / Math.tanh(drive);
  s.curve = c;
  return s;
}

/** A dark space: a few seconds of decaying, darkening noise as a convolver impulse response. */
function cavern(ac, seconds) {
  const n = Math.floor(ac.sampleRate * seconds);
  const b = ac.createBuffer(2, n, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const a = 0.25 * Math.pow(0.04 / 0.25, Math.min(1, t * 2.5)); // the tail loses its highs first
      y += a * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp(-6.9 * t) * 0.6;
    }
  }
  return b;
}

/** Build the soundscape into `dest` on `ac`, starting at `ac.currentTime`. */
export function build(ac, dest) {
  const t0 = ac.currentTime;
  const nodes = [];
  const keep = (n) => (nodes.push(n), n);

  const out = ac.createGain();
  out.gain.value = 0;
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(LEVEL, t0 + FADE_IN);
  const hp = ac.createBiquadFilter(); // nothing a speaker cannot play may eat the headroom
  hp.type = 'highpass';
  hp.frequency.value = 38;
  out.connect(hp);
  hp.connect(dest);
  const space = ac.createConvolver();
  space.buffer = cavern(ac, 4);
  const spaceRet = ac.createGain();
  spaceRet.gain.value = 0.9;
  space.connect(spaceRet);
  spaceRet.connect(out);

  // the drone: low detuned saws, saturated, through a breathing low-pass
  const sat = saturator(ac, 2.4);
  const droneLp = ac.createBiquadFilter();
  droneLp.type = 'lowpass';
  droneLp.frequency.value = 480;
  droneLp.Q.value = 0.9;
  const drone = ac.createGain();
  drone.gain.value = 0.11;
  sat.connect(droneLp);
  droneLp.connect(drone);
  drone.connect(out);
  const dsend = ac.createGain();
  dsend.gain.value = 0.35;
  drone.connect(dsend);
  dsend.connect(space);
  const pre = ac.createGain();
  pre.gain.value = 0.22;
  pre.connect(sat);
  for (const [f, cents] of [
    [55, -7],
    [55, 6],
    [73.42, -4],
    [73.42, 9],
    [110, 3],
    [146.83, -5],
  ]) {
    const o = keep(ac.createOscillator());
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.detune.value = cents;
    o.connect(pre);
  }
  // two slow, unrelated breaths of the filter and the level: the drone never quite repeats
  const lfo = (rate, depth, param) => {
    const o = keep(ac.createOscillator());
    o.frequency.value = rate;
    const g = ac.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(param);
  };
  lfo(0.031, 200, droneLp.frequency);
  lfo(0.047, 0.035, drone.gain);

  // the wind of the void: brown noise in a low band that drifts, heaving slowly
  const wind = keep(ac.createBufferSource());
  wind.buffer = noiseBuffer(ac, 6, true);
  wind.loop = true;
  const wbp = ac.createBiquadFilter();
  wbp.type = 'bandpass';
  wbp.frequency.value = 300;
  wbp.Q.value = 0.7;
  const wg = ac.createGain();
  wg.gain.value = 0.16;
  wind.connect(wbp);
  wbp.connect(wg);
  wg.connect(out);
  wg.connect(dsend);
  lfo(0.019, 90, wbp.frequency);
  lfo(0.07, 0.06, wg.gain);

  // far collisions: a faint dark flash, then (light-travel delay) the sound of it
  const white = noiseBuffer(ac, 2, false);
  const brown = noiseBuffer(ac, 4, true);
  const arrival = (at) => {
    const pan = Math.random() * 1.4 - 0.7;
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    p.connect(out);
    const send = ac.createGain();
    send.gain.value = 1.2;
    p.connect(send);
    send.connect(space);
    // the flash: a soft, dark tick of light
    const fl = ac.createBufferSource();
    fl.buffer = white;
    const flp = ac.createBiquadFilter();
    flp.type = 'lowpass';
    flp.frequency.value = 900;
    const fg = ac.createGain();
    fg.gain.setValueAtTime(0, at);
    fg.gain.linearRampToValueAtTime(0.05, at + 0.004);
    fg.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    fl.connect(flp);
    flp.connect(fg);
    fg.connect(p);
    fl.start(at, Math.random());
    fl.stop(at + 0.3);
    // ... and, late, the boom: a body falling in pitch, saturated, and a long rumble
    const b = at + 1.5 + Math.random() * 1.5;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(90, b);
    o.frequency.exponentialRampToValueAtTime(32, b + 1.4);
    const og = ac.createGain();
    og.gain.setValueAtTime(0, b);
    og.gain.linearRampToValueAtTime(0.7, b + 0.06);
    og.gain.exponentialRampToValueAtTime(0.0001, b + 2.6);
    const bs = saturator(ac, 2.6);
    const blp = ac.createBiquadFilter();
    blp.type = 'lowpass';
    blp.frequency.setValueAtTime(700, b);
    blp.frequency.exponentialRampToValueAtTime(160, b + 2);
    const bg = ac.createGain();
    bg.gain.value = 0.22;
    o.connect(og);
    og.connect(bs);
    bs.connect(blp);
    blp.connect(bg);
    bg.connect(p);
    o.start(b);
    o.stop(b + 2.7);
    const r = ac.createBufferSource();
    r.buffer = brown;
    const rlp = ac.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.setValueAtTime(380, b);
    rlp.frequency.exponentialRampToValueAtTime(70, b + 3.8);
    const rg = ac.createGain();
    rg.gain.setValueAtTime(0, b);
    rg.gain.linearRampToValueAtTime(0.35, b + 0.25);
    rg.gain.exponentialRampToValueAtTime(0.0001, b + 3.9);
    r.connect(rlp);
    rlp.connect(rg);
    rg.connect(p);
    r.start(b, Math.random() * 0.1);
    r.stop(b + 4);
    o.onended = () => setTimeout(() => p.disconnect(), 4000);
  };
  // the first arrival comes early (the prologue's first beat), the rest at long, uneven intervals
  let next = t0 + 7;
  let timer = null;
  const schedule = () => {
    while (next < ac.currentTime + 60) {
      arrival(next);
      next += 20 + Math.random() * 25;
    }
  };
  schedule();
  const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
  if (!offline) timer = setInterval(schedule, 15000);

  for (const n of nodes) n.start(t0);
  return {
    stop(at = ac.currentTime) {
      if (timer) clearInterval(timer);
      out.gain.cancelScheduledValues(at);
      out.gain.setValueAtTime(out.gain.value, at);
      out.gain.linearRampToValueAtTime(0, at + FADE_OUT);
      for (const n of nodes) n.stop(at + FADE_OUT + 0.05);
    },
  };
}

/** Start the soundscape (call from a click: browsers only allow sound after a user gesture). Fades in over a few seconds. */
export async function start() {
  if (live) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  ctx ??= new Ctor({ latencyHint: 'playback' });
  if (ctx.state === 'suspended') await ctx.resume();
  live = build(ctx, ctx.destination);
}

/** Fade the soundscape out and let the context sleep. */
export function stop() {
  if (!live || !ctx) return;
  live.stop();
  live = null;
  const c = ctx;
  setTimeout(
    () => {
      if (!live && c.state === 'running') void c.suspend();
    },
    (FADE_OUT + 0.2) * 1000,
  );
}
