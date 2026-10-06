/**
 * 우리's chunk-tearing cost (Gate 2C): heavy blows (power 1 / 3 / 5) on the chamber and the arms, the hit itself and the next
 * world ticks (connectivity included), min of `--reps` replays; then the break-apart (every part released into its chunks).
 *   npx tsx tools/matter/uritear.ts [--reps=3]
 */
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { URI_ORDER } from '@/titans/uri/rig';
import { uriRestBodies } from './uri2a';

const REPS = +((process.argv.find((a) => a.startsWith('--reps=')) ?? '--reps=3').split('=')[1] ?? 3);

function points(world: MatterWorldEx, id: number, n: number): [number, number][] {
  const b = world.core.bodyById[id]!;
  const out: [number, number][] = [];
  const live: number[] = [];
  for (let c = 0; c < b.n; c++) if (b.map.material[c] !== 0) live.push(c);
  for (let k = 0; k < n; k++) {
    const c = live[Math.floor(((k + 0.5) / n) * live.length)]!;
    const p = { x: 0, y: 0 };
    b.cellWorld(c % b.w, Math.floor(c / b.w), p);
    out.push([p.x, p.y]);
  }
  return out;
}

function run(power: number): { hit: number[]; tick: number[]; conn: number[]; torn: number } {
  const world = createMatterWorld(3);
  const ids = uriRestBodies(world, 120, 16);
  const core = world.core;
  core.clock = () => performance.now();
  for (let t = 0; t < 5; t++) world.tick();
  const hit: number[] = [];
  const tick: number[] = [];
  const conn: number[] = [];
  let torn = 0;
  const targets = ['chamber', 'domeR', 'faL', 'fistR', 'uaR'];
  for (let round = 0; round < 4; round++)
    for (const k of targets) {
      const id = ids[URI_ORDER.indexOf(k as (typeof URI_ORDER)[number])]!;
      for (const [x, y] of points(world, id, 3)) {
        const s = performance.now();
        torn += world.hitTear(id, x + round * 3, y, power);
        hit.push(performance.now() - s);
        let worst = 0;
        let worstConn = 0;
        for (let t = 0; t < 3; t++) {
          const c0 = core.prof[4]!;
          const s2 = performance.now();
          world.tick();
          worst = Math.max(worst, performance.now() - s2);
          worstConn = Math.max(worstConn, core.prof[4]! - c0);
        }
        tick.push(worst);
        conn.push(worstConn);
      }
    }
  return { hit, tick, conn, torn };
}

const stat = (a: number[]): string => {
  const s = a.slice().sort((x, y) => x - y);
  return `median ${s[s.length >> 1]!.toFixed(3)} p90 ${s[Math.floor(s.length * 0.9)]!.toFixed(3)} max ${s[s.length - 1]!.toFixed(3)}`;
};
for (const power of [1, 3, 5]) {
  let best = run(power);
  for (let r = 1; r < REPS; r++) {
    const x = run(power);
    best = {
      hit: best.hit.map((v, i) => Math.min(v, x.hit[i]!)),
      tick: best.tick.map((v, i) => Math.min(v, x.tick[i]!)),
      conn: best.conn.map((v, i) => Math.min(v, x.conn[i]!)),
      torn: best.torn,
    };
  }
  console.log(`power ${power}: ${best.hit.length} blows, ${best.torn} chunks torn`);
  console.log(`  hit (hitTear)          ${stat(best.hit)} ms`);
  console.log(`  worst of next 3 ticks  ${stat(best.tick)} ms`);
  console.log(`  of which connectivity  ${stat(best.conn)} ms`);
}
// break-apart: every part into its chunks in one tick
{
  const world = createMatterWorld(4);
  const ids = uriRestBodies(world, 120, 16);
  // spread over 7 ticks, two parts a tick (S2's break-apart runs at 0.3× time scale: ~23 frames)
  const budgets = world.releaseBudgets(ids);
  const chamber = ids[URI_ORDER.indexOf('chamber')];
  let pieces = 0;
  let worst = 0;
  let worstTick = 0;
  const led0 = world.ledger().dissipated;
  for (let k = 0; k < ids.length; k += 2) {
    const s = performance.now();
    for (let j = k; j < Math.min(ids.length, k + 2); j++)
      pieces += world.releaseGroups(ids[j]!, 347, 171, ids[j] === chamber ? 0.35 : 0.55, budgets[j]);
    worst = Math.max(worst, performance.now() - s);
    const s2 = performance.now();
    world.tick();
    worstTick = Math.max(worstTick, performance.now() - s2);
  }
  console.log(
    `break-apart: ${pieces} pieces over 7 ticks, worst release ${worst.toFixed(1)} ms, worst world tick ${worstTick.toFixed(1)} ms; chunks alive ${world.diagnostics().chunks}; mass dusted ${(world.ledger().dissipated - led0).toFixed(1)}`,
  );
}
