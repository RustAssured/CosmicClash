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
  fit() {
    const scale = Math.max(this.minScale, Math.ceil(innerWidth / 560)) + this.boost;
    const w = Math.max(64, Math.ceil(this.cssW / scale));
    const h = Math.max(36, Math.ceil(this.cssH / scale));
    if (w === this.w && h === this.h) return;
    this.w = this.cv.width = w;
    this.h = this.cv.height = h;
    this.img = this.ctx.createImageData(w, h);
    this.d = this.img.data;
    this.u32 = new Uint32Array(this.d.buffer); // one write per opaque pixel (little-endian RGBA)
    this.vig = null;
  }
  clear(c = [5, 3, 12]) {
    const d = this.d;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
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
    const d = this.d;
    for (let i = 0; i < d.length; i += 4) {
      d[i] *= k;
      d[i + 1] *= k;
      d[i + 2] *= k;
    }
  }
  // darken towards the edges (cinematic vignette); s: strength
  vignette(s) {
    const { w, h, d } = this;
    // the mask depends only on the size and strength: build it once
    if (!this.vig || this.vigS !== s) {
      this.vigS = s;
      this.vig = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = (x / w - 0.5) * 2;
          const dy = (y / h - 0.5) * 2;
          this.vig[y * w + x] = 1 - clamp((dx * dx * 0.6 + dy * dy * 0.9 - 0.25) * s);
        }
    }
    const v = this.vig;
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
 * costs dozens of sin() per point; a texture lookup costs one atan2 and one asin, and the sphere still turns.
 */
const TEX_W = 160,
  TEX_H = 80;
const TEX = new Map();
function surfTex(surf) {
  let T = TEX.get(surf);
  if (T) return T;
  const ramps = [];
  const ri = new Uint8Array(TEX_W * TEX_H);
  const v = new Float32Array(TEX_W * TEX_H);
  for (let j = 0; j < TEX_H; j++) {
    const lat = ((j + 0.5) / TEX_H - 0.5) * Math.PI;
    for (let i = 0; i < TEX_W; i++) {
      const lon = ((i + 0.5) / TEX_W - 0.5) * Math.PI * 2;
      const s = surf(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      let k = ramps.indexOf(s.rp);
      if (k < 0) k = ramps.push(s.rp) - 1;
      ri[j * TEX_W + i] = k;
      v[j * TEX_W + i] = s.v || 0;
    }
  }
  T = { ramps, ri, v };
  TEX.set(surf, T);
  return T;
}

/** A lit sphere. surf(nx,ny,nz) → { rp, v } picks the ramp and a value offset for each surface point. */
function sphere(px, cx, cy, r, surf, rot = 0, rim = null) {
  if (r < 0.75) {
    const s = surf(0, 0, 1);
    px.put(cx, cy, px.rc(s.rp, 0.8, cx | 0, cy | 0));
    return;
  }
  const T = surfTex(surf);
  const x0 = Math.max(0, Math.floor(cx - r)),
    x1 = Math.min(px.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)),
    y1 = Math.min(px.h - 1, Math.ceil(cy + r));
  const cr = Math.cos(rot),
    sr = Math.sin(rot);
  const TAU = Math.PI * 2;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / r,
        ny = (y + 0.5 - cy) / r;
      const q = nx * nx + ny * ny;
      if (q > 1) continue;
      const nz = Math.sqrt(1 - q);
      const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const X = nx * cr + nz * sr,
        Z = -nx * sr + nz * cr;
      const ti = Math.min(TEX_W - 1, ((Math.atan2(X, Z) / TAU + 0.5) * TEX_W) | 0);
      const tj = Math.min(
        TEX_H - 1,
        ((Math.asin(ny < -1 ? -1 : ny > 1 ? 1 : ny) / Math.PI + 0.5) * TEX_H) | 0,
      );
      const k = tj * TEX_W + ti;
      let v = 0.06 + lam * 0.86 + T.v[k];
      if (rim && q > 0.82) v += (q - 0.82) * 2.2 * (0.3 + lam);
      px.put(x, y, px.rc(rim && q > 0.82 ? rim : T.ramps[T.ri[k]], v, x, y));
    }
}

const earthSurf = (x, y, z) => {
  const n = fbm(x * 2.2 + 3, y * 2.2, z * 2.2);
  if (Math.abs(y) > 0.86) return { rp: R.moon, v: 0.25 };
  if (n > 0.55) return { rp: R.land, v: -0.05 };
  return { rp: R.ocean, v: 0 };
};
const planetSurf = (x, y, z) => {
  const n = fbm(x * 1.6 + 9, y * 1.6 + 2, z * 1.6);
  const c = vnoise(x * 6 + 1, y * 6, z * 6);
  if (n > 0.52) return { rp: R.rock, v: c > 0.78 ? -0.25 : 0 };
  return { rp: R.pocean, v: -0.02 };
};
const sunSurf = (x, y, z) => ({ rp: R.sun, v: 0.35 + fbm(x * 3, y * 3, z * 3 + 7) * 0.35 });
const moonSurf = (x, y, z) => ({ rp: R.moon, v: vnoise(x * 5, y * 5, z * 5) > 0.7 ? -0.2 : 0 });
// one surface per core (its turning, passed to sphere() as rot, is what moves it; textures are cached per surface)
const CORE_SURF = new Map();
const coreSurf = (rp) => {
  let f = CORE_SURF.get(rp);
  if (!f) CORE_SURF.set(rp, (f = (x, y, z) => ({ rp, v: 0.25 + fbm(x * 2.5, y * 2.5, z * 2.5) * 0.45 })));
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

// ------------------------------------------------------------ the prologue scenes (one per beat)
const PRO = [
  // 0: two specks very far away; now and then they touch and the light arrives late
  (px, f, t, st) => {
    drawStars(px, st, t, { drift: 1 });
    const cx = px.w * 0.5,
      cy = px.h * 0.36;
    const a = t * 0.012;
    const ax = cx + Math.cos(a) * 3,
      ay = cy + Math.sin(a) * 1.2;
    const bx = cx - Math.cos(a) * 3,
      by = cy - Math.sin(a) * 1.2;
    px.put(ax, ay, R.pocean[4]);
    px.put(bx, by, R.sun[5]);
    const flash = Math.max(0, Math.sin(t * 0.035)) ** 40;
    if (flash > 0.02) glow(px, cx, cy, 2 + flash * 3, R.sun[5], flash);
  },
  // 1: the old titans: a world that pulls, a star that burns, circling with dust between them
  (px, f, t, st) => {
    drawStars(px, st, t, { drift: 1 });
    const cx = px.w * 0.5,
      cy = px.h * 0.36;
    const s = Math.min(px.h / 160, px.w / 110); // portrait phones: fit the width too
    const a = t * 0.006 + f * 1.4;
    const pr = 14 * s,
      sr = 11 * s;
    const P = [cx + Math.cos(a) * 34 * s, cy + Math.sin(a) * 12 * s];
    const S = [cx - Math.cos(a) * 34 * s, cy - Math.sin(a) * 12 * s];
    for (let k = 0; k < 140; k++) {
      const b = a - k * 0.02;
      const r2 = 34 * s + Math.sin(k * 1.3) * 3 * s;
      px.put(cx + Math.cos(b) * r2, cy + Math.sin(b) * r2 * 0.36 + Math.sin(k) * s, R.rock[3], 0.5 - k / 300);
    }
    const back = Math.sin(a) < 0;
    const drawP = () => sphere(px, P[0], P[1], pr, planetSurf, t * 0.004, R.pocean);
    const drawS = () => {
      glow(px, S[0], S[1], sr, R.sun[4], 0.55);
      sphere(px, S[0], S[1], sr, sunSurf, t * 0.01);
    };
    if (back) {
      drawP();
      drawS();
    } else {
      drawS();
      drawP();
    }
  },
  // 2: 우리: two world-cores in one load-bearing infinity loop, rubble held around them, the command moon above
  (px, f, t, st) => {
    drawStars(px, st, t, { drift: 1 });
    // a little higher than the other beats: this beat's caption runs to four lines
    const cx = px.w * 0.5,
      cy = px.h * 0.33;
    const s = Math.min(px.h / 175, px.w / 140);
    const A = 46 * s;
    // rubble shell
    for (let k = 0; k < 70; k++) {
      const b = (k / 70) * Math.PI * 2 + t * 0.0015;
      const rr = A * (1.05 + h3(k, 2, 9) * 0.35);
      const x = cx + Math.cos(b) * rr,
        y = cy + Math.sin(b) * rr * 0.62;
      const z = 1 + h3(k, 3, 9) * 3 * s;
      for (let yy = 0; yy < z; yy++)
        for (let xx = 0; xx < z * 1.3; xx++)
          px.put(
            x + xx,
            y + yy,
            px.rc(R.hull, 0.2 + (yy < 1 ? 0.5 : 0) + h3(k, xx, yy) * 0.2, x + xx, y + yy),
          );
    }
    const lem = (u) => {
      const d = 1 + Math.sin(u) ** 2;
      return [cx + (A * Math.cos(u)) / d, cy + (A * Math.sin(u) * Math.cos(u)) / d];
    };
    // cores sit in the lobes; the big hot one breathes, the dense one spins
    const pulse = 1 + Math.sin(t * 0.05) * 0.04;
    glow(px, cx - A * 0.62, cy, 12 * s, R.coreA[3], 0.5);
    sphere(px, cx - A * 0.62, cy, 14 * s * pulse, coreSurf(R.coreA), t * 0.01);
    glow(px, cx + A * 0.62, cy, 8 * s, R.coreB[3], 0.55);
    sphere(px, cx + A * 0.62, cy, 9 * s, coreSurf(R.coreB), -t * 0.02);
    // the loop: light flows through it; f drives the load surge
    for (let k = 0; k < 600; k++) {
      const u = (k / 600) * Math.PI * 2;
      const [x, y] = lem(u);
      const flow = (Math.sin(u * 2 - t * 0.08) * 0.5 + 0.5) ** 6;
      px.put(x, y, flow > 0.5 ? R.coreB[5] : R.coreB[3], 0.55 + flow * 0.45);
      if (flow > 0.7) px.put(x, y - 1, R.coreB[4], 0.4, true);
    }
    // command moon on its gravity tether
    const mx = cx + Math.sin(t * 0.01) * 4 * s,
      my = cy - A * 0.95 + Math.cos(t * 0.013) * 2 * s;
    for (let k = 0; k < 14; k++)
      px.put(lerp(cx, mx, k / 14), lerp(cy - A * 0.2, my, k / 14), R.coreB[3], 0.15);
    sphere(px, mx, my, 4 * s, moonSurf, 0, null);
  },
  // 3: the blow: two bodies meet, a shock ring runs across the sky, matter shears off
  (px, f, t, st) => {
    const T = (t % 150) / 150;
    const shake = T > 0.33 && T < 0.45 ? (Math.sin(t * 3) * 2) | 0 : 0;
    drawStars(px, st, t, { drift: 1, ox: shake });
    const cx = px.w * 0.5 + shake,
      cy = px.h * 0.37;
    const s = Math.min(px.h / 165, px.w / 150);
    const close = ease(clamp(T / 0.33));
    const pr = 18 * s,
      sr = 13 * s;
    const P = [cx - lerp(60, 17, close) * s, cy + 4 * s];
    const S = [cx + lerp(60, 15, close) * s, cy - 2 * s];
    // debris after impact
    if (T > 0.33)
      for (let k = 0; k < 90; k++) {
        const a = h3(k, 5, 1) * Math.PI * 2;
        const sp = (20 + h3(k, 5, 2) * 80) * s;
        const d = (T - 0.33) * sp;
        const x = cx + Math.cos(a) * d,
          y = cy + Math.sin(a) * d * 0.7;
        const c = k % 3 ? R.rock[3 + (k % 2)] : R.sun[4];
        px.put(x, y, c, 1 - (T - 0.33));
        px.put(x - Math.cos(a), y - Math.sin(a) * 0.7, c, 0.4 * (1 - T));
      }
    sphere(px, P[0], P[1], pr, planetSurf, t * 0.004, R.pocean);
    glow(px, S[0], S[1], sr, R.sun[4], 0.5);
    sphere(px, S[0], S[1], sr, sunSurf, t * 0.01);
    if (T > 0.33) {
      const k = (T - 0.33) / 0.67;
      const rr = k * Math.max(px.w, px.h) * 0.9;
      for (let a = 0; a < Math.PI * 2; a += 1 / Math.max(8, rr)) {
        const x = cx + Math.cos(a) * rr,
          y = cy + Math.sin(a) * rr * 0.55;
        px.put(x, y, R.sun[5], (1 - k) * 0.9, true);
        px.put(x, y + 1, R.sun[3], (1 - k) * 0.5, true);
      }
      if (k < 0.12) glow(px, cx, cy, 10 * s * (1 - k * 6), [255, 255, 255], 1 - k * 8);
    }
  },
  // 4: something felt it: the sky is pulled to the edges, coils come over the rim, a maw opens below
  (px, f, t, st) => {
    const pull = ease(clamp(f * 1.4));
    drawStars(px, st, t, { pull, drift: 1 - pull });
    edgeCoils(px, t, pull, 1);
    const r = px.h * (0.28 + pull * 0.16);
    maw(px, px.w * 0.5, px.h + r * (0.95 - pull * 0.75), r, pull, t * 0.02);
  },
];

/** Coils pressing in over the left and right edges (and the top corners), writhing. amt 0..1 */
function edgeCoils(px, t, amt, thick = 1) {
  const { w, h } = px;
  const T = t * 0.01;
  const paths = [];
  for (const side of [-1, 1]) {
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

function scaleScene(px, P, t, st) {
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
  px.vignette(0.9);
  // where the sprites go, in canvas pixels per world unit (scaleReveal turns it into CSS)
  return { X, Y, s, supernova: P > 1.2 ? clamp((P - 1.2) * 2) : 0 };
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
  const stars = makeStars(260, 3);
  const N = PRO.length;
  let cur = -1;
  whenVisible(
    sec,
    (t) => {
      px.fit();
      px.clear();
      const P = reduceMotion.matches ? 2.5 : progress(sec) * N;
      const i = Math.min(N - 1, Math.floor(P));
      const f = P - i;
      PRO[i](px, f, t, stars);
      // dip to black between beats
      const fade = Math.min(clamp(f / 0.12), clamp((1 - f) / 0.1), 1);
      if (i < N - 1 || f < 0.9) px.dim(0.25 + 0.75 * ease(fade));
      px.vignette(0.7);
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
      const at = scaleScene(px, P, t, stars);
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
story();
