import { BELL, GLASS, makeOut, noiseHit, partials, tone } from '@/audio/voices/synth';
import { boom, catastrophe, crackle, grind, lowBell, roar, swell, whoosh } from '@/audio/voices/epic';
import { ceramicFracture, filamentSnap, resonance, tectonicCrack } from '@/audio/voices/materials';
import { designCtx, drone, wetSound } from './audio-trailer';

/**
 * The launch trailer v3's score and sound (docs/cinema/TRAILER_V3.md §1, §2.3), rendered offline by the game's own synth from a
 * PLAN that tools/ui/audio-cinema.ts derives from src/cinema/timeline.json (shot starts, the genesis weld and drum cues, the edge
 * word cues). Every time is snapped to a 60 fps frame, so each hit lands on its frame.
 *
 * Five stems, rendered one at a time (`renderCinemaStem`): drone (pads, roars, the room tone, the wet far-away), motifs (우리:
 * two notes a fifth apart, one per world, gaining layers as the body is built; the Witness: glassy, high, a close dissonance;
 * the Mouth: sub and wet noise, no pitch), percussion (the two hearts, the genesis drums on the weld cues, the hunt's beat,
 * the edge's word blows, the sting), SFX (designed beats; the Act III gameplay slots stay empty until S5's takes exist) and VO
 * (an empty slot: WJ's "우리는 아직 여기 있다" may come later; subtitle only for now).
 * The two HARD silences gate everything but the room tone (the first lets the bite's own ring-out through).
 */
export interface CinemaPlan {
  duration: number;
  fps: number;
  /** Shot id → [start, end] (timeline seconds). */
  shots: Record<string, [number, number]>;
  /** The genesis: one drum per part as it completes (two per fist), every chunk's weld. */
  drums: { t: number; part: string; size: number; clench?: number }[];
  welds: number[];
  /** Act IV: one word per coil pass. */
  words: { word: string; t: number }[];
  /** Hard silences: [from, to, ringOut] (ringOut: the SFX stem's own tail may pass). */
  silences: [number, number, boolean][];
}

export type StemName = 'drone' | 'motifs' | 'perc' | 'sfx' | 'vo';
export const STEMS: readonly StemName[] = ['drone', 'motifs', 'perc', 'sfx', 'vo'];

const SR = 48000;
/** 우리's two notes: world A (D3) and world B, a fifth above (A3). */
const URI_A = 146.83;
const URI_B = 220;

/** A placed cue, for the report: where the score put it (s). */
export interface PlacedCue {
  stem: StemName;
  name: string;
  /** The cue as its source gives it, and where it was placed (snapped to its frame). */
  cue: number;
  at: number;
}

export async function renderCinemaStem(
  plan: CinemaPlan,
  stem: StemName,
): Promise<{ left: Float32Array; right: Float32Array; cues: PlacedCue[] }> {
  const N = Math.ceil(SR * plan.duration);
  const ctx = new OfflineAudioContext(2, N, SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const gated = ctx.createGain(); // everything but the room tone passes the silences' gate
  gated.connect(out);
  const c = designCtx(ctx, gated, 31 + STEMS.indexOf(stem));
  const cues: PlacedCue[] = [];
  const fr = (t: number): number => Math.round(t * plan.fps) / plan.fps;
  // a source cue (a weld, a word) is first SEEN on the first frame at or after it: its sound lands on that frame
  const seen = (t: number): number => Math.ceil(t * plan.fps - 1e-6) / plan.fps;
  const S = (id: string, dt = 0): number => fr((plan.shots[id]?.[0] ?? 0) + dt);
  const E = (id: string): number => fr(plan.shots[id]?.[1] ?? 0);
  const has = (id: string): boolean => plan.shots[id] !== undefined;
  const cue = (name: string, t: number, at = fr(t)): number => {
    cues.push({ stem, name, cue: +t.toFixed(4), at: +at.toFixed(4) });
    return at;
  };
  const hearts = (from: number, to: number, gain: number, wrongAt?: number): void => {
    // two hearts, out of phase: L lub-dub, and R a little later and a little slower
    // (periods and phase in whole frames: every beat is a frame)
    for (const [pan, period, phase] of [
      [-0.7, 52 / 60, 0],
      [0.7, 56 / 60, 19 / 60],
    ] as const) {
      for (let t = from + phase; t < to - 0.2; t += period) {
        const at = cue(`heart ${pan < 0 ? 'L' : 'R'}`, t);
        boom(c, makeOut(c, pan, 0.05), at, { f0: 62, f1: 38, dur: 0.32, gain, crunch: 0.5, click: 0.05 });
        boom(c, makeOut(c, pan, 0.05), fr(at + 0.24), {
          f0: 54,
          f1: 34,
          dur: 0.26,
          gain: gain * 0.6,
          crunch: 0.4,
        });
      }
    }
    if (wrongAt !== undefined) {
      // the third heart: wrong. Late, detuned, and it does not resolve
      const at = cue('heart (the wrong third)', wrongAt);
      boom(c, makeOut(c, 0, 0.6), at, {
        f0: 71,
        f1: 44,
        dur: 0.9,
        gain: gain * 1.15,
        crunch: 0.8,
        drive: 3.8,
      });
      tone(c, makeOut(c, 0, 0.6), at, { f0: 77.8, f1: 69, dur: 1.4, gain: 0.08, attack: 0.01 });
    }
  };
  /** 우리's motif: world A's note, world B's a fifth above; `layers` 1..5 add the octave, the choir, the sub, the twelfth. */
  const uriMotif = (at: number, layers: number, gain: number, cut?: number): void => {
    const phrase = [
      [0, URI_A],
      [0.9, URI_B],
      [1.8, URI_A],
      [2.25, URI_B],
    ] as const;
    for (const [dt, f] of phrase) {
      const t = fr(at + dt);
      if (cut !== undefined && t >= cut) break; // the motif stops mid-phrase
      const o = makeOut(c, f === URI_A ? -0.35 : 0.35, 0.7);
      lowBell(c, o, t, f, BELL, { decay: 2.2, gain: gain, shimmer: 0.3 });
      if (layers >= 2) lowBell(c, o, t, f / 2, BELL, { decay: 2.6, gain: gain * 0.7 });
      if (layers >= 3)
        roar(c, o, t, { f: f / 2, dur: 1.6, gain: gain * 0.5, attack: 0.25, lp0: 700, lp1: 300, noise: 0 });
      if (layers >= 4)
        tone(c, o, t, { f0: f / 4, dur: 1.8, gain: gain * 0.9, attack: 0.05, type: 'triangle' });
      if (layers >= 5) lowBell(c, o, t, f * 1.5, BELL, { decay: 1.6, gain: gain * 0.5, shimmer: 0.4 });
    }
  };
  /** The Witness: glassy and high, two rings a quarter-tone apart that beat against each other. */
  const witness = (at: number, dur: number, gain: number): void => {
    const o = makeOut(c, 0.2, 0.9);
    for (const [f, d] of [
      [1318.5, 0],
      [1357, 0.04],
      [987.8, 0.5],
      [1017, 0.56],
    ] as const)
      partials(c, o, fr(at + d), f, GLASS, {
        decay: Math.max(0.5, dur - d),
        gain,
        shimmer: 0.5,
        maxHz: 5000,
      });
  };
  /** The Mouth: no pitch. A sub that sinks, and wet noise. */
  const mouth = (from: number, to: number, gain: number): void => {
    swell(c, makeOut(c, 0, 0.3), from, {
      dur: to - from,
      gain: gain * 0.3,
      f0: 50,
      f1: 220,
      sub: gain,
      subHz: 30,
    });
    const o = makeOut(c, -0.2, 0.8);
    noiseHit(c, o, from, {
      dur: to - from,
      gain: gain * 0.9,
      kind: 'brown',
      filter: { type: 'bandpass', f0: 140, f1: 70, q: 3 },
      attack: (to - from) * 0.4,
    });
  };

  switch (stem) {
    case 'drone': {
      // the room tone: never gated (the silences are room tone, not digital zero)
      const room = ctx.createBufferSource();
      room.buffer = c.brown;
      room.loop = true;
      const rl = ctx.createBiquadFilter();
      rl.type = 'lowpass';
      rl.frequency.value = 300;
      const rg = ctx.createGain();
      rg.gain.value = 0.008;
      room.connect(rl);
      rl.connect(rg);
      rg.connect(out);
      room.start(0);
      // ACT 0: a low roar under the hearts from the matter pixel, the inhale, and silence at the freeze
      if (has('cold-matter-pixel'))
        roar(c, makeOut(c, 0, 0.4), S('cold-matter-pixel'), {
          f: 36.7,
          dur: E('cold-pullback') - S('cold-matter-pixel'),
          gain: 0.12,
          attack: 1,
          lp0: 300,
          lp1: 700,
        });
      if (has('cold-pullback'))
        swell(c, makeOut(c, 0, 0.3), S('cold-pullback'), {
          dur: E('cold-pullback') - S('cold-pullback'),
          gain: 0.18,
          f0: 80,
          f1: 900,
        });
      // ACT I: a soft pad under the two worlds, fading as the halo rises
      const lv: [number, number][] = [
        [0, 0],
        [S('before-two-worlds'), 0],
        [S('before-two-worlds', 2), 0.09],
        [S('before-halo-rise', 1), 0.07],
        [E('before-gaze'), 0.05],
        [E('before-bite') - 1.5, 0.04],
        [S('build-genesis'), 0.03],
        [S('build-genesis', 3), 0.08],
        [S('build-brace'), 0.12],
        [S('hunt-burst'), 0.12],
        [S('hunt-nova'), 0.05],
        [E('hunt-beams'), 0.1],
        [S('edge-wide'), 0],
        [S('edge-title'), 0],
        [S('edge-title', 0.1), 0.1],
        [E('edge-title'), 0.02],
        [plan.duration, 0],
      ];
      drone(
        c,
        lv.sort((a, b) => a[0] - b[0]),
        plan.duration,
      );
      // ACT IV: something wet, far away; the coils
      if (has('edge-slide')) wetSound(c, S('edge-slide'), S('edge-wipe'));
      break;
    }
    case 'motifs': {
      // ACT I: 우리 first, two notes (one per world) on the pad; it stops mid-phrase when the halo rises
      if (has('before-two-worlds')) {
        uriMotif(S('before-two-worlds', 0.6), 1, 0.06);
        cue('우리 motif (stops mid-phrase)', S('before-two-worlds', 3.2));
        uriMotif(S('before-two-worlds', 3.2), 1, 0.06, S('before-halo-rise'));
      }
      if (has('before-eye')) witness(cue('Witness motif', S('before-eye')), 4, 0.03);
      if (has('before-mouth-edge'))
        mouth(cue('Mouth motif', S('before-mouth-edge')), S('before-bite', 0.5), 0.5);
      // ACT II: 우리 returns as the body is built: one more layer for every few parts
      if (has('build-assembly')) {
        const parts = plan.drums.filter((d) => d.part !== 'loop');
        parts.forEach((d, i) => {
          if (i % 3 !== 0) return;
          uriMotif(fr(d.t), 1 + Math.floor((4 * i) / Math.max(1, parts.length - 1)), 0.05, S('build-brace'));
        });
      }
      if (has('build-brace')) uriMotif(cue('우리 motif, full', S('build-brace', 0.3)), 5, 0.08);
      // ACT III: the full score; it ducks to the hearts in the nova, and the two motifs collide at the eye
      if (has('hunt-burst'))
        for (let t = S('hunt-burst'); t < S('hunt-nova') - 1; t += 2.4)
          uriMotif(fr(t), 5, 0.07, S('hunt-nova'));
      if (has('hunt-eye')) {
        witness(cue('Witness motif (collides)', S('hunt-eye')), 5, 0.035);
        uriMotif(S('hunt-eye', 0.45), 4, 0.07, S('hunt-black'));
      }
      if (has('before-mouth-edge') && has('edge-slide')) mouth(S('edge-pullback'), S('edge-wipe'), 0.4);
      break;
    }
    case 'perc': {
      if (has('cold-heartbeats')) hearts(S('cold-heartbeats'), S('cold-adeuk'), 0.5);
      // the genesis: a drum on every part's weld; the fists' two clenches are heavy hits
      for (const d of plan.drums) {
        const at = cue(`drum ${d.part}${d.clench ? ` clench ${d.clench}` : ''}`, d.t, seen(d.t));
        const big = d.clench !== undefined || d.part === 'loop' || d.size > 6000;
        boom(c, makeOut(c, 0, 0.3), at, {
          f0: big ? 96 : 120,
          f1: big ? 32 : 50,
          dur: big ? 1.2 : 0.5,
          gain: big ? 0.75 : 0.4,
          drive: 3,
          crunch: 2.4,
        });
      }
      // ACT III: the beat, on a grid that starts on the bars' burst; it drops to the hearts in the nova
      if (has('hunt-burst')) {
        const bpm = 104;
        const beat = 60 / bpm;
        let i = 0;
        for (let t = S('hunt-burst'); t < S('hunt-nova') - 0.05; t += beat, i++) {
          const at = fr(t);
          const down = i % 4 === 0;
          if (down) cue('hunt downbeat', t, at);
          boom(c, makeOut(c, 0, 0.2), at, {
            f0: down ? 100 : 130,
            f1: down ? 38 : 60,
            dur: down ? 0.6 : 0.25,
            gain: down ? 0.5 : 0.22,
            crunch: 2,
          });
        }
        hearts(S('hunt-nova'), S('hunt-eye'), 0.4);
        // the riser into the punch, cut dead a frame before it
        swell(c, makeOut(c, 0, 0.4), S('hunt-beams'), {
          dur: S('hunt-black') - S('hunt-beams'),
          gain: 0.35,
          f0: 70,
          f1: 1100,
          sub: 0.25,
        });
      }
      // ACT IV: one blow per word; the bite; the title's final hit; the sting
      for (const w of plan.words) {
        const at = cue(`word ${w.word}`, w.t, seen(w.t));
        boom(c, makeOut(c, 0, 0.5), at, { f0: 84, f1: 28, dur: 1.4, gain: 0.8, drive: 3.6, crunch: 2.6 });
      }
      if (has('edge-title')) {
        const at = cue('title hit', S('edge-title'));
        catastrophe(c, makeOut(c, 0, 0.15), makeOut(c, 0, 0.9), at, { pre: 0, size: 0.7, gain: 0.8 });
      }
      if (has('edge-sting')) {
        const s = S('edge-sting');
        hearts(s, s + 0.75, 0.5);
        hearts(s, s, 0.5, s + 0.78);
      }
      break;
    }
    case 'sfx': {
      // ACT I: the gaze (beam sizzle) and the crust cracking under it; the bite and its ring-out
      if (has('before-gaze')) {
        const g = cue('gaze beam', S('before-gaze'));
        roar(c, makeOut(c, 0.3, 0.6), g, {
          f: 73.4,
          dur: 2.6,
          gain: 0.12,
          attack: 0.05,
          lp0: 1300,
          lp1: 400,
        });
        crackle(c, makeOut(c, 0.2, 0.5), g + 0.3, { dur: 2.4, count: 30, gain: 0.12, f: 1300 });
        for (const dt of [0.6, 1.3, 2.1])
          tectonicCrack(c, makeOut(c, -0.2, 0.5), fr(g + dt), 0.8, resonance(0.9));
        ceramicFracture(c, makeOut(c, 0, 0.5), fr(g + 1.3), 0.6, resonance(1));
      }
      if (has('before-mouth-edge')) {
        const m = S('before-mouth-edge');
        boom(c, makeOut(c, 0, 0.2), cue('sub drop (the Mouth)', m), {
          f0: 70,
          f1: 24,
          dur: 2,
          gain: 0.5,
          drive: 3,
        });
        grind(c, makeOut(c, -0.6, 0.6), m + 0.4, { dur: 1.6, gain: 0.12, f0: 160, f1: 90, rate: 4 });
      }
      if (has('before-bite')) {
        const b = cue('the bite (impact; Silence #1 follows)', S('before-bite', 0.5));
        whoosh(c, fr(b - 0.45), {
          dur: 0.45,
          gain: 0.25,
          panFrom: -0.6,
          panTo: 0.2,
          wet: 0.3,
          f0: 900,
          f1: 150,
        });
        catastrophe(c, makeOut(c, 0, 0.2), makeOut(c, 0, 0.6), b, { pre: 0, size: 0.4, gain: 0.95 });
      }
      // ACT II: the ignition (a rising ringing whoosh) and a clank on every weld
      if (has('build-genesis')) {
        const loop = plan.drums.find((d) => d.part === 'loop')?.t ?? S('build-genesis', 3);
        swell(c, makeOut(c, 0, 0.6), S('build-genesis'), {
          dur: fr(loop) - S('build-genesis'),
          gain: 0.25,
          f0: 90,
          f1: 1000,
          sub: 0.12,
        });
        lowBell(c, makeOut(c, 0, 0.9), fr(loop), 110, BELL, { decay: 3, gain: 0.1, shimmer: 0.5 });
      }
      let last = -1;
      for (const w of plan.welds) {
        const at = fr(w);
        if (at - last < 0.03) continue; // a weld per frame at most
        last = at;
        lowBell(c, makeOut(c, (c.rand() - 0.5) * 0.8, 0.4), at, 180 + 120 * c.rand(), BELL, {
          decay: 0.35,
          gain: 0.025,
        });
      }
      // the launch at the camera
      if (has('build-launch'))
        whoosh(c, S('build-launch'), {
          dur: 1.6,
          gain: 0.3,
          panFrom: 0,
          panTo: 0,
          wet: 0.4,
          f0: 1000,
          f1: 120,
          body: 1.4,
        });
      // ACT III: the gameplay SFX come from S5's takes (empty slots until then); the bars' burst gets a designed hit
      if (has('hunt-burst')) {
        const h = cue('bars burst (first gameplay hit; game SFX slot)', S('hunt-burst'));
        boom(c, makeOut(c, 0, 0.2), h, { f0: 100, f1: 30, dur: 1.4, gain: 0.85, drive: 3.6, crunch: 3 });
      }
      // ACT IV: the jaw-rings close over the camera: the bite, then black
      if (has('edge-wipe')) {
        const w = S('edge-wipe');
        grind(c, makeOut(c, 0, 0.5), w, {
          dur: E('edge-wipe') - w - 0.3,
          gain: 0.2,
          f0: 300,
          f1: 90,
          rate: 9,
        });
        const bite = cue('jaw wipe bite', E('edge-wipe') - 0.35);
        boom(c, makeOut(c, 0, 0.3), bite, { f0: 110, f1: 30, dur: 0.6, gain: 0.7, drive: 3.6, crunch: 3 });
        filamentSnap(c, makeOut(c, 0, 0.4), bite, 70, 1, resonance(0.4));
      }
      break;
    }
    case 'vo':
      // WJ's whispered line (우리는 아직 여기 있다) has its slot at the brace; until it is recorded, the subtitle carries it
      cue('VO slot (empty): 우리는 아직 여기 있다', S('build-brace', 0.5));
      break;
  }
  // the HARD silences: everything but the room tone (and, on the first, the bite's own ring-out) is cut
  // (windows that touch are merged first: two gates back to back must not reopen for a moment between them)
  const windows: [number, number][] = [];
  for (const [a, b, ringOut] of [...plan.silences].sort((x, y) => x[0] - y[0])) {
    if (ringOut && stem === 'sfx') continue;
    const last = windows[windows.length - 1];
    if (last && a <= last[1] + 0.05) last[1] = Math.max(last[1], b);
    else windows.push([a, b]);
  }
  for (const [a, b] of windows) {
    gated.gain.setValueAtTime(1, a - 0.01);
    gated.gain.linearRampToValueAtTime(0, a);
    gated.gain.setValueAtTime(0, b);
    gated.gain.linearRampToValueAtTime(1, b + 0.02);
  }
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0), right: buf.getChannelData(1), cues };
}
