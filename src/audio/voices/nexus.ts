import { clamp, clamp01 } from '../dsp/math';
import { fourierCoefficients, heartbeatWave } from '../dsp/waves';
import { cueKind } from './cues';
import { createBed, noiseBand, pingsDown, ratchet, scrape, silentGain, subOut, type Bed } from './kit';
import { CHAIN, TINK, makeOut, noiseHit, partials, pick, riser, thump, tone, whistlePass } from './synth';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * THE NEXUS: a crimson graph of nodes and hardened chains around a crystalline hub. Metal, and a slow pulse.
 *
 * The sound is chain links: hollow inharmonic ring modes (`CHAIN`) that clank and drag, a latching "click-lock" when a chain
 * takes hold of the enemy (assimilation), a wet ratcheting tear when it harvests, and descending detuned pings when a node
 * goes dark. Under everything a 40-60 Hz heartbeat throbs, faster the more of the graph is alive (`resource`).
 *
 * Tuning: the rings sit on a minor-ish cluster (C♯ E G A♯ C♯) so overlapping clanks are dark but never harsh.
 */
const NODES = [277.18, 329.63, 392, 466.16, 554.37];

interface Pulse {
  bed: Bed;
  sub: OscillatorNode;
  lfo: OscillatorNode;
  beat: GainNode;
  beatDepth: GainNode;
  hum: GainNode;
  rattle: GainNode;
}

/** One pulse period: lub at 0, dub at 0.3; band-limited to 48 harmonics (at 2.5 Hz that is 120 Hz, far above the carrier). */
const HEART = ((): { real: Float32Array; imag: Float32Array } =>
  fourierCoefficients(heartbeatWave(512, 0.3, 0.6), 48))();

export function createNexusVoice(): TitanVoice {
  const pulses = new Map<number, Pulse>();

  /** A chain link struck: hollow ring plus a tiny click on the attack. Heavier blows ring longer and lower. */
  const clank = (
    c: VoiceCtx,
    t: number,
    pan: number,
    hz: number,
    mag: number,
    open: number,
    wet = 0.3,
    level = 1,
  ): void => {
    const o = makeOut(c, pan, wet);
    partials(c, o, t, hz, CHAIN, {
      decay: 0.14 + 0.55 * mag,
      gain: (0.07 + 0.09 * mag) * open * level,
      maxHz: 12000,
    });
    noiseHit(c, o, t, {
      dur: 0.014,
      gain: 0.16 * open * level,
      filter: { type: 'highpass', f0: 3200 },
      attack: 0.0005,
    });
  };

  /** A chain snapping: bright crack, a falling whip of pitch, a ring. */
  const snap = (c: VoiceCtx, t: number, pan: number, amount = 1): void => {
    const o = makeOut(c, pan, 0.4);
    noiseHit(c, o, t, {
      dur: 0.02,
      gain: 0.22 * amount,
      filter: { type: 'highpass', f0: 4200 },
      attack: 0.0004,
    });
    tone(c, o, t, { f0: 2200, f1: 380, dur: 0.16, gain: 0.05 * amount, attack: 0.001 });
    partials(c, o, t + 0.004, pick(c, NODES) * 1.5, CHAIN, { decay: 0.4, gain: 0.08 * amount, maxHz: 12000 });
  };

  /** The click-lock: a tick, a clunk as the latch seats, and three quick ratchet clicks. */
  const lock = (c: VoiceCtx, t: number, pan: number, mag: number, level = 1): void => {
    const o = makeOut(c, pan, 0.25);
    noiseHit(c, o, t, {
      dur: 0.01,
      gain: 0.2 * level,
      filter: { type: 'bandpass', f0: 2600, q: 2 },
      attack: 0.0003,
    });
    partials(c, o, t + 0.045, 420, CHAIN, { decay: 0.14, gain: 0.13 * level });
    thump(c, subOut(c, pan), t + 0.045, 140, 70, 0.14, (0.16 + 0.12 * mag) * level);
    ratchet(c, o, t + 0.09, { count: 3, from: 0.03, to: 0.05, f: 3400, gain: 0.09 * level });
  };

  /** Harvesting: a wet ratcheting tear: a zipping scrape, an accelerating ratchet and a low rip. */
  const harvest = (c: VoiceCtx, t: number, pan: number, amount: number, level = 1): void => {
    const o = makeOut(c, pan, 0.4);
    // (a band-passed noise is only a few percent of the noise's power: it takes big gains to be heard)
    scrape(c, o, t, {
      dur: 0.42 + 0.2 * amount,
      f0: 700,
      f1: 3200,
      q: 1,
      gain: 0.5 * level,
      rate: 46,
      depth: 0.85,
      attack: 0.02,
    });
    ratchet(c, o, t, {
      count: 8 + Math.round(6 * amount),
      from: 0.055,
      to: 0.02,
      f: 2400,
      gain: 0.3 * level,
    });
    noiseHit(c, o, t + 0.02, {
      dur: 0.4,
      gain: 0.3 * level,
      filter: { type: 'lowpass', f0: 900, f1: 180, q: 0.8 },
      kind: 'brown',
      attack: 0.05,
    });
  };

  return {
    titan: 'nexus',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      switch (ev.moveSlot) {
        case 'strike': {
          // a chain whipped out: a rising drag and a crack at the far end
          const o = makeOut(c, pan, 0.3);
          scrape(c, o, t, { dur: 0.22, f0: 900, f1: 3400, q: 1.2, gain: 0.26, rate: 38, attack: 0.06 });
          break;
        }
        case 'crush': {
          // heavy chain hauled tight: a low drag, a creak and a slow rising tension tone
          const o = makeOut(c, pan, 0.45);
          scrape(c, o, t, {
            dur: 0.55,
            f0: 300,
            f1: 900,
            q: 1,
            gain: 0.45,
            rate: 14,
            depth: 0.7,
            attack: 0.25,
            kind: 'brown',
          });
          tone(c, o, t, { f0: 90, f1: 150, dur: 0.6, gain: 0.09, type: 'sawtooth', attack: 0.3 });
          break;
        }
        case 'signature': {
          // chains latching: a ratchet that speeds up as the trap is set
          ratchet(c, makeOut(c, pan, 0.3), t, {
            count: 9,
            from: 0.07,
            to: 0.025,
            f: 2800,
            gain: 0.26,
            ping: TINK,
            pingHz: 900,
          });
          break;
        }
        case 'ultimate': {
          // the shell begins to form: a ring of pings gathering inward
          const o = makeOut(c, pan * 0.3, 0.6);
          for (let i = 0; i < 6; i++)
            partials(c, o, t + i * 0.09, NODES[i % NODES.length]! * (1 + (i % 3)), CHAIN, {
              decay: 0.5,
              gain: 0.05,
            });
          break;
        }
        case 'guard':
        case 'surge':
          break; // their own events carry the sound
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      if (ev.moveSlot === 'crush') {
        clank(c, t, pan, NODES[0]! * 0.7, 1, 1, 0.5);
        thump(c, subOut(c, pan), t, 92, 34, 0.6, 0.45 + 0.2 * p);
      } else if (ev.moveSlot === 'signature') {
        lock(c, t, pan, p, 1.3);
      } else {
        const o = makeOut(c, pan, 0.3);
        noiseHit(c, o, t, {
          dur: 0.1 + 0.06 * p,
          gain: 0.34,
          filter: { type: 'bandpass', f0: 1200, f1: 3800, q: 1.2 },
          attack: 0.006,
        });
        clank(c, t + 0.01, pan, pick(c, NODES) * 2.4, 0.35 + 0.3 * p, 1, 0.3, 1.4);
      }
    },

    onSurge(c, t, ev) {
      // chains reeling the body along: a metallic Doppler streak with a drag under it
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whistlePass(c, t, {
        f: 880,
        dur: 0.4,
        gain: 0.11,
        panFrom: clamp(pan - 0.5 * dir, -1, 1),
        panTo: clamp(pan + 0.5 * dir, -1, 1),
        wet: 0.3,
        approach: 1.4,
        recede: 0.6,
      });
      scrape(c, makeOut(c, pan, 0.2), t, { dur: 0.35, f0: 1500, f1: 700, q: 1.4, gain: 0.26, rate: 30 });
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      if (ev.type === 'ASSIMILATION') lock(c, t, pan, mag, 0.75);
      else clank(c, t, pan, pick(c, NODES) * 3, 0.2 + 0.4 * mag, 1 - clamp01(ev.blocked) * 0.6, 0.25);
    },

    onHitTaken(c, t, ev, mag) {
      // the body is metal and chain: it CLANKS, the harder the lower and longer; a blocked blow is a dull thunk
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.75;
      clank(c, t, pan, pick(c, NODES) * 2.6 * (1.5 - 0.6 * mag), mag, open, 0.4);
      if (ev.onDamaged > 0.3) snap(c, t + 0.02, pan, 0.6 * open);
    },

    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      clank(c, t, pan, NODES[1]! * 0.6, ev.broke ? 1 : 0.5, 1, 0.45);
      thump(c, subOut(c, pan), t, 100, 44, ev.broke ? 0.7 : 0.3, ev.broke ? 0.6 : 0.3);
      if (ev.broke)
        for (let i = 0; i < 5; i++) snap(c, t + 0.05 + i * 0.07, pan + (c.rand() - 0.5) * 0.4, 0.5);
    },

    onKo(c, t, ev) {
      // the graph comes apart link by link, each ring lower and lonelier, then the nodes go dark
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.75);
      for (let i = 0; i < 14; i++) {
        const at = t + 0.05 + i * (0.08 + 0.02 * i);
        partials(c, o, at, pick(c, NODES) * Math.pow(0.93, i) * 2.4, CHAIN, {
          decay: 0.5 + 0.05 * i,
          gain: 0.05 * (1 - i / 20),
          maxHz: 11000,
        });
        noiseHit(c, o, at, {
          dur: 0.012,
          gain: 0.07,
          filter: { type: 'highpass', f0: 3000 },
          attack: 0.0004,
        });
      }
      pingsDown(c, o, t + 0.9, {
        count: 6,
        f: 987,
        step: 0.8,
        spacing: 0.2,
        decay: 1.0,
        gain: 0.04,
        set: CHAIN,
      });
      thump(c, subOut(c, pan), t, 68, 24, 1.8, 0.5);
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // the shell closes: pings spiralling inward faster and faster, a rising tension, then the crush
        let at = t;
        let gap = 0.24;
        for (let i = 0; i < 16; i++) {
          const side = i % 2 === 0 ? -1 : 1;
          const po = makeOut(c, side * (0.9 - i * 0.05), 0.5);
          partials(c, po, at, NODES[i % NODES.length]! * (1 + Math.floor(i / 5)) * 1.5, CHAIN, {
            decay: 0.45,
            gain: 0.05 + 0.002 * i,
          });
          at += gap;
          gap *= 0.86;
        }
        riser(c, o, t, 2.4, 0.11, 400, 5200);
        thump(c, subOut(c, 0), t + 2.4, 62, 22, 1.7, 0.9);
        clank(c, t + 2.4, 0, NODES[0]! * 0.5, 1, 1, 0.8);
      } else {
        pingsDown(c, o, t, {
          count: 5,
          f: 740,
          step: 0.82,
          spacing: 0.15,
          decay: 0.9,
          gain: 0.06,
          set: CHAIN,
        });
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      switch (ev.kind) {
        case 'harvest':
          harvest(c, t, pan, m);
          return true;
        case 'consume':
          lock(c, t, pan, m);
          return true;
        case 'detach':
          snap(c, t, pan, 0.8 + 0.8 * m);
          return true;
        default:
          return false;
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      switch (cueKind(ev.id)) {
        case 'sever':
        case 'break':
          snap(c, t, pan, 2.4 + 0.6 * a);
          return;
        case 'dark':
          pingsDown(c, makeOut(c, pan, 0.5), t, {
            count: 4,
            f: 830,
            step: 0.8,
            spacing: 0.1,
            decay: 0.55,
            gain: 0.25,
            set: CHAIN,
          });
          return;
        case 'harvest':
          harvest(c, t, pan, a, 1.7);
          return;
        case 'latch':
          lock(c, t, pan, 0.6 + 0.4 * a, 1.3);
          return;
        case 'merge':
          clank(c, t, pan, NODES[0]! * 3, 0.5, 1, 0.5, 2.2);
          partials(c, makeOut(c, pan, 0.6), t + 0.03, NODES[2]! * 3, CHAIN, {
            decay: 0.7,
            gain: 0.11,
            maxHz: 11000,
          });
          return;
        default:
          clank(c, t, pan, pick(c, NODES) * 3, 0.35 + 0.3 * a, 1, 0.4, 2);
      }
    },

    update(c, scene, slot) {
      const ac = c.ac;
      let p = pulses.get(slot);
      if (!p) {
        const bed = createBed(c, 0.25);
        // the pulse: a sine at 40-60 Hz whose gain is driven by a heartbeat-shaped LFO
        const sub = bed.run(ac.createOscillator());
        sub.type = 'sine';
        sub.frequency.value = 48;
        const beat = silentGain(c, bed.input);
        sub.connect(beat);
        const lfo = ac.createOscillator();
        lfo.setPeriodicWave(ac.createPeriodicWave(HEART.real, HEART.imag));
        lfo.frequency.value = 0.8;
        const beatDepth = ac.createGain();
        beatDepth.gain.value = 0;
        lfo.connect(beatDepth);
        beatDepth.connect(beat.gain);
        bed.run(lfo);
        // a faint metallic hum (inharmonic partials) and the chain rattle that follows movement
        const humLp = ac.createBiquadFilter();
        humLp.type = 'lowpass';
        humLp.frequency.value = 1100;
        const hum = silentGain(c, bed.input);
        humLp.connect(hum);
        for (const [i, f] of [220, 331.7, 497.3].entries()) {
          const o = bed.run(ac.createOscillator());
          o.type = 'sine';
          o.frequency.value = f;
          o.detune.value = (i - 1) * 6;
          const og = ac.createGain();
          og.gain.value = [0.5, 0.35, 0.22][i]!;
          o.connect(og);
          og.connect(humLp);
        }
        const rattle = silentGain(c, bed.input);
        noiseBand(c, bed, rattle, { kind: 'white', type: 'bandpass', f: 3300, q: 4 });
        p = { bed, sub, lfo, beat, beatDepth, hum, rattle };
        pulses.set(slot, p);
      }
      const now = ac.currentTime;
      const alive = clamp01(scene.resource); // how much of the graph is still lit: more nodes, a faster pulse
      const move = clamp01(scene.speed / 600);
      const mass = clamp(scene.massFrac, 0.2, 1.4);
      p.lfo.frequency.setTargetAtTime(0.75 + 1.5 * alive, now, 0.4);
      p.sub.frequency.setTargetAtTime(43 + 12 * alive, now, 0.4);
      const depth = 0.05 + 0.04 * mass;
      p.beat.gain.setTargetAtTime(depth * 0.13, now, 0.2); // the LFO's DC is removed, so keep the trough at silence
      p.beatDepth.gain.setTargetAtTime(depth, now, 0.2);
      p.hum.gain.setTargetAtTime(0.004 + 0.008 * move, now, 0.3);
      p.rattle.gain.setTargetAtTime(0.0015 + 0.016 * move, now, 0.15);
      p.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...pulses.keys()] : [slot]) {
        pulses.get(s)?.bed.dispose();
        pulses.delete(s);
      }
    },
  };
}
