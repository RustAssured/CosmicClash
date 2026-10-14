/**
 * DMath: deterministic transcendental functions for the simulation (netplay Step 0, docs/netplay/STEP0.md).
 *
 * ECMAScript only specifies + − × ÷, sqrt, floor / round / trunc, abs, min / max and the like exactly. Math.sin, cos, tan,
 * atan, atan2, asin, acos, exp, log, pow (and `**`), hypot, cbrt and tanh are "implementation-approximated": V8, SpiderMonkey
 * and JavaScriptCore each use their own library, and even two Chromium versions disagree in the last bit. One last bit is
 * enough: a matter sim amplifies it into a different fight within a few hundred ticks (measured: STEP0.md).
 *
 * Everything here is built ONLY from exactly specified operations (IEEE-754 double arithmetic, Math.sqrt, Math.round,
 * Math.floor, Math.abs, comparisons, number literals), so every engine on every CPU returns the same bits. The algorithms are
 * fdlibm's (Sun, 1993: the reference behind most libms) with their coefficients, so accuracy is within about one ulp of the
 * true value (pow within a few ulp): behaviour-preserving, not bit-identical to any engine's Math.
 *
 * Every file on the simulation path (sim, matter, combat, ai, titans, contracts) uses DMath instead of those Math functions;
 * ESLint enforces it (eslint.config.js, `no-restricted-properties` and the `**` operator). Render, audio and UI keep Math.
 */

/* ---- raw bits (frexp / ldexp for log and exp); every platform that runs a browser today is little-endian, but check ---- */
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LE ? 1 : 0;
const LO = LE ? 0 : 1;

const highWord = (x: number): number => {
  F64[0] = x;
  return U32[HI]! | 0;
};
const lowWord = (x: number): number => {
  F64[0] = x;
  return U32[LO]! >>> 0;
};
const withHigh = (x: number, hi: number): number => {
  F64[0] = x;
  U32[HI] = hi >>> 0;
  return F64[0]!;
};

/** 2^k for integer k in [-1022, 1023], built by exact doubling at load time. */
const POW2 = new Float64Array(2046);
{
  let p = 1;
  for (let k = 0; k <= 1023; k++, p *= 2) POW2[k + 1022] = p;
  p = 1;
  for (let k = 0; k >= -1022; k--, p *= 0.5) POW2[k + 1022] = p;
}
/** y · 2^k, exact unless the result is subnormal (then IEEE-rounded, identically everywhere). */
function scalbn(y: number, k: number): number {
  while (k > 1023) {
    y *= POW2[1023 + 1022]!;
    k -= 1023;
  }
  while (k < -1022) {
    y *= POW2[0]!;
    k += 1022;
  }
  return y * POW2[k + 1022]!;
}

/* ---- sin / cos: Cody-Waite reduction by π/2, fdlibm kernels on [-π/4, π/4] ---- */
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417; // first 33 bits of π/2
const PIO2_1T = 6.07710050650619224932e-11; // π/2 − PIO2_1
const PIO2_2 = 6.0771005063039659766e-11; // second 33 bits
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.0222662487111664558e-21; // third 33 bits
const PIO2_3T = 8.47842766036889956997e-32;

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

/** sin on [-π/4, π/4], with y the tail of the reduced argument (x + y). */
function kSin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}
/** cos on [-π/4, π/4]. */
function kCos(x: number, y: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + (z * r - x * y));
}

/** Reduction result: quadrant n (int) and x − n·π/2 as head + tail. */
let redHi = 0;
let redLo = 0;
function reduce(x: number): number {
  const fn = Math.round(x * INV_PIO2);
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  if (Math.abs(fn) >= 1048576) {
    // big arguments: two more 33-bit pieces of π/2 (fdlibm's medium reduction; enough for any |x| < 2^50)
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - (t - r - w);
    t = r;
    w = fn * PIO2_3;
    r = t - w;
    w = fn * PIO2_3T - (t - r - w);
  }
  redHi = r - w;
  redLo = r - redHi - w;
  return fn;
}

function sin(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) return ax < 7.450580596923828e-9 ? x : kSin(x, 0);
  if (!(ax < Infinity)) return NaN;
  const n = reduce(x) % 4;
  const q = n < 0 ? n + 4 : n;
  return q === 0
    ? kSin(redHi, redLo)
    : q === 1
      ? kCos(redHi, redLo)
      : q === 2
        ? -kSin(redHi, redLo)
        : -kCos(redHi, redLo);
}

function cos(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) return ax < 7.450580596923828e-9 ? 1 : kCos(x, 0);
  if (!(ax < Infinity)) return NaN;
  const n = reduce(x) % 4;
  const q = n < 0 ? n + 4 : n;
  return q === 0
    ? kCos(redHi, redLo)
    : q === 1
      ? -kSin(redHi, redLo)
      : q === 2
        ? -kCos(redHi, redLo)
        : kSin(redHi, redLo);
}

function tan(x: number): number {
  const ax = Math.abs(x);
  if (ax < 7.450580596923828e-9) return x;
  if (!(ax < Infinity)) return NaN;
  let hi = x;
  let lo = 0;
  let q = 0;
  if (ax > 0.7853981633974483) {
    const n = reduce(x) % 4;
    q = (n < 0 ? n + 4 : n) & 1;
    hi = redHi;
    lo = redLo;
  }
  const s = kSin(hi, lo);
  const c = kCos(hi, lo);
  return q === 0 ? s / c : -c / s;
}

/* ---- atan / atan2 / asin / acos (fdlibm s_atan.c, e_atan2.c) ---- */
const ATANHI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.570796326794896558,
];
const ATANLO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.1111110405462355788e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.6531572744216915527e-2;
const AT10 = 1.62858201153657823623e-2;

function atan(x0: number): number {
  if (x0 !== x0) return NaN;
  let x = Math.abs(x0);
  if (x >= 7.378697629483821e19) return x0 < 0 ? -1.5707963267948966 : 1.5707963267948966;
  let id = -1;
  if (x < 0.4375) {
    if (x < 3.725290298461914e-9) return x0;
  } else if (x < 1.1875) {
    if (x < 0.6875) {
      id = 0;
      x = (2 * x - 1) / (2 + x);
    } else {
      id = 1;
      x = (x - 1) / (x + 1);
    }
  } else if (x < 2.4375) {
    id = 2;
    x = (x - 1.5) / (1 + 1.5 * x);
  } else {
    id = 3;
    x = -1 / x;
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x0 < 0 ? -(x - x * (s1 + s2)) : x - x * (s1 + s2);
  const r = ATANHI[id]! - (x * (s1 + s2) - ATANLO[id]! - x);
  return x0 < 0 ? -r : r;
}

const PI = 3.141592653589793;
const PI_LO = 1.2246467991473532e-16;

function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  if (x === 1) return atan(y);
  const yNeg = y < 0 || (y === 0 && 1 / y < 0);
  const xNeg = x < 0 || (x === 0 && 1 / x < 0);
  if (y === 0) return xNeg ? (yNeg ? -PI : PI) : y;
  if (x === 0) return yNeg ? -1.5707963267948966 : 1.5707963267948966;
  if (x === Infinity || x === -Infinity) {
    if (y === Infinity || y === -Infinity) {
      const a = xNeg ? 2.356194490192345 : 0.7853981633974483;
      return yNeg ? -a : a;
    }
    return xNeg ? (yNeg ? -PI : PI) : yNeg ? -0 : 0;
  }
  if (y === Infinity || y === -Infinity) return yNeg ? -1.5707963267948966 : 1.5707963267948966;
  const z = atan(Math.abs(y / x));
  if (!xNeg) return yNeg ? -z : z;
  const r = PI - (z - PI_LO);
  return yNeg ? -r : r;
}

function asin(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

function acos(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

/* ---- exp / log / pow (fdlibm e_exp.c, e_log.c) ---- */
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.442695040888963387;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;

function exp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  if (Math.abs(x) < 3.725290298461914e-9) return 1 + x;
  const k = Math.round(x * INV_LN2);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  return k === 0 ? y : scalbn(y, k);
}

const LG1 = 6.66666666666673513e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;
const TWO54 = 1.8014398509481984e16;

function log(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let k = 0;
  let hx = highWord(x);
  if (hx < 0x00100000) {
    // subnormal: scale up
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHigh(x, hx | (i0 ^ 0x3ff00000)); // x or x/2, in [sqrt(2)/2, sqrt(2))
  k += i0 >> 20;
  const f = x - 1;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    // |f| < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const R = f * f * (0.5 - 0.3333333333333333 * f);
    return k === 0 ? f - R : dk * LN2_HI - (R - dk * LN2_LO - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

const isInt = (y: number): boolean => Math.floor(y) === y;

/** x^n for an integer n, |n| ≤ 64, by binary powering (exact for squares; a few ulp at worst). */
function powInt(x: number, n: number): number {
  let e = n < 0 ? -n : n;
  let r = 1;
  let b = x;
  while (e > 0) {
    if (e & 1) r *= b;
    e >>= 1;
    if (e > 0) b *= b;
  }
  return n < 0 ? 1 / r : r;
}

/**
 * x^y with the ECMAScript special cases (Number::exponentiate). Small integer exponents use binary powering (x² is exact);
 * the rest exp(y·log|x|), within a few ulp for the magnitudes the sim uses.
 */
function pow(x: number, y: number): number {
  if (y !== y) return NaN;
  if (y === 0) return 1;
  if (x !== x) return NaN;
  if (y === 1) return x;
  const ax = Math.abs(x);
  if (y === Infinity || y === -Infinity) {
    if (ax === 1) return NaN;
    return ax > 1 === y > 0 ? Infinity : 0;
  }
  const yi = isInt(y);
  const odd = yi && Math.abs(y) < 9007199254740992 && Math.abs(y % 2) === 1;
  if (x === 0) {
    const negZero = 1 / x < 0;
    if (y > 0) return negZero && odd ? -0 : 0;
    return negZero && odd ? -Infinity : Infinity;
  }
  if (x === Infinity) return y > 0 ? Infinity : 0;
  if (x === -Infinity) return y > 0 ? (odd ? -Infinity : Infinity) : odd ? -0 : 0;
  if (yi && Math.abs(y) <= 64) return powInt(x, y);
  if (y === 0.5) return Math.sqrt(x);
  if (x < 0 && !yi) return NaN;
  const r = exp(y * log(ax));
  return x < 0 && odd ? -r : r;
}

/* ---- the rest ---- */
/** √(x² + y² [+ z²]). No scaling: |components| up to ~1e150 (pixels and speeds are far below). */
function hypot(x: number, y: number, z?: number): number {
  return z === undefined ? Math.sqrt(x * x + y * y) : Math.sqrt(x * x + y * y + z * z);
}

function cbrt(x: number): number {
  if (x === 0 || x !== x || x === Infinity || x === -Infinity) return x;
  const a = Math.abs(x);
  let t = exp(log(a) / 3);
  t -= (t * t * t - a) / (3 * t * t); // one Newton step from a near-ulp start
  return x < 0 ? -t : t;
}

function tanh(x: number): number {
  if (x !== x) return NaN;
  const a = Math.abs(x);
  if (a > 22) return x < 0 ? -1 : 1;
  if (a < 3.725290298461914e-9) return x;
  const e = exp(2 * a);
  const r = (e - 1) / (e + 1);
  return x < 0 ? -r : r;
}

/** Drop-in for the implementation-approximated members of Math, on the simulation path. Same signatures. */
export const DMath = Object.freeze({
  sin,
  cos,
  tan,
  atan,
  atan2,
  asin,
  acos,
  exp,
  log,
  pow,
  hypot,
  cbrt,
  tanh,
});

/** x², exactly (the replacement for `x ** 2`, which is pow: implementation-approximated). */
export const sq = (x: number): number => x * x;

/** Low and high words of a double (tests; the endianness check above). */
export const dmathBits = (x: number): [number, number] => [lowWord(x), highWord(x) >>> 0];
