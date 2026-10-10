/**
 * Per-act grades (TRAILER_V3 §2.1), applied to the renderer's final native frame before the overlay:
 *  - before:  cold blue (the two worlds, before anything came);
 *  - witness: gold and celadon (the eye's own colours, pushed);
 *  - mouth:   red, blacks crushed;
 *  - build:   ember (the genesis);
 *  - hunt:    neutral at full saturation (the game as it is, a touch more saturated);
 *  - edge:    desaturated, except the flesh (the Mouth's reds keep their colour).
 * A grade is a fixed function of the colour (memoised per colour), so it never adds texture and never smooths. NOTE: the
 * brief asks for LUTs inside the master palette; since D34 the game's own frame is no longer snapped to the 128-colour
 * master, so the grades shift colour in the game's current (unsnapped) space and keep its range.
 */
export type GradeId = 'none' | 'before' | 'witness' | 'mouth' | 'build' | 'hunt' | 'edge';

const memo = new Map<GradeId, Map<number, number>>();

function gradeRgb(g: GradeId, r: number, gr: number, b: number): [number, number, number] {
  const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
  const sat = (k: number): void => {
    r = l + (r - l) * k;
    gr = l + (gr - l) * k;
    b = l + (b - l) * k;
  };
  switch (g) {
    case 'before':
      sat(0.8);
      r *= 0.86;
      gr *= 0.97;
      b = b * 1.1 + 6;
      break;
    case 'witness': {
      // highlights to gold, shadows to celadon
      const t = l / 255;
      r = r * (0.92 + 0.16 * t) + 4 * (1 - t);
      gr = gr * (1.0 + 0.06 * t) + 10 * (1 - t);
      b = b * (0.82 + 0.0 * t) + 8 * (1 - t);
      break;
    }
    case 'mouth': {
      sat(1.1);
      r *= 1.12;
      gr *= 0.82;
      b *= 0.86;
      // crush the blacks: everything below ~14 % luminance falls toward black
      const k = Math.min(1, Math.max(0, (l - 18) / 40));
      r *= k;
      gr *= k;
      b *= k;
      break;
    }
    case 'build':
      r = r * 1.08 + 6;
      gr = gr * 0.98 + 2;
      b *= 0.84;
      break;
    case 'hunt':
      sat(1.15);
      break;
    case 'edge': {
      const flesh = r > gr * 1.25 && r > b * 1.15;
      if (!flesh) sat(0.25);
      break;
    }
    default:
      break;
  }
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(gr), c(b)];
}

/** Grade a native frame in place (packed RGBA, alpha untouched). */
export function applyGrade(px: Uint32Array, g: GradeId): void {
  if (g === 'none') return;
  let m = memo.get(g);
  if (!m) memo.set(g, (m = new Map()));
  for (let i = 0; i < px.length; i++) {
    const c = px[i]!;
    const key = c & 0xffffff;
    let v = m.get(key);
    if (v === undefined) {
      const [r, gr, b] = gradeRgb(g, c & 255, (c >>> 8) & 255, (c >>> 16) & 255);
      v = ((b << 16) | (gr << 8) | r) >>> 0;
      m.set(key, v);
    }
    px[i] = ((c & 0xff000000) | v) >>> 0;
  }
}
