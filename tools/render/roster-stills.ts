import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { launch, openGame } from '../lead/browser';

/**
 * D36 evidence: stills of the colossus (The Last One, 'colossus') and the returning five-eyed Witness ('lastone') in real
 * fights, rendered by the game itself (the production bundle served by `vite preview`, AI vs AI, frozen after N fight ticks
 * with `t=N`, the full post pipeline, HUD on so the names read). One 1280×720 PNG (×2) per shot.
 *   npx tsx tools/render/roster-stills.ts [--out=docs/gallery/roster] [--build=1] [--only=name,name]
 */
const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const out = opt('out', 'docs/gallery/roster');
const only = opt('only', '').split(',').filter(Boolean);

const SHOTS: { name: string; params: string }[] = [
  // the two of them, face to face, then trading blows
  {
    name: 'witness-vs-lastone-start',
    params: 'mode=aivai&a=lastone&b=colossus&stage=shearfield&seed=5&ai=4&t=20',
  },
  {
    name: 'witness-vs-lastone-fight',
    params: 'mode=aivai&a=lastone&b=colossus&stage=shearfield&seed=5&ai=4&t=900',
  },
  {
    name: 'witness-vs-lastone-late',
    params: 'mode=aivai&a=lastone&b=colossus&stage=nursery&seed=11&ai=4&t=2400',
  },
  // the Witness against the roster
  { name: 'witness-vs-planet', params: 'mode=aivai&a=lastone&b=planet&stage=nursery&seed=21&ai=4&t=1200' },
  { name: 'witness-vs-asteroid', params: 'mode=aivai&a=lastone&b=asteroid&stage=rim&seed=7&ai=4&t=1500' },
  // the Last One (the colossus) against the Planet, as before
  { name: 'lastone-vs-planet', params: 'mode=aivai&a=colossus&b=planet&stage=mausoleum&seed=21&ai=4&t=900' },
  // the titan select screen with both of them on the roster
  { name: 'select', params: 'mode=select&a=lastone&b=colossus' },
];

const VITE = 'node_modules/vite/bin/vite.js';
const base = 'http://localhost:4173';
async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
let server: ChildProcess | null = null;
if (opt('build', '0') === '1' || !existsSync('dist/index.html')) {
  console.log('building production bundle...');
  await new Promise<void>((res, rej) => {
    const b = spawn(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { stdio: 'inherit' });
    b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
  });
}
// a site build (npm run build:site) puts the game at /play/
const game = existsSync('dist/play/index.html') ? `${base}/play/` : `${base}/`;
if (!(await reachable(base))) {
  server = spawn(process.execPath, [VITE, 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await reachable(base)); i++) await new Promise((r) => setTimeout(r, 500));
}

mkdirSync(out, { recursive: true });
const browser = await launch();
try {
  for (const s of SHOTS) {
    if (only.length && !only.includes(s.name)) continue;
    const url = `${game}?${s.params}&hud=1&aftermath=0`;
    console.log(`${s.name}: ${url}`);
    const { page, errors } = await openGame(browser, url, { width: 1280, height: 720 });
    await page.evaluate(() => window.__ADEUK__!.renderNow());
    writeFileSync(`${out}/${s.name}.png`, await page.locator('#game').screenshot());
    if (errors.length) console.log(`  console: ${errors.slice(0, 5).join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}
console.log(`saved to ${out}`);
