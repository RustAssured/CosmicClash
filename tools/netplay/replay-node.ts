/**
 * Netplay Step 0: replay recordings in this Node process and write every tick's hash (the Node side of crossengine.ts, run
 * as a child process so it can take V8 flags; crossengine.ts runs it bundled):
 *   node --jitless replay-node.mjs --recs=recordings.json --out=x.json [--limit=6] [--pick=8,30,54] [--ticks=1000]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { digest, mathProbe, replayMatch, type Recording } from './replay-core';
import { PROBE_EXTRA } from './probe-extra';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const all = JSON.parse(readFileSync(arg('recs', '.scratch/netplay/recordings.json'), 'utf8')) as Recording[];
/** --pick=i,j,…: these recordings (indices into the file); else the first --limit. */
const picked = arg('pick', '')
  ? arg('pick', '')
      .split(',')
      .map(Number)
      .filter((i) => i < all.length)
  : all.slice(0, +arg('limit', '1000')).map((_, i) => i);
// --ticks=N: only the first N ticks of each (a slow engine, e.g. --jitless, checks a prefix)
const maxTicks = +arg('ticks', '1e9');
const results = picked.map((i, k) => {
  const rec = { ...all[i]!, ticks: Math.min(all[i]!.ticks, maxTicks) };
  const r = replayMatch(rec, () => performance.now());
  console.log(
    `${k + 1}/${picked.length} ${rec.a} v ${rec.b} ${digest(r.hashes)} ${(r.ms / rec.ticks).toFixed(2)} ms/tick`,
  );
  return {
    i,
    a: r.a,
    b: r.b,
    ticks: r.ticks,
    hashes: Array.from(r.hashes),
    checksums: r.checksums ? Array.from(r.checksums) : null,
    digest: digest(r.hashes),
    final: r.final,
    ms: r.ms,
  };
});
writeFileSync(
  arg('out', '.scratch/netplay/node.json'),
  JSON.stringify({
    ua: `node ${process.version} ${process.execArgv.join(' ')}`,
    probe: mathProbe(PROBE_EXTRA),
    results,
  }),
);
