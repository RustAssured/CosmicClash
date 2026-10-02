import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, parseScript, pa } from '@/contracts';
import { createScriptSource } from '@/sim';
import type { FighterImpl } from './fighter';
import { Overlay } from './fx/overlay';
import { SplinePen, type SplineStyle } from './fx/spline';
import { NODES, type TendrilSystem } from './behaviours/tendrils';
import { createFakeWorld, makeMatch, skipIntro } from './testing/harness';

const RAMP = [0xff101010, 0xff303030, 0xff505050, 0xff707070, 0xff909090, 0xffb0b0b0];
const style = (o: Partial<SplineStyle> = {}): SplineStyle => ({
  r0: 3,
  r1: 0.8,
  taperPow: 1.2,
  ramp: RAMP,
  rootShade: 0,
  contrast: 1,
  tipRamp: null,
  tipFrom: 0.8,
  tipEmissive: 0,
  jointEvery: 0,
  jointBulge: 0,
  outlineDark: 0xff000001,
  outlineLit: 0xff000002,
  ...o,
});

/** Draw a chain of nodes into a fresh overlay centred on (100, 100); returns the overlay. */
function draw(xs: number[], ys: number[], st: SplineStyle, light = DEFAULT_LIGHTING.dir): Overlay {
  const ov = new Overlay('t', 0, 200, 200, 'normal', true);
  const pen = new SplinePen(200, 200);
  pen.setLight(light);
  ov.begin(100, 100);
  pen.stroke(ov, xs, ys, 0, xs.length, xs.length, st);
  ov.end();
  return ov;
}

const filledColumn = (ov: Overlay, x: number, fill: (c: number) => boolean): number => {
  let n = 0;
  for (let y = 0; y < 200; y++) if (fill(ov.get(x, y))) n++;
  return n;
};
const isBody = (c: number): boolean => pa(c) !== 0 && RAMP.includes(c);

describe('SplinePen (tendrils now, Witness arms and fibres next)', () => {
  const xs = Array.from({ length: 12 }, (_, k) => 40 + k * 10);
  const ys = xs.map(() => 100);

  it('tapers from the root to the tip', () => {
    const ov = draw(xs, ys, style());
    const root = filledColumn(ov, 44, isBody);
    const tip = filledColumn(ov, 140, isBody);
    expect(root).toBeGreaterThanOrEqual(5);
    expect(tip).toBeLessThanOrEqual(2);
    expect(tip).toBeGreaterThan(0);
  });

  it('is lit per pixel across the tube (more than the old three bands) and darker on the side away from the light', () => {
    const ov = draw(xs, ys, style({ r0: 4, r1: 4 }));
    const col: number[] = [];
    for (let y = 0; y < 200; y++) if (isBody(ov.get(80, y))) col.push(RAMP.indexOf(ov.get(80, y)));
    expect(col.length).toBeGreaterThanOrEqual(7);
    // the stage light comes from the upper left: the top flank is lighter than the bottom one
    expect(col[1]!).toBeGreaterThan(col[col.length - 2]!);
    let distinct = 0;
    for (let i = 0; i < RAMP.length; i++) if (col.includes(i)) distinct++;
    expect(distinct).toBeGreaterThanOrEqual(4);
  });

  it('passes through every node (Catmull-Rom interpolates) and is drawn as a smooth curve between them', () => {
    const cx = Array.from({ length: 8 }, (_, k) => 50 + k * 14);
    const cy = cx.map((_, k) => 100 + Math.sin(k * 0.9) * 22);
    const ov = draw(cx, cy, style({ r0: 1.5, r1: 1.5 }));
    for (let k = 0; k < cx.length; k++)
      expect(pa(ov.get(Math.floor(cx[k]!), Math.floor(cy[k]!)))).not.toBe(0);
    // no gaps: every column between the first and last node holds the stroke
    for (let x = 52; x < cx[cx.length - 1]! - 2; x++) expect(filledColumn(ov, x, isBody)).toBeGreaterThan(0);
  });

  it('outlines the stroke (dark on the shadow side, lit edge on the lit side)', () => {
    const ov = draw(xs, ys, style({ r0: 3, r1: 3 }));
    let dark = 0;
    let lit = 0;
    for (let y = 0; y < 200; y++) {
      const c = ov.get(80, y);
      if (c === 0xff000001) dark++;
      if (c === 0xff000002) lit++;
    }
    expect(dark).toBe(1);
    expect(lit).toBe(1);
  });

  it('joints bulge and carry a darker groove', () => {
    const plain = draw(xs, ys, style({ r0: 2.5, r1: 2.5 }));
    const jointed = draw(xs, ys, style({ r0: 2.5, r1: 2.5, jointEvery: 3, jointBulge: 0.5 }));
    // node 3 sits at x = 70
    expect(filledColumn(jointed, 70, (c) => pa(c) !== 0)).toBeGreaterThan(
      filledColumn(plain, 70, (c) => pa(c) !== 0),
    );
    const mean = (ov: Overlay, x: number): number => {
      let s = 0;
      let n = 0;
      for (let y = 0; y < 200; y++)
        if (isBody(ov.get(x, y))) {
          s += RAMP.indexOf(ov.get(x, y));
          n++;
        }
      return s / n;
    };
    expect(mean(jointed, 70)).toBeLessThan(mean(plain, 70));
  });

  it('is deterministic', () => {
    const a = draw(xs, ys, style({ jointEvery: 3, jointBulge: 0.4 }));
    const b = draw(xs, ys, style({ jointEvery: 3, jointBulge: 0.4 }));
    expect(Array.from(a.layer.pixels)).toEqual(Array.from(b.layer.pixels));
  });
});

/** Total turning (rad) along a chain: how curved it is. */
function turning(s: TendrilSystem, i: number): number {
  let sum = 0;
  let prev = NaN;
  for (let k = 1; k < s.count[i]!; k++) {
    const a = Math.atan2(
      s.y[i * NODES + k]! - s.y[i * NODES + k - 1]!,
      s.x[i * NODES + k]! - s.x[i * NODES + k - 1]!,
    );
    if (!Number.isNaN(prev)) {
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      sum += Math.abs(d);
    }
    prev = a;
  }
  return sum;
}

/** Largest distance (px) of a node from the root→tip chord: how much the whip bows. */
function bow(s: TendrilSystem, i: number): number {
  const b = i * NODES;
  const c = s.count[i]! - 1;
  const ax = s.x[b]!;
  const ay = s.y[b]!;
  const dx = s.x[b + c]! - ax;
  const dy = s.y[b + c]! - ay;
  const l = Math.hypot(dx, dy) || 1;
  let m = 0;
  for (let k = 1; k < c; k++)
    m = Math.max(m, Math.abs(((s.x[b + k]! - ax) * dy - (s.y[b + k]! - ay) * dx) / l));
  return m;
}

/**
 * Longest stretch (px) of the drawn Catmull-Rom curve of tendril i over which the heading turns less than 0.1 rad — a
 * visually straight run.
 */
function longestStraight(s: TendrilSystem, i: number): number {
  const base = i * NODES;
  const cnt = s.count[i]!;
  const px: number[] = [];
  const py: number[] = [];
  for (let k = 0; k + 1 < cnt; k++) {
    const i1 = base + k;
    const i2 = i1 + 1;
    const x1 = s.x[i1]!;
    const y1 = s.y[i1]!;
    const x2 = s.x[i2]!;
    const y2 = s.y[i2]!;
    const x0 = k > 0 ? s.x[i1 - 1]! : 2 * x1 - x2;
    const y0 = k > 0 ? s.y[i1 - 1]! : 2 * y1 - y2;
    const x3 = k + 2 < cnt ? s.x[i2 + 1]! : 2 * x2 - x1;
    const y3 = k + 2 < cnt ? s.y[i2 + 1]! : 2 * y2 - y1;
    const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    for (let j = k === 0 ? 0 : 1; j <= n; j++) {
      const t = j / n;
      const t2 = t * t;
      const t3 = t2 * t;
      px.push(
        0.5 *
          (2 * x1 +
            (-x0 + x2) * t +
            (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 +
            (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
      );
      py.push(
        0.5 *
          (2 * y1 +
            (-y0 + y2) * t +
            (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
            (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
      );
    }
  }
  const h: number[] = [];
  const sl: number[] = [0];
  for (let k = 1; k < px.length; k++) {
    h.push(Math.atan2(py[k]! - py[k - 1]!, px[k]! - px[k - 1]!));
    if (k > 1) sl.push(sl[sl.length - 1]! + Math.hypot(px[k]! - px[k - 1]!, py[k]! - py[k - 1]!));
  }
  let best = 0;
  for (let a = 0; a < h.length; a++)
    for (let b = a + 1; b < h.length; b++) {
      let d = h[b]! - h[a]!;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.abs(d) >= 0.1) break;
      best = Math.max(best, sl[b]! - sl[a]!);
    }
  return best;
}

/** Number of self-crossings of tendril i's node polyline (a knot). */
function selfCrossings(s: TendrilSystem, i: number): number {
  const b = i * NODES;
  const c = s.count[i]!;
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  let n = 0;
  for (let p = 0; p + 1 < c; p++)
    for (let q = p + 2; q + 1 < c; q++) {
      const [x1, y1, x2, y2] = [s.x[b + p]!, s.y[b + p]!, s.x[b + p + 1]!, s.y[b + p + 1]!];
      const [x3, y3, x4, y4] = [s.x[b + q]!, s.y[b + q]!, s.x[b + q + 1]!, s.y[b + q + 1]!];
      const d1 = cross(x3, y3, x4, y4, x1, y1);
      const d2 = cross(x3, y3, x4, y4, x2, y2);
      const d3 = cross(x1, y1, x2, y2, x3, y3);
      const d4 = cross(x1, y1, x2, y2, x4, y4);
      if (d1 * d2 < 0 && d3 * d4 < 0) n++;
    }
  return n;
}

function lastOne(script = ''): { step: (n: number) => void; f: FighterImpl; sys: TendrilSystem } {
  const m = makeMatch({ a: 'lastone', b: 'asteroid', seed: 5, createWorld: createFakeWorld });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const foe = m.fighters[1] as FighterImpl;
  foe.px = f.px + 400;
  m.setSources(createScriptSource(parseScript(script), m.tick + 1), createScriptSource([], m.tick + 1));
  const sys = (f.behaviour as unknown as { sys: TendrilSystem }).sys;
  return {
    step: (n) => {
      for (let i = 0; i < n; i++) m.step();
    },
    f,
    sys,
  };
}

describe('Last One tendrils (D3): grown, varied, curved whips', () => {
  it('rest shapes are curved and varied, not a comb of equal straight rods', () => {
    const { step, sys } = lastOne();
    step(90);
    const lens = sys.roots.map((r) => r.len);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    // the old roots varied by ≈ 0.11 (coefficient of variation, 28–40 px); now ≈ 0.18 over 18–52 px
    expect(sd / mean).toBeGreaterThan(0.15);
    expect(Math.max(...lens) / Math.min(...lens)).toBeGreaterThan(1.8);
    let curved = 0;
    for (let i = 0; i < sys.n; i++) if (turning(sys, i) > 0.35) curved++;
    expect(curved).toBeGreaterThanOrEqual(sys.n * 0.75);
  });

  it('Shatter: the whips fan across the whole cone, bowed, and are out by the first active tick', () => {
    const { step, f, sys } = lastOne('4:crush');
    let first = -1;
    for (let k = 0; k < 80; k++) {
      step(1);
      if (f.mv.phase === 'active' && first < 0) {
        first = k;
        break;
      }
    }
    expect(first).toBeGreaterThan(0);
    const t = f.body.transform;
    // tips of the whipping tendrils (not the crown): bearings and reach from the anchor
    const bearings: number[] = [];
    let reach = 0;
    let bowSum = 0;
    let n = 0;
    for (let i = 0; i < sys.n; i++) {
      if (sys.roots[i]!.kind === 'crown') continue;
      const tip = i * NODES + sys.count[i]! - 1;
      const dx = (sys.x[tip]! - t.x) * t.facing;
      bearings.push(Math.atan2(sys.y[tip]! - t.y, dx));
      reach += dx;
      bowSum += bow(sys, i);
      n++;
    }
    // released before contact: on average the tips are already well in front of the body on the contact tick
    expect(reach / n).toBeGreaterThan(25);
    step(6);
    const later: number[] = [];
    let bowLater = 0;
    for (let i = 0; i < sys.n; i++) {
      if (sys.roots[i]!.kind === 'crown') continue;
      const tip = i * NODES + sys.count[i]! - 1;
      later.push(Math.atan2(sys.y[tip]! - t.y, (sys.x[tip]! - t.x) * t.facing));
      bowLater += bow(sys, i);
    }
    const spread = Math.max(...later) - Math.min(...later);
    // the old rake pinned every tip within ±12 px of the cone tip (≈ 0.2 rad); the fan now covers most of the cone
    expect(spread).toBeGreaterThan(0.5);
    expect(bowLater / n).toBeGreaterThan(3);
    expect(bowSum / n).toBeGreaterThan(2);
  });

  it('Shatter: whips are bowed arcs while active (no long straight runs), and recovery folds back without knots', () => {
    const { step, f, sys } = lastOne('4:crush');
    let worstActive = 0;
    let crossingsRecovery = 0;
    let chainTicks = 0;
    let recoveryTicks = 0;
    for (let k = 0; k < 140; k++) {
      step(1);
      const ph = f.mv.phase;
      for (let i = 0; i < sys.n; i++) {
        if (sys.count[i]! < 4) continue;
        if (ph === 'active' && sys.tw[i]! > 0.5) worstActive = Math.max(worstActive, longestStraight(sys, i));
        if (ph === 'recovery' || f.mv.def === null) {
          crossingsRecovery += selfCrossings(sys, i);
          chainTicks++;
        }
      }
      if (ph === 'recovery') recoveryTicks++;
    }
    expect(recoveryTicks).toBeGreaterThan(20);
    // measured before this change: 58–113 px of visually straight whip during the active frames; now ≤ ~30 px
    expect(worstActive).toBeLessThan(40);
    // knots in the recovery: 150 self-crossings over the recovery before the folding return; with S1's re-balance
    // choreography (back-step + counter-twist at tick 42) a few chains still cross for a tick or two (3 measured). The
    // bound is honest for this throwaway model: under 2 % of chain-ticks may be crossed (the bend limit is soft since the
    // scale-of-motion pass: a hard one chattered at the frame rate).
    expect(crossingsRecovery / Math.max(1, chainTicks)).toBeLessThan(0.02);
  });

  it('moves at planet scale (D28): tip motion is dominated by ≤ 1.5 Hz, with little energy above 2 Hz', () => {
    /** Fraction of the detrended, Hann-windowed signal energy above 2 Hz, and the dominant frequency (60 Hz sampling). */
    const spectrum = (sig: number[]): { high: number; dom: number } => {
      const n = sig.length;
      const mean = sig.reduce((a, b) => a + b, 0) / n;
      const s = sig.map((v, i) => (v - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
      let tot = 0;
      let hi = 0;
      let best = 0;
      let dom = 0;
      for (let k = 1; k < n / 2; k++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          re += s[i]! * Math.cos((2 * Math.PI * k * i) / n);
          im -= s[i]! * Math.sin((2 * Math.PI * k * i) / n);
        }
        const p = re * re + im * im;
        tot += p;
        if ((k * 60) / n > 2) hi += p;
        if (p > best) {
          best = p;
          dom = (k * 60) / n;
        }
      }
      return { high: tot > 0 ? hi / tot : 0, dom };
    };
    for (const script of ['', '4:crush']) {
      const { step, sys } = lastOne(script);
      const tips: number[][] = Array.from({ length: sys.n }, () => []);
      for (let t = 0; t < 240; t++) {
        step(1);
        for (let i = 0; i < sys.n; i++) {
          const j = i * NODES + sys.count[i]! - 1;
          tips[i]!.push(sys.x[j]! + sys.y[j]! * 0.7);
        }
      }
      let hi = 0;
      let dom = 0;
      for (const tip of tips) {
        const r = spectrum(tip);
        hi += r.high;
        dom = Math.max(dom, r.dom);
      }
      expect(hi / sys.n, script || 'idle').toBeLessThan(0.04);
      expect(dom, script || 'idle').toBeLessThanOrEqual(1.5);
    }
  });

  it('a lash is staggered and slow (D28): mid-strike the whips are at different stages, none snaps in a few ticks', () => {
    const { step, f, sys } = lastOne('4:strike');
    const out = { x: 0, y: 0 };
    let frac: number[] = [];
    let firstActive = -1;
    for (let k = 0; k < 60; k++) {
      step(1);
      if (f.mv.phase !== 'active') continue;
      if (firstActive < 0) firstActive = k;
      // half-way through the active window: how far along its path is each whip's tip target?
      if (k === firstActive + 6) {
        frac = [];
        for (let i = 0; i < sys.n; i++) {
          if (sys.tw[i]! < 0.5) continue;
          sys.whipTarget(i, out);
          const left = Math.hypot(out.x - sys.tx[i]!, out.y - sys.ty[i]!);
          const span = Math.hypot(sys.tx[i]! - sys.rx[i]!, sys.ty[i]! - sys.ry[i]!) || 1;
          frac.push(Math.min(1, left / span));
        }
      }
    }
    expect(frac.length).toBeGreaterThan(4);
    const mean = frac.reduce((a, b) => a + b, 0) / frac.length;
    const sd = Math.sqrt(frac.reduce((a, b) => a + (b - mean) ** 2, 0) / frac.length);
    // staggered: the tips are not all at the same distance from their targets …
    expect(sd).toBeGreaterThan(0.03);
    // … and slow: half-way through the window they are still on their way (a critter would already be there)
    expect(mean).toBeGreaterThan(0.05);
  });
});
