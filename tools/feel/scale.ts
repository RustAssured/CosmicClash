/**
 * Scale of motion (D28, Priority 0): does everything move like moons and planets, or like critters?
 *   npx tsx tools/feel/scale.ts [--titans=lastone,planet] [--classic] [--real] [--json=out.json] [--compare=before.json]
 *
 * For each titan and scenario (idle, stick start/stop, reversal, every move, a heavy hit taken) it records, per tick, the
 * body's continuous motion signals (root x/y with bob/sway/shudder, world lean, angle) and the behaviour's tracked secondary
 * points (tendril/arm tips, moons; relative to the root) and reports, per signal:
 *   f0   = dominant frequency (Hz) of the detrended signal,
 *   hf   = share of its energy above 2 Hz (%),
 *   hfA  = rms amplitude of the part above 2 Hz (px, or mrad for the angle),
 *   wob  = wobble: turn-backs per second / 2 (Hz), swings > 0.3 px (2 mrad),
 *   late = rms above 2.5 Hz after the first 150 ms of the command or hit (spec: above 2.5 Hz only hit shake, only early).
 * Targets and their meaning: docs/briefs/scale-spec.md. `--compare` prints before → after for each cell.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Btn, type TitanId } from '@/contracts';
import { NODES } from '@/combat/behaviours/tendrils';
import type { FighterImpl } from '@/combat/fighter';
import { makeLab, probeHit, type Lab } from '@/combat/testing/feelLab';
import { SCALE_SPEC, spectral, wobble } from './spectrum';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const flag = (k: string): boolean => args.includes(`--${k}`);
const TITANS = opt('titans', 'lastone,planet').split(',') as TitanId[];
const FOOTWORK = flag('classic') ? 'classic' : 'orbit';
const REAL = flag('real');
/** `--witness`: the Last One plays as the rebuilt Witness (MatchConfig.witness). */
const WITNESS = flag('witness');
const JSON_OUT = opt('json', '');
const COMPARE = opt('compare', '');

/* ---------------------------------------------------------------------------------------------- *
 *  scenarios
 * ---------------------------------------------------------------------------------------------- */

type Scenario = 'idle' | 'steer' | 'reverse' | 'strike' | 'crush' | 'surge' | 'signature' | 'guard' | 'hit';
const SCENARIOS: Scenario[] = [
  'idle',
  'steer',
  'reverse',
  'strike',
  'crush',
  'surge',
  'signature',
  'guard',
  'hit',
];
const TICKS = 180;

/** Tracked points: the behaviour's own list, or a duck-typed fallback for the current tendrils/moons. */
function track(f: FighterImpl, out: number[], kinds: number[]): number {
  out.length = 0;
  kinds.length = 0;
  const n = f.trackPoints(out, kinds);
  if (n > 0) return n;
  const beh = f.behaviour as unknown as {
    sys?: { n: number; x: Float32Array; y: Float32Array; count: Int8Array };
    moons?: { x: number; y: number }[];
  };
  if (beh.sys) {
    for (let i = 0; i < beh.sys.n; i++) {
      const c = beh.sys.count[i]!;
      const j = i * NODES + Math.max(0, c - 1);
      out.push(beh.sys.x[j]!, beh.sys.y[j]!);
    }
    return beh.sys.n;
  }
  if (beh.moons) {
    for (const m of beh.moons) out.push(m.x, m.y);
    return beh.moons.length;
  }
  return 0;
}

interface Signals {
  rootX: number[];
  rootY: number[];
  lean: number[];
  angle: number[];
  pts: number[][];
  /** Per point signal: 1 = a projectile in flight at any time in the window (held to the wobble limit only). */
  projectile: boolean[];
}

function record(lab: Lab, sc: Scenario): { s: Signals; hitAt: number } {
  const { a, f0, step } = lab;
  const s: Signals = { rootX: [], rootY: [], lean: [], angle: [], pts: [], projectile: [] };
  const m = { x: 0, y: 0, lean: 0, angle: 0 };
  const pts: number[] = [];
  const kinds: number[] = [];
  let hitAt = -1;
  const facing = f0.facing;
  for (let k = 0; k < TICKS; k++) {
    a.held = 0;
    a.moveX = 0;
    a.moveY = 0;
    switch (sc) {
      case 'steer':
        a.moveX = k < 60 ? facing : 0;
        break;
      case 'reverse':
        a.moveY = k < 50 ? -1 : k < 100 ? 1 : 0;
        break;
      case 'guard':
        a.held = k < 70 ? Btn.GUARD : 0;
        break;
      case 'strike':
      case 'crush':
      case 'surge':
      case 'signature':
        if (k === 0)
          a.held = { strike: Btn.STRIKE, crush: Btn.CRUSH, surge: Btn.SURGE, signature: Btn.SIGNATURE }[sc];
        break;
      default:
    }
    if (sc === 'hit' && k === 10) {
      // the SUBJECT takes a heavy edge blow from the foe
      probeHit(lab.swap!, -30, -26, 1200, 720);
      hitAt = k;
    }
    step();
    // any blow the subject lands or takes is an impact: its first 150 ms may shake (the late window starts after the last one)
    for (const e of lab.events)
      if (e.t === 'hit' && (e.attacker === f0.slot || e.target === f0.slot) && k < TICKS - 60) hitAt = k;
    lab.events.length = 0;
    f0.motionSample(m);
    s.rootX.push(m.x);
    s.rootY.push(m.y);
    s.lean.push(m.lean);
    s.angle.push(m.angle * 1000);
    const n = track(f0, pts, kinds);
    // each tracked point gives two signals: its offset from the root's sim position along x and y (the body's own travel
    // removed; measured against px/py, not the drawn root, so the root's own hit shudder is not counted as part wobble)
    for (let i = 0; i < n; i++) {
      (s.pts[2 * i] ??= []).push(pts[2 * i]! - f0.px);
      (s.pts[2 * i + 1] ??= []).push(pts[2 * i + 1]! - f0.py);
      if (kinds[i] === 1) s.projectile[2 * i] = s.projectile[2 * i + 1] = true;
    }
  }
  return { s, hitAt };
}

/* ---------------------------------------------------------------------------------------------- *
 *  per-signal metrics and the verdict (thresholds: docs/briefs/scale-spec.md)
 * ---------------------------------------------------------------------------------------------- */

interface Row {
  titan: string;
  scenario: string;
  signal: string;
  wob: number;
  f0: number;
  hf: number;
  hfA: number;
  late: number;
}

const inSpec = (r: Row): boolean => {
  const angle = r.signal === 'angle';
  return (
    r.wob <= SCALE_SPEC.wobbleHz &&
    r.late <= (angle ? SCALE_SPEC.lateRmsAngle : SCALE_SPEC.lateRms) &&
    (r.hf <= SCALE_SPEC.hfShare || r.hfA < (angle ? 1 : 0.1))
  );
};

const rows: Row[] = [];
for (const titan of TITANS) {
  const foe: TitanId = titan === 'planet' ? 'lastone' : 'planet';
  for (const sc of SCENARIOS) {
    const lab = makeLab({ a: titan, b: foe, gap: 260, real: REAL, footwork: FOOTWORK, witness: WITNESS });
    // the 'hit' scenario needs the foe to strike the subject: a lab view with the slots swapped
    lab.swap = { ...lab, f0: lab.f1, f1: lab.f0 } as Lab;
    const { s, hitAt } = record(lab, sc);
    const metrics = (signal: string, sig: number[]): Row => {
      const all = spectral(sig);
      // after the first 150 ms of the command (tick 0) or of the hit: the accept-tick response and hit shake are allowed
      const late = spectral(sig.slice(Math.max(0, hitAt) + 9), 2.5).hfA;
      const min = signal === 'angle' ? 2 : 0.3;
      return {
        titan,
        scenario: sc,
        signal,
        wob: wobble(sig, min),
        f0: all.f0,
        hf: all.hf,
        hfA: all.hfA,
        late,
      };
    };
    rows.push(
      metrics('root x', s.rootX),
      metrics('root y', s.rootY),
      metrics('lean', s.lean),
      metrics('angle', s.angle),
    );
    if (s.pts.length) {
      // secondary points: the WORST signal (most wobble, then most late high-frequency motion) and the mean
      // a projectile in flight (a slung moon) is held to the wobble limit only: a fast, curving path has high-frequency
      // energy without any turning back (proposal 133)
      const per = s.pts.map((p, i) => {
        const r = metrics('parts', p);
        if (s.projectile[i]) {
          r.late = 0;
          r.hf = 0;
        }
        return r;
      });
      const worst = per.reduce((x, y) => (y.wob > x.wob || (y.wob === x.wob && y.late > x.late) ? y : x));
      rows.push({ ...worst, signal: 'parts (worst)' });
      const mean = (k: (p: Row) => number): number => per.reduce((t, p) => t + k(p), 0) / per.length;
      rows.push({
        titan,
        scenario: sc,
        signal: 'parts (mean)',
        wob: mean((p) => p.wob),
        f0: mean((p) => p.f0),
        hf: mean((p) => p.hf),
        hfA: mean((p) => p.hfA),
        late: mean((p) => p.late),
      });
    }
  }
}

/* ---------------------------------------------------------------------------------------------- *
 *  report
 * ---------------------------------------------------------------------------------------------- */

const key = (r: Row): string => `${r.titan}|${r.scenario}|${r.signal}`;
const before = new Map<string, Row>();
if (COMPARE) for (const r of JSON.parse(readFileSync(COMPARE, 'utf8')).rows as Row[]) before.set(key(r), r);
const cell = (now: number, was: number | undefined, d: number): string =>
  was === undefined || !Number.isFinite(was) ? now.toFixed(d) : `${was.toFixed(d)}→${now.toFixed(d)}`;
console.log(
  `scale of motion, ${FOOTWORK}, ${REAL ? 'real' : 'fake'} world — wob = turn-backs/s ÷ 2 (Hz) | f0 Hz | energy > 2 Hz | rms > 2 Hz | late rms > 2.5 Hz`,
);
let lastHead = '';
for (const r of rows) {
  const head = `${r.titan} ${r.scenario}`;
  if (head !== lastHead) {
    console.log(`\n${head}`);
    lastHead = head;
  }
  const b = before.get(key(r));
  const mark = r.signal.includes('mean') ? ' ' : inSpec(r) ? ' ' : '*';
  console.log(
    `${mark} ${r.signal.padEnd(14)} wob ${cell(r.wob, b?.wob, 2).padStart(11)}  f0 ${cell(r.f0, b?.f0, 2).padStart(11)}  hf ${cell(r.hf * 100, b ? b.hf * 100 : undefined, 0).padStart(8)}%  hfA ${cell(r.hfA, b?.hfA, 2).padStart(11)}  late ${cell(r.late, b?.late, 2).padStart(11)}`,
  );
}
for (const titan of TITANS) {
  const mine = rows.filter((r) => r.titan === titan && !r.signal.includes('mean'));
  const body = mine.filter((r) => !r.signal.startsWith('parts'));
  const parts = mine.filter((r) => r.signal.startsWith('parts'));
  const was = COMPARE
    ? [...before.values()].filter((r) => r.titan === titan && !r.signal.includes('mean'))
    : [];
  const wasBody = was.filter((r) => !r.signal.startsWith('parts') && 'wob' in r).filter(inSpec).length;
  const wasParts = was.filter((r) => r.signal.startsWith('parts') && 'wob' in r).filter(inSpec).length;
  console.log(
    `\n${titan}: body signals in spec ${COMPARE ? `${wasBody}→` : ''}${body.filter(inSpec).length}/${body.length}, parts ${COMPARE ? `${wasParts}→` : ''}${parts.filter(inSpec).length}/${parts.length}  (* = outside the spec)`,
  );
}
if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ footwork: FOOTWORK, real: REAL, witness: WITNESS, rows }, null, 1),
  );
  console.log(`written ${JSON_OUT}`);
}
