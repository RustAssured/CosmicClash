import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { launch } from '../lead/browser';
import { startDevServer } from './devserver';
import { bakeUri, genesisCues } from '../../src/cinema/p4/uri';
import { EDGE, EDGE_WORDS, edgeWordCues } from '../../src/cinema/p6/edge';
import {
  KFilter,
  LoudnessAccumulator,
  TruePeakDetector,
  designTruePeakFir,
} from '../../src/telemetry/loudness';
import { LIMITER_LOOKAHEAD, LimiterCore } from '../../src/audio/worklets/limiter';
import type { CinemaPlan, PlacedCue, StemName } from '../../dev/ui/audio-cinema';

/**
 * The launch trailer v3's sound, in one command, from the timeline as it stands (docs/cinema/TRAILER_V3.md §2.3):
 *
 *   npx tsx tools/ui/audio-cinema.ts [--timeline=src/cinema/timeline.json] [--out=press/cinema/audio]
 *
 *  1. the plan: every shot's [start, end] from timeline.json; the genesis drums and welds from genesisCues() (src/cinema/p4/uri.ts,
 *     run on the build-genesis → build-brace span of the timeline); the edge word cues from edgeWordCues() (src/cinema/p6/edge.ts;
 *     shifted if the timeline moved the pull-back); the two HARD silences from the bite and the cut to black;
 *  2. the five stems rendered offline by the game's own synth in headless Edge (dev/ui/audio-cinema.ts), one at a time;
 *  3. the master: gain to −16 LUFS integrated, the game's own true-peak limiter (−1.3 dB ceiling, so ≤ −1 dBTP);
 *  4. out: stem-<name>.wav (24-bit, at the master's gain: they sum to the mix before its limiter), mix.wav (16-bit) and
 *     cue-report.json (every cue: where its source puts it, where it was placed (its frame), where its onset was measured in its
 *     stem, and the errors in ms).
 */
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const TIMELINE = arg('timeline', 'src/cinema/timeline.json');
const OUT = arg('out', 'press/cinema/audio');
const SR = 48000;
const TARGET = -16;
const STEMS: StemName[] = ['drone', 'motifs', 'perc', 'sfx', 'vo'];

/* ---------------------------------------------------------------- 1. the plan */
interface Shot {
  id: string;
  start: number;
  end: number;
}
const tl = JSON.parse(readFileSync(TIMELINE, 'utf8')) as { fps?: number; shots: Shot[] };
const fps = tl.fps ?? 60;
const shots: Record<string, [number, number]> = {};
for (const s of tl.shots) shots[s.id] = [s.start, s.end];
const duration = Math.max(...tl.shots.map((s) => s.end));
const start = (id: string, d = 0): number => shots[id]?.[0] ?? d;
const notes: string[] = [];

const png = (f: string): PNG => PNG.sync.read(readFileSync(`src/cinema/assets/${f}.png`));
const genStart = start('build-genesis', 27);
const genDur = start('build-brace', genStart + 14) - genStart;
const gen = genesisCues(
  bakeUri(png('uri-a'), png('uri-a-id'), png('uri-g'), png('uri-g-id')),
  genStart,
  genDur,
);
const drums = gen.drums.map((d) => ({
  t: d.t,
  part: d.part,
  size: d.size,
  clench: (d as { clench?: number }).clench,
}));
const welds = gen.welds.map((w) => w.t);

const pullShift = start('edge-pullback', EDGE.pullStart) - EDGE.pullStart;
if (Math.abs(pullShift) > 1e-6)
  notes.push(
    `edge-pullback starts at ${start('edge-pullback')} in the timeline, ${EDGE.pullStart} in edge.ts: words shifted`,
  );
const words = edgeWordCues().map((t, i) => ({ word: EDGE_WORDS[i]!, t: t + pullShift }));

const bite = start('before-bite', 22) + 0.5;
const silences: [number, number, boolean][] = [
  // Silence #1: the bite's own ring-out only, then room tone through the ruin
  [bite + 0.08, start('build-ruin', 24), true],
  [start('build-ruin', 24), start('build-genesis', 27), false],
  // Silence #2: the cut to black a frame before the punch, room tone only until the edge
  [start('hunt-black', 72), start('edge-wide', 77), false],
];
const plan: CinemaPlan = { duration, fps, shots, drums, welds, words, silences };

/* ---------------------------------------------------------------- 2. the stems */
const { server, url } = await startDevServer();
const browser = await launch();
const stems = new Map<StemName, { l: Float32Array; r: Float32Array; cues: PlacedCue[] }>();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`${url}/dev/ui/audio.html`);
  for (const stem of STEMS) {
    const code = `(async () => {
      const m = await import('/dev/ui/audio-cinema.ts');
      const r = await m.renderCinemaStem(${JSON.stringify(plan)}, '${stem}');
      const enc = function (x) {
        const q = new Int16Array(x.length);
        for (let i = 0; i < x.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 16384)));
        const b = new Uint8Array(q.buffer);
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return { l: enc(r.left), r: enc(r.right), cues: r.cues };
    })()`;
    const res = (await page.evaluate(code)) as { l: string; r: string; cues: PlacedCue[] };
    const dec = (s: string): Float32Array => {
      const b = Buffer.from(s, 'base64');
      const q = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
      return Float32Array.from(q, (v) => v / 16384);
    };
    stems.set(stem, { l: dec(res.l), r: dec(res.r), cues: res.cues });
    console.error(`stem ${stem}: rendered`);
  }
} finally {
  await browser.close();
  await server.close();
}

/* ---------------------------------------------------------------- 3. the master */
const N = Math.ceil(SR * duration);
const measure = (
  l: Float32Array,
  r: Float32Array,
): { integrated: number; truePeak: number; range: number } => {
  const kf = [new KFilter(SR), new KFilter(SR)];
  const tp = [new TruePeakDetector(), new TruePeakDetector()];
  const acc = new LoudnessAccumulator();
  const block = SR / 10;
  for (let i = 0; i + block <= l.length; i += block)
    acc.push(
      (kf[0]!.sumSquares(l, i, i + block) + kf[1]!.sumSquares(r, i, i + block)) / block,
      Math.max(tp[0]!.push(l, i, i + block), tp[1]!.push(r, i, i + block)),
    );
  return { integrated: acc.integrated, truePeak: acc.truePeak, range: acc.range };
};
const L = new Float32Array(N);
const R = new Float32Array(N);
for (const s of stems.values())
  for (let i = 0; i < N; i++) {
    L[i] += s.l[i] ?? 0;
    R[i] += s.r[i] ?? 0;
  }
const lin = (db: number): number => Math.pow(10, db / 20);
let gain = lin(TARGET - measure(L, R).integrated);
let mixL = L;
let mixR = R;
let limDb = 0;
for (let pass = 0; pass < 3; pass++) {
  const lim = new LimiterCore(
    2,
    SR,
    LIMITER_LOOKAHEAD,
    lin(-1.3),
    0.15,
    designTruePeakFir().map((p) => Array.from(p)),
  );
  const pad = lim.delayFrames;
  const inL = new Float32Array(N + pad);
  const inR = new Float32Array(N + pad);
  for (let i = 0; i < N; i++) {
    inL[i] = L[i]! * gain;
    inR[i] = R[i]! * gain;
  }
  const oL = new Float32Array(N + pad);
  const oR = new Float32Array(N + pad);
  lim.process([inL, inR], [oL, oR], N + pad);
  mixL = oL.subarray(pad);
  mixR = oR.subarray(pad);
  limDb = -20 * Math.log10(Math.max(1e-6, lim.takeMinGain()));
  const got = measure(mixL, mixR).integrated;
  if (Math.abs(got - TARGET) < 0.15) break;
  gain *= lin(TARGET - got);
}
// end on silence: the last 0.3 s at zero
for (let i = Math.max(0, N - Math.floor(0.3 * SR)); i < N; i++) mixL[i] = mixR[i] = 0;
const m = measure(mixL, mixR);

/* ---------------------------------------------------------------- 4. out */
function wav(l: Float32Array, r: Float32Array, bits: 16 | 24): Buffer {
  const bps = bits / 8;
  const n = l.length;
  const b = Buffer.alloc(44 + n * 2 * bps);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2 * bps, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2 * bps, 28);
  b.writeUInt16LE(2 * bps, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2 * bps, 40);
  const full = bits === 16 ? 32767 : 8388607;
  for (let i = 0; i < n; i++)
    for (const [c, x] of [
      [0, l[i]!],
      [1, r[i]!],
    ] as const) {
      const v = Math.max(-full - 1, Math.min(full, Math.round(x * full)));
      if (bits === 16) b.writeInt16LE(v, 44 + (i * 2 + c) * 2);
      else b.writeIntLE(v, 44 + (i * 2 + c) * 3, 3);
    }
  return b;
}
mkdirSync(OUT, { recursive: true });
let stemPeak = 0;
for (const s of stems.values())
  for (let i = 0; i < N; i++)
    stemPeak = Math.max(stemPeak, Math.abs(s.l[i]! * gain), Math.abs(s.r[i]! * gain));
const stemScale = stemPeak > 0.999 ? 0.999 / stemPeak : 1;
if (stemScale < 1)
  notes.push(
    `stems written ${(20 * Math.log10(stemScale)).toFixed(1)} dB under the mix's gain (a stem peaked over full scale)`,
  );
for (const [name, s] of stems)
  writeFileSync(
    join(OUT, `stem-${name}.wav`),
    wav(
      s.l.map((v) => v * gain * stemScale),
      s.r.map((v) => v * gain * stemScale),
      24,
    ),
  );
writeFileSync(join(OUT, 'mix.wav'), wav(mixL, mixR, 16));

// the cue report: each cue's onset measured in its own stem (the first 2.5 ms block within ±60 ms of the cue whose energy jumps
// to 8× the 20 ms before it)
const onset = (s: { l: Float32Array; r: Float32Array }, at: number): number | null => {
  const blk = Math.round(SR * 0.0025);
  const e = (i: number): number => {
    let a = 0;
    for (let k = i; k < i + blk && k < N; k++) a += s.l[k]! * s.l[k]! + s.r[k]! * s.r[k]!;
    return a / blk;
  };
  for (
    let i = Math.max(Math.round((at - 0.06) * SR), Math.round(0.02 * SR));
    i < Math.round((at + 0.06) * SR);
    i += blk
  ) {
    let before = 0;
    for (let k = i - Math.round(0.02 * SR); k < i; k += blk) before += e(k);
    before /= 8;
    if (e(i) > 8 * before + 1e-9 && e(i) > 1e-8) return i / SR;
  }
  return null;
};
const cues = [...stems.entries()].flatMap(([name, s]) =>
  s.cues.map((c) => {
    const o = name === 'vo' ? null : onset(s, c.at);
    return {
      ...c,
      frame: Math.round(c.at * fps),
      placeErrMs: +((c.at - c.cue) * 1000).toFixed(2),
      onset: o === null ? null : +o.toFixed(4),
      onsetErrMs: o === null ? null : +((o - c.cue) * 1000).toFixed(2),
      /** The measured onset against the frame it was placed on (the sync error a viewer could see). */
      onsetVsFrameMs: o === null ? null : +((o - c.at) * 1000).toFixed(2),
    };
  }),
);
const measured = cues.filter((c) => c.onsetVsFrameMs !== null).map((c) => Math.abs(c.onsetVsFrameMs!));
const sorted = [...measured].sort((a, b) => a - b);
const report = {
  timeline: TIMELINE,
  duration,
  integrated: +m.integrated.toFixed(1),
  truePeak: +m.truePeak.toFixed(2),
  range: +m.range.toFixed(1),
  limiterDb: +limDb.toFixed(1),
  masterGainDb: +(20 * Math.log10(gain)).toFixed(1),
  silences,
  cues: cues.length,
  cuesMeasured: measured.length,
  /** Measured onset vs. its frame: median and worst (ms). Cues inside dense passages may be masked (onset null). */
  medianOnsetVsFrameMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
  worstOnsetVsFrameMs: sorted.length ? sorted[sorted.length - 1] : null,
  worstPlaceErrMs: Math.max(...cues.map((c) => Math.abs(c.placeErrMs))),
  notes,
  gameplaySlots: Object.keys(shots).filter((id) => id.startsWith('hunt-')),
  all: cues,
};
writeFileSync(join(OUT, 'cue-report.json'), JSON.stringify(report, null, 1));
const { all: _all, ...summary } = report;
console.log(JSON.stringify(summary, null, 1));
