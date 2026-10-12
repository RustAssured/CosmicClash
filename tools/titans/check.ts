/**
 * `npm run titan:check -- <id> [--level=4] [--fights=1] [--quick]`: is this titan ready? Runs the roster checks for one
 * titan (size, palette, AI coverage, deterministic replay) and the slow balance sweep (AI vs AI against every other roster
 * titan, from both sides), then prints a report and writes it to .scratch/titan-check/<id>.md.
 *
 * `--quick` skips the sweep. Exit code 1 if anything is out of spec.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROSTER_IDS, type Difficulty, type TitanId } from '@/contracts';
import { getTitanDef } from '@/titans';
import { rosterEntry } from '@/titans/roster';
import {
  BALANCE_BAND,
  balanceSweep,
  checkAiCoverage,
  checkPalette,
  checkReplay,
  checkSize,
  type CheckResult,
} from './checks';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const id = args.find((a) => !a.startsWith('--')) as TitanId | undefined;
if (!id || !(ROSTER_IDS as readonly string[]).includes(id))
  throw new Error(`usage: npm run titan:check -- <id>   (roster: ${ROSTER_IDS.join(', ')})`);
const level = +opt('level', '4') as Difficulty;
const perSide = +opt('fights', '1');

const def = getTitanDef(id);
const entry = rosterEntry(id)!;
const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};
let failed = 0;
const show = (name: string, r: CheckResult): void => {
  say(`${r.ok ? 'PASS' : 'FAIL'}  ${name}: ${r.detail}`);
  for (const p of r.problems) say(`      - ${p}`);
  if (!r.ok) failed++;
};

say(`# ${def.name} (${def.nameKo}), id '${id}'${def.kit ? `, kit template '${def.kit.template}'` : ''}`);
say();
show('size', checkSize(id));
show('palette', checkPalette(id));
show('AI coverage', checkAiCoverage(id));
show('replay', checkReplay(id));

if (!args.includes('--quick')) {
  say();
  say(`## Balance sweep: AI level ${level}, ${perSide} fight(s) per side against every other roster titan`);
  const t0 = performance.now();
  const sweep = balanceSweep(id, level, perSide, (r) =>
    say(
      `  vs ${r.foe.padEnd(10)} ${r.side === 0 ? 'left ' : 'right'}  ${r.score === 1 ? 'WIN ' : r.score === 0 ? 'loss' : 'draw'}  rounds ${r.rounds}  ${r.seconds.toFixed(0)} s`,
    ),
  );
  const pct = (sweep.rate * 100).toFixed(0);
  const inBand = sweep.rate >= BALANCE_BAND[0] && sweep.rate <= BALANCE_BAND[1];
  if (!inBand) failed++;
  say(
    `${inBand ? 'PASS' : 'FAIL'}  win rate ${pct} % over ${sweep.rows.length} fights (band ${BALANCE_BAND[0] * 100}–${BALANCE_BAND[1] * 100} %) in ${((performance.now() - t0) / 1000).toFixed(0)} s`,
  );
  say('  moves the AI started:');
  for (const [m, n] of Object.entries(sweep.moves))
    say(`    ${m.padEnd(22)} ${n}${n === 0 ? '   <- never used' : ''}`);
}

say();
say(
  `Card: "${entry.site.name}" / ${entry.site.ko}, essence "${entry.site.essence}", ${entry.size}, home stage ${entry.stage}`,
);
say(failed ? `${failed} check(s) out of spec.` : 'All checks pass.');
mkdirSync('.scratch/titan-check', { recursive: true });
writeFileSync(`.scratch/titan-check/${id}.md`, lines.join('\n') + '\n');
console.log(`(report: .scratch/titan-check/${id}.md)`);
process.exit(failed ? 1 : 0);
