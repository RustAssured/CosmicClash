/**
 * Netplay Step 1 (docs/netplay/STEP1.md §3): replay a desync report offline.
 *
 *   npx tsx tools/netplay/desync-replay.ts adeuk-desync-A.json [adeuk-desync-B.json]
 *
 * A report is what the game saves (SAVE DESYNC LOG) or logs to the console when two peers' checksums differ: the match
 * config, both slots' quantised inputs for every tick, and that peer's checksum after every tick. This tool replays the
 * inputs in Node and prints the first tick where Node's checksum differs from each report's own. With both peers' reports,
 * it also prints the first tick where the two peers' checksums differ, and whether their input logs agree.
 */
import { readFileSync } from 'node:fs';
import type { MatchConfig } from '@/contracts';
import { buildMatch, playbackSource } from './replay-core';

interface Report {
  build: string;
  role: string;
  config: MatchConfig;
  desync: { tick: number; kind: string; local: number; remote: number };
  dump: { ticks: number; inputs: [number[], number[]]; checksums: number[] };
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: npx tsx tools/netplay/desync-replay.ts <report.json> [<other-peer-report.json>]');
  process.exit(2);
}
const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Report);

for (const [i, r] of reports.entries()) {
  console.log(
    `${files[i]}: ${r.role} on ${r.build}, ${r.config.slots[0].titan} v ${r.config.slots[1].titan} on ${r.config.stage}, ` +
      `seed ${r.config.seed}; desync at tick ${r.desync.tick} (${r.desync.kind})`,
  );
  const m = buildMatch(r.config);
  m.setSources(playbackSource(r.dump.inputs[0]), playbackSource(r.dump.inputs[1]));
  let first = -1;
  for (let t = 1; t <= r.dump.checksums.length; t++) {
    m.step();
    const ck = m.checksum() >>> 0;
    if (first < 0 && ck !== r.dump.checksums[t - 1]) first = t;
  }
  console.log(
    first < 0
      ? `  Node reproduces this peer's ${r.dump.checksums.length} checksums exactly`
      : `  Node differs from this peer from tick ${first}: this peer's own sim diverged (engine maths? a tuned knob?)`,
  );
}

if (reports.length === 2) {
  const [a, b] = reports as [Report, Report];
  const n = Math.min(a.dump.checksums.length, b.dump.checksums.length);
  let ck = -1;
  for (let t = 0; t < n; t++)
    if (a.dump.checksums[t] !== b.dump.checksums[t]) {
      ck = t + 1;
      break;
    }
  console.log(
    ck < 0 ? `the peers agree on all ${n} common ticks` : `the peers' checksums first differ at tick ${ck}`,
  );
  for (const s of [0, 1] as const) {
    const x = a.dump.inputs[s];
    const y = b.dump.inputs[s];
    const k = Math.min(x.length, y.length);
    let d = -1;
    for (let j = 0; j < k; j++)
      if (x[j] !== y[j]) {
        d = Math.floor(j / 3) + 1;
        break;
      }
    console.log(
      d < 0 ? `slot ${s}: both peers fed the same inputs` : `slot ${s}: the input logs differ at tick ${d}`,
    );
  }
}
