/**
 * Netplay Step 0 (docs/netplay/STEP0.md §5): the costs that decide lockstep vs rollback.
 *   npx tsx tools/netplay/costs.ts [--recs=.scratch/netplay/recordings.json] [--limit=55] [--snap=1] [--out=…json]
 *
 * Per pairing, replaying recorded inputs (no AI on the clock, as a netplay peer runs it):
 *   - Match.step() time, median / p95 / max (ms)
 *   - Match.checksum() and Match.hash() time, median (µs)
 * Snapshot (`--snap=1`, a subset of pairings): a GENERIC deep copy of the whole Match object graph (prototypes kept, typed
 * arrays copied, frozen objects shared), its size and time to take and to restore; then whether a restored copy replays
 * the same hashes as the original (i.e. whether a naive snapshot is enough for rollback, or the sim needs explicit
 * save / restore).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildMatch, matchConfig, playbackSource, type Recording } from './replay-core';
import type { Match } from '@/sim';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const recs = (
  JSON.parse(readFileSync(arg('recs', '.scratch/netplay/recordings.json'), 'utf8')) as Recording[]
).slice(0, +arg('limit', '1000'));
const SNAP = arg('snap', '1') === '1';
const out = arg('out', '.scratch/netplay/costs.json');

const pct = (a: number[], p: number): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

/* ---- generic deep copy (what a naive rollback snapshot would be) ---- */
interface CopyStats {
  objects: number;
  typedBytes: number;
  arraySlots: number;
  props: number;
  shared: number;
  fns: number;
}
function deepCopy(root: unknown, st: CopyStats): unknown {
  const seen = new Map<unknown, unknown>();
  const bufs = new Map<ArrayBufferLike, ArrayBuffer>();
  const copy = (v: unknown): unknown => {
    if (typeof v === 'function') {
      st.fns++;
      return v;
    }
    if (v === null || typeof v !== 'object') return v;
    const hit = seen.get(v);
    if (hit !== undefined) return hit;
    if (Object.isFrozen(v)) {
      st.shared++;
      return v;
    }
    st.objects++;
    if (ArrayBuffer.isView(v)) {
      const src = v.buffer;
      let b = bufs.get(src);
      if (!b) {
        b = (src as ArrayBuffer).slice(0);
        bufs.set(src, b);
        st.typedBytes += b.byteLength;
      }
      const C = v.constructor as new (b: ArrayBuffer, o: number, n: number) => ArrayBufferView;
      const n = v instanceof DataView ? v.byteLength : (v as unknown as { length: number }).length;
      const c = new C(b, v.byteOffset, n);
      seen.set(v, c);
      return c;
    }
    if (v instanceof Map) {
      const m = new Map();
      seen.set(v, m);
      for (const [k, x] of v) m.set(copy(k), copy(x));
      st.arraySlots += v.size * 2;
      return m;
    }
    if (v instanceof Set) {
      const s = new Set();
      seen.set(v, s);
      for (const x of v) s.add(copy(x));
      st.arraySlots += v.size;
      return s;
    }
    if (v instanceof WeakMap || v instanceof WeakSet) return v;
    if (Array.isArray(v)) {
      const a: unknown[] = new Array(v.length);
      seen.set(v, a);
      for (let i = 0; i < v.length; i++) a[i] = copy(v[i]);
      st.arraySlots += v.length;
      return a;
    }
    const o = Object.create(Object.getPrototypeOf(v)) as Record<PropertyKey, unknown>;
    seen.set(v, o);
    for (const k of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if ('value' in d) d.value = copy(d.value);
      Object.defineProperty(o, k, d);
      st.props++;
    }
    return o;
  };
  return copy(root);
}
/** Rough heap size of a copy: typed bytes + 8 bytes per slot / property + 32 per object header. */
const approxBytes = (s: CopyStats): number => s.typedBytes + 8 * (s.arraySlots + s.props) + 32 * s.objects;

interface PairCost {
  pair: string;
  stepMedian: number;
  stepP95: number;
  stepMax: number;
  checksumUs: number;
  hashUs: number;
  snap?: {
    tick: number;
    bytes: number;
    typedBytes: number;
    objects: number;
    takeMs: number;
    restoreMs: number;
    replaySame: boolean;
    firstDiff: number;
  };
}

const rows: PairCost[] = [];
const now = (): number => performance.now();
// warm up the JIT and the paint cache on one pairing first (a netplay match starts after its loading screen)
{
  const m = buildMatch(matchConfig(recs[0]!, 'human'));
  m.setSources(playbackSource(recs[0]!.inputs[0]), playbackSource(recs[0]!.inputs[1]));
  for (let t = 0; t < 600; t++) m.step();
}
recs.forEach((rec, idx) => {
  const m = buildMatch(matchConfig(rec, 'human'));
  m.setSources(playbackSource(rec.inputs[0]), playbackSource(rec.inputs[1]));
  const step: number[] = [];
  const cs: number[] = [];
  const hs: number[] = [];
  const snapAt = Math.floor(rec.ticks / 2);
  let snapRow: PairCost['snap'];
  for (let t = 0; t < rec.ticks; t++) {
    let a = now();
    m.step();
    step.push(now() - a);
    if (t % 4 === 0) {
      a = now();
      m.checksum();
      cs.push(now() - a);
      a = now();
      m.hash();
      hs.push(now() - a);
    }
    // snapshot mid-fight on every 5th pairing: take, restore, and check the copy replays like the original
    if (SNAP && idx % 5 === 0 && t + 1 === snapAt) {
      const st: CopyStats = { objects: 0, typedBytes: 0, arraySlots: 0, props: 0, shared: 0, fns: 0 };
      let a2 = now();
      const snap = deepCopy(m, st) as Match;
      const takeMs = now() - a2;
      const st2: CopyStats = { objects: 0, typedBytes: 0, arraySlots: 0, props: 0, shared: 0, fns: 0 };
      a2 = now();
      const restored = deepCopy(snap, st2) as Match;
      const restoreMs = now() - a2;
      // the sources are closures (outside the snapshot): give the copy fresh ones at the same input position
      restored.setSources(playbackSource(rec.inputs[0], m.tick), playbackSource(rec.inputs[1], m.tick));
      const n = 300;
      const ref = buildMatch(matchConfig(rec, 'human'));
      ref.setSources(playbackSource(rec.inputs[0]), playbackSource(rec.inputs[1]));
      for (let k = 0; k <= t; k++) ref.step();
      let firstDiff = -1;
      for (let k = 0; k < n; k++) {
        ref.step();
        restored.step();
        if (firstDiff < 0 && ref.hash() !== restored.hash()) firstDiff = k + 1;
      }
      snapRow = {
        tick: m.tick,
        bytes: approxBytes(st),
        typedBytes: st.typedBytes,
        objects: st.objects,
        takeMs,
        restoreMs,
        replaySame: firstDiff < 0,
        firstDiff,
      };
    }
  }
  const row: PairCost = {
    pair: `${rec.a} v ${rec.b}`,
    stepMedian: pct(step, 0.5),
    stepP95: pct(step, 0.95),
    stepMax: pct(step, 1),
    checksumUs: pct(cs, 0.5) * 1000,
    hashUs: pct(hs, 0.5) * 1000,
    snap: snapRow,
  };
  rows.push(row);
  console.log(
    `${row.pair.padEnd(24)} step ${row.stepMedian.toFixed(2)} / p95 ${row.stepP95.toFixed(2)} / max ${row.stepMax.toFixed(1)} ms` +
      `  checksum ${row.checksumUs.toFixed(1)} µs  hash ${row.hashUs.toFixed(0)} µs` +
      (snapRow
        ? `  | snapshot @${snapRow.tick} ≈${(snapRow.bytes / 1e6).toFixed(1)} MB (typed ${(snapRow.typedBytes / 1e6).toFixed(1)} MB, ${snapRow.objects} objects) take ${snapRow.takeMs.toFixed(1)} ms restore ${snapRow.restoreMs.toFixed(1)} ms, restored copy ${snapRow.replaySame ? 'replays identically' : `DIVERGES after ${snapRow.firstDiff} ticks`}`
        : ''),
  );
});
const all = rows.map((r) => r.stepMedian);
const p95s = rows.map((r) => r.stepP95);
console.log(
  `\n${rows.length} pairings: step median of medians ${pct(all, 0.5).toFixed(2)} ms (worst ${Math.max(...all).toFixed(2)}), ` +
    `p95 median ${pct(p95s, 0.5).toFixed(2)} ms (worst ${Math.max(...p95s).toFixed(2)}); ` +
    `checksum median ${pct(
      rows.map((r) => r.checksumUs),
      0.5,
    ).toFixed(1)} µs, hash median ${pct(
      rows.map((r) => r.hashUs),
      0.5,
    ).toFixed(0)} µs`,
);
writeFileSync(out, JSON.stringify(rows, null, 1));
