/**
 * Netplay Step 0: how much did DMath change the titans' paint? Paints every titan with the current sources and with
 * another source tree (e.g. `git archive HEAD` unpacked in the scratch folder), and counts the cells whose material,
 * density or lit colour differ.
 *   npx tsx tools/netplay/paintdiff.ts --root=<other source tree>
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

// child mode: paint every titan, dump the arrays
if (arg('dump', '')) {
  const { generateTitanBody, getTitanDef } = await import('@/titans');
  const { TITAN_SKY } = await import('@/render/unified');
  const ids = [
    'colossus',
    'lastone',
    'asteroid',
    'nexus',
    'blackhole',
    'supernova',
    'planet',
    'uri',
    'cradle',
    'mouth',
  ];
  const out: Record<
    string,
    { w: number; h: number; material: number[]; density: number[]; color: number[] }
  > = {};
  for (const id of ids) {
    const def = getTitanDef(id as never);
    let g;
    try {
      g = generateTitanBody(def, 7, TITAN_SKY);
    } catch {
      continue; // the Mouth has no matter map (an analytic fighter)
    }
    out[id] = {
      w: g.map.w,
      h: g.map.h,
      material: Array.from(g.map.material),
      density: Array.from(g.map.density),
      color: Array.from(g.map.baseColor),
    };
  }
  writeFileSync(arg('dump', ''), JSON.stringify(out));
  process.exit(0);
}

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, '.scratch/netplay/paintdiff');
mkdirSync(OUT, { recursive: true });
const trees = { now: ROOT, other: resolve(arg('root', ROOT)) };
const dumps: Record<string, string> = {};
for (const [k, tree] of Object.entries(trees)) {
  const js = join(OUT, `${k}.mjs`);
  await build({
    entryPoints: [join(ROOT, 'tools/netplay/paintdiff.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outfile: js,
    tsconfig: join(tree, 'tsconfig.json'),
    external: ['esbuild'],
    logLevel: 'warning',
  });
  dumps[k] = join(OUT, `${k}.json`);
  const p = spawnSync(process.execPath, [js, `--dump=${dumps[k]}`], { cwd: tree, stdio: 'inherit' });
  if (p.status !== 0) throw new Error(`${k}: paint failed`);
}
type Dump = Record<string, { w: number; h: number; material: number[]; density: number[]; color: number[] }>;
const a = JSON.parse(readFileSync(dumps.now!, 'utf8')) as Dump;
const b = JSON.parse(readFileSync(dumps.other!, 'utf8')) as Dump;
for (const id of Object.keys(a)) {
  const x = a[id]!;
  const y = b[id];
  if (!y) continue;
  if (x.w !== y.w || x.h !== y.h) {
    console.log(`${id}: size ${x.w}×${x.h} vs ${y.w}×${y.h}`);
    continue;
  }
  let live = 0;
  let mat = 0;
  let den = 0;
  let col = 0;
  let maxD = 0;
  for (let i = 0; i < x.material.length; i++) {
    if (x.material[i] || y.material[i]) live++;
    if (x.material[i] !== y.material[i]) mat++;
    if (x.density[i] !== y.density[i]) den++;
    if (x.color[i] !== y.color[i]) {
      col++;
      const p = x.color[i]! >>> 0;
      const q = y.color[i]! >>> 0;
      for (let s = 0; s < 24; s += 8) maxD = Math.max(maxD, Math.abs(((p >>> s) & 255) - ((q >>> s) & 255)));
    }
  }
  console.log(
    `${id.padEnd(10)} ${x.w}×${x.h}, ${live} live cells: material ${mat}, density ${den}, colour ${col} differ (max channel step ${maxD})`,
  );
}
