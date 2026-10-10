import { ANGLE_STEPS, type RenderLayer, type RenderPart } from '@/contracts';

/**
 * The Witness close-up's pose overrides (TRAILER_V3 §2.1: pose overrides only for the cinema-only beats). They act on the
 * REAL Witness's own pixels, never a stand-in:
 *  - `pupil` (1 = as drawn … 0.35 = contracted): the black pupil of the eye cradle (the fighter's body layer, titan-<slot>)
 *    shrinks; the cells it gives up take the iris colour found just outside it on the same ray, so the celadon iris closes in.
 *  - `rings` (0 = as the rig holds them … 1 = aligned): the halo arcs (the atlas parts drawn furthest back) are offset round
 *    the eye and click back into place in whole clicks: each click jumps the arcs by one notch and holds, like a lens ring.
 */
export interface WitnessPose {
  pupil: number;
  rings: number;
}

/** Halo arcs on the Witness (src/titans/art/lastone.ts HALO_ARCS). */
const HALO_N = 5;
/** Misalignment at rings 0 (radians per arc, alternating) and the number of clicks back to aligned. */
const MISALIGN = 0.42;
const CLICKS = 6;

interface Twin {
  layer: RenderLayer;
  parts: RenderPart[];
}
const twins = new Map<string, Twin>();

function twinOf(l: RenderLayer): Twin {
  let tw = twins.get(l.id);
  if (!tw || tw.layer.pixels.length !== l.pixels.length) {
    tw = {
      layer: { ...l, id: `${l.id}:pose`, pixels: new Uint32Array(l.pixels.length), version: 0 },
      parts: [],
    };
    twins.set(l.id, tw);
  }
  return tw;
}

const luma = (c: number): number =>
  0.2126 * (c & 255) + 0.7152 * ((c >>> 8) & 255) + 0.0722 * ((c >>> 16) & 255);

/** Eye centre (world px) of the last frame, for the halo rotation. */
let eyeX = 0;
let eyeY = 0;

/** Pass a Witness's layers through the pose (copies; the fighter's own layers are untouched). */
export function witnessLayers(src: readonly RenderLayer[], pose: WitnessPose, out: RenderLayer[]): void {
  for (const l of src) {
    if (/^titan-\d$/.test(l.id)) out.push(pupilLayer(l, pose.pupil));
    else if (/^witness-\d$/.test(l.id) && l.parts) out.push(haloLayer(l, pose.rings));
    else out.push(l);
  }
}

function pupilLayer(l: RenderLayer, pupil: number): RenderLayer {
  const tw = twinOf(l);
  const d = tw.layer;
  const prev = d.version;
  const pixels = d.pixels;
  Object.assign(d, l, { id: `${l.id}:pose`, pixels, dirty: null });
  pixels.set(l.pixels);
  // the pupil: the near-black cells round the sprite's centre
  const cx0 = l.w / 2;
  const cy0 = l.h / 2;
  let sx = 0;
  let sy = 0;
  let n = 0;
  const lim = Math.min(l.w, l.h) * 0.3;
  for (let y = 0; y < l.h; y++)
    for (let x = 0; x < l.w; x++) {
      const c = l.pixels[y * l.w + x]!;
      if (c >>> 24 && luma(c) < 34 && Math.hypot(x - cx0, y - cy0) < lim) {
        sx += x;
        sy += y;
        n++;
      }
    }
  // the eye's centre in world px (the body layer's anchor sits on it), for the halo
  eyeX = l.x - (l.anchorX - (n ? sx / n : cx0)) * l.facing;
  eyeY = l.y - (l.anchorY - (n ? sy / n : cy0));
  if (n && pupil < 0.999) {
    const px = sx / n;
    const py = sy / n;
    let R = 0;
    for (let y = 0; y < l.h; y++)
      for (let x = 0; x < l.w; x++) {
        const c = l.pixels[y * l.w + x]!;
        if (c >>> 24 && luma(c) < 34 && Math.hypot(x - cx0, y - cy0) < lim)
          R = Math.max(R, Math.hypot(x + 0.5 - px, y + 0.5 - py));
      }
    const r = R * pupil;
    for (let y = 0; y < l.h; y++)
      for (let x = 0; x < l.w; x++) {
        const i = y * l.w + x;
        const c = l.pixels[i]!;
        if (!(c >>> 24) || luma(c) >= 34) continue;
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        const dd = Math.hypot(dx, dy);
        if (dd <= r || dd > R + 0.5) continue;
        // the iris colour just outside the drawn pupil on this ray
        const k = (R + 1.5) / (dd || 1);
        const ix = Math.round(px + dx * k - 0.5);
        const iy = Math.round(py + dy * k - 0.5);
        const iris = ix >= 0 && iy >= 0 && ix < l.w && iy < l.h ? l.pixels[iy * l.w + ix]! : 0;
        pixels[i] = iris >>> 24 && luma(iris) >= 34 ? iris : 0xff8ab6a2;
      }
  }
  d.version = prev + 1;
  return d;
}

function haloLayer(l: RenderLayer, rings: number): RenderLayer {
  const tw = twinOf(l);
  const d = tw.layer;
  const prev = d.version;
  const pixels = d.pixels;
  Object.assign(d, l, { id: `${l.id}:pose`, pixels, dirty: null });
  pixels.set(l.pixels);
  const parts = l.parts!;
  if (tw.parts.length !== parts.length) tw.parts = parts.map((p) => ({ ...p }));
  // the halo arcs: the parts drawn furthest back
  const order = parts.map((_p, i) => i).sort((a, b) => parts[a]!.z - parts[b]!.z);
  const halo = new Set(order.slice(0, HALO_N));
  // whole clicks back to aligned: the offset holds between clicks
  const left = Math.ceil((1 - Math.min(1, Math.max(0, rings))) * CLICKS - 1e-9) / CLICKS;
  let k = 0;
  parts.forEach((p, i) => {
    const q = tw.parts[i]!;
    Object.assign(q, p);
    if (!halo.has(i) || left <= 0) return;
    const a = (k++ % 2 ? 1 : -1) * MISALIGN * left * (1 + 0.25 * (i % 3));
    const dx = (p.wx - eyeX) * l.facing;
    const dy = p.wy - eyeY;
    const c = Math.cos(a);
    const s = Math.sin(a);
    q.wx = Math.round(eyeX + (dx * c - dy * s) * l.facing);
    q.wy = Math.round(eyeY + dx * s + dy * c);
    q.step =
      (((p.step + Math.round((a / (2 * Math.PI)) * ANGLE_STEPS * l.facing)) % ANGLE_STEPS) + ANGLE_STEPS) %
      ANGLE_STEPS;
  });
  d.parts = tw.parts;
  d.version = prev + 1;
  return d;
}
