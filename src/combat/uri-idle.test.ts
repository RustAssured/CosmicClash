import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  LOGICAL_H,
  LOGICAL_W,
  parseScript,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef, URI_ID, uriDef } from '@/titans';
import { URI_IDLE_PARTS, uriIdleJigs, uriSpeckPixels, type UriIdleFx } from '@/render/uriLive';
import { createFighter } from './index';
import type { FighterImpl } from './fighter';
import type { UriBehaviour } from './behaviours/uri';
import { skipIntro } from './testing/harness';
import { UriKinetics, uriLoose } from './uri/kinetics';

const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };

interface Peek {
  kin: UriKinetics;
}
const kinOf = (beh: UriBehaviour): UriKinetics => (beh as unknown as Peek).kin;

/** 우리 in slot 0, the foe still, `dx` px away (negative = on its left). */
function setup(dx = 260, seed = 7): { m: Match; u: FighterImpl; beh: UriBehaviour } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: URI_ID, controller: 'human' },
      { titan: 'planet' as TitanId, controller: 'human' },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef: (id: TitanId) => (id === URI_ID ? uriDef() : getTitanDef(id)),
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  const u = m.fighters[0] as FighterImpl;
  const foe = m.fighters[1] as unknown as { px: number; py: number };
  foe.px = u.px + dx;
  foe.py = u.py;
  m.setSources(createScriptSource([], m.tick + 1), createScriptSource([], m.tick + 1));
  return { m, u, beh: u.behaviour as unknown as UriBehaviour };
}

describe('우리 living idle, "The Refusal: still here" (idle handover specs/uri.md; WJ 2026-10-20: the prototype\'s timing)', () => {
  it('rendering never changes the sim through a whole Refusal (S19, 900 ticks)', () => {
    const a = setup();
    const b = setup();
    for (let t = 0; t < 900; t++) {
      a.m.step();
      b.m.step();
      a.u.renderLayers(view, 1);
    }
    expect(kinOf(a.beh).idleOn).toBe(true);
    expect(a.m.hash()).toBe(b.m.hash());
  });

  it('a Refusal comes 8 s into the round: loosens for 1.6 s, slams once at +2.1 s (ring, flash, shake), ends by +5.6 s', () => {
    const { m, beh } = setup();
    const kin = kinOf(beh);
    const u = m.fighters[0] as FighterImpl;
    let start = -1;
    let slamAt = -1;
    let shakes = 0;
    let maxLoose = 0;
    let endedAt = -1;
    for (let t = 0; t < 900; t++) {
      m.step();
      for (const e of u.events) if (e.t === 'shake' && e.amp === 4) shakes++;
      const R = kin.refT;
      if (R >= 0 && start < 0) start = kin.t;
      if (start >= 0 && R < 0 && endedAt < 0) endedAt = kin.t;
      maxLoose = Math.max(maxLoose, beh.kview.idle!.loose);
      if (beh.kview.idle!.flash > 0.95 && slamAt < 0) slamAt = kin.t;
    }
    expect(start).toBeGreaterThan(7.9);
    expect(start).toBeLessThan(8.2);
    expect(maxLoose).toBe(1);
    expect(slamAt - start).toBeGreaterThan(2.05);
    expect(slamAt - start).toBeLessThan(2.15);
    expect(endedAt - start).toBeGreaterThan(5.55);
    expect(endedAt - start).toBeLessThan(5.7);
    expect(shakes).toBe(1);
    // the coming-apart's curve: smooth in, held, snapped back
    expect(uriLoose(0.8)).toBeCloseTo(0.5, 5);
    expect(uriLoose(1.9)).toBe(1);
    expect(uriLoose(2.4)).toBe(0);
  });

  it('a move started mid-Refusal cancels it on the same tick', () => {
    const { m, u, beh } = setup();
    const kin = kinOf(beh);
    let t = 0;
    while (kin.refT < 1.0 && t++ < 900) m.step();
    expect(kin.refT).toBeGreaterThan(0.9);
    m.setSources(createScriptSource(parseScript('1:strike'), m.tick + 1), createScriptSource([], m.tick + 1));
    let cancelled = false;
    for (let k = 0; k < 6; k++) {
      m.step();
      if (beh.kview.move) {
        expect(kin.refT).toBe(-1);
        expect(beh.kview.idle!.loose).toBe(0);
        cancelled = true;
        break;
      }
    }
    void u;
    expect(cancelled).toBe(true);
  });

  it('the guard leads with the arm on the opponent side (never mirrored: only which arm leads)', () => {
    const r = setup(260);
    const l = setup(-260);
    for (let t = 0; t < 120; t++) {
      r.m.step();
      l.m.step();
    }
    const R = kinOf(r.beh).L;
    const L = kinOf(l.beh).L;
    // the lead arm's shoulder held forward (−10°·d), the rear arm back (+6°·d): with the foe on the right the right arm leads
    expect(R.sR.x).toBeLessThan(-0.05);
    expect(R.sL.x).toBeGreaterThan(0.02);
    expect(L.sL.x).toBeGreaterThan(0.05);
    expect(L.sR.x).toBeLessThan(-0.02);
    // the body is still drawn facing +1
    for (const layer of l.u.renderLayers(view, 1)) expect(layer.facing, layer.id).toBe(1);
  });

  it('the oracle-parity harness keeps the idle off: a bare UriKinetics rests exactly as before', () => {
    const a = new UriKinetics(3);
    for (let t = 0; t < 600; t++) a.step(1 / 60);
    expect(a.idleOn).toBe(false);
    expect(a.refT).toBe(-1);
    expect(a.L.hx.x).toBe(0);
    expect(a.L.sR.x).toBe(0);
  });

  it('broken apart: no idle', () => {
    const { m, beh } = setup();
    for (let t = 0; t < 500; t++) m.step();
    // (just before the first Refusal; then the loop snaps: the round ends, so look only at the ticks right after)
    (beh as unknown as { breakApart(): void }).breakApart();
    for (let t = 0; t < 60; t++) {
      m.step();
      expect(beh.brokenApart).toBe(true);
      expect(kinOf(beh).idleOn).toBe(false);
      expect(kinOf(beh).refT).toBe(-1);
    }
  });

  it('the jigs and specks are stateless and never pick a part that has gone', () => {
    const parts = new Float32Array(URI_IDLE_PARTS * 4);
    for (let i = 0; i < URI_IDLE_PARTS; i++)
      parts.set([100 + i, 100, i === 7 ? 0 : 20, i === 7 ? 0 : 20], i * 4);
    const fx: UriIdleFx = {
      on: true,
      t: 0,
      refT: -1,
      loose: 0,
      flash: 0,
      bx: 0,
      by: 0,
      ox: 0,
      oy: 0,
      scale: 2 / 3,
      parts,
      slot: 0,
    };
    const out = new Float32Array(24);
    const out2 = new Float32Array(24);
    let seen = 0;
    for (let t = 0; t < 120; t += 0.05) {
      fx.t = t;
      const n = uriIdleJigs(fx, out, 6);
      expect(uriIdleJigs(fx, out2, 6)).toBe(n);
      expect(Array.from(out2.subarray(0, n * 4))).toEqual(Array.from(out.subarray(0, n * 4)));
      for (let j = 0; j < n; j++) {
        // the chamber (7) is gone; the pelvis (2, the body layer) and the moon (12) never jig
        expect([2, 7, 12]).not.toContain(out[j * 4]);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(100);
    // about six specks a second, each about a second: a handful alive at any time
    fx.t = 30;
    const sp = new Float32Array(128 * 6);
    const ns = uriSpeckPixels(fx, 0, 0, sp);
    expect(ns).toBeGreaterThan(2);
    expect(ns).toBeLessThan(14);
    // the slam's 60 inward specks
    fx.refT = 2.2;
    expect(uriSpeckPixels(fx, 0, 0, sp)).toBeGreaterThanOrEqual(ns + 50);
  });
});
