/**
 * The roster cards' MATTER stat: how many cells of simulated matter each titan's body really has, counted from the game's
 * own generators (generateTitanBody at seed 1 and default lighting; every region of the colossus; every part of 우리).
 * The counts go to site/media/titans/matter.json, which the titan cards are generated from (tools/site/roster.ts).
 *
 *   npx tsx tools/site/matter.ts              # every roster titan; then regenerates the cards in site/index.html
 *   npx tsx tools/site/matter.ts --only=<id>  # one titan (merged into matter.json)
 *
 * Re-run when a titan's art or size changes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SITE_ROSTER } from '@/titans/roster';
import { MATTER_JSON, countMatter, writeRosterInto } from './roster';

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const counts: Record<string, number> =
  only && existsSync(MATTER_JSON)
    ? (JSON.parse(readFileSync(MATTER_JSON, 'utf8')) as Record<string, number>)
    : {};
for (const r of SITE_ROSTER) {
  if (only && r.id !== only) continue;
  const n = countMatter(r.id);
  counts[r.site.file] = n;
  console.log(`${r.site.file.padEnd(10)} ${n.toLocaleString('en-US').padStart(8)} cells`);
}
writeFileSync(MATTER_JSON, JSON.stringify(counts, null, 2) + '\n');
await writeRosterInto('site/index.html');
console.log('site/index.html: titan cards regenerated');
