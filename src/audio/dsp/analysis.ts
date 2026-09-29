/**
 * Measurement helpers: pure functions on sample arrays, used by the unit tests (Node) and by the in-browser verification
 * page that renders the real engine through an OfflineAudioContext.
 */

export function peak(x: ArrayLike<number>, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) {
    const a = Math.abs(x[i]!);
    if (a > p) p = a;
  }
  return p;
}

export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
}

export const toDb = (v: number): number => 20 * Math.log10(Math.max(1e-9, v));

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Spectral centroid in Hz of `x[from..from+len)` (Hann windowed, zero-padded to a power of two): the "brightness" of a sound —
 * glassy bells sit high, rock and sub-bass low. Weighted by POWER (|X|²): a magnitude-weighted centroid of any −6 dB/oct
 * rolloff is dragged up by the far-high, far-quiet bins and stops meaning "how bright it sounds". `minHz` ignores everything
 * below it (skip the shared sub-bass thump to compare the CHARACTER of two sounds).
 */
export function spectralCentroid(
  x: ArrayLike<number>,
  sampleRate: number,
  from = 0,
  len = 4096,
  minHz = 0,
): number {
  let n = 1;
  while (n < len) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const end = Math.min(x.length, from + len);
  const m = end - from;
  for (let i = 0; i < m; i++)
    re[i] = x[from + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, m - 1)));
  fft(re, im);
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const pw = re[k]! * re[k]! + im[k]! * im[k]!;
    const f = (k * sampleRate) / n;
    if (f < minHz) continue;
    num += f * pw;
    den += pw;
  }
  return den > 0 ? num / den : 0;
}

/** Fraction (0..1) of the power in `x[from..from+len)` that lies between `loHz` and `hiHz` (Hann windowed). */
export function bandShare(
  x: ArrayLike<number>,
  sampleRate: number,
  loHz: number,
  hiHz: number,
  from = 0,
  len = 16384,
): number {
  let n = 1;
  while (n < len) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const end = Math.min(x.length, from + len);
  const m = end - from;
  for (let i = 0; i < m; i++)
    re[i] = x[from + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, m - 1)));
  fft(re, im);
  let band = 0;
  let all = 0;
  for (let k = 1; k < n / 2; k++) {
    const pw = re[k]! * re[k]! + im[k]! * im[k]!;
    const f = (k * sampleRate) / n;
    all += pw;
    if (f >= loHz && f < hiHz) band += pw;
  }
  return all > 0 ? band / all : 0;
}

/** First sample index whose magnitude exceeds `thr`, or −1. */
export function firstAbove(x: ArrayLike<number>, thr: number): number {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > thr) return i;
  return -1;
}

/** Windowed RMS envelope in dBFS, one value per `winSamples`. */
export function envelopeDb(x: ArrayLike<number>, winSamples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + winSamples <= x.length; i += winSamples) out.push(toDb(rms(x, i, i + winSamples)));
  return out;
}

/**
 * Seconds until the signal's RMS envelope has fallen `db` below its peak window and stays below (a tail-length measure).
 * Returns the full duration if it never decays that far.
 */
export function decayTime(x: ArrayLike<number>, sampleRate: number, db = 60, winMs = 20): number {
  const win = Math.max(1, Math.round((sampleRate * winMs) / 1000));
  const env = envelopeDb(x, win);
  let pk = -Infinity;
  let pkIdx = 0;
  env.forEach((v, i) => {
    if (v > pk) {
      pk = v;
      pkIdx = i;
    }
  });
  let last = pkIdx;
  for (let i = pkIdx; i < env.length; i++) if (env[i]! > pk - db) last = i;
  return ((last - pkIdx + 1) * win) / sampleRate;
}

/**
 * RT60 of an impulse response by Schroeder backward integration: fit the −5…−35 dB slope of the energy decay curve and
 * extrapolate to −60 dB.
 */
export function rt60(ir: ArrayLike<number>, sampleRate: number): number {
  const n = ir.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += ir[i]! * ir[i]!;
    edc[i] = acc;
  }
  const total = edc[0]!;
  if (total <= 0) return 0;
  let t5 = -1;
  let t35 = -1;
  for (let i = 0; i < n; i++) {
    const d = 10 * Math.log10(edc[i]! / total);
    if (t5 < 0 && d <= -5) t5 = i;
    if (t35 < 0 && d <= -35) {
      t35 = i;
      break;
    }
  }
  if (t5 < 0 || t35 < 0) return n / sampleRate;
  return ((t35 - t5) / sampleRate) * (60 / 30);
}
