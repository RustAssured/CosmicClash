import { makeOut, noiseHit, tone, type Out } from './synth';
import { scrape } from './kit';
import { boom, crackle, grind, roar, rumble, swell } from './epic';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * THE REMAINDER's voice (docs/titans/remainder/BRIEF.md): "a wound in reality that learned to fear closing". Low and under
 * strain, never a roar of a creature and never a whistle (D34):
 *  - the wound: two low sines a hair apart, beating (a sound that cannot settle), and the vortex's breath, a band of noise
 *    that wavers as it turns; hurt, the beat quickens and the pitch strains upward. Held shut, it is muffled and stalls;
 *  - Snap: rubber stretched (a rising creak), a crack, and the slap of it snapping back;
 *  - Inhale: space drawn in (a rising, sucking rush) and the bone rim biting shut;
 *  - Fold: an implosion (everything falls to a point), then a tear opening elsewhere;
 *  - Compaction: matter ground tighter while it is held, a hard crack when the slug leaves;
 *  - Loosening: the wound let go (a tearing roar opening out), and the slam when it forces itself shut;
 *  - the KO: it finally closes. Everything falls to one point and stops.
 */
const F = 37;
/** Its one-shots sit a little under the others' (its fights are dense: a Snap every few seconds, hits on most of them). */
const LEVEL = 0.75;
const out = (c: VoiceCtx, pan: number, wet: number): Out => makeOut(c, pan, wet, LEVEL);
const sub = (c: VoiceCtx, pan: number): Out => makeOut(c, pan * 0.3, 0, LEVEL);

/** A crack: a very short, bright snap with a dropping knock under it (rubber or bone giving way). */
function crack(c: VoiceCtx, pan: number, t: number, size: number): void {
  noiseHit(c, out(c, pan, 0.25), t, {
    dur: 0.04 + 0.03 * size,
    gain: 0.16 + 0.1 * size,
    attack: 0.001,
    filter: { type: 'highpass', f0: 1400, q: 0.7 },
    filter2: { type: 'lowpass', f0: 5200, q: 0.5 },
  });
  boom(c, sub(c, pan), t, { f0: 140, f1: 50, dur: 0.18 + 0.25 * size, gain: 0.2 + 0.25 * size, drive: 2 });
}

/** Space drawn in: a band of noise that rises and swells toward `t + dur` (a breath in, reversed-sounding). */
function suck(c: VoiceCtx, pan: number, t: number, dur: number, gain: number): void {
  noiseHit(c, out(c, pan, 0.45), t, {
    dur,
    gain,
    attack: dur * 0.85,
    kind: 'brown',
    filter: { type: 'bandpass', f0: 180, f1: 1100, q: 1.4 },
  });
}

/** Bone plates meeting: a dry clack and a short grind. */
function clack(c: VoiceCtx, pan: number, t: number, size: number): void {
  crackle(c, out(c, pan, 0.2), t, {
    dur: 0.06 + 0.1 * size,
    count: Math.round(3 + 6 * size),
    gain: 0.1,
    f: 1100,
  });
  grind(c, out(c, pan, 0.3), t + 0.01, {
    dur: 0.15 + 0.3 * size,
    gain: 0.06 + 0.06 * size,
    f0: 260,
    f1: 140,
    rate: 22,
  });
}

/** Everything falling to one point: a pitch that drops away fast and a sub that swallows it. */
function implode(c: VoiceCtx, pan: number, t: number, size: number): void {
  tone(c, out(c, pan, 0.35), t, {
    type: 'triangle',
    f0: 420,
    f1: 38,
    dur: 0.2 + 0.4 * size,
    gain: 0.08 + 0.06 * size,
    attack: 0.005,
  });
  swell(c, out(c, pan, 0.3), t, {
    dur: 0.25 + 0.4 * size,
    gain: 0.08,
    f0: 900,
    f1: 90,
    sub: 0.15,
    subHz: F * 1.5,
  });
}

interface Bed {
  a: OscillatorNode;
  b: OscillatorNode;
  strain: OscillatorNode;
  body: GainNode;
  breath: AudioBufferSourceNode;
  breathFilter: BiquadFilterNode;
  breathGain: GainNode;
  /** Compaction's grind, held while it charges. */
  press: AudioBufferSourceNode;
  pressFilter: BiquadFilterNode;
  pressGain: GainNode;
  lp: BiquadFilterNode;
  pan: StereoPannerNode;
}

export function createRemainderVoice(): TitanVoice {
  const beds = new Map<0 | 1, Bed>();
  /** Compaction's charge per slot (0 = not charging). */
  const pressing = new Map<0 | 1, number>();
  return {
    titan: 'remainder',
    /**
     * Always there: the wound's beating drone and the vortex's wavering breath. Hurt, the beat quickens and strains upward;
     * guarding (Hold Shut), the whole bed is muffled, as if heard through bone.
     */
    update(c, scene, slot) {
      const ac = c.ac;
      let b = beds.get(slot);
      if (!b) {
        const pan = ac.createStereoPanner();
        pan.connect(c.dry);
        const wet = ac.createGain();
        wet.gain.value = 0.4;
        pan.connect(wet);
        wet.connect(c.wet);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2400;
        lp.Q.value = 0.6;
        lp.connect(pan);
        const body = ac.createGain();
        body.gain.value = 0;
        body.connect(lp);
        const a = ac.createOscillator();
        a.frequency.value = F;
        const b2 = ac.createOscillator();
        b2.frequency.value = F + 0.9;
        // the strain: a triangle two octaves and a fifth up, so small speakers hear the beat
        const strain = ac.createOscillator();
        strain.type = 'triangle';
        strain.frequency.value = F * 6;
        const sg = ac.createGain();
        sg.gain.value = 0.12;
        strain.connect(sg);
        a.connect(body);
        b2.connect(body);
        sg.connect(body);
        const breath = ac.createBufferSource();
        breath.buffer = c.brown;
        breath.loop = true;
        const breathFilter = ac.createBiquadFilter();
        breathFilter.type = 'bandpass';
        breathFilter.frequency.value = 300;
        breathFilter.Q.value = 2.5;
        const breathGain = ac.createGain();
        breathGain.gain.value = 0;
        breath.connect(breathFilter);
        breathFilter.connect(breathGain);
        breathGain.connect(lp);
        const press = ac.createBufferSource();
        press.buffer = c.noise;
        press.loop = true;
        const pressFilter = ac.createBiquadFilter();
        pressFilter.type = 'bandpass';
        pressFilter.frequency.value = 160;
        pressFilter.Q.value = 3;
        const pressGain = ac.createGain();
        pressGain.gain.value = 0;
        press.connect(pressFilter);
        pressFilter.connect(pressGain);
        pressGain.connect(lp);
        a.start();
        b2.start();
        strain.start();
        breath.start();
        press.start();
        b = {
          a,
          b: b2,
          strain,
          body,
          breath,
          breathFilter,
          breathGain,
          press,
          pressFilter,
          pressGain,
          lp,
          pan,
        };
        beds.set(slot, b);
      }
      const now = ac.currentTime;
      const hurt = 1 - Math.max(0, Math.min(1, scene.massFrac));
      const shut = scene.state === 'guard';
      // the beat: 0.9 Hz whole, up to 3.5 Hz near death; the pitch strains up a minor third
      const f = F * (1 + 0.19 * hurt);
      b.a.frequency.setTargetAtTime(f, now, 0.4);
      b.b.frequency.setTargetAtTime(shut ? f : f + 0.9 + 2.6 * hurt, now, shut ? 0.08 : 0.4);
      b.strain.frequency.setTargetAtTime(f * 6 * (1 + 0.02 * hurt), now, 0.4);
      b.body.gain.setTargetAtTime(shut ? 0.03 : 0.055, now, 0.15);
      // the breath wavers as the vortex turns (a slow, uneven sweep), choked while held shut
      const sweep = 0.5 + 0.5 * Math.sin(now * 1.7) * Math.sin(now * 0.63);
      b.breathFilter.frequency.setTargetAtTime(220 + 380 * sweep + 300 * hurt, now, 0.12);
      b.breathGain.gain.setTargetAtTime(shut ? 0.01 : 0.035 + 0.03 * hurt, now, 0.15);
      b.lp.frequency.setTargetAtTime(shut ? 380 : 2400, now, 0.06);
      const p = pressing.get(slot) ?? 0;
      b.pressGain.gain.setTargetAtTime(p > 0 ? 0.03 + 0.09 * p : 0, now, 0.05);
      b.pressFilter.frequency.setTargetAtTime(140 + 420 * p, now, 0.08);
      b.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, c.panOf(scene.x))), now, 0.1);
    },
    stop(slot) {
      for (const s of slot === 'all' ? [...beds.keys()] : [slot]) {
        const b = beds.get(s);
        if (!b) continue;
        try {
          b.a.stop();
          b.b.stop();
          b.strain.stop();
          b.breath.stop();
          b.press.stop();
        } catch {
          /* already stopped */
        }
        b.pan.disconnect();
        b.lp.disconnect();
        b.body.disconnect();
        b.breathGain.disconnect();
        b.pressGain.disconnect();
        beds.delete(s);
        pressing.delete(s);
      }
    },
    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      switch (ev.moveSlot) {
        case 'strike':
          // the rubber stretched: a creak that rises as it pulls taut (its 9-tick wind-up)
          scrape(c, out(c, pan, 0.3), t, {
            dur: 0.16,
            f0: 140,
            f1: 520,
            gain: 0.09,
            rate: 38,
            kind: 'brown',
          });
          break;
        case 'crush':
          // the tell: space drawn in, rising toward the yank (28 ticks)
          suck(c, pan, t, 0.48, 0.2);
          swell(c, out(c, pan, 0.3), t, {
            dur: 0.5,
            gain: 0.06,
            f0: 120,
            f1: 600,
            sub: 0.1,
            subHz: F * 2,
          });
          break;
        case 'signature':
          // the vortex starts to crush what it holds (the hold is the bed's grind)
          clack(c, pan, t, 0.3);
          break;
        default:
          break;
      }
    },
    onCharge(c, _t, ev) {
      if (!ev.moveId.endsWith('compaction')) return;
      pressing.set(ev.slot, ev.phase === 'release' ? 0 : Math.max(0.05, Math.min(1, ev.frac)));
      void c;
    },
    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      switch (ev.moveSlot) {
        case 'strike':
          // the crack at the tip, then the slap of the band snapping home
          crack(c, pan, t, 0.5);
          noiseHit(c, out(c, pan, 0.3), t + 0.12, {
            dur: 0.12,
            gain: 0.12,
            kind: 'brown',
            filter: { type: 'lowpass', f0: 900, f1: 180, q: 1.6 },
            attack: 0.004,
          });
          tone(c, out(c, pan, 0.2), t + 0.12, {
            type: 'triangle',
            f0: 240,
            f1: 70,
            dur: 0.16,
            gain: 0.07,
          });
          break;
        case 'crush':
          // the yank, and the rim biting shut on what it caught
          rumble(c, out(c, pan, 0.35), t, { dur: 0.35, gain: 0.16, f0: 900, f1: 120 });
          clack(c, pan, t + 0.1, 1);
          boom(c, sub(c, pan), t + 0.1, { f0: 90, f1: 30, dur: 0.5, gain: 0.4, drive: 2.2 });
          break;
        default:
          break;
      }
    },
    onSurge(c, t, ev) {
      // Fold: it drains into its own eye
      implode(c, c.panOf(ev.x), t, 0.7);
    },
    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      // a tear: matter pulled apart, a ripping sweep down, and the weight of it under
      noiseHit(c, out(c, pan, 0.3), t, {
        dur: 0.12 + 0.25 * mag,
        gain: 0.1 + 0.12 * mag,
        filter: { type: 'bandpass', f0: 2400, f1: 300, q: 1.2 },
        attack: 0.003,
      });
      boom(c, sub(c, pan), t, {
        f0: 80 - 20 * mag,
        f1: 30,
        dur: 0.3 + 0.4 * mag,
        gain: 0.22 + 0.3 * mag,
        drive: 1.8,
      });
    },
    onHitTaken(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      // the shell: old bone and crust cracking; a big blow makes the wound flinch (a beat of the drone, choked)
      crackle(c, out(c, pan, 0.25), t, {
        dur: 0.1 + 0.2 * mag,
        count: Math.round(4 + 10 * mag),
        gain: 0.09,
        f: 900,
      });
      noiseHit(c, out(c, pan, 0.3), t, {
        dur: 0.12 + 0.15 * mag,
        gain: 0.12 + 0.12 * mag,
        kind: 'brown',
        filter: { type: 'lowpass', f0: 800, f1: 180, q: 1.2 },
      });
      if (mag > 0.5) tone(c, out(c, pan, 0.4), t + 0.03, { f0: F * 4, f1: F * 2, dur: 0.3, gain: 0.06 });
    },
    onGuard(c, t, ev) {
      // Hold Shut takes the blow on bone: a heavy clack; a broken guard cracks open with the wound's breath rushing out
      const pan = c.panOf(ev.x);
      clack(c, pan, t, ev.broke ? 1 : 0.5);
      boom(c, sub(c, pan), t, { f0: 95, f1: 40, dur: ev.broke ? 0.8 : 0.3, gain: ev.broke ? 0.5 : 0.28 });
      if (ev.broke)
        noiseHit(c, out(c, pan, 0.5), t + 0.04, {
          dur: 0.6,
          gain: 0.14,
          kind: 'brown',
          filter: { type: 'bandpass', f0: 1200, f1: 200, q: 1 },
        });
    },
    onUltimate(c, t, ev) {
      if (ev.phase !== 'start') return;
      const pan = c.panOf(ev.x);
      // LOOSENING: it lets go. A tearing roar opening out over everything, the drone's beat breaking into a howl of air
      roar(c, out(c, pan, 0.6), t + 0.1, {
        f: F * 2,
        f1: F * 2.5,
        dur: 2.4,
        gain: 0.12,
        attack: 0.5,
        lp0: 300,
        lp1: 1400,
        detune: 18,
      });
      suck(c, pan, t, 0.65, 0.22);
      rumble(c, out(c, pan, 0.5), t + 0.4, { dur: 2.2, gain: 0.2, f0: 160, f1: 700 });
    },
    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      switch (ev.id) {
        case 'snap-latch':
          // the tip bit into the foe: a wet grip, pulled
          noiseHit(c, out(c, pan, 0.3), t, {
            dur: 0.18,
            gain: 0.1,
            kind: 'brown',
            filter: { type: 'bandpass', f0: 700, f1: 260, q: 1.5 },
          });
          break;
        case 'inhale-draw':
          suck(c, pan, t, 0.25, 0.12);
          break;
        case 'fold-collapse':
          implode(c, pan, t, 1);
          break;
        case 'fold-unfold':
          // a tear opening elsewhere: a short rush up and a pop of air
          noiseHit(c, out(c, pan, 0.5), t, {
            dur: 0.22,
            gain: 0.14,
            attack: 0.15,
            filter: { type: 'bandpass', f0: 300, f1: 1800, q: 1.2 },
          });
          boom(c, sub(c, pan), t + 0.18, { f0: 70, f1: 34, dur: 0.35, gain: 0.3, drive: 2 });
          break;
        case 'compaction-crack':
          // the slug leaves: a hard crack of packed matter and a heavy shove
          crack(c, pan, t, 1);
          boom(c, sub(c, pan), t, { f0: 70, f1: 26, dur: 0.6 + 0.15 * ev.amount, gain: 0.45, drive: 2.6 });
          break;
        case 'compaction-merge':
          // the plates grind out over the shell
          grind(c, out(c, pan, 0.35), t, { dur: 0.6, gain: 0.12, f0: 180, f1: 90, rate: 16 });
          crackle(c, out(c, pan, 0.25), t + 0.1, { dur: 0.4, count: 12, gain: 0.07, f: 800 });
          break;
        case 'loosen-tear':
          crackle(c, out(c, pan, 0.4), t, { dur: 0.5, count: 14, gain: 0.08, f: 650 });
          rumble(c, out(c, pan, 0.4), t, { dur: 0.8, gain: 0.12, f0: 300, f1: 90 });
          break;
        case 'loosen-break':
          // it forces itself shut: a rush in, then the slam of bone, the loudest thing it does
          suck(c, pan, t - 0.05, 0.2, 0.18);
          clack(c, pan, t + 0.12, 1.4);
          boom(c, sub(c, pan), t + 0.12, { f0: 60, f1: 20, dur: 1.4, gain: 0.6, drive: 3 });
          rumble(c, out(c, pan, 0.6), t + 0.15, { dur: 1.4, gain: 0.18, f0: 400, f1: 60 });
          break;
        case 'shut-consume':
          // a blow swallowed behind the plates: a muffled gulp
          tone(c, out(c, pan, 0.2), t, { f0: 160, f1: 45, dur: 0.2, gain: 0.12, attack: 0.01 });
          break;
        case 'cannibal-strip':
          // it eats its own shell: bone crunched inward, and the drone groans
          crackle(c, out(c, pan, 0.3), t, { dur: 0.45, count: 16, gain: 0.08, f: 700 });
          grind(c, out(c, pan, 0.35), t, { dur: 0.5, gain: 0.08, f0: 140, f1: 70, rate: 12 });
          tone(c, out(c, pan, 0.45), t + 0.05, {
            f0: F * 3,
            f1: F * 2.2,
            dur: 0.6,
            gain: 0.05,
            attack: 0.1,
          });
          break;
        default:
          break;
      }
    },
    onKo(c, t, ev) {
      const pan = c.panOf(ev.x);
      // it finally closes: everything falls to one point, a last slam, then nothing
      implode(c, pan, t, 2);
      tone(c, out(c, pan, 0.5), t, { f0: F * 4, f1: F * 0.5, dur: 2.2, gain: 0.08, attack: 0.05 });
      rumble(c, out(c, pan, 0.6), t, { dur: 2, gain: 0.25, f0: 500, f1: 40 });
      clack(c, pan, t + 1.9, 1.2);
      boom(c, sub(c, pan), t + 1.9, { f0: 55, f1: 18, dur: 1.2, gain: 0.5, drive: 2.4 });
    },
  };
}
