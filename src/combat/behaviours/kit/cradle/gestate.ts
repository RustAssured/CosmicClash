import { ROT_LUT, ROT_ONE, localToWorld, worldToLocal, type MatterBody, type MatterMap } from '@/contracts';
import { DMath, sq } from '@/contracts/dmath';

/**
 * GESTATION (Gate 3, brief "How it destroys matter"): the Cradle does not only break what it hits, it DEVELOPS it. Every blow
 * it lands plants a site in the foe's matter, which over the next second and a half is vascularised (a web of capillaries
 * spreads from the contact), folded into cartilage
 * ridges across the blow, and after a heavy blow swells into an organ-like bulge. Everything is drawn in the VICTIM'S OWN
 * colours (its darkest and lightest tones round the site): an asteroid grows rock-coloured cartilage, the Planet's crust
 * bulges in crust colours, 우리 sprouts capillaries in its own metal.
 *
 * The foe's matter is only recoloured, never added to or weakened (the blows did the damage; this is what they leave). Deterministic: sites are planted and
 * advanced on the sim tick, in order; their shapes come from integer hashes.
 */

export interface GestationSite {
  body: MatterBody;
  /** Contact in the body's map (cells, float). */
  lx: number;
  ly: number;
  /** Radius (cells), age (ticks), seed, the blow's direction in the map (unit) and whether it was heavy. */
  r: number;
  age: number;
  seed: number;
  dx: number;
  dy: number;
  heavy: boolean;
  /** The victim's own darkest / lightest tones round the site (packed). */
  dark: number;
  light: number;
  /** Strength multiplier (Implant: ×1.6). */
  k: number;
}

const MAX_SITES = 24;
/** Life of a site (ticks): web 0–30, ridges at 34, a heavy blow's organ at 52. */
const SITE_LIFE = 90;

const ihash = (a: number, b: number, s: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

const mix = (a: number, b: number, t: number): number => {
  const u = 1 - t;
  const r = (a & 255) * u + (b & 255) * t;
  const g = ((a >>> 8) & 255) * u + ((b >>> 8) & 255) * t;
  const bl = ((a >>> 16) & 255) * u + ((b >>> 16) & 255) * t;
  return ((255 << 24) | (Math.round(bl) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
};
const lum = (c: number): number => (c & 255) * 0.3 + ((c >>> 8) & 255) * 0.59 + ((c >>> 16) & 255) * 0.11;

/** Map-local coordinates of a world point in a body (mirrored, sheared or rotated). */
export function bodyLocal(b: MatterBody, wx: number, wy: number, out: { x: number; y: number }): void {
  const t = b.transform;
  const step = t.rot ?? 0;
  if (step === 0) {
    worldToLocal(t, wx, wy, out);
    return;
  }
  const c = ROT_LUT.cos[step]! / ROT_ONE;
  const s = ROT_LUT.sin[step]! / ROT_ONE;
  const dx = wx - Math.round(t.x);
  const dy = wy - Math.round(t.y);
  out.x = t.anchorX + (c * dx + s * dy) * t.facing;
  out.y = t.anchorY + (-s * dx + c * dy);
}

/** World position of a map-local point of a body (mirrored, sheared or rotated): the inverse of `bodyLocal`. */
export function bodyWorld(b: MatterBody, lx: number, ly: number, out: { x: number; y: number }): void {
  const t = b.transform;
  const step = t.rot ?? 0;
  if (step === 0) {
    localToWorld(t, lx, ly, out);
    return;
  }
  const c = ROT_LUT.cos[step]! / ROT_ONE;
  const s = ROT_LUT.sin[step]! / ROT_ONE;
  const mx = (lx - t.anchorX) * t.facing;
  const my = ly - t.anchorY;
  out.x = Math.round(t.x) + c * mx - s * my;
  out.y = Math.round(t.y) + s * mx + c * my;
}

export class Gestation {
  readonly sites: GestationSite[] = [];
  private readonly loc = { x: 0, y: 0 };
  /** Cells recoloured so far (instrumentation). */
  cells = 0;

  /**
   * A blow landed at world (x, y): find the foe body under it (the nearest live cell within 5 px) and plant a site there.
   * `energy` sizes it; `k` scales its strength (Implant).
   */
  plant(
    bodies: readonly MatterBody[],
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    energy: number,
    heavy: boolean,
    seed: number,
    k = 1,
  ): GestationSite | null {
    for (const b of bodies) {
      const m = b.map;
      bodyLocal(b, x, y, this.loc);
      const cx = Math.floor(this.loc.x);
      const cy = Math.floor(this.loc.y);
      let best = 26;
      let bx = -1;
      let by = -1;
      for (let yy = cy - 5; yy <= cy + 5; yy++)
        for (let xx = cx - 5; xx <= cx + 5; xx++) {
          if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h || m.material[yy * m.w + xx] === 0) continue;
          const d = sq(xx - cx) + sq(yy - cy);
          if (d < best) {
            best = d;
            bx = xx;
            by = yy;
          }
        }
      if (bx < 0) continue;
      const r = Math.min(26, 10 + Math.sqrt(Math.max(0, energy)) * 0.4) * (0.85 + 0.15 * k);
      // the victim's own palette round the site
      let dark = 0;
      let light = 0;
      let dl = Infinity;
      let ll = -Infinity;
      const R = Math.ceil(r);
      for (let yy = by - R; yy <= by + R; yy += 2)
        for (let xx = bx - R; xx <= bx + R; xx += 2) {
          if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
          const i = yy * m.w + xx;
          if (m.material[i] === 0) continue;
          const l = lum(m.baseColor[i]!);
          if (l < dl) {
            dl = l;
            dark = m.baseColor[i]!;
          }
          if (l > ll) {
            ll = l;
            light = m.baseColor[i]!;
          }
        }
      // the blow's direction in the map's frame (mirror; a rotated body is close enough unrotated for a stripe direction)
      const dx = dirX * b.transform.facing;
      const s: GestationSite = {
        body: b,
        lx: bx + 0.5,
        ly: by + 0.5,
        r,
        age: 0,
        seed,
        dx,
        dy: dirY,
        heavy,
        dark: mix(dark, 0xff000000, 0.25),
        light,
        k,
      };
      if (this.sites.length >= MAX_SITES) this.sites.shift();
      this.sites.push(s);
      return s;
    }
    return null;
  }

  /** Advance every site one tick (call once per sim tick). */
  tick(): void {
    for (let n = this.sites.length - 1; n >= 0; n--) {
      const s = this.sites[n]!;
      const m = s.body.map;
      if (m.material.length === 0) {
        this.sites.splice(n, 1);
        continue;
      }
      const a = s.age++;
      if (a < 30 && a % 3 === 0) this.web(s, a / 30);
      if (a === 34) this.ridges(s);
      if (a === 52 && s.heavy) this.organ(s);
      if (s.age >= SITE_LIFE) this.sites.splice(n, 1);
    }
  }

  /** Capillaries spread from the contact as branching dark threads in the victim's darkest tone. */
  private web(s: GestationSite, u: number): void {
    const m = s.body.map;
    const branches = 7 + Math.floor(4 * s.k);
    const reach = s.r * (0.25 + 0.95 * u);
    let x0 = m.w;
    let y0 = m.h;
    let x1 = 0;
    let y1 = 0;
    for (let b = 0; b < branches; b++) {
      let a = ihash(b, 1, s.seed) * Math.PI * 2;
      let x = s.lx;
      let y = s.ly;
      const steps = Math.ceil(reach);
      for (let k = 0; k < steps; k++) {
        a += (ihash(b, k, s.seed + 7) - 0.5) * 1.1;
        x += DMath.cos(a);
        y += DMath.sin(a);
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= m.w || iy >= m.h) break;
        const i = iy * m.w + ix;
        if (m.material[i] === 0) break;
        // a thread thins and pales toward its end; near the contact it is two cells thick, with a lit flank (it is raised)
        const t = 0.9 - 0.4 * (k / Math.max(1, steps));
        this.paint(m, i, mix(m.baseColor[i]!, s.dark, t));
        if (k < steps * 0.55) {
          const j = iy + 1 < m.h ? i + m.w : i;
          if (m.material[j] !== 0) this.paint(m, j, mix(m.baseColor[j]!, s.dark, t * 0.8));
          const l = iy > 0 && ix > 0 ? i - m.w - 1 : i;
          if (l !== i && m.material[l] !== 0) this.paint(m, l, mix(m.baseColor[l]!, s.light, 0.3));
        }
        x0 = Math.min(x0, ix);
        y0 = Math.min(y0, iy);
        x1 = Math.max(x1, ix + 1);
        y1 = Math.max(y1, iy + 1);
        // forks
        if (k > 2 && ihash(b, k, s.seed + 13) < 0.12) a += (ihash(b, k, s.seed + 17) < 0.5 ? -1 : 1) * 0.9;
      }
    }
    if (x1 > x0) touch(m, x0, y0, x1, y1);
  }

  /** Cartilage ridges folded across the blow: pale crests and dark troughs in the victim's own tones. */
  private ridges(s: GestationSite): void {
    const m = s.body.map;
    const R = Math.ceil(s.r * 0.9);
    const cx = Math.floor(s.lx);
    const cy = Math.floor(s.ly);
    const l = DMath.hypot(s.dx, s.dy) || 1;
    const ux = s.dx / l;
    const uy = s.dy / l;
    for (let y = cy - R; y <= cy + R; y++)
      for (let x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
        const i = y * m.w + x;
        if (m.material[i] === 0) continue;
        const px = x + 0.5 - s.lx;
        const py = y + 0.5 - s.ly;
        const d = DMath.hypot(px, py) / (s.r * 0.9);
        if (d >= 1) continue;
        // bands across the blow's direction, bowed (folded inward), fading at the rim
        const along = px * ux + py * uy + (0.08 * sq(px * uy - py * ux)) / Math.max(1, s.r);
        const w = DMath.sin(along * 1.25 + s.seed);
        const fade = (1 - d) * 0.8;
        let c = m.baseColor[i]!;
        if (w > 0.45) c = mix(c, s.light, 0.7 * fade + 0.15);
        else if (w < -0.3) c = mix(c, s.dark, 0.75 * fade + 0.1);
        else continue;
        m.baseColor[i] = c;
        m.pixels[i] = c;
        this.cells++;
      }
    touch(m, cx - R, cy - R, cx + R + 1, cy + R + 1);
  }

  /** A heavy blow's site swells into a malformed, organ-like mass: a lit dome with a dark rim and a dark lumen in it. */
  private organ(s: GestationSite): void {
    const m = s.body.map;
    const r = s.r * 0.78;
    const R = Math.ceil(r) + 1;
    // off the contact, a little into the body
    const ox = s.lx + s.dx * r * 0.35;
    const oy = s.ly + s.dy * r * 0.35;
    const cx = Math.floor(ox);
    const cy = Math.floor(oy);
    const lumX = ox + (ihash(3, 4, s.seed) - 0.5) * r * 0.6;
    const lumY = oy + (ihash(5, 6, s.seed) - 0.5) * r * 0.6;
    for (let y = cy - R; y <= cy + R; y++)
      for (let x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
        const i = y * m.w + x;
        if (m.material[i] === 0) continue;
        const px = x + 0.5 - ox;
        const py = y + 0.5 - oy;
        // lobed outline, not a circle
        const ang = DMath.atan2(py, px);
        const rr = r * (0.85 + 0.15 * DMath.sin(ang * 3 + s.seed));
        const d = DMath.hypot(px, py) / rr;
        if (d >= 1.12) continue;
        let c = m.baseColor[i]!;
        if (d >= 0.86) c = mix(c, s.dark, 0.85);
        else {
          // a swollen dome lit from the upper left like everything else, its far side in shadow
          const sh = (px + py) / (rr * 1.4);
          const lit = Math.max(0, 1 - d) * 0.7 + Math.max(0, -sh) * 0.4;
          c = sh > 0.25 ? mix(c, s.dark, Math.min(0.7, sh * 0.8)) : mix(c, s.light, Math.min(0.85, lit));
          if (DMath.hypot(x + 0.5 - lumX, y + 0.5 - lumY) < r * 0.24) c = mix(c, s.dark, 0.9);
        }
        m.baseColor[i] = c;
        m.pixels[i] = c;
        this.cells++;
      }
    touch(m, cx - R, cy - R, cx + R + 1, cy + R + 1);
  }

  private paint(m: MatterMap, i: number, c: number): void {
    if (c === m.baseColor[i]) return;
    m.baseColor[i] = c;
    m.pixels[i] = c;
    this.cells++;
  }

  reset(): void {
    this.sites.length = 0;
  }

  hash(h: number): number {
    let x = Math.imul(h ^ this.sites.length, 0x01000193);
    for (const s of this.sites)
      x = Math.imul(x ^ (s.age + 977 * s.body.id + Math.round(s.lx * 31 + s.ly)), 0x01000193);
    return x >>> 0;
  }
}

/** Mark a rectangle of a map changed (the renderer re-uploads it). */
export function touch(m: MatterMap, x0: number, y0: number, x1: number, y1: number): void {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(m.w, x1);
  y1 = Math.min(m.h, y1);
  if (x1 <= x0 || y1 <= y0) return;
  const d = m.dirty;
  if (d) {
    d.x0 = Math.min(d.x0, x0);
    d.y0 = Math.min(d.y0, y0);
    d.x1 = Math.max(d.x1, x1);
    d.y1 = Math.max(d.y1, y1);
  } else m.dirty = { x0, y0, x1, y1 };
  m.version++;
}
