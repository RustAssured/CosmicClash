import { readFileSync, writeFileSync } from 'node:fs';
import type { Moment, PressCfg, ScanResult } from '../../dev/press/press';
import { WORK, arg } from './common';

/**
 * Rank candidate shots from press/work/scan.json: every anchor (a KO, a catastrophic blow, an ultimate, a titan's
 * signature cue) scored by what happens around it, then the best per category with a spread over matchups and arenas.
 * Writes press/work/candidates.json (look at them with tools/press/preview.ts before rendering finals).
 *   npx tsx tools/press/pick.ts [--per=6]
 */
export interface Candidate {
  id: string;
  cat: string;
  cfg: PressCfg;
  anchor: number;
  score: number;
  what: string;
}

const SIGNATURE: Record<string, string> = {
  'uri:break-apart': 'uri-break',
  'planet:crust-slab': 'planet-slab',
  'planet:core-out': 'planet-core',
  'planet:moon-shatter': 'planet-moon',
  'planet:comet-sling': 'planet-comet',
  'supernova:collapse': 'supernova-collapse',
  'blackhole:disk-shed': 'blackhole-disk',
  'blackhole:consume': 'blackhole-well',
  'nexus:chain-latch': 'nexus-chain',
  'nexus:node-dark': 'nexus-node',
  'asteroid:fragment-lost': 'asteroid-fragment',
  'asteroid:rubble-pile': 'asteroid-rubble',
};
const per = Number(arg('per', '6'));
const scan = JSON.parse(readFileSync(`${WORK}/scan.json`, 'utf8')) as Record<
  string,
  ScanResult & { cfg: PressCfg }
>;

const weightOf = (m: Moment): number =>
  m.k === 'ko'
    ? 8
    : m.k === 'hit'
      ? m.d === 'catastrophic'
        ? 5
        : 1.5
      : m.k === 'ult'
        ? 3
        : m.k === 'flash'
          ? 2
          : m.k === 'cue' && SIGNATURE[`${m.titan}:${m.d}`]
            ? 3
            : m.k === 'detach'
              ? 0.3
              : 0;

const all: Candidate[] = [];
for (const [key, r] of Object.entries(scan)) {
  const ms = r.moments;
  const score = (t: number): number =>
    ms.filter((m) => m.tick >= t - 100 && m.tick <= t + 50).reduce((a, m) => a + weightOf(m), 0);
  const add = (cat: string, m: Moment, what: string): void => {
    // the round's live window only (no anchors right at the round start)
    if (m.tick < 260) return;
    all.push({ id: `${cat}@${key}@${m.tick}`, cat, cfg: r.cfg, anchor: m.tick, score: score(m.tick), what });
  };
  for (const m of ms) {
    if (m.k === 'ko') add('ko', m, `KO slot ${m.slot}`);
    else if (m.k === 'hit' && m.d === 'catastrophic')
      add(`cat-${r.cfg[m.slot === 0 ? 'a' : 'b']}`, m, `catastrophic on ${m.titan}`);
    else if (m.k === 'ult') add(`ult-${m.titan}`, m, `ultimate ${m.titan}`);
    else if (m.k === 'cue' && SIGNATURE[`${m.titan}:${m.d}`])
      add(SIGNATURE[`${m.titan}:${m.d}`]!, m, `${m.titan} ${m.d}`);
  }
}
// best per category, at most two per config, anchors 6 s apart
const byCat = new Map<string, Candidate[]>();
for (const c of all) byCat.set(c.cat, [...(byCat.get(c.cat) ?? []), c]);
const picked: Candidate[] = [];
for (const [cat, list] of [...byCat.entries()].sort()) {
  list.sort((a, b) => b.score - a.score);
  const keep: Candidate[] = [];
  for (const c of list) {
    if (keep.length >= per) break;
    const sameCfg = keep.filter((k) => JSON.stringify(k.cfg) === JSON.stringify(c.cfg));
    if (sameCfg.length >= 2 || sameCfg.some((k) => Math.abs(k.anchor - c.anchor) < 360)) continue;
    keep.push(c);
  }
  picked.push(...keep);
  console.log(
    `${cat}: ${keep.map((k) => `${k.score.toFixed(0)} ${k.id.split('@').slice(1).join('@')}`).join(' | ')}`,
  );
}
writeFileSync(`${WORK}/candidates.json`, JSON.stringify(picked, null, 1));
console.log(`${picked.length} candidates`);
