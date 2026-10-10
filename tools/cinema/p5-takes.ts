import { mkdirSync, writeFileSync } from 'node:fs';
import type { StageId, TitanId } from '../../src/contracts';
import type { Moment, PressCfg, ScanResult } from '../../dev/press/press';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { openWorker } from '../press/common';
import type { Candidate } from '../press/pick';

/**
 * P5 (TRAILER_V3 §3): gameplay takes for Act III. 우리 (slot 0) runs a SCRIPTED input track (the harness grammar: real
 * moves through the normal move system, real damage) against each opponent's AI (level 4), over several seeds and three
 * script tracks; the press worker (dev/press/press.ts, the game's harness match rebuilt headless) scans each fight's events,
 * and the best windows are ranked: 우리's landed heavy / catastrophic blows, KOs, the opponent's signature cues, 우리's
 * break-apart. → press/cinema/p5/takes.json (scan) and candidates.json (≈ 30, for tools/press/preview.ts).
 *   npx tsx tools/cinema/p5-takes.ts [--seeds=1,2,3,4] && npx tsx tools/press/preview.ts --file=press/cinema/p5/candidates.json
 */
const OUT = 'press/cinema/p5';
mkdirSync(OUT, { recursive: true });
const seeds = (process.argv.find((a) => a.startsWith('--seeds='))?.slice(8) ?? '1,2,3,4')
  .split(',')
  .map(Number);

/** The opponents, each on its own arena (the hunt crosses the galaxies). */
const FOES: [TitanId, StageId][] = [
  ['planet', 'nursery'],
  ['blackhole', 'tussenruimte'],
  ['supernova', 'redgiant'],
  ['nexus', 'shearfield'],
  ['asteroid', 'rim'],
  ['lastone', 'mausoleum'],
];

/**
 * 우리's script tracks (harness grammar, 60 ticks/s). It has no Surge and no Guard (D31-2): it closes in on the stick and
 * throws its real moves.
 *  - hunt: walk in, crush, crush, signature, repeat (heavy, relentless);
 *  - feint: in, strike, out, in, signature; ultimate when the meter allows;
 *  - brawl: in, strike-strike-crush chains, a signature every third beat.
 */
function track(kind: 'hunt' | 'feint' | 'brawl', ticks = 2400): string {
  const ev: string[] = [];
  let t = 10;
  let k = 0;
  while (t < ticks) {
    if (kind === 'hunt') {
      ev.push(`${t}:right*40`, `${t + 30}:crush*20`, `${t + 80}:crush*20`, `${t + 140}:sig*30`);
      t += 210;
    } else if (kind === 'feint') {
      ev.push(
        `${t}:right*30`,
        `${t + 25}:strike*6`,
        `${t + 45}:left*20`,
        `${t + 75}:right*35`,
        `${t + 105}:sig*30`,
      );
      if (k % 3 === 2) ev.push(`${t + 160}:ult*10`);
      t += 200;
    } else {
      ev.push(`${t}:right*25`, `${t + 20}:strike*6`, `${t + 45}:strike*6`, `${t + 70}:crush*24`);
      if (k % 3 === 2) ev.push(`${t + 120}:sig*30`);
      t += 170;
    }
    k++;
  }
  return ev.join(',');
}
const TRACKS = (['hunt', 'feint', 'brawl'] as const).map((k) => ({ kind: k, script: track(k) }));

const weightOf = (m: Moment): number =>
  m.k === 'ko'
    ? 8
    : m.k === 'hit'
      ? (m.d === 'catastrophic' ? 5 : 1.5) * (m.slot === 0 ? 1.4 : 1)
      : m.k === 'ult'
        ? 3
        : m.k === 'cue' && m.d === 'break-apart'
          ? 6
          : m.k === 'flash'
            ? 2
            : m.k === 'cue'
              ? 0.4
              : 0;

const { server, url } = await startRenderServer();
const browser = await launch();
const scans: Record<string, ScanResult & { cfg: PressCfg; track: string }> = {};
const all: Candidate[] = [];
try {
  const worker = await openWorker(browser, url);
  for (const [foe, stage] of FOES)
    for (const tr of TRACKS)
      for (const seed of seeds) {
        const cfg: PressCfg = { a: 'uri', b: foe, stage, seed, ai: 4, script0: tr.script };
        const key = `uri-${foe}-${stage}-${seed}-${tr.kind}`;
        const r = (await worker.evaluate(([c, n]) => window.__press!.scan(c, n), [
          cfg,
          2400,
        ] as const)) as ScanResult;
        scans[key] = { ...r, cfg, track: tr.kind };
        const ms = r.moments;
        const score = (t: number): number =>
          ms.filter((m) => m.tick >= t - 90 && m.tick <= t + 40).reduce((a, m) => a + weightOf(m), 0);
        for (const m of ms) {
          if (m.tick < 200) continue;
          const anchor =
            (m.k === 'hit' && m.slot === 0 && (m.d === 'heavy' || m.d === 'catastrophic')) ||
            m.k === 'ko' ||
            (m.k === 'cue' && m.d === 'break-apart') ||
            m.k === 'ult';
          if (!anchor) continue;
          all.push({
            id: `${foe}@${key}@${m.tick}`,
            cat: foe,
            cfg,
            anchor: m.tick,
            score: score(m.tick),
            what: `${m.k} ${m.d} ${key}`,
          });
        }
        const land = ms.filter((m) => m.k === 'hit' && m.slot === 0 && m.d !== 'medium').length;
        console.log(
          `${key}: end ${r.endTick}, 우리 heavy+ ${land}, ko ${ms.filter((m) => m.k === 'ko').length}`,
        );
      }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(`${OUT}/takes.json`, JSON.stringify(scans));
// the best five per opponent: different fights (or 6 s apart), the highest score first
const picked: Candidate[] = [];
for (const [foe] of FOES) {
  const list = all.filter((c) => c.cat === foe).sort((a, b) => b.score - a.score);
  const keep: Candidate[] = [];
  for (const c of list) {
    if (keep.length >= 5) break;
    if (keep.some((k) => k.id.split('@')[1] === c.id.split('@')[1] && Math.abs(k.anchor - c.anchor) < 360))
      continue;
    keep.push(c);
  }
  picked.push(...keep);
  console.log(
    `${foe}: ${keep.map((k) => `${k.score.toFixed(0)} ${k.id.split('@').slice(1).join('@')}`).join(' | ')}`,
  );
}
writeFileSync(`${OUT}/candidates.json`, JSON.stringify(picked, null, 1));
console.log(`${picked.length} candidates → ${OUT}/candidates.json`);
