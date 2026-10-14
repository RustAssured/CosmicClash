/**
 * Sim frame spikes in the big moments (S19): every titan's Ultimate, plus the heavy moves, against a set of foes, timing
 * every Match.step(). The perf regression check for the "hiccups during ultimates" report.
 *
 *   npx tsx tools/perf/ultspikes.ts [--only=cradle,uri] [--foes=planet,uri,cradle,blackhole,colossus] [--moves=ult]
 *       [--reps=2] [--ticks=420] [--trace=1] [--budget=8] [--json=out.json]
 *
 * Per scenario (attacker, move, foe): the round goes live, the attacker gets a full meter and the move on tick 10 (the
 * foe stands still), then `--ticks` ticks are timed. Wall-clock noise on a laptop: each scenario is replayed `--reps`
 * times and the per-tick MINIMUM is kept (a spike that is real code cost appears in every replay; a scheduler hiccup or
 * an unlucky GC does not). The report gives p95 / p99 / max of that, the first replay's raw max, and the tick of the max.
 * `--trace=1` wraps the world's and the fighters' methods and prints, for the slowest ticks, where the time went.
 * `--budget=N`: exit code 1 when any scenario's (min-of-reps) max tick exceeds N ms; `--lbudget=N` the same for the frame's
 * layer work (every fighter's and the world's `renderLayers`, where the overlays are rasterised: the CPU half of a frame).
 */
import { writeFileSync } from 'node:fs';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId } from '@/contracts';
import type { FighterImpl } from '@/combat';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { createMatterWorld } from '@/matter';
import { FX_DETAIL } from '@/combat/fx/detail';
import type { Match } from '@/sim';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const ATTACKERS: TitanId[] = [
  'colossus',
  'lastone',
  'asteroid',
  'nexus',
  'blackhole',
  'supernova',
  'planet',
  'uri',
  'cradle',
  'mouth',
] as TitanId[];
const only = opt('only', '');
const attackers = (only ? only.split(',') : ATTACKERS) as TitanId[];
const foes = opt('foes', 'planet,uri,cradle,blackhole,colossus').split(',') as TitanId[];
/** Move scripts: `ult` the Ultimate; `sig` the Signature; `crush` a full charge (the catastrophic blow); `combo` a string. */
const MOVES: Record<string, string> = {
  ult: '10:ult',
  sig: '10:sig',
  crush: '10:crush*70',
  combo: '10:strike,40:strike,70:crush*40,140:surge,170:sig,240:strike,270:crush*60',
};
const moves = opt('moves', 'ult').split(',');
const REPS = +opt('reps', '2');
const TICKS = +opt('ticks', '420');
const TRACE = opt('trace', '0') === '1';
const BUDGET = +opt('budget', '0');
const LBUDGET = +opt('lbudget', '0');
const GAP = +opt('gap', '210');
const JSON_OUT = opt('json', '');
/** `--detail=0|1|2`: the render-only effect detail (FX_DETAIL; the game sets it from the quality tier, 'auto' starts at 1). */
FX_DETAIL.level = +opt('detail', '1') as 0 | 1 | 2;

type Sections = Map<string, number>;

/** Wrap every function-valued property (own + prototype chain) of `obj` so its time adds to `sec[label.key]`. */
function instrument(obj: object, label: string, cur: { s: Sections | null }): void {
  const seen = new Set<string>();
  for (
    let p: object | null = obj;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p) as object | null
  ) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === 'constructor' || seen.has(k)) continue;
      seen.add(k);
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (!d || typeof d.value !== 'function' || d.get) continue;
      const fn = d.value as (...a: unknown[]) => unknown;
      const name = `${label}.${k}`;
      let depth = 0;
      try {
        (obj as Record<string, unknown>)[k] = function (this: unknown, ...a: unknown[]): unknown {
          if (!cur.s || depth > 0) return fn.apply(this, a);
          depth++;
          const t = performance.now();
          try {
            return fn.apply(this, a);
          } finally {
            depth--;
            cur.s.set(name, (cur.s.get(name) ?? 0) + performance.now() - t);
          }
        };
      } catch {
        /* frozen */
      }
    }
  }
}

interface Row {
  attacker: TitanId;
  move: string;
  foe: TitanId;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  maxTick: number;
  rawMax: number;
  /** The frame's CPU layer work (overlays rasterised at render time), min of reps. */
  lp95: number;
  lmax: number;
  trace?: string[];
}

function scenario(
  a: TitanId,
  foe: TitanId,
  script: string,
  trace: boolean,
): { t: Float64Array; lt: Float64Array; tr: Sections[]; ltr: Sections[] } {
  const m: Match = makeMatch({ a, b: foe, seed: 7, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const fa = m.fighters[0] as FighterImpl;
  const fb = m.fighters[1] as FighterImpl;
  fa.px = 800 - GAP / 2;
  fb.px = 800 + GAP / 2;
  fa.meter = 1;
  m.setSources(
    createScriptSource(parseScript(script), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  const cur: { s: Sections | null } = { s: null };
  const tr: Sections[] = [];
  const ltr: Sections[] = [];
  if (trace) {
    instrument(m.world, 'world', cur);
    m.fighters.forEach((f, i) => {
      instrument(f, `f${i}`, cur);
      const beh = (f as unknown as { behaviour?: object }).behaviour;
      if (beh) instrument(beh, `f${i}.beh`, cur);
    });
  }
  const t = new Float64Array(TICKS);
  const lt = new Float64Array(TICKS);
  const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };
  for (let i = 0; i < TICKS; i++) {
    if (trace) {
      cur.s = new Map();
      tr.push(cur.s);
    }
    const s = performance.now();
    m.step();
    t[i] = performance.now() - s;
    // the CPU side of a rendered frame (one per tick, as at 60 Hz): every layer the app collects, overlays drawn here
    if (trace) {
      cur.s = new Map();
      ltr.push(cur.s);
    }
    const s2 = performance.now();
    for (const f of m.fighters) f.renderLayers(view, 0);
    m.world.renderLayers(view, 0);
    lt[i] = performance.now() - s2;
    // keep the meter topped up so a move that needs it is always available (the Ultimate fires once anyway)
    if (i === 0) fa.meter = Math.max(fa.meter, 1);
  }
  cur.s = null;
  return { t, lt, tr, ltr };
}

const pct = (s: number[], q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;

// warm the JIT and the paint caches (a real match starts after its loading screen)
for (const a of attackers.slice(0, 3)) scenario(a, 'planet', '10:ult', false);

const rows: Row[] = [];
for (const a of attackers)
  for (const mv of moves)
    for (const foe of foes) {
      if (a === 'mouth' && mv === 'ult') continue; // the Mouth has no Ultimate
      const script = MOVES[mv] ?? mv;
      const runs: Float64Array[] = [];
      const lruns: Float64Array[] = [];
      let tr: Sections[] = [];
      for (let r = 0; r < REPS; r++) {
        const res = scenario(a, foe, script, false);
        runs.push(res.t);
        lruns.push(res.lt);
      }
      const lbest = new Float64Array(TICKS);
      for (let i = 0; i < TICKS; i++) lbest[i] = Math.min(...lruns.map((r) => r[i]!));
      const lsorted = Array.from(lbest).sort((x, y) => x - y);
      const best = new Float64Array(TICKS);
      for (let i = 0; i < TICKS; i++) best[i] = Math.min(...runs.map((r) => r[i]!));
      const sorted = Array.from(best).sort((x, y) => x - y);
      let maxTick = 0;
      for (let i = 1; i < TICKS; i++) if (best[i]! > best[maxTick]!) maxTick = i;
      const row: Row = {
        attacker: a,
        move: mv,
        foe,
        p50: pct(sorted, 0.5),
        p95: pct(sorted, 0.95),
        p99: pct(sorted, 0.99),
        max: sorted[sorted.length - 1]!,
        maxTick,
        rawMax: Math.max(...Array.from(runs[0]!)),
        lp95: pct(lsorted, 0.95),
        lmax: lsorted[lsorted.length - 1]!,
      };
      if (TRACE) {
        const res = scenario(a, foe, script, true);
        tr = res.tr;
        const order = Array.from(res.t.keys()).sort((x, y) => res.t[y]! - res.t[x]!);
        const span = opt('span', '');
        const picks = span
          ? Array.from(
              { length: +span.split('-')[1]! - +span.split('-')[0]! + 1 },
              (_, k) => +span.split('-')[0]! + k,
            )
          : order.slice(0, 3);
        row.trace = picks.map((i) => {
          const secs = Array.from(tr[i]!.entries())
            .sort((x, y) => y[1] - x[1])
            .slice(0, +opt('top', '6'))
            .map(([k, v]) => `${k} ${v.toFixed(1)}`)
            .join(', ');
          const lsecs = Array.from(res.ltr[i]!.entries())
            .sort((x, y) => y[1] - x[1])
            .slice(0, 5)
            .map(([k, v]) => `${k} ${v.toFixed(1)}`)
            .join(', ');
          return `t${i} ${res.t[i]!.toFixed(1)} ms: ${secs}\n      layers ${res.lt[i]!.toFixed(1)} ms: ${lsecs}`;
        });
      }
      rows.push(row);
      console.log(
        `${a.padEnd(9)} ${mv.padEnd(5)} v ${foe.padEnd(9)} p50 ${row.p50.toFixed(2).padStart(5)}  p95 ${row.p95
          .toFixed(2)
          .padStart(
            5,
          )}  p99 ${row.p99.toFixed(2).padStart(6)}  max ${row.max.toFixed(1).padStart(6)} @t${String(
          row.maxTick,
        ).padEnd(
          4,
        )} (raw max ${row.rawMax.toFixed(1)})  | layers p95 ${row.lp95.toFixed(2)} max ${row.lmax.toFixed(1)}`,
      );
      for (const l of row.trace ?? []) console.log(`    ${l}`);
    }

// per attacker + move: the worst over the foes
console.log('\nworst over the foes (ms, min of reps):');
const keys = [...new Set(rows.map((r) => `${r.attacker} ${r.move}`))];
let worst = 0;
let lworst = 0;
for (const k of keys) {
  const rs = rows.filter((r) => `${r.attacker} ${r.move}` === k);
  const mx = (f: (r: Row) => number): number => Math.max(...rs.map(f));
  worst = Math.max(
    worst,
    mx((r) => r.max),
  );
  lworst = Math.max(
    lworst,
    mx((r) => r.lmax),
  );
  console.log(
    `  ${k.padEnd(16)} p95 ${mx((r) => r.p95).toFixed(2)}  p99 ${mx((r) => r.p99).toFixed(2)}  max ${mx((r) => r.max).toFixed(1)}  | layers p95 ${mx((r) => r.lp95).toFixed(2)} max ${mx((r) => r.lmax).toFixed(1)}`,
  );
}
console.log(`worst tick overall: ${worst.toFixed(1)} ms; worst frame layer work: ${lworst.toFixed(1)} ms`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
if (BUDGET > 0 && worst > BUDGET) {
  console.log(`FAIL: a tick over the ${BUDGET} ms budget`);
  process.exitCode = 1;
}
if (LBUDGET > 0 && lworst > LBUDGET) {
  console.log(`FAIL: a frame's layer work over the ${LBUDGET} ms budget`);
  process.exitCode = 1;
}
