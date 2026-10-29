import { mkdirSync, writeFileSync } from 'node:fs';
import {
  ROUND_INTRO_TICKS,
  ROUND_LENGTH_PACE,
  ROUND_LENGTH_SECONDS,
  type Difficulty,
  type MatchConfig,
  type SimEvent,
  type StageId,
  type TitanId,
} from '../../../src/contracts';
import { createAI } from '../../../src/ai';
import { createFighter } from '../../../src/combat';
import { createMatterWorld } from '../../../src/matter';
import { TITAN_SKY } from '../../../src/render';
import { createAiSource, createMatch, type Match } from '../../../src/sim';
import { STAGES } from '../../../src/stages';
import { arenaForMatch } from '../../../src/combat/mouth/arena';
import { getTitanDef } from '../../../src/titans';

/**
 * "WHAT'S LEFT" (the 60 s trailer), step 1: find the moments. The press worker's match (dev/press/press.ts `buildMatch`,
 * itself `App.buildSession` for `?mode=aivai`) rebuilt in Node, run long, logging every notable event and both fighters'
 * matter (cells) so the edit can pick takes and the counter can show true numbers.
 *   npx tsx tools/press/sixty/scan.ts <a> <b> <stage> <seed> [ticks] → press/sixty/scan/<a>-<b>-<stage>-<seed>.json
 */
export interface SixtyCfg {
  a: TitanId;
  b: TitanId;
  stage: StageId;
  seed: number;
}

export function buildMatch(c: SixtyCfg, ai = 4): Match {
  const config: MatchConfig = {
    seed: c.seed,
    stage: c.stage,
    mode: 'aivai',
    slots: [
      { titan: c.a, controller: 'ai', aiLevel: ai as Difficulty },
      { titan: c.b, controller: 'ai', aiLevel: ai as Difficulty },
    ],
    startState: 'intact',
    infinite: false,
    startGap: 380,
    footwork: 'orbit',
    zdepth: false,
    witness: true,
    // the game fixes the Options' ROUND LENGTH into the config (App.buildSession; the default is 'normal')
    pace: ROUND_LENGTH_PACE.normal,
    roundSeconds: ROUND_LENGTH_SECONDS.normal,
  };
  const m = createMatch(config, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: arenaForMatch(STAGES[c.stage].arena, [c.a, c.b]),
    lighting: TITAN_SKY,
  });
  const src = (slot: 0 | 1) =>
    createAiSource(
      m,
      slot,
      createAI(ai as Difficulty, getTitanDef(config.slots[slot].titan), c.seed * 7 + slot, { footwork: 'orbit' }),
    );
  m.setSources(src(0), src(1));
  for (let i = 0; i < ROUND_INTRO_TICKS + 1; i++) m.step();
  return m;
}

/** One line per notable event: [tick, kind, detail, slot, value]. */
type Row = [number, string, string, number, number];

function rows(ev: readonly SimEvent[], tick: number, out: Row[]): void {
  for (const e of ev) {
    if (e.t === 'hit') {
      const w = e.weight ?? (e.heavy ? 'heavy' : 'medium');
      if (w === 'heavy' || w === 'catastrophic') out.push([tick, 'hit', w, e.attacker, Math.round(e.energy)]);
    } else if (e.t === 'ko') out.push([tick, 'ko', '', e.slot, 1]);
    else if (e.t === 'cue') out.push([tick, 'cue', e.id, e.slot, +(e.amount ?? 0).toFixed(2)]);
    else if (e.t === 'ultimate') out.push([tick, 'ult', e.phase, e.slot, 1]);
    else if (e.t === 'move') out.push([tick, 'move', `${e.moveSlot}:${e.moveId}`, e.slot, 0]);
    else if (e.t === 'round') out.push([tick, 'round', `${e.phase}:${e.round}:${e.winner}`, -1, 0]);
    else if (e.t === 'matter' && e.kind === 'detach' && e.mass >= 40) out.push([tick, 'detach', '', e.slot, e.mass]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b, stage, seed, ticks] = process.argv.slice(2);
  const c: SixtyCfg = { a: a as TitanId, b: b as TitanId, stage: stage as StageId, seed: Number(seed) };
  const m = buildMatch(c);
  const ev: Row[] = [];
  /** [tick, cells0, cells1, massFrac0, massFrac1, x0, y0, x1, y1] every 6 ticks */
  const body: number[][] = [];
  const t0 = m.tick;
  for (let i = 0; i < Number(ticks ?? 12000) && m.phase !== 'matchend'; i++) {
    m.step();
    rows(m.events, m.tick, ev);
    if (m.tick % 6 === 0) {
      const v = m.fighters.map((f) => f.view);
      body.push([
        m.tick,
        ...v.map((x) => (x.bodyStats as { cells: number }).cells),
        ...v.map((x) => +x.bodyStats.massFrac.toFixed(3)),
        ...v.flatMap((x) => [Math.round(x.x), Math.round(x.y)]),
      ]);
    }
  }
  mkdirSync('press/sixty/scan', { recursive: true });
  const key = `${a}-${b}-${stage}-${seed}`;
  writeFileSync(`press/sixty/scan/${key}.json`, JSON.stringify({ cfg: c, t0, end: m.tick, hash: m.hash(), ev, body }));
  const n = (k: string, d?: string) => ev.filter((r) => r[1] === k && (!d || r[2] === d)).length;
  console.log(`${key}: ${t0}–${m.tick}, cat ${n('hit', 'catastrophic')}, heavy ${n('hit', 'heavy')}, ko ${n('ko')}, cues ${n('cue')}, ult ${n('ult', 'start')}`);
}
