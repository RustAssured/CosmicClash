/**
 * Every titan's Ultimate against the same standing foes (real fighters, real matter world, full meter, scripted: the foe does
 * nothing): how much of each foe's integrity it takes. The yardstick for a new titan's Ultimate.
 *
 *   npx tsx tools/titans/ult-compare.ts [--foes=planet,asteroid,lastone,nexus] [--gap=210] [--ticks=420] [--only=cradle]
 */
import { parseScript, type TitanId } from '@/contracts';
import type { FighterImpl } from '@/combat';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { createMatterWorld } from '@/matter';
import { ROSTER } from '@/titans/roster';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const foes = opt('foes', 'planet,asteroid,lastone,nexus').split(',') as TitanId[];
const only = opt('only', '');
const attackers = (only ? only.split(',') : ROSTER.map((r) => r.id)) as TitanId[];
const gap = +opt('gap', '210');
const ticks = +opt('ticks', '420');
const rows: string[] = [];
for (const a of attackers) {
  const cells: number[] = [];
  for (const b of foes) {
    if (a === b) {
      cells.push(NaN);
      continue;
    }
    const m = makeMatch({ a, b, seed: 7, createWorld: (s) => createMatterWorld(s) });
    skipIntro(m);
    const fa = m.fighters[0] as FighterImpl;
    const fb = m.fighters[1] as FighterImpl;
    fa.px = 800 - gap / 2;
    fb.px = 800 + gap / 2;
    fa.meter = 1;
    m.setSources(
      createScriptSource(parseScript('10:ult'), m.tick + 1),
      createScriptSource(parseScript(''), m.tick + 1),
    );
    for (let t = 0; t < ticks; t++) m.step();
    cells.push(100 - fb.view.integrityPct);
  }
  const fin = cells.filter(Number.isFinite);
  const mean = fin.reduce((s, x) => s + x, 0) / Math.max(1, fin.length);
  rows.push(
    `${a.padEnd(10)} ${cells.map((c) => (Number.isFinite(c) ? c.toFixed(0).padStart(5) : '    -')).join(' ')}   mean ${mean.toFixed(0)} %`,
  );
}
console.log(`attacker   ${foes.map((f) => f.slice(0, 5).padStart(5)).join(' ')}   (integrity taken, %)`);
for (const r of rows) console.log(r);
