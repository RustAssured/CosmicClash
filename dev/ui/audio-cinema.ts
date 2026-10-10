import type { SimEvent } from '@/contracts';
import { DamageFlag } from '@/contracts';
import { createAudioEngine, laptopVoicing } from '@/audio/engine';
import { BELL, GLASS, makeOut, noiseHit, partials, tone } from '@/audio/voices/synth';
import {
  boom,
  catastrophe,
  crackle,
  grind,
  lowBell,
  roar,
  saturationCurve,
  swell,
  whoosh,
} from '@/audio/voices/epic';
import { filamentSnap, resonance } from '@/audio/voices/materials';
import { FxState, buildAudioScene } from '@/app/fx';
import { buildShotMatch } from '@/cinema/match';
import { sceneTime, type Shot } from '@/cinema/timeline';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';
import { designCtx, drone, wetSound } from './audio-trailer';

/**
 * The launch trailer v3's score and sound (docs/cinema/TRAILER_V3.md §1, §2.3), rendered offline by the game's own synth from a
 * PLAN that tools/ui/audio-cinema.ts derives from src/cinema/timeline.json (the beats as named anchors, the genesis weld and drum
 * cues, the edge word cues, the hard silences, and every shot that has a real fight). Every sound lands on its 60 fps frame.
 *
 * Five stems, rendered one at a time (`renderCinemaStem`):
 *  - drone: the room tone (never gated), the roars, the pads, the wet far-away;
 *  - motifs: 우리 (two notes a fifth apart, one per world, gaining layers as the body is built), the Witness (glassy, high, a
 *    close dissonance), the Mouth (sub and wet noise, no pitch);
 *  - perc: the two hearts, the genesis drums on the weld cues, the hunt's beat, the word blows, the sting;
 *  - sfx: the REAL sound of every fight shot (each shot's match replayed exactly as the Director plays it, its sim events fed
 *    to the game's audio engine on the frame they are first drawn), plus the designed beats (the bite, the ignition, the welds,
 *    the launch, the jaw wipe);
 *  - vo: an empty slot (WJ's "우리는 아직 여기 있다"; subtitle only for now).
 * The two HARD silences gate everything but the room tone (the first lets the bite's own ring-out through).
 * Small speakers: every stem goes out through the game's own laptop voicing (LAPTOP_EQ + the WEIGHT harmonics of the sub) and a
 * gentle upper-mid exciter (harmonics of the 0.9–3.5 kHz band above 1.8 kHz), so the mix carries on a laptop or a phone while
 * the real sub stays.
 */
export interface CinemaAnchors {
  /** Act 0: the hearts, the matter pixel's roar, the inhale (the pull-back) and the freeze. */
  cold: number;
  roar: number;
  inhale: [number, number];
  freeze: number;
  /** Act I. */
  worlds: [number, number];
  halo: number;
  eye: number;
  gaze: [number, number];
  mouth: number;
  bite: number;
  /** Act II. */
  ruin: number;
  genesis: number;
  loop: number;
  brace: number;
  launch: number;
  /** Act III. */
  burst: number;
  nova: [number, number];
  eyeHunt: number;
  beams: number;
  black: number;
  /** Act IV. */
  edge: number;
  slide: number;
  pull: [number, number];
  wipe: [number, number];
  title: number;
  sting: number;
}

export interface CinemaPlan {
  duration: number;
  fps: number;
  a: CinemaAnchors;
  /** The genesis: one drum per part as it completes (two per fist), every chunk's weld. */
  drums: { t: number; part: string; size: number; clench?: number }[];
  welds: number[];
  /** Act IV: one word per coil pass. */
  words: { word: string; t: number }[];
  /** Hard silences: [from, to, ringOut] (ringOut: the SFX stem's own tail may pass). */
  silences: [number, number, boolean][];
  /** Every shot with a real fight (as in timeline.json), with the game sound's level in it. */
  fights: { shot: Shot; level: number }[];
}

export type StemName = 'drone' | 'motifs' | 'perc' | 'sfx' | 'vo';
export const STEMS: readonly StemName[] = ['drone', 'motifs', 'perc', 'sfx', 'vo'];

const SR = 48000;
/** 우리's two notes: world A (D3) and world B, a fifth above (A3). */
const URI_A = 146.83;
const URI_B = 220;

/** A placed cue, for the report: where its source puts it and where the score put it (s). */
export interface PlacedCue {
  stem: StemName;
  name: string;
  cue: number;
  at: number;
}

/** The small-speaker pass: the game's laptop voicing plus an upper-mid exciter, `from` → `to`. */
function smallSpeakerPass(ac: BaseAudioContext, from: AudioNode, to: AudioNode): void {
  laptopVoicing(ac, from, to);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.6;
  const drive = ac.createGain();
  drive.gain.value = 4;
  const sh = ac.createWaveShaper();
  sh.curve = saturationCurve(2.2) as Float32Array<ArrayBuffer>;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 6500;
  const lvl = ac.createGain();
  lvl.gain.value = 0.22;
  from.connect(bp);
  bp.connect(drive);
  drive.connect(sh);
  sh.connect(hp);
  hp.connect(lp);
  lp.connect(lvl);
  lvl.connect(to);
}

/**
 * One sim tick of a shot's fight exactly as the Director ticks it (src/cinema/director.ts `tickMatch`): the step, then the
 * shot's injected blows (`match.blows`: real damage, plus the shockwave / flash / shake / hit-stop a blow of that weight sends).
 */
function tickShot(
  m: ReturnType<typeof buildShotMatch>,
  fx: FxState,
  shot: Shot,
  absTick: number,
): SimEvent[] {
  m.step();
  let ev: SimEvent[] = [...(m.events as readonly SimEvent[])];
  for (const b of (shot.match?.blows ?? []).filter((x) => x.tick === absTick)) {
    const f = m.fighters[b.slot];
    const x = f.view.x + b.dx;
    const y = f.view.y + b.dy;
    const len = Math.hypot(b.dirX, b.dirY) || 1;
    m.world.applyDamage(f.body.id, {
      type: b.type ?? 'CRUSH',
      shape: { kind: 'point', x, y, r: b.r },
      energy: b.energy,
      dirX: b.dirX / len,
      dirY: b.dirY / len,
      duration: 1,
      sourceMass: 12,
      sourceBodyId: -1,
      originX: x,
      originY: y,
      flags: DamageFlag.PIERCE,
      params: { penetration: 999, shock: b.shock ?? 260 },
      weight: 'catastrophic',
    });
    ev = [
      ...ev,
      { t: 'shockwave', x, y, strength: 1, radius: b.r * 3, hue: -1 },
      { t: 'flash', amount: 0.9, x, y },
      { t: 'shake', dirX: b.dirX / len, dirY: b.dirY / len, amp: b.shake ?? 14 },
      { t: 'hitstop', ticks: 6 },
    ];
  }
  fx.tick(ev, m);
  return ev;
}

export async function renderCinemaStem(
  plan: CinemaPlan,
  stem: StemName,
): Promise<{ left: Float32Array; right: Float32Array; cues: PlacedCue[] }> {
  const N = Math.ceil(SR * plan.duration);
  const ctx = new OfflineAudioContext(2, N, SR);
  const out = ctx.createGain();
  smallSpeakerPass(ctx, out, ctx.destination);
  const gated = ctx.createGain(); // everything but the room tone passes the silences' gate
  gated.connect(out);
  const c = designCtx(ctx, gated, 31 + STEMS.indexOf(stem));
  const cues: PlacedCue[] = [];
  const A = plan.a;
  const fr = (t: number): number => Math.round(t * plan.fps) / plan.fps;
  // a source cue (a weld, a word) is first SEEN on the first frame at or after it: its sound lands on that frame
  const seen = (t: number): number => Math.ceil(t * plan.fps - 1e-6) / plan.fps;
  const cue = (name: string, t: number, at = fr(t)): number => {
    cues.push({ stem, name, cue: +t.toFixed(4), at: +at.toFixed(4) });
    return at;
  };
  const hearts = (from: number, to: number, gain: number, wrongAt?: number): void => {
    // two hearts, out of phase: L lub-dub, and R a little later and a little slower (periods in whole frames)
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
      lowBell(c, o, t, f, BELL, { decay: 2.2, gain, shimmer: 0.3 });
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
    noiseHit(c, makeOut(c, -0.2, 0.8), from, {
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
      roar(c, makeOut(c, 0, 0.4), fr(A.roar), {
        f: 36.7,
        dur: A.freeze - A.roar,
        gain: 0.12,
        attack: 1,
        lp0: 300,
        lp1: 700,
      });
      swell(c, makeOut(c, 0, 0.3), fr(A.inhale[0]), {
        dur: A.inhale[1] - A.inhale[0],
        gain: 0.18,
        f0: 80,
        f1: 900,
      });
      const lv: [number, number][] = [
        [0, 0],
        [A.worlds[0], 0],
        [A.worlds[0] + 2, 0.09],
        [A.halo + 1, 0.07],
        [A.gaze[1], 0.05],
        [A.bite - 1.5, 0.04],
        [A.genesis, 0.03],
        [A.genesis + 3, 0.08],
        [A.brace, 0.12],
        [A.burst, 0.12],
        [A.nova[0], 0.05],
        [A.black, 0.1],
        [A.edge, 0],
        [A.title, 0],
        [A.title + 0.1, 0.1],
        [A.sting, 0.02],
        [plan.duration, 0],
      ];
      drone(
        c,
        lv.sort((x, y) => x[0] - y[0]),
        plan.duration,
      );
      // ACT IV: something wet, far away; the coils
      wetSound(c, fr(A.slide), fr(A.wipe[0]));
      break;
    }
    case 'motifs': {
      // ACT I: 우리 first, two notes (one per world) on the pad; it stops mid-phrase when the halo rises
      uriMotif(fr(A.worlds[0] + 0.6), 1, 0.06);
      cue('우리 motif (stops mid-phrase)', A.worlds[0] + 3.2);
      uriMotif(fr(A.worlds[0] + 3.2), 1, 0.06, fr(A.halo));
      witness(cue('Witness motif', A.eye), 4, 0.03);
      mouth(cue('Mouth motif', A.mouth), fr(A.bite), 0.5);
      // ACT II: 우리 returns as the body is built: one more layer every few parts
      const parts = plan.drums.filter((d) => d.part !== 'loop');
      parts.forEach((d, i) => {
        if (i % 3 !== 0) return;
        uriMotif(seen(d.t), 1 + Math.floor((4 * i) / Math.max(1, parts.length - 1)), 0.05, fr(A.brace));
      });
      uriMotif(cue('우리 motif, full', A.brace + 0.3), 5, 0.08);
      // ACT III: the full score; it ducks to the hearts in the nova, and the two motifs collide at the eye
      for (let t = A.burst; t < A.nova[0] - 1; t += 2.4) uriMotif(fr(t), 5, 0.07, fr(A.nova[0]));
      witness(cue('Witness motif (collides)', A.eyeHunt), 5, 0.035);
      uriMotif(fr(A.eyeHunt + 0.45), 4, 0.07, fr(A.black));
      mouth(fr(A.pull[0]), fr(A.wipe[0]), 0.4);
      break;
    }
    case 'perc': {
      hearts(fr(A.cold), fr(A.freeze), 0.5);
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
      const beat = 60 / 104;
      let i = 0;
      for (let t = A.burst; t < A.nova[0] - 0.05; t += beat, i++) {
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
      hearts(fr(A.nova[0]), fr(A.nova[1]), 0.4);
      // the riser into the punch, cut dead a frame before it (the gate at the cut to black)
      swell(c, makeOut(c, 0, 0.4), fr(A.beams), {
        dur: A.black - A.beams,
        gain: 0.35,
        f0: 70,
        f1: 1100,
        sub: 0.25,
      });
      for (const w of plan.words) {
        const at = cue(`word ${w.word}`, w.t, seen(w.t));
        boom(c, makeOut(c, 0, 0.5), at, { f0: 84, f1: 28, dur: 1.4, gain: 0.8, drive: 3.6, crunch: 2.6 });
      }
      catastrophe(c, makeOut(c, 0, 0.15), makeOut(c, 0, 0.9), cue('title hit', A.title), {
        pre: 0,
        size: 0.7,
        gain: 0.8,
      });
      hearts(fr(A.sting), fr(A.sting + 0.75), 0.5);
      hearts(fr(A.sting), fr(A.sting), 0.5, fr(A.sting + 0.78));
      break;
    }
    case 'sfx': {
      // the bite (it is a real blow in the match: this is its cinema weight) and its ring-out; Silence #1 follows
      const b = cue('the bite (impact; Silence #1 follows)', A.bite);
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
      boom(c, makeOut(c, 0, 0.2), cue('sub drop (the Mouth)', A.mouth), {
        f0: 70,
        f1: 24,
        dur: 2,
        gain: 0.5,
        drive: 3,
      });
      grind(c, makeOut(c, -0.6, 0.6), fr(A.mouth + 0.4), { dur: 1.6, gain: 0.12, f0: 160, f1: 90, rate: 4 });
      // ACT II: the ignition (a rising ringing whoosh) and a clank on every weld
      swell(c, makeOut(c, 0, 0.6), fr(A.genesis), {
        dur: seen(A.loop) - fr(A.genesis),
        gain: 0.25,
        f0: 90,
        f1: 1000,
        sub: 0.12,
      });
      lowBell(c, makeOut(c, 0, 0.9), seen(A.loop), 110, BELL, { decay: 3, gain: 0.1, shimmer: 0.5 });
      let last = -1;
      for (const w of plan.welds) {
        const at = seen(w);
        if (at - last < 0.03) continue; // a weld per frame at most
        last = at;
        lowBell(c, makeOut(c, (c.rand() - 0.5) * 0.8, 0.4), at, 180 + 120 * c.rand(), BELL, {
          decay: 0.35,
          gain: 0.025,
        });
      }
      whoosh(c, fr(A.launch), {
        dur: 1.6,
        gain: 0.3,
        panFrom: 0,
        panTo: 0,
        wet: 0.4,
        f0: 1000,
        f1: 120,
        body: 1.4,
      });
      // ACT IV: the jaw-rings close over the camera: the bite, then black
      grind(c, makeOut(c, 0, 0.5), fr(A.wipe[0]), {
        dur: A.wipe[1] - A.wipe[0] - 0.3,
        gain: 0.2,
        f0: 300,
        f1: 90,
        rate: 9,
      });
      const bite = cue('jaw wipe bite', A.wipe[1] - 0.35);
      boom(c, makeOut(c, 0, 0.3), bite, { f0: 110, f1: 30, dur: 0.6, gain: 0.7, drive: 3.6, crunch: 3 });
      filamentSnap(c, makeOut(c, 0, 0.4), bite, 70, 1, resonance(0.4));
      crackle(c, makeOut(c, 0, 0.6), bite, { dur: 0.8, count: 10, gain: 0.1 });
      break;
    }
    case 'vo':
      // WJ's whispered line has its slot at the brace; until it is recorded, the subtitle carries it
      cue('VO slot (empty): 우리는 아직 여기 있다', A.brace + 0.5);
      break;
  }
  // the REAL fights: every fight shot's sim events, through the game's own engine, on the frame they are first drawn
  let game: ReturnType<typeof createAudioEngine> | null = null;
  if (stem === 'sfx' && plan.fights.length) {
    await loadUriAsset(uriBinUrl);
    const eng = createAudioEngine({ context: ctx, seed: 5, unsafeBypassLimiter: true });
    game = eng;
    await eng.unlock();
    eng.setVolumes({ music: 0, master: 0 });
    const frames = Math.round(plan.duration * plan.fps);
    let cur: {
      shot: Shot;
      level: number;
      m: ReturnType<typeof buildShotMatch>;
      fx: FxState;
      ticks: number;
    } | null = null;
    // (the game's own output does not pass the stem's gate: its master fader is the gate)
    const silent = (t: number): boolean => plan.silences.some(([a, b]) => t >= a && t < b);
    const drive = (n: number): void => {
      const t = n / plan.fps;
      const f = plan.fights.find((x) => t >= x.shot.start - 1e-9 && t < x.shot.end - 1e-9);
      if (f && cur?.shot !== f.shot) {
        const sm = f.shot.match!;
        const m = buildShotMatch(sm, f.shot.stage);
        const fx = new FxState();
        for (let k = 0; k < (sm.startTick ?? 0) && m.phase !== 'matchend'; k++)
          tickShot(m, fx, f.shot, k + 1);
        cur = { shot: f.shot, level: f.level, m, fx, ticks: 0 };
        eng.setVolumes({ master: silent(t) ? 0 : f.level });
      }
      if (!f && cur) {
        cur = null;
        eng.setVolumes({ master: 0 });
      }
      if (cur) {
        if (silent(t)) eng.setVolumes({ master: 0 });
        const target = sceneTime(cur.shot, t - cur.shot.start) * 60;
        const evs: SimEvent[] = [];
        while (cur.ticks + 1 <= target + 1e-9 && cur.m.phase !== 'matchend') {
          cur.ticks++;
          evs.push(...tickShot(cur.m, cur.fx, cur.shot, (cur.shot.match!.startTick ?? 0) + cur.ticks));
        }
        if (evs.length) eng.handleAt(evs, t);
        const rate = Math.max(
          0.3,
          Math.min(
            1,
            (sceneTime(cur.shot, t - cur.shot.start + 0.05) - sceneTime(cur.shot, t - cur.shot.start)) / 0.05,
          ),
        );
        const mid = (cur.m.fighters[0].view.x + cur.m.fighters[1].view.x) / 2;
        const scene = buildAudioScene(cur.m, 'fight', cur.fx.intensity(), mid);
        eng.updateAt({ ...scene, timeScale: rate }, 1 / plan.fps, t + 0.1);
      } else
        eng.updateAt(
          {
            phase: 'menu',
            stage: 'rim',
            intensity: 0,
            listenerX: 800,
            lowestIntegrity: 1,
            timeScale: 1,
            fighters: null,
          },
          1 / plan.fps,
          t + 0.1,
        );
    };
    drive(0);
    for (let n = 1; n < frames; n++) {
      const at = n / plan.fps;
      void ctx.suspend(at).then(() => {
        drive(n);
        void ctx.resume();
      });
    }
  }
  // the HARD silences: everything but the room tone (and, on the first, the bite's own ring-out) is cut; windows that touch are
  // merged first, so two gates back to back never reopen for a moment between them
  const windows: [number, number][] = [];
  for (const [a, b, ringOut] of [...plan.silences].sort((x, y) => x[0] - y[0])) {
    if (ringOut && stem === 'sfx') continue;
    const prev = windows[windows.length - 1];
    if (prev && a <= prev[1] + 0.05) prev[1] = Math.max(prev[1], b);
    else windows.push([a, b]);
  }
  for (const [a, b] of windows) {
    gated.gain.setValueAtTime(1, a - 0.01);
    gated.gain.linearRampToValueAtTime(0, a);
    gated.gain.setValueAtTime(0, b);
    gated.gain.linearRampToValueAtTime(1, b + 0.02);
  }
  const buf = await ctx.startRendering();
  game?.dispose();
  return { left: buf.getChannelData(0), right: buf.getChannelData(1), cues };
}
