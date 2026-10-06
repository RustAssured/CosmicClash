import { describe, expect, it } from 'vitest';
import {
  Btn,
  parseScript,
  type DamageEvent,
  type RenderLayer,
  type SimEvent,
  type TitanId,
} from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import type { FighterImpl } from './fighter';
import type { PlanetBehaviour } from './behaviours/planet';
import { ManualSource, createScriptSource, makeMatch, skipIntro } from './testing/harness';
import { getTitanDef } from '@/titans';

/** The world's size against the one these tests were written at (D31-6, `art.params.scale`): lengths on it scale with it. */
const PS = (getTitanDef('planet').art.params as { scale?: number }).scale ?? 1;

function duel(a: TitanId, b: TitanId, gap = 170, seed = 7) {
  const m = makeMatch({ a, b, seed, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const fa = m.fighters[0] as FighterImpl;
  const fb = m.fighters[1] as FighterImpl;
  fa.px = 800 - gap / 2;
  fb.px = 800 + gap / 2;
  return { m, fa, fb, pl: (fa.behaviour ?? fb.behaviour) as unknown as PlanetBehaviour };
}

const thermal = (cx: number, cy: number): DamageEvent => ({
  type: 'THERMAL',
  shape: { kind: 'field', x: cx, y: cy, r: 60, falloff: 1.5 },
  energy: 380,
  dirX: 1,
  dirY: 0,
  duration: 1,
  sourceMass: 7,
  sourceBodyId: -1,
  originX: cx - 100,
  originY: cy,
  flags: 0,
  params: {},
});

describe('Planet', () => {
  it('its moons are real matter bodies on visible orbits, in front of and behind the world', () => {
    const { m, fa, pl } = duel('planet', 'asteroid', 380);
    m.setSources(null, null);
    const seenFront = new Set<boolean>();
    const xs: number[] = [];
    for (let t = 0; t < 500; t++) {
      m.step();
      for (const mo of pl.moonBodies) {
        expect(fa.world.getBody(mo.body.id)?.kind).toBe('moon');
        if (mo === pl.moonBodies[0]) {
          seenFront.add(mo.back);
          xs.push(mo.x - fa.px);
        }
      }
    }
    expect(pl.moonBodies.length).toBe(2);
    expect(seenFront.size).toBe(2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150);
    expect(fa.view.resource).toBe(2);
    expect(fa.view.parts).toBe(2);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 60_000);

  it('Moon Slam (Strike) spends a moon, hits for real, and the moon comes home damaged', () => {
    const { m, fa, fb, pl } = duel('planet', 'asteroid', 300);
    const ini = fb.view.bodyStats.mass;
    m.setSources(createScriptSource(parseScript('1:strike*30'), m.tick + 1), null);
    let spent = false;
    for (let t = 0; t < 300; t++) {
      m.step();
      if (fa.view.resource === 1) spent = true;
    }
    expect(spent).toBe(true);
    expect(fb.view.bodyStats.mass).toBeLessThan(ini * 0.97);
    expect(fa.view.resource).toBe(2);
    expect(Math.min(pl.moonFrac(0), pl.moonFrac(1))).toBeLessThan(0.95);
  }, 60_000);

  it('hard blows that reach a moon damage it, knock it out of orbit and lose it (cue, pip out)', () => {
    const { m, fb } = duel('asteroid', 'planet', 120);
    m.setSources(null, null);
    const b = fb.behaviour as unknown as PlanetBehaviour;
    const attacker = m.fighters[0]!;
    const events: SimEvent[] = [];
    const mo = b.moonBodies[0]!;
    let lost = false;
    let knocked = false;
    for (let t = 0; t < 400 && !lost; t++) {
      m.step();
      if (mo.mode === 3) knocked = true;
      for (const e of m.events) if (e.t === 'cue' && e.id === 'moon-lost') lost = true;
      if (t % 10 === 0 && mo.mode !== 4) {
        const ev = thermal(mo.x, mo.y);
        ev.type = 'CRUSH';
        // a moon of a PS× world has PS² the matter: the same blow for its size
        ev.energy = 900 * PS * PS;
        ev.shape = { kind: 'point', x: mo.x, y: mo.y, r: 14 * PS };
        events.length = 0;
        fb.receive(ev, attacker, events);
        if (events.some((e) => e.t === 'cue' && e.id === 'moon-lost')) lost = true;
      }
    }
    expect(lost).toBe(true);
    expect(mo.mode).toBe(4);
    expect(knocked || lost).toBe(true);
    expect(fb.world.getBody(mo.body.id)).toBeUndefined();
    // the other moon may have been jolted out of orbit by the same blows: given time, it comes home and its pip stays lit
    for (let t = 0; t < 240 && fb.view.parts !== 1; t++) m.step();
    expect(fb.view.parts).toBe(1);
    expect(fb.world.ledger().error).toBeLessThan(0.05);
  }, 60_000);

  it('atmosphere absorbs heat: the same burst does far less to an intact planet than to a stripped one', () => {
    const measure = (strip: boolean): number => {
      const { m, fb } = duel('supernova', 'planet', 170);
      const ids = fb.rig as unknown as { ids: { atmosphere: number; cloud: number } };
      m.setSources(null, null);
      if (strip) {
        const map = fb.body.map;
        for (let i = 0; i < map.material.length; i++)
          if (map.material[i] === ids.ids.atmosphere || map.material[i] === ids.ids.cloud) {
            map.material[i] = 0;
            map.integrity[i] = 0;
          }
        (fb.world as MatterWorldEx).settleBody(fb.body.id);
      }
      const t = fb.body.transform;
      const before = fb.world.stats(fb.body.id).mass;
      const ev = thermal(t.x - 60, t.y);
      ev.energy = 700;
      fb.world.applyDamage(fb.body.id, ev);
      for (let k = 0; k < 40; k++) m.step();
      return before - fb.world.stats(fb.body.id).mass;
    };
    const intact = measure(false);
    const stripped = measure(true);
    expect(intact).toBeGreaterThan(0);
    expect(stripped).toBeGreaterThan(intact * 1.05);
  }, 60_000);

  it('stripping the atmosphere weakens the guard shell', () => {
    const { m, fb, pl } = duel('asteroid', 'planet', 200);
    m.setSources(null, null);
    const b = fb.behaviour as unknown as PlanetBehaviour;
    for (let t = 0; t < 12; t++) m.step();
    const full = b.guardMultiplier();
    const map = fb.body.map;
    const ids = (fb.rig as unknown as { ids: { atmosphere: number; cloud: number } }).ids;
    for (let i = 0; i < map.material.length; i++)
      if (map.material[i] === ids.atmosphere || map.material[i] === ids.cloud) map.material[i] = 0;
    for (let t = 0; t < 12; t++) m.step();
    expect(b.guardMultiplier()).toBeLessThan(full - 0.3);
    void pl;
  }, 60_000);

  it('is deterministic: identical scripted fights end in identical hashes (moons and spin included)', () => {
    const run = (): number => {
      const { m } = duel('planet', 'lastone', 200);
      const t0 = m.tick;
      m.setSources(
        createScriptSource(parseScript('1:strike,50:sig*30,150:crush,300:guard*30'), t0 + 1),
        createScriptSource(parseScript('20:strike,120:crush,200:sig'), t0 + 1),
      );
      for (let t = 0; t < 450; t++) m.step();
      return m.hash();
    };
    expect(run()).toBe(run());
  }, 90_000);
});

/** A Planet (slot 0) against a far, idle Asteroid, driven by hand. */
function handDuel(gap = 420) {
  const { m, fa, fb, pl } = duel('planet', 'asteroid', gap);
  const a = new ManualSource();
  m.setSources(a, null);
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) m.step();
  };
  return { m, fa, fb, pl, a, step };
}

/** Lit pixels in the Planet's detached fx overlay (ring, aurora, moon trails, move fx) this frame. */
function fxPixels(f: FighterImpl): number {
  const fx = f
    .renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 0)
    .find((l: RenderLayer) => l.id === 'planet-fx');
  if (!fx || !fx.visible) return 0;
  let n = 0;
  for (let i = 0; i < fx.pixels.length; i++) if (fx.pixels[i]! >>> 24 !== 0) n++;
  return n;
}

const crushAt = (x: number, y: number, dirX: number, energy = 650): DamageEvent => ({
  type: 'CRUSH',
  shape: { kind: 'point', x, y, r: 26 },
  energy,
  dirX,
  dirY: 0,
  duration: 1,
  sourceMass: 6,
  sourceBodyId: -1,
  originX: x - dirX * 80,
  originY: y,
  flags: 0,
  params: { crater: 12, compress: 6, shock: 0.8 },
});

describe('Planet spin and orientation', () => {
  it('turns on its own at the day rate, published (and hashed) as FighterView.angle/spin', () => {
    const { m, fa, pl, step } = handDuel();
    step(5);
    const a0 = fa.view.angle;
    step(120);
    // prograde (negative in the fighters' sense), 0.14 rad/s: two seconds turn it ~0.28 rad
    expect(fa.view.spin).toBeCloseTo(pl.spin, 9);
    expect(fa.view.spin).toBeLessThan(-0.1);
    expect(Math.abs(fa.view.angle - a0)).toBeGreaterThan(0.2);
    expect(Math.abs(fa.view.angle - a0)).toBeLessThan(0.4);
    // the angular state is part of the match hash
    const h = m.hash();
    fa.view.spin += 0.5;
    expect(m.hash()).not.toBe(h);
  }, 60_000);

  it('Impact commits the world into spin; the stop overshoots the day rate, then the day carries on', () => {
    const { fa, pl, a, step } = handDuel();
    step(5);
    const day = pl.spin; // the world's own day, prograde
    expect(day).toBeCloseTo(-0.14, 2);
    a.held = Btn.CRUSH;
    step();
    a.held = 0;
    let peak = day;
    let peakTick = 0;
    for (let t = 0; t < 60; t++) {
      step();
      if (Math.abs(pl.spin - day) > Math.abs(peak - day)) {
        peak = pl.spin;
        peakTick = t;
      }
      expect(fa.body.transform.lean).toBe(0); // a world never shears
    }
    expect(Math.abs(peak - day)).toBeGreaterThan(2); // committed: the cloud deck streaks
    // after the peak the spin swings back PAST the day rate (overshoot) before settling on it
    const side = Math.sign(peak - day);
    let overshoot = 0;
    for (let t = 0; t < 300; t++) {
      step();
      overshoot = Math.max(overshoot, -(pl.spin - day) * side);
    }
    expect(peakTick).toBeGreaterThan(0);
    expect(overshoot).toBeGreaterThan(0.05);
    expect(pl.spin).toBeCloseTo(day, 1); // …and the day carries on: the world never stops turning
    expect(Math.abs(pl.spin)).toBeGreaterThan(0.08);
  }, 60_000);

  it('the cloud deck lags a spin-up (atmospheric drag) and the moons fall behind their orbits', () => {
    // the Cataclysm's windup spins the world up to its limit over 1.5 s
    const { fa, pl, a, step } = handDuel();
    step(5);
    fa.meter = 1;
    a.held = Btn.ULTIMATE;
    step();
    a.held = 0;
    let lagged = false;
    let moonLag = 0;
    for (let t = 0; t < 150; t++) {
      step();
      if (Math.abs(pl.cloudSpin) < Math.abs(pl.spin) - 0.05) lagged = true;
      for (const mo of pl.moonBodies) moonLag = Math.min(moonLag, mo.lag);
    }
    expect(lagged).toBe(true);
    expect(moonLag).toBeLessThan(-0.03);
  }, 60_000);

  it('answers every command on its input tick with light and fx (feel respond, channel fx), never with a lean', () => {
    for (const [btn, cmd] of [
      [Btn.STRIKE, 'strike'],
      [Btn.CRUSH, 'crush'],
      [Btn.SURGE, 'surge'],
      [Btn.SIGNATURE, 'signature'],
      [Btn.GUARD, 'guard'],
      [Btn.GRAVITY, 'gravity'],
    ] as const) {
      const ctl = handDuel();
      ctl.step(8);
      ctl.step();
      const quiet = fxPixels(ctl.fa);
      const d = handDuel();
      d.step(8);
      d.a.held = btn;
      d.step();
      expect(d.pl.feelRespond(cmd), cmd).toBe('fx');
      expect(fxPixels(d.fa), cmd).toBeGreaterThan(quiet + 20);
      expect(d.fa.body.transform.lean, cmd).toBe(0);
    }
  }, 120_000);

  it('Rotational Brace turns the world: its fresh far face comes round under a cloud cover, and the next blow lands on it', () => {
    const { m, fa, pl, a, step } = handDuel(300);
    m.setSources(a, null);
    step(5);
    expect(pl.twoFaced).toBe(true);
    // batter the face toward the viewer and the foe (blows from the right, heading left)
    const hitNear = (): void => {
      fa.world.applyDamage(fa.body.id, crushAt(fa.px + 50, fa.py, -1));
      step(30);
    };
    hitNear();
    hitNear();
    hitNear();
    const before = { near: 1, far: 1 };
    pl.faceIntegrity(before);
    expect(before.near).toBeLessThan(before.far - 0.04);
    const mass0 = fa.world.stats(fa.body.id).massFrac;
    a.held = Btn.GUARD;
    step();
    expect(pl.turning).toBe(true);
    let streak = 0;
    for (let t = 0; t < 45; t++) {
      step();
      streak = Math.max(streak, Math.abs(pl.cloudSpin));
    }
    expect(pl.turning).toBe(false);
    expect(pl.bracedFace).toBe(true);
    expect(streak).toBeGreaterThan(5); // the half-turn streaks the cloud deck
    // no mirror: the body is drawn and hit as it always is; the matter itself changed faces, and the world's mass did not
    expect(fa.body.transform.facing).toBe(fa.facing);
    expect(fa.world.stats(fa.body.id).massFrac).toBeCloseTo(mass0, 2);
    const after = { near: 1, far: 1 };
    pl.faceIntegrity(after);
    expect(after.near).toBeCloseTo(before.far, 1);
    expect(after.far).toBeCloseTo(before.near, 1);
    // the same blow now lands on the fresh face; the battered one, turned away, is spared
    hitNear();
    const hit = { near: 1, far: 1 };
    pl.faceIntegrity(hit);
    expect(hit.near).toBeLessThan(after.near - 0.01);
    expect(hit.far).toBeCloseTo(after.far, 3);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 90_000);

  it('does not turn when the face toward the foe is as good as the far one', () => {
    const { fa, pl, a, step } = handDuel(300);
    step(5);
    a.held = Btn.GUARD;
    step(45);
    expect(pl.bracedFace).toBe(false);
    expect(pl.turning).toBe(false);
    expect(fa.body.transform.facing).toBe(fa.facing);
  }, 60_000);

  it('the Cataclysm quake light is local (an impact light at the epicentre), never a screen wash', () => {
    const { fa, fb, m, a, step } = handDuel(220);
    step(5);
    fa.meter = 1;
    a.held = Btn.ULTIMATE;
    step();
    a.held = 0;
    const flashes: SimEvent[] = [];
    for (let t = 0; t < 200 && !fb.view.ko; t++) {
      step();
      if (!fb.view.ko) for (const e of m.events) if (e.t === 'flash') flashes.push(e);
    }
    expect(flashes.length).toBeGreaterThan(0);
    for (const e of flashes) {
      if (e.t !== 'flash') continue;
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.y)).toBe(true);
    }
  }, 60_000);
});

/** Rms (px) of the part of a signal above `hz` (DFT of the detrended, Hann-windowed series sampled at 60 Hz). */
function rmsAbove(sig: number[], hz: number): number {
  const n = sig.length;
  const a0 = sig[0]!;
  const b = (sig[n - 1]! - a0) / (n - 1);
  const d = sig.map((v, i) => (v - a0 - b * i) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  let hi = 0;
  for (let k = 1; k < n / 2; k++) {
    if ((k * 60) / n <= hz) continue;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += d[i]! * Math.cos((2 * Math.PI * k * i) / n);
      im -= d[i]! * Math.sin((2 * Math.PI * k * i) / n);
    }
    hi += re * re + im * im;
  }
  return Math.sqrt((2 * hi) / (n * n)) * 1.63;
}

describe('Planet scale of motion (D28)', () => {
  it('moons swing into the Guard shield and back like orbiting bodies, not springs: no motion above 2.5 Hz', () => {
    const { fa, pl, a, step } = handDuel();
    step(10);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let t = 0; t < 180; t++) {
      a.held = t < 90 ? Btn.GUARD : 0;
      step();
      const mo = pl.moonBodies[1]!;
      xs.push(mo.x - fa.px);
      ys.push(mo.y - fa.py);
    }
    expect(rmsAbove(xs, 2.5)).toBeLessThan(0.3);
    expect(rmsAbove(ys, 2.5)).toBeLessThan(0.3);
  }, 60_000);

  it('the sky does not twinkle: under 5% of its lit pixels flicker (on, off, on again) from tick to tick', () => {
    // moving motes and curtains change pixels as they travel; a flicker is a pixel that blinks back within two ticks
    const { fa, step } = handDuel();
    step(10);
    const frames: Set<number>[] = [];
    let lit = 0;
    for (let t = 0; t < 60; t++) {
      step();
      const fx = fa.renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 0).find((l) => l.id === 'planet-fx')!;
      const cur = new Set<number>();
      const ox = fx.x - fx.anchorX;
      const oy = fx.y - fx.anchorY;
      if (fx.visible)
        for (let i = 0; i < fx.pixels.length; i++)
          if (fx.pixels[i]! >>> 24 !== 0) cur.add((oy + Math.floor(i / fx.w)) * 4096 + ox + (i % fx.w));
      frames.push(cur);
      lit += cur.size;
    }
    let flicker = 0;
    for (let t = 2; t < frames.length; t++)
      for (const p of frames[t]!) if (frames[t - 2]!.has(p) && !frames[t - 1]!.has(p)) flicker++;
    expect(lit).toBeGreaterThan(0);
    expect(flicker / lit).toBeLessThan(0.05);
  }, 60_000);

  it('publishes its planet-scale parts as tracked points in a stable order (moons, cloud, aurora, ring, comet)', () => {
    const { fa, step } = handDuel();
    step(3);
    const out: number[] = [];
    expect(fa.trackPoints(out)).toBe(7);
    expect(out).toHaveLength(14);
    expect(out.every(Number.isFinite)).toBe(true);
  }, 60_000);
});

describe('Planet kit', () => {
  it('Moon Slam is delayed and curved: the moon whips round its orbit first, and the stick bends its path over or under', () => {
    const flight = (aim: number): { whip: number; meanY: number } => {
      const { fa, fb, pl, a, step } = handDuel(360);
      step(5);
      a.held = Btn.STRIKE;
      a.moveY = aim;
      step(14);
      a.held = 0;
      step();
      const mo = pl.moonBodies.find((m) => m.mode === 1)!;
      // the whip: it stays on its orbit (racing round it) until its path points at the foe
      let whip = 0;
      while (mo.windup > 0 && whip < 90) {
        step();
        whip++;
        // on its orbit (long axis 120 px at the authored size, PS× now) while it whips round it
        expect(Math.hypot(mo.x - fa.px, mo.y - fa.py)).toBeLessThan(140 * PS);
      }
      // then the flight: where it runs relative to the straight line to the foe, over its first 20 ticks
      const y0 = mo.y;
      let sum = 0;
      for (let t = 0; t < 20 && mo.mode === 1; t++) {
        step();
        const u = (mo.x - fa.px) / Math.max(1, fb.px - fa.px);
        sum += mo.y - (y0 + (fb.py - y0) * u);
      }
      return { whip, meanY: sum / 20 };
    };
    const up = flight(-1);
    const down = flight(1);
    expect(up.whip).toBeGreaterThanOrEqual(13);
    expect(down.whip).toBeGreaterThanOrEqual(13);
    expect(up.meanY).toBeLessThan(down.meanY - 10);
  }, 90_000);

  it('a broken moon shatters on impact and its fragments carry on at the foe', () => {
    const { m, fa, pl, a, step } = handDuel(300);
    step(5);
    // crack both moons down to about half their mass (whichever is slung is broken)
    for (const mo of pl.moonBodies) {
      const i = pl.moonBodies.indexOf(mo);
      fa.world.carve(mo.body.id, 0.45, 11 + i);
      expect(pl.moonFrac(i)).toBeGreaterThan(0.28);
      expect(pl.moonFrac(i)).toBeLessThan(0.55);
    }
    const chunks0 = fa.world.ledger().chunkMass;
    a.held = Btn.STRIKE;
    step(13);
    a.held = 0;
    let shattered = false;
    for (let t = 0; t < 200 && !shattered; t++) {
      step();
      for (const e of m.events) if (e.t === 'cue' && e.id === 'moon-shatter') shattered = true;
    }
    expect(shattered).toBe(true);
    expect(pl.moonBodies.filter((mo) => mo.mode === 4)).toHaveLength(1);
    expect(fa.world.ledger().chunkMass).toBeGreaterThan(chunks0);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 90_000);

  it('Orbital Drift bends the dash into an arc around the foe and builds spin', () => {
    const { fa, pl, a, step } = handDuel(380);
    step(5);
    const y0 = fa.py;
    const s0 = Math.abs(pl.spin);
    a.moveX = 1;
    a.held = Btn.SURGE;
    step();
    a.held = 0;
    let dy = 0;
    let spin = 0;
    for (let t = 0; t < 30; t++) {
      step();
      dy = Math.max(dy, Math.abs(fa.py - y0));
      spin = Math.max(spin, Math.abs(pl.spin));
    }
    expect(dy).toBeGreaterThan(6);
    expect(spin).toBeGreaterThan(s0 + 0.5);
  }, 60_000);

  it('Comet Shepherd calls a comet in, bends it into the ring, spins it up while held, and Slingshot throws it at the foe', () => {
    const { fa, fb, pl, a, step } = handDuel(260);
    step(5);
    const ini = fb.view.bodyStats.mass;
    a.held = Btn.SIGNATURE;
    // on the flattened ring the speed swings with the phase: compare the top speed just after capture with the top speed late
    let captured = -1;
    let early = 0;
    let late = 0;
    for (let t = 0; t < 150; t++) {
      step();
      if (captured < 0 && pl.cometMode === 2) captured = t;
      if (pl.cometMode !== 2) continue;
      if (t < captured + 25) early = Math.max(early, pl.cometPos.speed);
      if (t >= 110) late = Math.max(late, pl.cometPos.speed);
    }
    expect(captured).toBeGreaterThan(5);
    expect(captured).toBeLessThan(85);
    expect(late).toBeGreaterThan(early * 1.5);
    a.held = 0;
    let flew = false;
    for (let t = 0; t < 200; t++) {
      step();
      if (pl.cometMode === 3) flew = true;
    }
    expect(flew).toBe(true);
    expect(fb.view.bodyStats.mass).toBeLessThan(ini);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 90_000);

  it('Comet Shepherd takes a free arena comet within reach instead of calling one in', () => {
    const { m, fa, pl, a, step } = handDuel(300);
    step(5);
    const px = new Uint32Array(12 * 12).fill(0xffe0d0c0);
    const id = fa.world.spawnChunk({
      pixels: px,
      w: 12,
      h: 12,
      // outside the ring (it grows with the world), well within reach
      x: fa.px - 200 * PS,
      y: fa.py - 120 * PS,
      vx: 80,
      vy: 0,
      spin: 0.2,
      mass: 12,
    }) as unknown as number;
    (m as unknown as { ctx: { comets: unknown[] } }).ctx.comets = [
      { id, x: fa.px - 200 * PS, y: fa.py - 120 * PS, vx: 80, vy: 0, mass: 12, mode: 0, owner: -1 },
    ];
    a.held = Btn.SIGNATURE;
    step(2);
    expect(pl.cometMode).toBe(1);
    expect(Math.hypot(pl.cometPos.x - (fa.px - 200 * PS), pl.cometPos.y - (fa.py - 120 * PS))).toBeLessThan(
      10,
    );
  }, 60_000);

  it('Tidal Draw (R1) captures nearby debris into the ring; a moonless Moon Slam throws it, and ring chunks soak blows', () => {
    const { m, fa, fb, pl, a, step } = handDuel(300);
    step(5);
    const px = new Uint32Array(14 * 14).fill(0xff406080);
    for (let k = 0; k < 4; k++)
      fa.world.spawnChunk({
        pixels: px,
        w: 14,
        h: 14,
        x: fa.px - 120,
        y: fa.py - 45 + 30 * k,
        vx: 0,
        vy: 0,
        spin: 0,
        mass: 14,
      });
    a.held = Btn.GRAVITY;
    step(90);
    expect(pl.drawLevel).toBeCloseTo(1, 2);
    expect(pl.ringCount).toBeGreaterThanOrEqual(3);
    a.held = 0;
    step(60);
    expect(pl.drawLevel).toBeLessThan(0.1);
    expect(pl.ringCount).toBeGreaterThanOrEqual(3); // the ring keeps what it caught
    // ammunition: with no moon in orbit, Strike throws the heaviest ring chunk
    for (const mo of pl.moonBodies) mo.mode = 3;
    const ring0 = pl.ringCount;
    a.held = Btn.STRIKE;
    step(13);
    a.held = 0;
    let thrown = false;
    for (let t = 0; t < 10 && !thrown; t++) {
      step();
      for (const e of m.events) if (e.t === 'cue' && e.id === 'ring-throw') thrown = true;
    }
    expect(thrown).toBe(true);
    expect(pl.ringCount).toBe(ring0 - 1);
    // armour: a blow aimed through the ring is partly soaked and knocks ring chunks loose
    const ids = new Int32Array(16);
    const w = fa.world as unknown as {
      chunksInShape(s: DamageEvent['shape'], o: Int32Array): number;
      chunkState(id: number, o: { x: number; y: number; mode: number }): boolean;
    };
    const st = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      spin: 0,
      mass: 0,
      radius: 0,
      mode: 0,
      owner: 0,
      origin: 0,
      temp: 0,
    };
    const n = w.chunksInShape({ kind: 'field', x: fa.px, y: fa.py, r: 200, falloff: 1 }, ids);
    let target = -1;
    for (let k = 0; k < n && target < 0; k++)
      if (w.chunkState(ids[k]!, st) && st.mode === 1) target = ids[k]!;
    expect(target).toBeGreaterThanOrEqual(0);
    w.chunkState(target, st);
    const before = pl.ringCount;
    const ev = crushAt(st.x, st.y, 1, 400);
    ev.shape = { kind: 'point', x: st.x, y: st.y, r: 16 };
    const events: SimEvent[] = [];
    const res = fa.receive(ev, fb, events);
    expect(res.blocked).toBeGreaterThan(0);
    expect(pl.ringCount).toBeLessThan(before);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 90_000);
});

/** One heavy blow on the face toward the foe (from the right), walking round the limb so the wound spreads and deepens. */
function woundOnce(fa: FighterImpl, k: number): void {
  const a = ((k % 7) - 3) * 0.18;
  fa.world.applyDamage(fa.body.id, crushAt(fa.px + 40 * Math.cos(a), fa.py + 40 * Math.sin(a), -1, 650));
}

describe('Planet damage phases and failure', () => {
  it('advances through the four geological phases as it is wounded, never back; the wounded world hits harder and braces worse', () => {
    const { fa, pl, step } = handDuel();
    step(7);
    expect(pl.damagePhase).toBe(1);
    const g1 = pl.guardMultiplier();
    // wound the face toward the foe blow by blow (the carve harness stops at the two-face shell's stats), watching the phase
    const seen: number[] = [1];
    for (let k = 0; k < 120 && pl.damagePhase < 4 && !fa.view.ko; k++) {
      woundOnce(fa, k);
      step(8);
      if (pl.damagePhase !== seen[seen.length - 1]) seen.push(pl.damagePhase);
    }
    expect(fa.view.ko).toBe(false);
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeGreaterThan(seen[k - 1]!);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[seen.length - 1]).toBe(4);
    const s = { speedMul: 1, damageMul: 1, mass: 5, reachMul: 1, tempoMul: 1 };
    pl.adjustStats(s, 0.4);
    expect(s.damageMul).toBeGreaterThan(1.05);
    expect(pl.guardMultiplier()).toBeLessThan(g1 * 0.7);
    // core crisis shakes the outer moon loose
    expect(pl.moonsAlive).toBeLessThan(2);
  }, 120_000);

  it('holding Crush turns Tidal Rush into the phase move: Crust Breaker, then Magma Vent, then Core Pulse (full meter)', () => {
    const held = (phase: number, meter: number): string | null => {
      const { fa, pl, a, step } = handDuel(300);
      step(5);
      for (let k = 0; k < 120 && pl.damagePhase < phase && !fa.view.ko; k++) {
        woundOnce(fa, k);
        step(8);
      }
      step(13);
      fa.meter = meter;
      a.held = Btn.CRUSH;
      step(14);
      return fa.view.moveId;
    };
    expect(held(1, 0)).toBe('planet.crustbreaker');
    expect(held(3, 0)).toBe('planet.magmavent');
    expect(held(4, 1)).toBe('planet.corepulse');
    expect(held(4, 0)).toBe('planet.magmavent');
    // a tap stays Tidal Rush
    const { fa, a, step } = handDuel(300);
    step(5);
    a.held = Btn.CRUSH;
    step(3);
    a.held = 0;
    step(12);
    expect(fa.view.moveId).toBe('planet.impact');
  }, 120_000);

  it('Crust Breaker sends a tectonic ring out that reaches the foe', () => {
    const { fb, a, step } = handDuel(240);
    step(5);
    const ini = fb.view.bodyStats.mass;
    a.held = Btn.CRUSH;
    step(70);
    a.held = 0;
    step(60);
    expect(fb.view.bodyStats.mass).toBeLessThan(ini * 0.99);
  }, 90_000);

  it('fails over ~3 s at KO: the air vents, the moons drift off, the crust slabs, the core goes out last', () => {
    const { m, fa, pl } = handDuel();
    const cues: string[] = [];
    const step = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        m.step();
        for (const e of m.events) if (e.t === 'cue' && e.slot === fa.slot && fa.view.ko) cues.push(e.id);
      }
    };
    step(5);
    fa.world.carve(fa.body.id, 0.3, 4);
    step(7);
    const atmo0 = pl.atmosphere;
    // the finishing wound
    let guard = 0;
    while (!fa.view.ko && guard++ < 20) {
      fa.world.applyDamage(fa.body.id, crushAt(fa.px + 30, fa.py, -1, 1500));
      step(3);
    }
    expect(fa.view.ko).toBe(true);
    let lightAt100 = 0;
    let moonsFree = false;
    for (let t = 0; t < 230; t++) {
      step();
      if (pl.failure === 100) lightAt100 = pl.coreLight;
      if (pl.failure > 30) moonsFree = pl.moonBodies.every((mo) => mo.mode === 3 || mo.mode === 4);
    }
    expect(cues).toContain('atmo-vent');
    expect(cues).toContain('moons-drift');
    expect(cues).toContain('crust-slab');
    expect(cues).toContain('core-out');
    expect(cues.indexOf('core-out')).toBeGreaterThan(cues.indexOf('crust-slab'));
    expect(pl.atmosphere).toBeLessThanOrEqual(atmo0);
    expect(moonsFree).toBe(true);
    expect(lightAt100).toBe(1);
    expect(pl.coreLight).toBe(0);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 120_000);
});
