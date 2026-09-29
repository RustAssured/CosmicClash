/** Scalar-field utilities for the art toolkit (all Float32Array, row-major w×h). */

const INF = 1e20;

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher). Returns, for every cell, the distance in
 * pixels to the nearest cell whose solidity equals `targetSolid` (0 for cells that ARE the target).
 * `mask` is any Uint8Array; nonzero = solid. `targetSolid=false` measures the distance inside solids to the nearest void.
 * Cells with no target anywhere get 1e6.
 */
export function edt(
  mask: Uint8Array,
  w: number,
  h: number,
  targetSolid: boolean,
  out?: Float32Array,
): Float32Array {
  const n = w * h;
  const res = out ?? new Float32Array(n);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = (mask[i] !== 0) === targetSolid ? 0 : INF;
  const m = Math.max(w, h);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const pass = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x]!;
    pass(h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x]!;
    pass(w);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x]!;
  }
  for (let i = 0; i < n; i++) res[i] = g[i]! >= INF * 0.5 ? 1e6 : Math.sqrt(g[i]!);
  return res;
}

/** Separable box blur with edge clamping; radius in px. Returns a new array unless `out` is given. */
export function boxBlur(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
  out?: Float32Array,
): Float32Array {
  const tmp = new Float32Array(w * h);
  const res = out ?? new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      acc += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      res[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return res;
}

/** Central-difference gradient at (x,y) with edge clamping. */
export function gradAt(
  f: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  out: { x: number; y: number },
): void {
  const x0 = x > 0 ? x - 1 : 0;
  const x1 = x < w - 1 ? x + 1 : w - 1;
  const y0 = y > 0 ? y - 1 : 0;
  const y1 = y < h - 1 ? y + 1 : h - 1;
  out.x = (f[y * w + x1]! - f[y * w + x0]!) / (x1 - x0 || 1);
  out.y = (f[y1 * w + x]! - f[y0 * w + x]!) / (y1 - y0 || 1);
}

/** Keep only the largest 4-connected solid component of `mask` (in place). Returns the number of cells removed. */
export function keepLargestComponent(mask: Uint8Array, w: number, h: number): number {
  const n = w * h;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let best = 0;
  let bestLabel = 0;
  let cur = 0;
  for (let s = 0; s < n; s++) {
    if (mask[s] === 0 || label[s] !== 0) continue;
    cur++;
    let sp = 0;
    let size = 0;
    stack[sp++] = s;
    label[s] = cur;
    while (sp > 0) {
      const i = stack[--sp]!;
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && mask[i - 1] !== 0 && label[i - 1] === 0) {
        label[i - 1] = cur;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] !== 0 && label[i + 1] === 0) {
        label[i + 1] = cur;
        stack[sp++] = i + 1;
      }
      if (y > 0 && mask[i - w] !== 0 && label[i - w] === 0) {
        label[i - w] = cur;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && mask[i + w] !== 0 && label[i + w] === 0) {
        label[i + w] = cur;
        stack[sp++] = i + w;
      }
    }
    if (size > best) {
      best = size;
      bestLabel = cur;
    }
  }
  let removed = 0;
  for (let i = 0; i < n; i++)
    if (mask[i] !== 0 && label[i] !== bestLabel) {
      mask[i] = 0;
      removed++;
    }
  return removed;
}
