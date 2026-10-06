/**
 * 우리's kinetic system against the locked oracle, number for number: replays every recorded oracle run
 * (tools/uri/oracle.ts) through `UriKinetics` with the same target and reports, per move × side, the frame each phase starts
 * (oracle vs game, at 60 fps), the impact frame, and the largest difference of every link over the 3 s.
 *   npx tsx tools/uri/compare.ts [--in=.scratch/uri-oracle] [--json=out.json]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { UriKinetics } from '@/combat/uri/kinetics';
import { URI_REF } from '@/titans/uri/rig';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const IN = opt('in', '.scratch/uri-oracle');
const JSON_OUT = opt('json', '');

interface Rec {
  move: 'punch' | 'cross' | 'slam' | 'upper';
  side: string;
  target: [number, number];
  frames: { phase: string | null; hs: number; L: Record<string, number> }[];
}

/** Run the game's kinetic system the way the oracle harness runs the page. */
export function replay(rec: Pick<Rec, 'move' | 'target'>, n: number): Rec['frames'] {
  const k = new UriKinetics(1);
  // the oracle's screen → reference coordinates
  k.target = [
    rec.target[0] - (URI_REF.screenX - URI_REF.originX),
    rec.target[1] - (URI_REF.screenY - URI_REF.originY),
  ];
  for (let f = 0; f < 240; f++) k.step(1 / 60);
  k.begin(rec.move);
  const out: Rec['frames'] = [];
  const v = {
    move: null,
    phase: null,
    lead: null,
    rear: null,
    loop: { l: 1, r: 1, sh: 0, vt: 1, br: 1 },
    stress: 0,
    torque: 0,
    core: { x: 0, y: 0 },
    pylon: { L: { th: 0, ang: 0 }, R: { th: 0, ang: 0 } },
    moon: null,
    spread: { L: 1, R: 1 },
  } as Parameters<UriKinetics['view']>[0];
  for (let f = 0; f < n; f++) {
    k.step(1 / 60);
    k.view(v);
    const L: Record<string, number> = {};
    for (const [key, l] of Object.entries(k.L)) L[key] = l.x;
    out.push({ phase: v.phase, hs: k.hitstop, L });
  }
  return out;
}

const starts = (fr: Rec['frames']): Map<string, number> => {
  const m = new Map<string, number>();
  let prev: string | null = '§';
  fr.forEach((f, i) => {
    const p = f.phase ?? 'rest';
    if (p !== prev && !m.has(p)) m.set(p, i);
    prev = p;
  });
  return m;
};
const impactFrame = (fr: Rec['frames']): number => fr.findIndex((f) => f.hs > 0);

const rows: unknown[] = [];
for (const file of readdirSync(IN).filter((f) => f.endsWith('.json'))) {
  const rec = JSON.parse(readFileSync(`${IN}/${file}`, 'utf8')) as Rec;
  const game = replay(rec, rec.frames.length);
  const so = starts(rec.frames);
  const sg = starts(game);
  const phases = [...so.keys()].map((p) => `${p} ${so.get(p)}/${sg.get(p) ?? '-'}`);
  let worstAng = 0;
  let worstPx = 0;
  let worstKey = '';
  for (let i = 0; i < rec.frames.length; i++)
    for (const [key, x] of Object.entries(rec.frames[i]!.L)) {
      const d = Math.abs(x - game[i]!.L[key]!);
      const px = key[0] === 'h' && key !== 'ha' ? true : key.startsWith('dx');
      if (key[0] === 'c') continue;
      if (px) worstPx = Math.max(worstPx, d);
      else if (d * 57.2958 > worstAng) {
        worstAng = d * 57.2958;
        worstKey = key;
      }
    }
  const io = impactFrame(rec.frames);
  const ig = impactFrame(game);
  console.log(
    `${rec.move.padEnd(5)} ${rec.side.padEnd(5)} impact ${io}/${ig}  phases (oracle/game) ${phases.join(', ')}  max Δ angle ${worstAng.toFixed(3)}° (${worstKey}), Δ px ${worstPx.toFixed(3)}`,
  );
  rows.push({
    move: rec.move,
    side: rec.side,
    impactOracle: io,
    impactGame: ig,
    phases: Object.fromEntries([...so].map(([p, f]) => [p, [f, sg.get(p) ?? null]])),
    maxDeg: worstAng,
    maxPx: worstPx,
  });
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
