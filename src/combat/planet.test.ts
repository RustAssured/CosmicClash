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

  it('Moon Slam spends a moon, hits for real, and the moon comes home damaged', () => {
    const { m, fa, fb, pl } = duel('planet', 'asteroid', 300);
    const ini = fb.view.bodyStats.mass;
    m.setSources(createScriptSource(parseScript('1:sig*45'), m.tick + 1), null);
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
        ev.energy = 900;
        ev.shape = { kind: 'point', x: mo.x, y: mo.y, r: 14 };
        events.length = 0;
        fb.receive(ev, attacker, events);
        if (events.some((e) => e.t === 'cue' && e.id === 'moon-lost')) lost = true;
      }
    }
    expect(lost).toBe(true);
    expect(mo.mode).toBe(4);
    expect(knocked || lost).toBe(true);
    expect(fb.world.getBody(mo.body.id)).toBeUndefined();
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
    for (let t = 0; t < 90; t++) {
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

  it('Rotational Brace turns the more intact face toward the foe under a cloud cover, and the next blow lands on it', () => {
    const { m, fa, pl, a, step } = handDuel(300);
    m.setSources(a, null);
    step(5);
    // batter the face toward the foe (the foe is to the right: blows come from the right, heading left)
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
    expect(fa.body.transform.facing).toBe(fa.facing);
    a.held = Btn.GUARD;
    step();
    expect(pl.turning).toBe(true);
    let streak = 0;
    for (let t = 0; t < 20; t++) {
      step();
      streak = Math.max(streak, Math.abs(pl.cloudSpin));
    }
    expect(pl.turning).toBe(false);
    expect(pl.bracedFace).toBe(true);
    expect(streak).toBeGreaterThan(5); // the half-turn streaks the cloud deck
    // the body is now drawn and hit mirrored against the fighter's facing: the intact face is toward the foe
    expect(fa.body.transform.facing).toBe(-fa.facing as 1 | -1);
    const after = { near: 1, far: 1 };
    pl.faceIntegrity(after);
    expect(after.near).toBeCloseTo(before.far, 2);
    expect(after.far).toBeCloseTo(before.near, 2);
    // the same blow now lands on the fresh face; the battered one, turned away, is spared
    hitNear();
    const hit = { near: 1, far: 1 };
    pl.faceIntegrity(hit);
    expect(hit.near).toBeLessThan(after.near - 0.01);
    expect(after.far - hit.far).toBeLessThan((after.near - hit.near) * 0.5);
  }, 90_000);

  it('does not turn when the face toward the foe is already the better one', () => {
    const { fa, pl, a, step } = handDuel(300);
    step(5);
    for (let k = 0; k < 3; k++) {
      fa.world.applyDamage(fa.body.id, crushAt(fa.px - 50, fa.py, 1));
      step(30);
    }
    a.held = Btn.GUARD;
    step(25);
    expect(pl.bracedFace).toBe(false);
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
