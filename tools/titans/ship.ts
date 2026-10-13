/**
 * `npm run titan:ship -- <id>`: take a finished work-in-progress titan public, in one step (docs/TITAN_GUIDE.md §5).
 *
 *  1. runs its checks (`titan:check -- <id> --quick`: size, palette, AI coverage, replay); stops if one fails;
 *  2. deletes `"wip": true` from its JSON's `kit` block (src/titans/kit/<id>/<id>.json): it is now in the menus, the site,
 *     the press kit and the titan count;
 *  3. regenerates what is made from the roster:
 *     - its site portrait and Korean name (tools/site/art.ts --only), its MATTER count (tools/site/matter.ts --only);
 *     - its site hover clip, when it has a press shot `<id>-card` (tools/press/shots.ts) whose clip is rendered: the web
 *       loop (tools/site/media.ts titans=<file>), and `kit.site.clip` turned on;
 *     - its press card and portrait (tools/press/cards.ts --only) and the key-art lineup (tools/press/keyart.ts), when the
 *       local press/ folder exists;
 *     - the site's titan cards and count (tools/site/roster.ts);
 *  4. prints what is left to do by hand (a ladder slot, a hover clip shot, …).
 *
 *   npm run titan:ship -- <id> [--force] [--no-keyart] [--render-clip]
 *
 * `--force` ships despite a failed check; `--no-keyart` skips the (slow, GPU) key-art lineup; `--render-clip` renders the
 * card shot first when its clip does not exist yet (tools/press/clip.ts, a few minutes). Shipping an already shipped titan
 * just regenerates its outputs. Nothing is committed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ROSTER_IDS, type TitanId } from '@/contracts';
import { LADDER_ORDER } from '@/ui/ladder';
import { RUNG_LINES } from '@/ui/ladderStory';
import { cardShot } from '../press/shots';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--')) as TitanId | undefined;
const flag = (f: string): boolean => args.includes(`--${f}`);
if (!id || !(ROSTER_IDS as readonly string[]).includes(id))
  throw new Error(`usage: npm run titan:ship -- <id>   (roster: ${ROSTER_IDS.join(', ')})`);
const JSON_PATH = `src/titans/kit/${id}/${id}.json`;
if (!existsSync(JSON_PATH))
  throw new Error(
    `titan:ship: ${id} is not a kit titan (no ${JSON_PATH}); the titans before the kit are always shipped`,
  );

const step = (s: string): void => console.log(`\n== ${s}`);
/** Run a repo tool in its own process (each re-reads the roster from disk, so it sees the flipped flag). */
function run(script: string, ...a: string[]): boolean {
  console.log(`> npx tsx ${script} ${a.join(' ')}`);
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', script, ...a], {
    stdio: 'inherit',
  });
  return r.status === 0;
}
const todo: string[] = [];

// 1. the checks
step(`1. checks: titan:check -- ${id} --quick`);
if (!run('tools/titans/check.ts', id, '--quick')) {
  if (!flag('force')) {
    console.error(`\ntitan:ship: ${id} fails its checks (above); fix them or ship with --force`);
    process.exit(1);
  }
  todo.push('It failed a check and was shipped with --force: fix that check.');
}

// 2. the flag (a text edit, so the JSON keeps its formatting; UTF-8 throughout for the Korean names)
step('2. wip off');
let json = readFileSync(JSON_PATH, 'utf8');
const before = json;
json = json.replace(/,(\s*)"wip":\s*true(\s*)(?=[}\n])/, '$2').replace(/(\s*)"wip":\s*true,/, '');
if (json !== before) {
  writeFileSync(JSON_PATH, json);
  console.log(`${JSON_PATH}: "wip": true removed`);
} else console.log(`${JSON_PATH}: no wip flag (already shipped): regenerating its outputs`);
const def = JSON.parse(json) as { kit?: { wip?: boolean; site: { file: string; clip?: boolean } } };
if (!def.kit) throw new Error(`${JSON_PATH} has no kit block`);
if (def.kit.wip) throw new Error(`${JSON_PATH}: could not remove the wip flag; delete it by hand and re-run`);
const file = def.kit.site.file;

// 3. what is made from the roster
step('3a. site portrait, Korean name and matter count');
run('tools/site/art.ts', `--only=${id}`);
run('tools/site/matter.ts', `--only=${id}`);

step('3b. site hover clip');
const shot = cardShot(id);
const mov = `press/work/clips/${id}-card.mov`;
if (!shot) {
  todo.push(
    `No hover clip: add a \`${id}-card\` shot to tools/press/shots.ts (4 s, 240 ticks; see 'cradle-card'), render it with ` +
      `\`npx tsx tools/press/clip.ts --only=${id}-card\`, then re-run \`npm run titan:ship -- ${id}\`.`,
  );
  console.log(`(no '${id}-card' shot in tools/press/shots.ts: the card shows its portrait only)`);
} else {
  if (!existsSync(mov) && flag('render-clip')) run('tools/press/clip.ts', `--only=${id}-card`);
  if (!existsSync(mov))
    todo.push(
      `Its card shot '${id}-card' is not rendered here (${mov}): \`npx tsx tools/press/clip.ts --only=${id}-card\`, then ` +
        `re-run \`npm run titan:ship -- ${id}\` (or ship with --render-clip).`,
    );
  else if (run('tools/site/media.ts', `titans=${file}`)) {
    if (!def.kit.site.clip) {
      const on = readFileSync(JSON_PATH, 'utf8').replace(
        new RegExp(`("file":\\s*"${file}"[\\s\\S]*?"clip":\\s*)false`),
        '$1true',
      );
      writeFileSync(JSON_PATH, on);
      console.log(`${JSON_PATH}: kit.site.clip on`);
    }
  } else todo.push('The site clip encode failed (tools/site/media.ts needs ffmpeg on PATH).');
}

step('3c. press card and key art');
if (existsSync('press')) {
  run('tools/press/cards.ts', `--only=${id}`);
  if (flag('no-keyart')) todo.push('Key-art lineup skipped (--no-keyart): `npx tsx tools/press/keyart.ts`.');
  else if (!run('tools/press/keyart.ts'))
    todo.push('The key-art lineup failed: `npx tsx tools/press/keyart.ts`.');
  todo.push(
    'Press kit: re-pack press/adeuk-titans-presskit.zip if you hand it out, and add the titan to the Titans line of ' +
      'press/README.md.',
  );
} else
  console.log(
    '(no local press/ folder: press card and key art skipped; run tools/press/cards.ts and keyart.ts where it is)',
  );

step('3d. site titan cards');
run('tools/site/roster.ts');

// 4. what is left
const ladder = LADDER_ORDER.includes(id);
if (!ladder)
  todo.push(
    `Ladder slot (WJ decides): it can climb the tournament but is not an opponent. Add it to LADDER_ORDER and ` +
      `LADDER_STAGE in src/ui/ladder.ts (docs/TITAN_GUIDE.md §6; eight rungs, so one regular leaves or the ladder grows).`,
  );
else if (!(id in RUNG_LINES)) todo.push(`Story line for its rung: RUNG_LINES in src/ui/ladderStory.ts.`);
todo.push(
  'Look at it: `npx tsx tools/ui/select-shots.ts` (the select in every mode) and the site titan section at desktop, ' +
    'tablet and phone (`npm run build:site`, `npx tsx tools/site/verify.ts`).',
  'Note it in PROGRESS.md, then commit and push (the site deploys from main).',
);
step(`4. ${id} is shipped. Left by hand:`);
todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
