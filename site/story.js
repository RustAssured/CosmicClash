// ADEUK: TITANS landing page: the story layer. Prologue, scale reveal and the Edge.
// Everything here is drawn in code as pixel art on small canvases (like the game), no image files.
// Plain JS, no dependencies. Respects prefers-reduced-motion (static frames, no scroll pinning).

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

// ------------------------------------------------------------ pixel buffer with palette ramps and Bayer dither
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ramp = (...hs) => hs.map(rgb);
const R = {
  ocean: ramp('#050a1c', '#0b1f45', '#14406e', '#2a6aa0', '#5aa0cc', '#b8e4f4'),
  land: ramp('#0c0f08', '#203018', '#3f5a2a', '#6e7e3a', '#b0a060', '#efe2b0'),
  rock: ramp('#0e0a0c', '#2a1e1c', '#4e3a30', '#7e6048', '#b49070', '#e8d0a8'),
  pocean: ramp('#03101a', '#0a2a40', '#14506a', '#2a86a0', '#58b8cc', '#bff0f0'),
  sun: ramp('#4a1206', '#9a300a', '#e0620e', '#ff9a2a', '#ffd060', '#fff4c0', '#ffffff'),
  flesh: ramp('#040108', '#0d030c', '#1a0614', '#2a0b1c', '#3e1224', '#561c2c', '#742a36', '#9a4646'),
  wet: ramp('#b8706a', '#e2b0a0', '#fff0e4'),
  slime: ramp('#3a2a34', '#7a6470', '#c8b4b8'),
  bone: ramp('#1a120c', '#4a3a2a', '#8a7556', '#c8b088', '#f2e4c0'),
  throat: ramp('#000000', '#12010a', '#3a0414', '#7a0c1e', '#d02a2a', '#ff7a4a'),
  coreA: ramp('#3a0c04', '#8a2408', '#e05a10', '#ff9a30', '#ffd27a', '#fff6d8'),
  coreB: ramp('#060c2a', '#14286a', '#2e5ad0', '#6a92f8', '#b8ccff', '#ffffff'),
  moon: ramp('#0c0c10', '#2a2a32', '#55545e', '#8c8a92', '#c8c6cc'),
  hull: ramp('#0a0806', '#241c14', '#4a3a28', '#7a6040', '#b08a58'),
};

class Px {
  constructor(cv, minScale = 3) {
    this.minScale = minScale;
    this.boost = 0; // raised by whenVisible() when frames run long: fewer, bigger pixels
    this.cv = cv;
    this.ctx = cv.getContext('2d');
    this.w = this.h = 0;
    this.cssW = this.cssH = 0;
    this.vigs = new Map();
    // the canvas's CSS size, read on resize only (a layout read every frame costs more than the drawing it sizes)
    const measure = () => {
      const r = this.cv.getBoundingClientRect();
      this.cssW = r.width;
      this.cssH = r.height;
    };
    measure();
    addEventListener('resize', measure);
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(cv);
  }
  /** Size the buffer to the canvas: `fixed` forces a scale (the teaser film uses fit(1): the native 640 × 360 canvas). */
  fit(fixed) {
    const scale = fixed || Math.max(this.minScale, Math.ceil(innerWidth / 560)) + this.boost;
    const w = Math.max(64, Math.ceil(this.cssW / scale));
    const h = Math.max(36, Math.ceil(this.cssH / scale));
    if (w === this.w && h === this.h) return;
    this.w = this.cv.width = w;
    this.h = this.cv.height = h;
    this.img = this.ctx.createImageData(w, h);
    this.d = this.img.data;
    this.u32 = new Uint32Array(this.d.buffer); // one write per opaque pixel (little-endian RGBA)
    this.vigs = new Map();
  }
  /** Finish a frame: dim (1 = as is) and vignette strength (0 = none), in one pass over the pixels. */
  post(dim = 1, vig = 0) {
    if (vig <= 0) {
      if (dim < 1) this.dim(dim);
      return;
    }
    // integer maths on whole pixels: a Uint8Clamped multiply per channel costs several times more on a big canvas
    const v = this.vigMask(vig),
      u = this.u32;
    for (let p = 0; p < v.length; p++) {
      const k = (v[p] * dim * 256) | 0;
      if (k >= 256) continue;
      const c = u[p];
      u[p] =
        (0xff000000 |
          (((((c >>> 16) & 255) * k) >> 8) << 16) |
          (((((c >>> 8) & 255) * k) >> 8) << 8) |
          (((c & 255) * k) >> 8)) >>>
        0;
    }
  }
  clear(c = [5, 3, 12]) {
    this.u32.fill((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]);
  }
  // put a colour, optionally blended (a < 1) or added (add = true)
  put(x, y, c, a = 1, add = false) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.d;
    if (add) {
      d[i] = Math.min(255, d[i] + c[0] * a);
      d[i + 1] = Math.min(255, d[i + 1] + c[1] * a);
      d[i + 2] = Math.min(255, d[i + 2] + c[2] * a);
    } else if (a >= 1) {
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
    } else {
      d[i] += (c[0] - d[i]) * a;
      d[i + 1] += (c[1] - d[i + 1]) * a;
      d[i + 2] += (c[2] - d[i + 2]) * a;
    }
  }
  // dithered ramp lookup: v in 0..1
  rc(rp, v, x, y) {
    const f = clamp(v) * (rp.length - 1);
    const i = Math.floor(f);
    const t = BAYER[(y & 3) * 4 + (x & 3)];
    return rp[Math.min(rp.length - 1, f - i > t ? i + 1 : i)];
  }
  dim(k) {
    const u = this.u32;
    const ki = (k * 256) | 0;
    if (ki >= 256) return;
    for (let p = 0; p < u.length; p++) {
      const c = u[p];
      u[p] =
        (0xff000000 |
          (((((c >>> 16) & 255) * ki) >> 8) << 16) |
          (((((c >>> 8) & 255) * ki) >> 8) << 8) |
          (((c & 255) * ki) >> 8)) >>>
        0;
    }
  }
  // darken towards the edges (cinematic vignette); s: strength
  /** The vignette's falloff for strength s: it depends only on the size and strength, so it is built once. */
  vigMask(s) {
    const { w, h } = this;
    let v = this.vigs.get(s);
    if (!v) {
      v = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = (x / w - 0.5) * 2;
          const dy = (y / h - 0.5) * 2;
          v[y * w + x] = 1 - clamp((dx * dx * 0.6 + dy * dy * 0.9 - 0.25) * s);
        }
      this.vigs.set(s, v);
    }
    return v;
  }
  vignette(s) {
    const d = this.d;
    const v = this.vigMask(s);
    for (let p = 0, i = 0; p < v.length; p++, i += 4) {
      const k = v[p];
      if (k === 1) continue;
      d[i] *= k;
      d[i + 1] *= k;
      d[i + 2] *= k;
    }
  }
  show() {
    this.ctx.putImageData(this.img, 0, 0);
  }
}

// ------------------------------------------------------------ noise
function h3(x, y, z) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function vnoise(x, y, z) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z);
  const xf = x - xi,
    yf = y - yi,
    zf = z - zi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf),
    w = zf * zf * (3 - 2 * zf);
  const a = lerp(
    lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u),
    lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u),
    v,
  );
  const b = lerp(
    lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u),
    lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u),
    v,
  );
  return lerp(a, b, w);
}
const fbm = (x, y, z) =>
  vnoise(x, y, z) * 0.55 + vnoise(x * 2.1, y * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3, z * 4.3) * 0.15;

const L = (() => {
  const v = [-0.62, -0.48, 0.62];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

// ------------------------------------------------------------ bodies
/**
 * A surface baked once into a longitude × latitude texture (ramp and value offset per texel). The noise behind a planet
 * costs dozens of sin() per point; a texture lookup costs one atan2 and one asin, and the sphere still turns. Only for
 * surfaces marked `tex` (fixed ones); a surface that depends on the light or changes per frame (worldSurf) is evaluated
 * per pixel as before.
 */
const TEX_W = 160,
  TEX_H = 80;
const TEX = new Map();
const baked = (surf) => ((surf.tex = true), surf);
function surfTex(surf) {
  let T = TEX.get(surf);
  if (T) return T;
  const ramps = [];
  const ri = new Uint8Array(TEX_W * TEX_H);
  const v = new Float32Array(TEX_W * TEX_H);
  // a fixed colour a surface shows only in the dark (a world's city lights: worldSurf returns { c } where lam is low)
  const night = [];
  const nc = new Uint8Array(TEX_W * TEX_H);
  for (let j = 0; j < TEX_H; j++) {
    const lat = ((j + 0.5) / TEX_H - 0.5) * Math.PI;
    for (let i = 0; i < TEX_W; i++) {
      const lon = ((i + 0.5) / TEX_W - 0.5) * Math.PI * 2;
      const X = Math.cos(lat) * Math.sin(lon),
        Y = Math.sin(lat),
        Z = Math.cos(lat) * Math.cos(lon);
      const s = surf(X, Y, Z, 1);
      let k = ramps.indexOf(s.rp);
      if (k < 0) k = ramps.push(s.rp) - 1;
      ri[j * TEX_W + i] = k;
      v[j * TEX_W + i] = s.v || 0;
      const sn = surf(X, Y, Z, 0);
      if (sn.c) {
        let m = night.indexOf(sn.c);
        if (m < 0) m = night.push(sn.c) - 1;
        nc[j * TEX_W + i] = m + 1;
      }
    }
  }
  T = { ramps, ri, v, night, nc };
  TEX.set(surf, T);
  return T;
}

/** A lit sphere. surf(nx,ny,nz) → { rp, v } picks the ramp and a value offset for each surface point. */
function sphere(px, cx, cy, r, surf, rot = 0, rim = null, mask = null) {
  if (r < 0.75) {
    const s = surf(0, 0, 1);
    px.put(cx, cy, s.c || px.rc(s.rp, 0.8, cx | 0, cy | 0));
    return;
  }
  const T = surf.tex ? surfTex(surf) : null;
  const TAU = Math.PI * 2;
  const x0 = Math.max(0, Math.floor(cx - r)),
    x1 = Math.min(px.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)),
    y1 = Math.min(px.h - 1, Math.ceil(cy + r));
  const cr = Math.cos(rot),
    sr = Math.sin(rot);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / r,
        ny = (y + 0.5 - cy) / r;
      const q = nx * nx + ny * ny;
      if (q > 1) continue;
      const nz = Math.sqrt(1 - q);
      const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      if (mask && mask(x, y)) continue;
      if (T) {
        const X = nx * cr + nz * sr,
          Z = -nx * sr + nz * cr;
        const ti = Math.min(TEX_W - 1, ((Math.atan2(X, Z) / TAU + 0.5) * TEX_W) | 0);
        const tj = Math.min(
          TEX_H - 1,
          ((Math.asin(ny < -1 ? -1 : ny > 1 ? 1 : ny) / Math.PI + 0.5) * TEX_H) | 0,
        );
        const k = tj * TEX_W + ti;
        if (lam < 0.14 && T.nc[k]) {
          px.put(x, y, T.night[T.nc[k] - 1]);
          continue;
        }
        let v = 0.06 + lam * 0.86 + T.v[k];
        if (rim && q > 0.82) v += (q - 0.82) * 2.2 * (0.3 + lam);
        px.put(x, y, px.rc(rim && q > 0.82 ? rim : T.ramps[T.ri[k]], v, x, y));
        continue;
      }
      const s = surf(nx * cr + nz * sr, ny, -nx * sr + nz * cr, lam);
      if (s.c) {
        px.put(x, y, s.c);
        continue;
      }
      let v = 0.06 + lam * 0.86 + (s.v || 0);
      if (rim && q > 0.82) v += (q - 0.82) * 2.2 * (0.3 + lam);
      px.put(x, y, px.rc(rim && q > 0.82 ? rim : s.rp, v, x, y));
    }
}

const earthSurf = baked((x, y, z) => {
  const n = fbm(x * 2.2 + 3, y * 2.2, z * 2.2);
  if (Math.abs(y) > 0.86) return { rp: R.moon, v: 0.25 };
  if (n > 0.55) return { rp: R.land, v: -0.05 };
  return { rp: R.ocean, v: 0 };
});
const planetSurf = baked((x, y, z) => {
  const n = fbm(x * 1.6 + 9, y * 1.6 + 2, z * 1.6);
  const c = vnoise(x * 6 + 1, y * 6, z * 6);
  if (n > 0.52) return { rp: R.rock, v: c > 0.78 ? -0.25 : 0 };
  return { rp: R.pocean, v: -0.02 };
});
const sunSurf = baked((x, y, z) => ({ rp: R.sun, v: 0.35 + fbm(x * 3, y * 3, z * 3 + 7) * 0.35 }));
const moonSurf = baked((x, y, z) => ({ rp: R.moon, v: vnoise(x * 5, y * 5, z * 5) > 0.7 ? -0.2 : 0 }));
// one baked surface per core; its turning (sphere's rot, which the callers pass as t) is what moves it
const CORE_SURF = new Map();
const coreSurf = (rp) => {
  let f = CORE_SURF.get(rp);
  if (!f)
    CORE_SURF.set(rp, (f = baked((x, y, z) => ({ rp, v: 0.25 + fbm(x * 2.5, y * 2.5, z * 2.5) * 0.45 }))));
  return f;
};

/** Soft additive glow (a star's corona). */
function glow(px, cx, cy, r, c, a = 0.6) {
  const R2 = r * 3;
  // a glow far larger than the frame is a near-uniform faint tint: not worth a pass over every pixel
  if (R2 > Math.max(px.w, px.h) * 3 || a <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - R2)),
    x1 = Math.min(px.w - 1, Math.ceil(cx + R2));
  const y0 = Math.max(0, Math.floor(cy - R2)),
    y1 = Math.min(px.h - 1, Math.ceil(cy + R2));
  const RR = R2 * R2;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const q = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (q >= RR) continue;
      const d = Math.sqrt(q) / R2;
      const k = (1 - d) ** 2.4 * a;
      if (k > BAYER[(y & 3) * 4 + (x & 3)] * 0.35) px.put(x, y, c, k, true);
    }
}

/** A writhing flesh tube along a path [{x,y,r}], drawn as overlapping lit rings (ridges every few px). */
function tube(px, path, seed = 0, sheen = 1, spines = true) {
  let s = 0;
  const thorns = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const step = Math.max(0.6, Math.min(a.r, b.r) * 0.45);
    for (let u = 0; u < len; u += step) {
      const t = u / len;
      const cx = lerp(a.x, b.x, t),
        cy = lerp(a.y, b.y, t),
        r = lerp(a.r, b.r, t);
      const ridge = Math.sin((s + u) * (2.6 / Math.max(2, r)) * 2.2 + seed) * 0.5 + 0.5;
      ring(px, cx, cy, r, ridge, sheen);
      // bone thorns along the outer curve, every so often
      if (
        spines &&
        r > 2.5 &&
        h3(Math.floor((s + u) / (r * 0.9)), seed, 5) > 0.72 &&
        (s + u) % (r * 0.9) < step
      ) {
        const dx = (b.x - a.x) / len,
          dy = (b.y - a.y) / len;
        const sg = h3(Math.floor((s + u) / r), seed, 6) > 0.5 ? 1 : -1;
        thorns.push([cx, cy, -dy * sg, dx * sg, r]);
      }
    }
    s += len;
  }
  for (const [cx, cy, nx, ny, r] of thorns) {
    const bx = cx + nx * r * 0.85,
      by = cy + ny * r * 0.85;
    const tx = -ny,
      ty = nx;
    tri(
      px,
      bx + tx * r * 0.16,
      by + ty * r * 0.16,
      bx - tx * r * 0.16,
      by - ty * r * 0.16,
      bx + nx * r * 0.62 + tx * r * 0.2,
      by + ny * r * 0.62 + ty * r * 0.2,
      Math.atan2(ny, nx),
    );
  }
}

/** A sagging thread of slime between two points, catching a little light. */
function thread(px, ax, ay, bx, by, sag, a = 0.6) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay));
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const x = lerp(ax, bx, u),
      y = lerp(ay, by, u) + Math.sin(u * Math.PI) * sag;
    px.put(
      x,
      y,
      px.rc(R.slime, 0.3 + (1 - Math.abs(u - 0.5) * 2) * 0.5, x | 0, y | 0),
      a * (0.5 + Math.sin(u * Math.PI) * 0.5),
    );
  }
}
/**
 * A ring's lighting depends only on its radius, so it is computed once per half-pixel radius and stamped: the coils draw
 * thousands of rings a frame, and this keeps the sqrt and the pow out of the inner loop.
 */
const STAMPS = new Map();
/** Packed opaque colours of a ramp, for Uint32 writes. */
const packed = (rp) =>
  rp.p || (rp.p = Uint32Array.from(rp, (c) => (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]));
function ringStamp(r) {
  // half-pixel steps for small rings, ~3 % steps for big ones: a zooming coil reuses a bounded set of stamps
  const key = r < 12 ? Math.max(1, Math.round(r * 2)) : 24 + Math.round(Math.log(r / 12) * 34);
  let s = STAMPS.get(key);
  if (s) return s;
  const rr = r < 12 ? key / 2 : 12 * Math.exp((key - 24) / 34);
  const c = Math.ceil(rr);
  const n = c * 2 + 1;
  const base = new Float32Array(n * n);
  const spec = new Float32Array(n * n);
  const inside = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const nx = (i - c) / rr,
        ny = (j - c) / rr;
      const q = nx * nx + ny * ny;
      if (q > 1) continue;
      const nz = Math.sqrt(1 - q);
      const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const k = j * n + i;
      inside[k] = 1;
      // the groove between rings darkens the rim
      base[k] = 0.05 + lam * 0.7 - (q > 0.78 ? (q - 0.78) * 2.4 : 0);
      spec[k] = lam ** 34;
    }
  s = { c, n, base, spec, inside };
  if (STAMPS.size > 400) STAMPS.clear();
  STAMPS.set(key, s);
  return s;
}
function ring(px, cx, cy, r, ridge, sheen) {
  if (r < 0.6) return;
  const { c, n, base, spec, inside } = ringStamp(r);
  const X = Math.floor(cx) - c,
    Y = Math.floor(cy) - c;
  const i0 = Math.max(0, -X),
    i1 = Math.min(n, px.w - X);
  const j0 = Math.max(0, -Y),
    j1 = Math.min(n, px.h - Y);
  if (i0 >= i1 || j0 >= j1) return;
  const u = px.u32,
    w = px.w;
  const dark = (1 - ridge) * 0.3;
  const sh = ridge * sheen;
  const fl = packed(R.flesh),
    fn = fl.length - 1;
  const wt = packed(R.wet),
    wn = wt.length - 1;
  for (let j = j0; j < j1; j++) {
    const y = Y + j;
    const by = (y & 3) * 4;
    const row = y * w + X;
    for (let i = i0; i < i1; i++) {
      const k = j * n + i;
      if (!inside[k]) continue;
      const x = X + i;
      const sp = spec[k] * sh;
      // dithered ramp lookups, inlined (see Px.rc)
      let f;
      let rp, rn;
      if (sp > 0.42) {
        f = (sp - 0.42) * 2.4;
        rp = wt;
        rn = wn;
      } else {
        f = base[k] - dark;
        rp = fl;
        rn = fn;
      }
      f = (f < 0 ? 0 : f > 1 ? 1 : f) * rn;
      const fi = f | 0;
      u[row + i] = rp[f - fi > BAYER[by + (x & 3)] && fi < rn ? fi + 1 : fi];
    }
  }
}

/** The jaw-rings: a lip, a black throat with an ember in its depth, and inward rows of teeth. open: 0..1 */
function maw(px, cx, cy, r, open, t) {
  // fleshy lip
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2 + t * 0.15;
    const w = 1 + Math.sin(a * 3 + t * 1.3) * 0.06;
    ring(px, cx + Math.cos(a) * r * w, cy + Math.sin(a) * r * w, r * 0.26, Math.sin(k * 1.7) * 0.5 + 0.5, 1);
  }
  // throat
  const tr = r * (0.55 + open * 0.42);
  const x0 = Math.max(0, Math.floor(cx - tr)),
    x1 = Math.min(px.w - 1, Math.ceil(cx + tr));
  const y0 = Math.max(0, Math.floor(cy - tr)),
    y1 = Math.min(px.h - 1, Math.ceil(cy + tr));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / tr;
      if (d > 1) continue;
      const swirl = Math.sin(Math.atan2(y - cy, x - cx) * 5 + d * 9 - t * 2) * 0.06;
      px.put(x, y, px.rc(R.throat, (1 - d) ** 3 * 0.85 * (0.5 + open * 0.5) + swirl, x, y));
    }
  // three counter-rotating rows of teeth, pointing inward
  const rows = [
    [r * 0.98, 22, t * 0.11, 0.36],
    [r * 0.78, 18, -t * 0.17, 0.3],
    [r * 0.6, 14, t * 0.23, 0.26],
  ];
  for (const [rr0, n, rot, len] of rows) {
    const rr = rr0 * (0.6 + open * 0.4);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rot;
      const half = (Math.PI / n) * 0.7;
      const L1 = rr * (1 - len * (0.8 + 0.4 * h3(k, n, 3)));
      tri(
        px,
        cx + Math.cos(a - half) * rr,
        cy + Math.sin(a - half) * rr,
        cx + Math.cos(a + half) * rr,
        cy + Math.sin(a + half) * rr,
        cx + Math.cos(a) * L1,
        cy + Math.sin(a) * L1,
        a,
      );
    }
  }
}
function tri(px, ax, ay, bx, by, cx, cy, a) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
    x1 = Math.min(px.w - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
    y1 = Math.min(px.h - 1, Math.ceil(Math.max(ay, by, cy)));
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(den) < 1e-6) return;
  // light from the upper left: teeth facing it are bright bone, the others dark
  const lit = 0.35 + 0.45 * Math.max(0, -Math.cos(a) * L[0] - Math.sin(a) * L[1]);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px_ = x + 0.5,
        py = y + 0.5;
      const w1 = ((by - cy) * (px_ - cx) + (cx - bx) * (py - cy)) / den;
      const w2 = ((cy - ay) * (px_ - cx) + (ax - cx) * (py - cy)) / den;
      const w3 = 1 - w1 - w2;
      if (w1 < 0 || w2 < 0 || w3 < 0) continue;
      px.put(x, y, px.rc(R.bone, lit + w3 * 0.35 - Math.min(w1, w2) * 0.4, x, y));
    }
}

// ------------------------------------------------------------ stars (per canvas)
function makeStars(n, seed = 1) {
  const out = [];
  for (let i = 0; i < n; i++)
    out.push({
      x: h3(i, seed, 1),
      y: h3(i, seed, 2),
      z: h3(i, seed, 3) ** 2,
      c: [rgb('#ffffff'), rgb('#ffe6c2'), rgb('#c9d8ff'), rgb('#ffb0d0'), rgb('#b9a8ff')][
        (h3(i, seed, 4) * 5) | 0
      ],
    });
  return out;
}
function drawStars(px, stars, t, { pull = 0, drift = 0, ox = 0, oy = 0 } = {}) {
  const { w, h } = px;
  for (const s of stars) {
    let x = (((s.x * w + ox * (0.2 + s.z) + drift * t * (0.02 + s.z * 0.05)) % w) + w) % w;
    let y = (((s.y * h + oy * (0.2 + s.z)) % h) + h) % h;
    let a = 0.25 + s.z * 0.6 + Math.sin(t * 0.03 + s.x * 40) * 0.1;
    if (pull > 0) {
      // something at the edge drags the sky outward and swallows the light
      const dx = x - w / 2,
        dy = y - h / 2;
      const k = 1 + pull * (0.4 + s.z) * 1.6;
      const nx = w / 2 + dx * k,
        ny = h / 2 + dy * k;
      for (let j = 0; j < pull * 6 * (0.5 + s.z); j++)
        px.put(lerp(x, nx, j / 6), lerp(y, ny, j / 6), s.c, a * 0.25);
      x = nx;
      y = ny;
      a *= 1 - pull * 0.5;
    }
    px.put(x, y, s.c, a);
  }
}

// ------------------------------------------------------------ 우리's story: the prologue scenes (one per beat)
// Two worlds → an eye looks → a mouth eats → ruin → they build 우리 from the wreck → it braces → it hunts.

const W1 = ramp('#06101c', '#0c2a46', '#185078', '#2f80a8', '#6ab4c8', '#c8eef0'); // world A seas
const W1L = ramp('#0e0c06', '#2a2614', '#4e4626', '#7a6a3a', '#b0985a', '#e8d6a0'); // world A land
const W2 = ramp('#0a0618', '#1c1238', '#33245e', '#503a88', '#7a62b0', '#c0b0e8'); // world B seas (stranger)
const W2L = ramp('#0a0a10', '#1e2228', '#3a4448', '#5e7270', '#8aa8a0', '#c8e0d8'); // world B land
const CIV = [rgb('#e88a3a'), rgb('#ffb060'), rgb('#ffd890')];
const MAGMA = ramp('#3a0804', '#8a1e06', '#e0520e', '#ff9a30', '#ffe0a0');
const CARA = ramp('#050908', '#0c1513', '#16261f', '#22392f', '#355647', '#4f7d68', '#7aa898', '#b4d3c3');
const IRIS = ramp('#1a0e04', '#5c4216', '#8f6b24', '#c39b3e', '#e9c96c', '#fff1b8');

/** A world with city lights on its night side; crack 0..1 opens glowing faults across it. */
const WORLD_SURF = new Map();
// baked like the planets (the cracks open in 16 steps; the city lights are kept as their own channel, see surfTex)
const worldSurf = (sea, land, seed, crack = 0) => {
  const q = Math.round(clamp(crack) * 16);
  const key = `${seed}|${q}`;
  let f = WORLD_SURF.get(key);
  if (!f) WORLD_SURF.set(key, (f = baked(worldSurfRaw(sea, land, seed, q / 16))));
  return f;
};
const worldSurfRaw =
  (sea, land, seed, crack = 0) =>
  (x, y, z, lam) => {
    if (crack > 0) {
      const n = vnoise(x * 3.1 + seed, y * 3.1, z * 3.1);
      const ridge = 1 - Math.abs(2 * n - 1);
      if (ridge > 1 - crack * 0.16) return { rp: MAGMA, v: 0.5 + (ridge - (1 - crack * 0.16)) * 4 };
    }
    const n = fbm(x * 2.2 + seed, y * 2.2, z * 2.2);
    if (n > 0.53) {
      if (lam < 0.14 && h3(Math.floor(x * 40), Math.floor(y * 40), Math.floor(z * 40) + seed) > 0.8)
        return { c: CIV[(h3(x * 9, y * 9, seed) * 3) | 0] };
      return { rp: land, v: 0 };
    }
    return { rp: sea, v: 0 };
  };

/** The eye that looked. open 0..1; look -1..1 moves the iris; anger reddens the white. */
function eye(px, cx, cy, ew, eh, open, look, t, anger = 0) {
  const x0 = Math.max(0, Math.floor(cx - ew * 1.25)),
    x1 = Math.min(px.w - 1, Math.ceil(cx + ew * 1.25));
  const y0 = Math.max(0, Math.floor(cy - eh * 1.9)),
    y1 = Math.min(px.h - 1, Math.ceil(cy + eh * 1.9));
  const ir = eh * 0.95,
    icx = cx + look * ew * 0.28,
    icy = cy + Math.sin(t * 0.02) * eh * 0.05;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const u = (x + 0.5 - cx) / ew,
        v = (y + 0.5 - cy) / eh;
      if (Math.abs(u) > 1.22) continue;
      const shape = Math.max(0, 1 - u * u) ** 0.75;
      const lid = open * shape;
      const av = Math.abs(v);
      if (av < lid) {
        // inside: dark wet sclera, the iris, a slit pupil
        const dx = x + 0.5 - icx,
          dy = y + 0.5 - icy;
        const d = Math.hypot(dx, dy) / ir;
        if (d < 1) {
          const slit = Math.abs(dx) / (ir * (0.1 + 0.06 * open)) + (dy / ir) ** 2 * 0.4;
          if (slit < 1) {
            px.put(x, y, d < 0.18 ? [40, 8, 6] : [2, 1, 2]);
            continue;
          }
          const ang = Math.atan2(dy, dx);
          const streak =
            vnoise(Math.cos(ang) * 6 + 3, Math.sin(ang) * 6, d * 3) * 0.5 + Math.sin(ang * 23) * 0.08;
          px.put(x, y, px.rc(IRIS, 0.25 + (1 - d) * 0.45 + streak * 0.5 - (d > 0.9 ? 0.35 : 0), x, y));
          continue;
        }
        const vein = anger * Math.max(0, Math.sin(Math.atan2(dy, dx) * 9 + d * 7) - 0.6) * (av / lid);
        const base = 0.18 + (1 - av / lid) * 0.25;
        px.put(x, y, vein > 0.15 ? px.rc(MAGMA, 0.25 + vein, x, y) : px.rc(CARA, base, x, y));
      } else if (av < lid + 0.42 + 0.35 * shape) {
        // the lids: layered carapace plates, lit from above
        const k = (av - lid) / (0.42 + 0.35 * shape);
        const plate = Math.sin(k * 9 + u * 3) * 0.5 + 0.5;
        const top = v < 0 ? 0.25 : -0.05;
        px.put(x, y, px.rc(CARA, 0.25 + (1 - k) * 0.35 + plate * 0.18 + top - k * 0.2, x, y));
      }
    }
  if (open > 0.3) glow(px, icx, icy, ir * 0.5, IRIS[4], 0.35 * open);
  return [icx, icy];
}

/** A beam of sight: a hard bright line with a soft halo, from a to b. */
function gaze(px, ax, ay, bx, by, a) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay));
  for (let k = 0; k <= n; k++) {
    const x = lerp(ax, bx, k / n),
      y = lerp(ay, by, k / n);
    px.put(x, y, IRIS[5], a, true);
    px.put(x + 1, y, IRIS[3], a * 0.4, true);
    px.put(x - 1, y, IRIS[3], a * 0.4, true);
  }
}

/** Drifting wreckage: shards in two palettes; gather 0..1 pulls them toward a point. */
function wreckage(px, t, s, n, seed, cx, cy, spread, gather = 0, gx = cx, gy = cy) {
  for (let k = 0; k < n; k++) {
    const a = h3(k, seed, 1) * Math.PI * 2 + t * 0.0008 * (h3(k, seed, 7) - 0.5);
    const r = (0.25 + h3(k, seed, 2) ** 0.7) * spread;
    let x = cx + Math.cos(a) * r,
      y = cy + Math.sin(a) * r * 0.55;
    x = lerp(x, gx, gather * h3(k, seed, 8));
    y = lerp(y, gy, gather * h3(k, seed, 8));
    const z = Math.max(1, (1 + h3(k, seed, 3) * 3) * s);
    const hot = h3(k, seed, 4) > 0.82;
    for (let yy = 0; yy < z * 0.8; yy++)
      for (let xx = 0; xx < z; xx++) {
        const lit = yy < 1 || xx < 1 ? 0.45 : 0.18;
        px.put(
          x + xx,
          y + yy,
          hot && yy > z * 0.4
            ? px.rc(MAGMA, 0.5, x + xx, y + yy)
            : px.rc(R.hull, lit + h3(k, xx, yy) * 0.15, x + xx, y + yy),
        );
      }
  }
}

// ---------- 우리 sprite: the real game matter, baked from the locked rig into two poses with per-chunk ids
const URI = { ready: false, loading: false, A: null, G: null, small: null };
/** The real Planet and Supernova sprites as pixels ({ width, height, data }), for blitSprite. */
const SPR = {};
function loadUri() {
  if (URI.loading) return;
  URI.loading = true;
  const load = (n) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = `media/story/${n}.png`;
    });
  // the real Planet and Supernova too, for drawing the scale reveal into a frame (the teaser film)
  const sprite = (n) =>
    new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ width: im.width, height: im.height, data: pixelsOf(im) });
      im.onerror = () => res(null);
      im.src = `media/titans/${n}.png`;
    });
  sprite('planet').then((s) => (SPR.planet = s));
  sprite('supernova').then((s) => (SPR.supernova = s));
  Promise.all(['uri-a', 'uri-a-id', 'uri-g', 'uri-g-id'].map(load))
    .then(([a, ai, g, gi]) => {
      URI.A = bakeUri(a, ai);
      URI.G = bakeUri(g, gi);
      if (window.__CUES) weldsFromCues(URI.A, window.__CUES);
      URI.small = shrinkUri(URI.A, 6);
      URI.ready = true;
    })
    .catch(() => {});
}
function pixelsOf(im) {
  const c = document.createElement('canvas');
  c.width = im.width;
  c.height = im.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0);
  return g.getImageData(0, 0, im.width, im.height).data;
}
// assembly windows (fraction of the genesis beat) per part code; codes follow the rig's part order
// 1 pyL 2 pyR 3 pelvis 4 uaL 5 uaR 6 domeL 7 domeR 8 chamber 9 faL 10 faR 11 fistL 12 fistR 13 moon · 200 hot core · 201 cold core · 255 loop
const WIN = {
  200: [0, 0.16],
  201: [0, 0.16],
  255: [0.15, 0.27],
  8: [0.2, 0.46],
  3: [0.3, 0.5],
  1: [0.36, 0.56],
  2: [0.36, 0.56],
  6: [0.44, 0.64],
  7: [0.44, 0.64],
  4: [0.54, 0.72],
  5: [0.54, 0.72],
  9: [0.6, 0.8],
  10: [0.6, 0.8],
  11: [0.68, 0.9],
  12: [0.68, 0.9],
  13: [0.86, 0.97],
};
function bakeUri(im, idim) {
  const w = im.width,
    h = im.height,
    c = pixelsOf(im),
    id = pixelsOf(idim);
  const map = new Map();
  let pyBottom = [0, 0, 0, 0]; // x,y of the two pylon tips
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (c[i + 3] < 128) continue;
      const code = id[i],
        ch = id[i + 1] | ((id[i + 2] & 127) << 8),
        em = id[i + 2] >> 7;
      const key = code * 65536 + ch;
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, code, px: [], sx: 0, sy: 0 }));
      g.px.push(x, y, c[i], c[i + 1], c[i + 2], em);
      g.sx += x;
      g.sy += y;
      if (code === 1 && y > pyBottom[1]) pyBottom = [x, y, pyBottom[2], pyBottom[3]];
      if (code === 2 && y > pyBottom[3]) pyBottom = [pyBottom[0], pyBottom[1], x, y];
    }
  const list = [...map.values()];
  for (const g of list) {
    const n = g.px.length / 6;
    g.cx = g.sx / n;
    g.cy = g.sy / n;
    for (let q = 0; q < g.px.length; q += 6) {
      g.px[q] -= g.cx;
      g.px[q + 1] -= g.cy;
    }
    g.seed = h3(g.cx * 0.37, g.cy * 0.53, g.code);
    const win = WIN[g.code] || [0.3, 0.6];
    g.ta = g.code === 255 ? win[1] : win[0] + 0.1 + g.seed * (win[1] - win[0] - 0.1);
    // where the piece waits in the wreckage field before it is pulled in
    const a = g.seed * Math.PI * 2 + g.code;
    const r = 0.75 + h3(g.code, g.seed * 99, 3) * 0.9;
    g.fx = Math.cos(a) * w * r * 0.75;
    g.fy = Math.sin(a) * h * r * 0.6;
  }
  // the two cores wait where the two worlds died: left and right
  for (const g of list) {
    if (g.code === 200) {
      g.fx = -w * 0.62;
      g.fy = 20;
    }
    if (g.code === 201) {
      g.fx = w * 0.62;
      g.fy = -10;
    }
  }
  return { w, h, list, map, py: pyBottom };
}
/**
 * Trailer mode: take every weld's moment from the score's cue sheet (tools/teaser/cues.json, `welds: [time, code, size]`),
 * so each chunk lands on its clank in press/teaser/score.wav even if WIN above is retuned. Groups are paired with the
 * listed welds of the same part and size, in time order; ta is solved from the time with the film's genesis mapping
 * (trailer.html: f = u · 0.97 and PRO[4] welds at k = f · 1.08 − 0.02). With today's WIN the result is identical.
 */
function weldsFromCues(A, cues) {
  const gen = cues.shots.find((s) => s.name === 'genesis');
  if (!gen) return;
  const by = new Map();
  for (const [time, code, size] of cues.welds) {
    const k = `${code}|${size}`;
    (by.get(k) || by.set(k, []).get(k)).push(time);
  }
  for (const v of by.values()) v.sort((a, b) => a - b);
  const groups = new Map();
  for (const g of A.list) {
    if (g.code === 255) continue;
    const k = `${g.code}|${g.px.length / 6}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(g);
  }
  let paired = 0;
  for (const [k, gs] of groups) {
    const times = by.get(k);
    if (!times) continue;
    gs.sort((a, b) => a.ta - b.ta);
    gs.forEach((g, i) => {
      if (times[i] == null) return;
      g.ta = ((times[i] - gen.start) / gen.dur) * 0.97 * 1.08 - 0.02;
      paired++;
    });
  }
  URI.cuePaired = paired;
}

/** A small copy (for distant shots): majority-occupied blocks, averaged colour. */
function shrinkUri(A, k) {
  const w = Math.ceil(A.w / k),
    h = Math.ceil(A.h / k);
  const acc = new Float32Array(w * h * 5);
  for (const g of A.list)
    for (let q = 0; q < g.px.length; q += 6) {
      const x = Math.round(g.cx + g.px[q]),
        y = Math.round(g.cy + g.px[q + 1]);
      const i = ((y / k) | 0) * w + ((x / k) | 0);
      acc[i * 5] += g.px[q + 2];
      acc[i * 5 + 1] += g.px[q + 3];
      acc[i * 5 + 2] += g.px[q + 4];
      acc[i * 5 + 3] += 1;
      acc[i * 5 + 4] += g.px[q + 5];
    }
  const out = [];
  for (let i = 0; i < w * h; i++) {
    const n = acc[i * 5 + 3];
    if (n < (k * k) / 2) continue;
    const em = acc[i * 5 + 4] / n > 0.4;
    out.push(
      i % w,
      (i / w) | 0,
      (acc[i * 5] / n) * (em ? 1.15 : 1),
      (acc[i * 5 + 1] / n) * (em ? 1.15 : 1),
      (acc[i * 5 + 2] / n) * (em ? 1.15 : 1),
      em ? 1 : 0,
    );
  }
  return { w, h, px: out };
}

const easeOutBack = (u) => 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2;
/**
 * Draw 우리 with its top-left at (ox, oy).
 * k: assembly 0..1 (1 = whole). morph: 0..1 from the open stance to the braced guard.
 * heat: extra glow on the loop and cores. Returns the list of glowing pixels for the bloom pass.
 */
function drawUri(px, ox, oy, t, { k = 1, morph = 0, heat = 0 } = {}) {
  const A = URI.A,
    G = URI.G;
  const em = [];
  const occ =
    px.occ && px.occ.length === px.w * px.h ? px.occ.fill(0) : (px.occ = new Uint8Array(px.w * px.h));
  const FL = 0.13;
  // (speed: one Uint32 write per pixel, no per-pixel arrays, and the outline pass only covers what was drawn; 우리 is
  // ~77,000 pixels a frame at the game's own pixel size)
  const u32 = px.u32,
    PW = px.w,
    PH = px.h;
  let bx0 = PW,
    by0 = PH,
    bx1 = -1,
    by1 = -1;
  const plot = (x, y, r, g, b, e, flash) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= PW || y >= PH) return;
    if (flash > 0) {
      r += (255 - r) * flash;
      g += (200 - g) * flash;
      b += (120 - b) * flash;
    }
    const i = y * PW + x;
    u32[i] = (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
    occ[i] = 1;
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
    if (e || flash > 0.3) em.push(i, r, g, b);
  };
  const m = ease(clamp(morph));
  for (const g of A.list) {
    // assembly: each piece waits in the field, then is hauled in with a little overshoot and welds with a flash
    let u = 1,
      flash = 0;
    if (k < 1) {
      u = clamp((k - (g.ta - FL)) / FL);
      flash = k >= g.ta ? Math.max(0, 1 - (k - g.ta) / 0.05) : 0;
    }
    let dx = 0,
      dy = 0;
    if (u < 1) {
      const e = easeOutBack(u);
      const drift = (1 - u) * 6;
      dx = g.fx * (1 - e) + Math.sin(t * 0.01 + g.seed * 20) * drift;
      dy = g.fy * (1 - e) + Math.cos(t * 0.013 + g.seed * 17) * drift;
    }
    if (g.code === 255) {
      // the loop ignites around its circuit once both hearts are in place
      const rev = clamp((k - 0.15) / 0.12);
      if (rev <= 0 && k < 1) continue;
      const boost = heat * 0.5 + (k < 1 ? (1 - rev) * 0.6 : 0);
      if (m > 0.5) continue; // the braced pose has its own loop
      for (let q = 0; q < g.px.length; q += 6) {
        if (k < 1 && (Math.atan2(g.px[q + 1], g.px[q]) / Math.PI + 1) / 2 > rev) continue;
        plot(ox + g.cx + g.px[q], oy + g.cy + g.px[q + 1], g.px[q + 2], g.px[q + 3], g.px[q + 4], 1, boost);
      }
      continue;
    }
    // stance change: pieces travel from the open stance to the guard; halfway they swap to the guard's own pixels
    let src = g,
      mx = 0,
      my = 0;
    if (m > 0) {
      const tw = G.map.get(g.key);
      if (tw) {
        if (m < 0.5) {
          mx = (tw.cx - g.cx) * m;
          my = (tw.cy - g.cy) * m;
        } else {
          src = tw;
          mx = (g.cx - tw.cx) * (1 - m);
          my = (g.cy - tw.cy) * (1 - m);
        }
      } else if (m >= 0.5) continue;
    }
    const hot = g.code === 200 || g.code === 201 ? heat * 0.35 : 0;
    for (let q = 0; q < src.px.length; q += 6)
      plot(
        ox + src.cx + src.px[q] + dx + mx,
        oy + src.cy + src.px[q + 1] + dy + my,
        src.px[q + 2],
        src.px[q + 3],
        src.px[q + 4],
        src.px[q + 5],
        Math.max(flash, hot),
      );
  }
  if (m >= 0.5)
    for (const g of G.list) {
      if (A.map.has(g.key) && g.code !== 255) continue;
      for (let q = 0; q < g.px.length; q += 6)
        plot(
          ox + g.cx + g.px[q],
          oy + g.cy + g.px[q + 1],
          g.px[q + 2],
          g.px[q + 3],
          g.px[q + 4],
          g.px[q + 5],
          g.code === 255 ? heat * 0.4 : 0,
        );
    }
  // dark outline round the whole silhouette, like the game's compose pass
  if (bx1 < 0) return;
  // the outline covers the body's own frame (pieces still flying in from far away go without it: they are specks)
  const x0 = Math.max(1, bx0 - 1, Math.floor(ox - 4)),
    x1 = Math.min(PW - 2, bx1 + 1, Math.ceil(ox + A.w + 4));
  const y0 = Math.max(1, by0 - 1, Math.floor(oy - 4)),
    y1 = Math.min(PH - 2, by1 + 1, Math.ceil(oy + A.h + 4));
  const OUTLINE = (255 << 24) | (8 << 16) | (4 << 8) | 4;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * PW + x;
      if (occ[i]) continue;
      if (occ[i - 1] || occ[i + 1] || occ[i - PW] || occ[i + PW]) u32[i] = OUTLINE;
    }
  // bloom: every glowing pixel spills a little light around itself (additive, 4 neighbours at 0.12, 4 more at 0.05)
  const d = px.d;
  const spill = (j, r, g, b, a) => {
    const o = j * 4;
    d[o] = Math.min(255, d[o] + r * a);
    d[o + 1] = Math.min(255, d[o + 1] + g * a);
    d[o + 2] = Math.min(255, d[o + 2] + b * a);
  };
  for (let q = 0; q < em.length; q += 4) {
    const i = em[q],
      r = em[q + 1],
      g = em[q + 2],
      b = em[q + 3];
    const x = i % PW,
      y = (i - x) / PW;
    if (x > 1 && x < PW - 2 && y > 1 && y < PH - 2) {
      spill(i - 1, r, g, b, 0.12);
      spill(i + 1, r, g, b, 0.12);
      spill(i - PW, r, g, b, 0.12);
      spill(i + PW, r, g, b, 0.12);
      spill(i - 2, r, g, b, 0.05);
      spill(i + 2, r, g, b, 0.05);
      spill(i - 2 * PW, r, g, b, 0.05);
      spill(i + 2 * PW, r, g, b, 0.05);
    }
  }
}

/** Weld sparks: short hot streaks flying off where pieces are joining right now. */
function weldSparks(px, ox, oy, k) {
  if (!URI.ready || k >= 1) return;
  for (const g of URI.A.list) {
    if (g.code === 255 || k < g.ta || k > g.ta + 0.04) continue;
    const n = 3 + ((g.seed * 5) | 0);
    for (let j = 0; j < n; j++) {
      const a = h3(g.key, j, 1) * Math.PI * 2;
      const d = (k - g.ta) * 900 * (0.5 + h3(g.key, j, 2));
      const x = ox + g.cx + Math.cos(a) * d,
        y = oy + g.cy + Math.sin(a) * d;
      px.put(x, y, [255, 210, 140], 1 - (k - g.ta) / 0.04, true);
      px.put(x - Math.cos(a), y - Math.sin(a), [255, 120, 40], 0.6 * (1 - (k - g.ta) / 0.04), true);
    }
  }
}

/** Where to put 우리 on screen: right of centre when the text sits on the left (wide screens). */
function uriPlace(px) {
  const side = innerWidth > 900 && innerWidth / innerHeight > 1.25;
  const cx = side ? px.w * 0.62 : px.w * 0.5;
  return { ox: Math.round(cx - URI.A.w / 2), oy: Math.round(px.h * (side ? 0.5 : 0.42) - URI.A.h / 2), side };
}

const PRO = [
  // I. two worlds, close enough to see each other's lights; ships cross between them
  {
    w: 1,
    draw(px, f, t, st) {
      drawStars(px, st, t, { drift: 1 });
      const s = px.h / 160;
      const cx = px.w * 0.5,
        cy = px.h * 0.3;
      const a = t * 0.004 + f * 0.6;
      const A = [cx + Math.cos(a) * 30 * s, cy + Math.sin(a) * 9 * s];
      const B = [cx - Math.cos(a) * 30 * s, cy - Math.sin(a) * 9 * s];
      for (let j = 0; j < 9; j++) {
        const u = (t * 0.004 + j / 9) % 1;
        const x = lerp(A[0], B[0], u),
          y = lerp(A[1], B[1], u) - Math.sin(u * Math.PI) * 14 * s;
        px.put(x, y, CIV[2], 0.9);
      }
      const dA = () => sphere(px, A[0], A[1], 19 * s, worldSurf(W1, W1L, 3), t * 0.003, W1);
      const dB = () => sphere(px, B[0], B[1], 13 * s, worldSurf(W2, W2L, 11), -t * 0.004, W2);
      if (Math.sin(a) < 0) {
        dA();
        dB();
      } else {
        dB();
        dA();
      }
    },
  },
  // II. an eye opened in the dark and looked at them; where it looked, the crust cracked
  {
    w: 1,
    draw(px, f, t, st) {
      drawStars(px, st, t, { drift: 0.6 });
      const s = px.h / 160;
      const open = ease(clamp(f / 0.4));
      const [ix, iy] = eye(
        px,
        px.w * 0.5,
        px.h * 0.26,
        px.w * 0.3,
        px.h * 0.085,
        open,
        Math.sin(t * 0.006) * 0.3 + 0.1,
        t,
        ease(clamp((f - 0.4) / 0.4)),
      );
      const A = [px.w * 0.6, px.h * 0.62],
        B = [px.w * 0.4, px.h * 0.6];
      const crack = ease(clamp((f - 0.45) / 0.45));
      sphere(px, B[0], B[1], 9 * s, worldSurf(W2, W2L, 11, crack * 0.6), -t * 0.004, W2);
      sphere(px, A[0], A[1], 13 * s, worldSurf(W1, W1L, 3, crack), t * 0.003, W1);
      if (f > 0.42) {
        const g = clamp((f - 0.42) / 0.08) * (0.7 + Math.sin(t * 0.3) * 0.15);
        gaze(px, ix, iy, A[0], A[1], g);
        gaze(px, ix, iy, B[0], B[1], g * 0.6);
      }
    },
  },
  // III. then something came to eat
  {
    w: 1,
    draw(px, f, t, st) {
      const k = ease(clamp(f * 1.2));
      drawStars(px, st, t, { pull: k * 0.5 });
      const s = px.h / 160;
      const A = [px.w * 0.36, px.h * 0.44],
        B = [px.w * 0.6, px.h * 0.4];
      const bite = ease(clamp((f - 0.35) / 0.4));
      const mr = px.h * 0.2;
      const mx = lerp(px.w + mr, B[0] + 10 * s, ease(clamp(f / 0.45))),
        my = lerp(px.h * 0.25, B[1], ease(clamp(f / 0.45)));
      // the neck trails back out over the edge
      const neck = [];
      for (let j = 0; j <= 10; j++) {
        const u = j / 10;
        neck.push({
          x: lerp(mx + mr * 0.6, px.w + mr * 2, u),
          y: lerp(my, px.h * 0.15, u) + Math.sin(u * 5 + t * 0.02) * mr * 0.2,
          r: mr * lerp(0.62, 0.9, u),
        });
      }
      sphere(px, A[0], A[1], 17 * s, worldSurf(W1, W1L, 3, 1), t * 0.003, W1);
      sphere(
        px,
        B[0],
        B[1],
        12 * s,
        worldSurf(W2, W2L, 11, 0.6),
        -t * 0.004,
        W2,
        (x, y) => Math.hypot(x - mx, y - my) < mr * bite * 1.05,
      );
      if (bite > 0) wreckage(px, t, s * 0.7, 60, 4, B[0], B[1], 30 * s * bite);
      tube(px, neck, 9, 1);
      maw(px, mx, my, mr, 0.3 + (1 - bite) * 0.6, t * 0.02);
      edgeCoils(px, t, 0.4 + k * 0.4, 1, [1]);
    },
  },
  // IV. ruin: two burning hearts, a sea of wreckage, and people still alive in it
  {
    w: 1,
    draw(px, f, t, st) {
      drawStars(px, st, t, { drift: 0.4 });
      const s = px.h / 160;
      const H1 = [px.w * 0.3, px.h * 0.42],
        H2 = [px.w * 0.7, px.h * 0.38];
      wreckage(px, t, s, 220, 2, px.w * 0.5, px.h * 0.42, px.w * 0.55, f * 0.15);
      glow(px, H1[0], H1[1], 10 * s, R.coreA[3], 0.55);
      sphere(px, H1[0], H1[1], 11 * s, coreSurf(R.coreA, t * 0.01), t * 0.01);
      glow(px, H2[0], H2[1], 7 * s, R.coreB[3], 0.6);
      sphere(px, H2[0], H2[1], 7 * s, coreSurf(R.coreB, -t * 0.02), -t * 0.02);
      // arks: warm specks, slowly gathering between the hearts
      for (let j = 0; j < 40; j++) {
        const a = h3(j, 8, 1) * Math.PI * 2;
        const r = (0.3 + h3(j, 8, 2)) * px.w * 0.35 * (1 - f * 0.5);
        px.put(
          px.w * 0.5 + Math.cos(a + t * 0.002) * r,
          px.h * 0.42 + Math.sin(a + t * 0.002) * r * 0.4,
          CIV[1 + (j % 2)],
          0.95,
        );
      }
    },
  },
  // V. they did not run. they built: the wreck is hauled in piece by piece around the two hearts
  {
    w: 2.4,
    side: true,
    draw(px, f, t, st) {
      drawStars(px, st, t, { drift: 0.4 });
      if (!URI.ready) return PRO_FALLBACK(px, f, t);
      const { ox, oy } = uriPlace(px);
      const k = clamp(f * 1.08 - 0.02);
      drawUri(px, ox, oy, t, { k, heat: 0 });
      weldSparks(px, ox, oy, k);
    },
  },
  // VI. 우리: it wakes, braces, the loop takes the load
  {
    w: 1.3,
    side: true,
    draw(px, f, t, st) {
      const brace = ease(clamp((f - 0.08) / 0.4));
      const flare = f > 0.55 ? Math.max(0, 1 - (f - 0.55) / 0.3) : 0;
      const shake = flare > 0.6 ? Math.round(Math.sin(t * 2.7) * 2) : 0;
      drawStars(px, st, t, { drift: 0.4, ox: shake });
      if (!URI.ready) return PRO_FALLBACK(px, 1, t);
      const { ox, oy } = uriPlace(px);
      const A = URI.A;
      // pylon thrust: two blue-white plumes holding the mass steady
      const thrust = 0.35 + brace * 0.65;
      for (const [x, y] of [
        [A.py[0], A.py[1]],
        [A.py[2], A.py[3]],
      ])
        for (let j = 0; j < 26 * thrust; j++)
          px.put(
            ox + x + Math.sin(j * 1.7 + t * 0.5) * (j / 12),
            oy + y + 2 + j,
            R.coreB[j < 6 ? 5 : 3],
            (1 - j / (26 * thrust)) * 0.8,
            true,
          );
      drawUri(px, ox + shake, oy, t, { k: 1, morph: brace, heat: 0.4 + flare });
      if (flare > 0) {
        const cx = ox + A.w * 0.55,
          cy = oy + A.h * 0.45;
        const rr = (1 - flare) * px.w * 0.7;
        for (let a = 0; a < Math.PI * 2; a += 1 / Math.max(8, rr))
          px.put(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.5, [200, 180, 255], flare * 0.8, true);
      }
    },
  },
  // VII. now it drifts between the galaxies, hunting an eye and a mouth
  {
    w: 1.3,
    draw(px, f, t, st) {
      drawStars(px, st, t, { drift: 0.2, ox: -f * 40 });
      // far away: the eye, half-open, and a coil sliding along the rim of the dark
      eye(px, px.w * 0.8, px.h * 0.22, px.w * 0.07, px.h * 0.018, 0.5 + Math.sin(t * 0.01) * 0.1, 0, t, 1);
      const cr = [];
      for (let j = 0; j <= 14; j++)
        cr.push({
          x: px.w * (0.7 + j * 0.03),
          y: px.h * 0.9 + Math.sin(j * 0.8 + t * 0.01) * px.h * 0.03,
          r: px.h * 0.02,
        });
      tube(px, cr, 2, 0.6, false);
      if (!URI.ready) return;
      const S = URI.small;
      const x0 = Math.round(lerp(px.w * 0.08, px.w * 0.22, f)),
        y0 = Math.round(px.h * 0.14 + Math.sin(t * 0.01) * 2);
      for (let q = 0; q < S.px.length; q += 6)
        px.put(x0 + S.px[q], y0 + S.px[q + 1], [S.px[q + 2], S.px[q + 3], S.px[q + 4]]);
      glow(px, x0 + S.w * 0.5, y0 + S.h * 0.42, 6, R.coreA[3], 0.35);
      for (let j = 0; j < 14; j++)
        px.put(x0 + S.w * (0.4 + (j % 2) * 0.2), y0 + S.h + j, R.coreB[3], 0.5 - j / 30, true);
    },
  },
];

/** If the 우리 sprite has not arrived yet, the old procedural sketch stands in. */
function PRO_FALLBACK(px, f, t) {
  const cx = px.w * 0.6,
    cy = px.h * 0.47;
  const s = px.h / 175;
  const A = 46 * s;
  const lem = (u) => {
    const d = 1 + Math.sin(u) ** 2;
    return [cx + (A * Math.cos(u)) / d, cy + (A * Math.sin(u) * Math.cos(u)) / d];
  };
  sphere(px, cx - A * 0.62, cy, 14 * s, coreSurf(R.coreA, t * 0.01), t * 0.01);
  sphere(px, cx + A * 0.62, cy, 9 * s, coreSurf(R.coreB, -t * 0.02), -t * 0.02);
  for (let k = 0; k < 600 * f; k++) {
    const [x, y] = lem((k / 600) * Math.PI * 2);
    px.put(x, y, R.coreB[4], 0.8);
  }
}

/** Coils pressing in over the left and right edges (and the top corners), writhing. amt 0..1 */
function edgeCoils(px, t, amt, thick = 1, sides = [-1, 1]) {
  const { w, h } = px;
  const T = t * 0.01;
  const paths = [];
  for (const side of sides) {
    for (let c = 0; c < 3; c++) {
      const path = [];
      const base = (h / 18) * (1.4 + c * 0.5) * thick;
      for (let k = 0; k <= 22; k++) {
        const v = k / 22;
        const y = lerp(-h * 0.15, h * 1.15, v);
        const wob =
          Math.sin(v * 6 + T * (1 + c * 0.3) + c * 2) * base * 0.9 + Math.sin(v * 13 - T * 1.7) * base * 0.25;
        const inset = (amt * (0.08 + c * 0.04) - 0.06) * w + wob;
        const x = side < 0 ? inset - base * 0.6 + c * base * 0.4 : w - inset + base * 0.6 - c * base * 0.4;
        path.push({ x, y, r: base * (0.85 + Math.sin(v * 9 + c) * 0.15) });
      }
      tube(px, path, c * 7 + (side > 0 ? 3 : 0), 1);
      paths.push(path);
    }
  }
  // slime strung between neighbouring coils, stretching as they writhe
  for (let k = 0; k < paths.length; k++) {
    if (k % 3 === 2) continue;
    const A = paths[k],
      B = paths[k + 1];
    for (let j = 0; j < 4; j++) {
      const ia = (3 + j * 5 + k) % A.length,
        ib = (4 + j * 5 + k * 2) % B.length;
      thread(px, A[ia].x, A[ia].y, B[ib].x, B[ib].y, (6 + Math.sin(T * 2 + j + k) * 4) * thick, 0.55);
    }
  }
}

// ------------------------------------------------------------ the scale reveal (Earth → Planet → arena → the thing at its edge)
// world units: Earth radius = 1. The Planet titan is ~40 Earths across in radius; the arena is 640×360 units of
// play space around the fight; the Mouth's body coils outside it.
// One world unit = one game pixel, so the real sprites (media/titans/*.png, drawn by the game's painters) sit at their true
// size: the Planet is 121 px across, the Supernova 183 × 153, the arena 640 × 360.
const ARENA = { x: 200, y: 0, w: 640, h: 360 };
const EARTH = { x: 84, y: -22 };
const SPRITES = { planet: { x: 0, y: 0, w: 121, h: 121 }, supernova: { x: 390, y: -40, w: 183, h: 153 } };
const KEYS = [
  { x: EARTH.x, y: EARTH.y, fit: 9 }, // Earth fills ~ a sliver of the frame
  { x: 0, y: -10, fit: 265 }, // the Planet (room above for the heading and below for the caption)
  { x: 200, y: 0, fit: 760 }, // the arena (fitted to a whole-number scale of the screen in scaleReveal)
  { x: 1050, y: 380, fit: 4400 }, // the thing at the edge
];
let MOUTH_PATH = null;
function mouthPath() {
  if (MOUTH_PATH) return MOUTH_PATH;
  // a vast heap of coil outside the right edge of the arena, its neck reaching back in, the head at the rim
  const p = [];
  for (let k = 0; k <= 160; k++) {
    const v = k / 160;
    const a = v * Math.PI * 7.5;
    const rad = lerp(1650, 380, v);
    p.push({ x: 1850 + Math.cos(a) * rad * 0.9, y: 700 + Math.sin(a) * rad * 0.62, r: lerp(330, 150, v) });
  }
  const end = p[p.length - 1];
  const neck = [
    { x: end.x, y: end.y, r: 150 },
    { x: 1250, y: 120, r: 120 },
    { x: 900, y: 10, r: 85 },
    { x: 640, y: -40, r: 62 },
  ];
  MOUTH_PATH = { coil: p, neck };
  return MOUTH_PATH;
}

function scaleScene(px, P, t, st, dom = false) {
  // P: 0..3 along the keys
  const i = Math.min(2, Math.floor(P));
  const f = ease(P - i);
  const a = KEYS[i],
    b = KEYS[i + 1];
  const fit = Math.exp(lerp(Math.log(a.fit), Math.log(b.fit), f));
  // centre moves so the zoom feels anchored: interpolate in "screen-fraction" space
  const cx = lerp(a.x, b.x, f),
    cy = lerp(a.y, b.y, f);
  const s = px.h / fit; // px per unit
  const X = (x) => px.w / 2 + (x - cx) * s;
  const Y = (y) => px.h / 2 + (y - cy) * s;
  px.clear();
  drawStars(px, st, t, { ox: -cx * s * 0.02, oy: -cy * s * 0.02 });
  // the Mouth (only drawn once it can matter)
  if (P > 1.6) {
    const m = mouthPath();
    const wob = (v) => Math.sin(v * 0.02 + t * 0.01) * 18;
    const path = (arr) =>
      arr.map((q, k) => ({ x: X(q.x + wob(q.y + k * 9)), y: Y(q.y + wob(q.x)), r: q.r * s }));
    if (s * 150 > 0.6) {
      tube(px, path(m.coil), 1, 0.9);
      tube(px, path(m.neck), 4, 1);
      maw(px, X(600), Y(-40), 70 * s, 0.35 + Math.sin(t * 0.02) * 0.08, t * 0.02);
    }
  }
  // arena frame
  if (P > 1.2) {
    const al = clamp((P - 1.2) * 2);
    const x0 = X(ARENA.x - ARENA.w / 2),
      x1 = X(ARENA.x + ARENA.w / 2);
    const y0 = Y(ARENA.y - ARENA.h / 2),
      y1 = Y(ARENA.y + ARENA.h / 2);
    const gold = rgb('#ffd27a');
    for (let x = Math.max(0, x0 | 0); x <= Math.min(px.w - 1, x1); x++) {
      if ((x >> 1) & 1) continue;
      px.put(x, y0, gold, al * 0.8);
      px.put(x, y1, gold, al * 0.8);
    }
    for (let y = Math.max(0, y0 | 0); y <= Math.min(px.h - 1, y1); y++) {
      if ((y >> 1) & 1) continue;
      px.put(x0, y, gold, al * 0.8);
      px.put(x1, y, gold, al * 0.8);
    }
    // the opponent's corona: the Supernova itself is the real sprite, laid over the canvas (see scaleReveal)
    glow(px, X(SPRITES.supernova.x), Y(SPRITES.supernova.y), 70 * s, R.sun[4], 0.4 * al);
  }
  // a faint atmosphere behind the real Planet sprite, then Earth beside it
  glow(px, X(0), Y(0), 52 * s, R.pocean[4], 0.22);
  sphere(px, X(EARTH.x), Y(EARTH.y), 1 * s, earthSurf, t * 0.01, R.ocean);
  if (s < 1.2) {
    // keep Earth findable as it shrinks: a tiny pip ring around it
    const al = clamp((1.2 - s) * 2) * clamp((2.2 - P) * 2);
    const ex = X(EARTH.x),
      ey = Y(EARTH.y);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      if (k % 2) px.put(ex + Math.cos(a) * 4, ey + Math.sin(a) * 4, [184, 228, 244], al * 0.8);
    }
  }
  const sn = P > 1.2 ? clamp((P - 1.2) * 2) : 0;
  // the site lays the real sprites over the canvas as images (crisp at any screen size); the film draws them into the
  // frame itself, at whole-number scales while they are ≥ 1
  if (!dom) {
    blitSprite(px, SPR.planet, X(SPRITES.planet.x), Y(SPRITES.planet.y), s, 1);
    if (sn > 0) blitSprite(px, SPR.supernova, X(SPRITES.supernova.x), Y(SPRITES.supernova.y), s, sn);
  }
  px.vignette(0.9);
  // where the sprites go, in canvas pixels per world unit (scaleReveal turns it into CSS)
  return { X, Y, s, supernova: sn };
}

/** Draw a sprite's pixels (ImageData) centred at (cx, cy), nearest-neighbour, scale s (snapped to whole numbers ≥ 1). */
function blitSprite(px, im, cx, cy, s, a = 1) {
  if (!im) return;
  const k = s >= 1 ? Math.round(s) : s;
  const w = im.width * k,
    h = im.height * k;
  const x0 = Math.round(cx - w / 2),
    y0 = Math.round(cy - h / 2);
  const X0 = Math.max(0, x0),
    X1 = Math.min(px.w, Math.ceil(x0 + w));
  const Y0 = Math.max(0, y0),
    Y1 = Math.min(px.h, Math.ceil(y0 + h));
  const d = im.data;
  for (let y = Y0; y < Y1; y++) {
    const sy = Math.min(im.height - 1, ((y - y0) / k) | 0);
    for (let x = X0; x < X1; x++) {
      const sx = Math.min(im.width - 1, ((x - x0) / k) | 0);
      const i = (sy * im.width + sx) * 4;
      if (d[i + 3] < 128) continue;
      px.put(x, y, [d[i], d[i + 1], d[i + 2]], a);
    }
  }
}

// ------------------------------------------------------------ wiring
/**
 * Run frame(t) every animation frame, only while el is on screen (and once on resize). t counts 60 Hz ticks of real time,
 * so a slow machine shows the same motion at a lower frame rate rather than in slow motion.
 *
 * Adaptive cost: if the drawing itself averages more than ~7 ms a frame (an integrated GPU laptop shares that budget with
 * the page's compositing), the canvas drops to bigger pixels (px.boost, up to +2 steps). It never steps back up within a
 * visit, so it cannot oscillate.
 */
/** Drawing cost per section (ms per frame, smoothed), the resolution step and the canvas size: for the site's checks. */
const stats = (window.__story = {});
function whenVisible(el, frame, px) {
  let on = false,
    raf = 0,
    t = 0,
    ema = 0,
    n = 0,
    since = 0,
    half = false,
    odd = false;
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    // last resort on a slow machine: draw every other frame (30 Hz pixel art reads fine; motion keeps real time)
    odd = !odd;
    if (half && odd) return;
    t = now / (1000 / 60);
    const c0 = performance.now();
    frame(t);
    const cost = performance.now() - c0;
    ema = n++ < 4 ? cost : ema * 0.9 + cost * 0.1;
    stats[el.id] = {
      ms: Math.round(ema * 10) / 10,
      boost: px ? px.boost : 0,
      w: px ? px.w : 0,
      h: px ? px.h : 0,
      half,
    };
    // judge only settled frames: the first ones after coming into view also bake textures and ring stamps
    if (px && ++since > 45 && n > 30 && ema > 7) {
      if (px.boost < 2) px.boost++;
      else half = true;
      since = 0;
      ema = 0;
      n = 0;
    }
  };
  new IntersectionObserver(
    ([e]) => {
      on = e.isIntersecting;
      cancelAnimationFrame(raf);
      n = 0;
      since = 0;
      if (on) {
        if (reduceMotion.matches) frame(240);
        else raf = requestAnimationFrame(loop);
      }
    },
    { rootMargin: '100px 0px' },
  ).observe(el);
  addEventListener('resize', () => on && frame(t || 240));
  return { redraw: () => on && frame(t || 240) };
}

/**
 * Section geometry (document top and height), measured on load and whenever the page's size changes, never inside a
 * frame: a getBoundingClientRect() per frame forces a layout of the whole page every frame, which cost more than the
 * drawing on an integrated GPU laptop.
 */
const GEOM = new Map();
function measureAll() {
  for (const el of GEOM.keys()) {
    const r = el.getBoundingClientRect();
    GEOM.set(el, { top: r.top + scrollY, h: r.height });
  }
}
function geom(el) {
  if (!GEOM.has(el)) {
    GEOM.set(el, null);
    measureAll();
  }
  return GEOM.get(el);
}
addEventListener('resize', measureAll);
addEventListener('load', measureAll);
if ('ResizeObserver' in window) new ResizeObserver(measureAll).observe(document.body);

/** Scroll progress of a tall section with a sticky stage: 0 at its top, 1 when its end leaves. */
function progress(sec) {
  const g = geom(sec);
  return clamp((scrollY - g.top) / Math.max(1, g.h - innerHeight));
}

function prologue() {
  const sec = $('#prologue');
  if (!sec) return;
  const cv = $('canvas', sec);
  const beats = $$('[data-beat]', sec);
  const px = new Px(cv);
  const stars = makeStars(300, 3);
  const N = PRO.length;
  const total = PRO.reduce((a, b) => a + b.w, 0);
  stats.beats = PRO.map((b) => b.w); // for the site's checks
  // beats have different lengths (w); the section is as tall as the story (one screen per unit, plus the last screen)
  const sizeSection = () => (sec.style.height = reduceMotion.matches ? '' : `${(total + 1) * 100}vh`);
  sizeSection();
  reduceMotion.addEventListener('change', sizeSection);
  // the 우리 sprite is fetched once the story is close
  new IntersectionObserver(
    ([e], io) => {
      if (e.isIntersecting) {
        loadUri();
        io.disconnect();
      }
    },
    { rootMargin: '150% 0px' },
  ).observe(sec);
  let cur = -1;
  whenVisible(
    sec,
    (t) => {
      // scroll position → beat i and progress f inside it
      let P = reduceMotion.matches ? total - 1.5 : progress(sec) * total;
      let i = 0;
      while (i < N - 1 && P >= PRO[i].w) P -= PRO[i++].w;
      const f = clamp(P / PRO[i].w);
      // 우리 beats render at the game's own pixel size (a whole number of screen pixels per game pixel); the rest are
      // chunkier and cheaper (and only those take the adaptive step: 우리 keeps its true pixels).
      const uriBeat = PRO[i].side || i === 4;
      const uriScale = Math.max(1, Math.min(Math.round(innerHeight / 460), Math.floor(innerWidth / 440)));
      px.fit(uriBeat ? uriScale : 0);
      px.clear();
      PRO[i].draw(px, f, t, stars);
      // dip to black between beats
      const fade = Math.min(clamp(f / 0.08), clamp((1 - f) / 0.08), 1);
      px.post(i < N - 1 || f < 0.92 ? 0.2 + 0.8 * ease(fade) : 1, 0.6);
      px.show();
      if (i !== cur && !reduceMotion.matches) {
        cur = i;
        beats.forEach((b, k) => b.classList.toggle('on', k === i));
      }
    },
    px,
  );
}

function scaleReveal() {
  const sec = $('#scale');
  if (!sec) return;
  const cv = $('canvas', sec);
  const caps = $$('[data-cap]', sec);
  const px = new Px(cv);
  const stars = makeStars(300, 7);
  const sprites = $$('[data-sprite]', sec).map((img) => ({ img, def: SPRITES[img.dataset.sprite], k: -1 }));
  let cur = -1;
  whenVisible(
    sec,
    (t) => {
      px.fit();
      const dpr = devicePixelRatio || 1;
      // the arena key lands on a whole-number scale of the screen (×2 on a 1080p screen: the game's own pixels, doubled)
      const raw = Math.min(px.cssW / (ARENA.w * 1.12), px.cssH / (ARENA.h * 1.25));
      const arenaS = raw * dpr >= 1 ? Math.floor(raw * dpr) / dpr : raw;
      KEYS[2].fit = px.cssH / arenaS;
      const P = reduceMotion.matches ? 3 : clamp(progress(sec) * 3.4 - 0.15, 0, 3);
      const at = scaleScene(px, P, t, stars, true);
      px.show();
      // the real sprites, over the canvas: CSS px per game px, snapped to whole device pixels while it is ≥ 1
      const kx = px.cssW / px.w,
        ky = px.cssH / px.h;
      const S = at.s * ky;
      const k = S * dpr >= 1 ? Math.max(1, Math.round(S * dpr)) / dpr : S;
      for (const sp of sprites) {
        const { img, def } = sp;
        const w = def.w * k,
          h = def.h * k;
        const x = at.X(def.x) * kx - w / 2,
          y = at.Y(def.y) * ky - h / 2;
        const off = x > px.cssW || y > px.cssH || x + w < 0 || y + h < 0 || w > px.cssW * 6;
        const op = img.dataset.sprite === 'supernova' ? at.supernova : 1;
        img.style.visibility = off || op <= 0 ? 'hidden' : 'visible';
        if (off) continue;
        if (sp.k !== k) {
          sp.k = k;
          img.style.width = `${w}px`;
          img.style.height = `${h}px`;
        }
        // left/top, not a transform: a transformed image this large could be promoted to one huge GPU layer
        img.style.left = `${Math.round(x * dpr) / dpr}px`;
        img.style.top = `${Math.round(y * dpr) / dpr}px`;
        img.style.opacity = String(op);
      }
      const i = Math.min(3, Math.round(P));
      if (i !== cur && !reduceMotion.matches) {
        cur = i;
        caps.forEach((c, k) => c.classList.toggle('on', k === i));
      }
    },
    px,
  );
}

function edge() {
  const sec = $('#edge');
  if (!sec) return;
  const cv = $('canvas', sec);
  // the Edge is the heaviest scene (writhing coils are thousands of lit rings): it starts one pixel step coarser
  const px = new Px(cv, 5);
  const stars = makeStars(220, 11);
  // the words land one by one once the section is in view
  const words = $$('[data-word]', sec);
  // the last word ("Repeats.") lands with a snap: the maw lunges open and the frame jolts once (no flash; not with
  // reduced motion)
  let snap = -1e9;
  new IntersectionObserver(
    ([e], io) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      words.forEach((w, k) =>
        setTimeout(
          () => {
            w.classList.add('on');
            if (k === words.length - 1 && !reduceMotion.matches) {
              snap = performance.now() / (1000 / 60);
              sec.classList.add('snap');
              setTimeout(() => sec.classList.remove('snap'), 600);
            }
          },
          reduceMotion.matches ? 0 : 500 + k * 700,
        ),
      );
    },
    { threshold: 0.45 },
  ).observe(sec);
  whenVisible(
    sec,
    (t) => {
      px.fit();
      px.clear([3, 1, 6]);
      const g = geom(sec);
      const k = clamp(1 - (g.top - scrollY + g.h * 0.3) / innerHeight); // how far the section has come up
      const pull = 0.25 + ease(k) * 0.55;
      drawStars(px, stars, t, { pull, drift: 0.3 });
      edgeCoils(px, t, 0.55 + k * 0.5, 1.15);
      const sn = Math.max(0, 1 - (t - snap) / 50) ** 2; // the snap, decaying over ~0.8 s
      const mr = px.h * (0.42 + sn * 0.05);
      const rise = 1.05 - ease(k) * 0.55 - sn * 0.12;
      maw(
        px,
        px.w * 0.5,
        px.h + mr * rise,
        mr,
        Math.min(1, 0.25 + ease(k) * 0.6 + Math.sin(t * 0.03) * 0.04 + sn * 0.3),
        t * 0.02,
      );
      px.vignette(1.1);
      px.show();
    },
    px,
  );
}

/** Under-the-hood readout: lines type in once. */
function readout() {
  const el = $('.readout');
  if (!el) return;
  new IntersectionObserver(
    ([e], io) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      $$('.readout dl > div', el).forEach((d, k) =>
        setTimeout(() => d.classList.add('on'), reduceMotion.matches ? 0 : k * 140),
      );
    },
    { threshold: 0.3 },
  ).observe(el);
}

/**
 * The prologue's opt-in soundscape (ambient.js: start()/stop(), WebAudio made in code). Off until the reader asks; once on,
 * it plays while the prologue or the scale reveal is on screen and fades out when they leave (it comes back with them).
 * If ambient.js is missing or the browser has no WebAudio, the button hides itself.
 */
function ambient() {
  const btn = $('[data-ambient]');
  if (!btn) return;
  if (!(window.AudioContext || window.webkitAudioContext)) {
    btn.hidden = true;
    return;
  }
  let mod = null;
  let wanted = false;
  let playing = false;
  let near = false;
  const load = () => (mod ??= import('./ambient.js'));
  // one change at a time (start() is async; a quick second click must not overtake it)
  let chain = Promise.resolve();
  const sync = () =>
    (chain = chain.then(async () => {
      const want = wanted && near;
      if (want === playing) return;
      try {
        const m = await load();
        if (want) await m.start();
        else m.stop();
        playing = want;
      } catch {
        btn.hidden = true; // no soundscape on this build or browser: hide rather than offer a dead button
      }
    }));
  // fetch the module as the pointer arrives, so the click's start() runs as close to the gesture as possible (Safari)
  btn.addEventListener('pointerenter', () => void load().catch(() => {}), { once: true });
  btn.addEventListener('click', () => {
    wanted = !wanted;
    btn.setAttribute('aria-pressed', String(wanted));
    void sync();
  });
  const zones = ['#prologue', '#scale'].map((s) => $(s)).filter(Boolean);
  const seen = new Set();
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    }
    near = seen.size > 0;
    void sync();
  });
  zones.forEach((z) => io.observe(z));
  document.addEventListener('visibilitychange', () => {
    near = !document.hidden && seen.size > 0;
    void sync();
  });
}

/**
 * Bake the sphere textures and the ring stamps in idle time after load, so the first frames of each scene do not stall
 * (a stall there would also mislead the adaptive resolution into dropping a step).
 */
function warm() {
  const jobs = [earthSurf, planetSurf, sunSurf, moonSurf, coreSurf(R.coreA), coreSurf(R.coreB)].map(
    (s) => () => surfTex(s),
  );
  for (let r = 1; r < 90; r *= 1.06) jobs.push(() => ringStamp(r));
  // the two worlds at every crack step the eye and the mouth open in them
  for (let q = 0; q <= 16; q++) {
    jobs.push(() => surfTex(worldSurf(W1, W1L, 3, q / 16)));
    jobs.push(() => surfTex(worldSurf(W2, W2L, 11, q / 16)));
  }
  const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 50));
  const run = (dl) => {
    while (jobs.length && dl.timeRemaining() > 2) jobs.shift()();
    if (jobs.length) idle(run);
  };
  idle(run);
}

export function story() {
  warm();
  ambient();
  document.documentElement.classList.toggle('story-static', reduceMotion.matches);
  reduceMotion.addEventListener('change', () =>
    document.documentElement.classList.toggle('story-static', reduceMotion.matches),
  );
  prologue();
  scaleReveal();
  edge();
  readout();
}
// the teaser film (tools/teaser/trailer.html) imports the scenes and drives them itself
if (!window.__FILM) story();

export { PRO, Px, makeStars, drawStars, URI, loadUri, scaleScene, edgeCoils, maw, glow, clamp, ease };
