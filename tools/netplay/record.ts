/**
 * Netplay Step 0: record AI-vs-AI input streams for every pairing, and check that playing the inputs back (no AI) gives the
 * live run's hashes tick for tick.
 *   npx tsx tools/netplay/record.ts [--ticks=3000] [--seed=1] [--pairs=all|colossus:cradle,…] [--out=.scratch/netplay/recordings.json]
 * Pairings alternate the stage between the nursery and the shearfield (arena comets, src/sim/hazards.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TitanId } from '@/contracts';
import { allPairings, firstDiff, recordMatch, replayMatch, type Recording } from './replay-core';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ticks = +arg('ticks', '3000');
const seed = +arg('seed', '1');
const out = arg('out', '.scratch/netplay/recordings.json');
const pairsArg = arg('pairs', 'all');
const pairs =
  pairsArg === 'all' ? allPairings() : pairsArg.split(',').map((p) => p.split(':') as [TitanId, TitanId]);

const recs: Recording[] = [];
let bad = 0;
const t0 = performance.now();
pairs.forEach(([a, b], i) => {
  const stage = i % 3 === 2 ? 'shearfield' : 'nursery';
  const { rec, hashes } = recordMatch(a, b, seed + i, ticks, stage);
  const r = replayMatch(rec, () => performance.now());
  const d = firstDiff(hashes, r.hashes);
  if (d >= 0) bad++;
  console.log(
    `${a} v ${b} (${stage}): ${r.final.phase} r${r.final.round} ${r.final.wins.join('-')}  replay ${d < 0 ? '== live' : `DIFFERS at tick ${d + 1}`}  ${(r.ms / ticks).toFixed(2)} ms/tick`,
  );
  recs.push(rec);
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(recs));
console.log(
  `${recs.length} recordings × ${ticks} ticks → ${out}; ${bad ? `${bad} replays DIFFER from live` : 'every replay equals its live run'}; ${((performance.now() - t0) / 1000).toFixed(0)} s`,
);
process.exit(bad ? 1 : 0);
