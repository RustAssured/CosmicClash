import {
  ROUND_INTRO_TICKS,
  parseScript,
  type Difficulty,
  type InputSource,
  type MatchConfig,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { TITAN_SKY } from '@/render/unified';
import { createAiSource, createMatch, createScriptSource, type Match } from '@/sim';
import { STAGES } from '@/stages';
import { getTitanDef } from '@/titans';
import type { ShotMatch } from './timeline';
import type { StageId } from '@/contracts';

/**
 * A shot's real fight: built exactly as the game's harness builds `?mode=aivai&a&b&stage&seed&ai` (Witness on, orbital
 * footwork, the stage's arena, the one titan sky, AI seeds seed·7 + slot, the intro fast-forwarded), so a seed found in the
 * press scans (press/work/scan.json) replays tick for tick. Scripted slots use the harness script grammar instead of the AI.
 */
export function buildShotMatch(m: ShotMatch, stage: StageId): Match {
  const level = (m.ai || 1) as Difficulty;
  const config: MatchConfig = {
    seed: m.seed,
    stage,
    mode: 'aivai',
    slots: [
      { titan: m.a, controller: m.ai ? 'ai' : 'dummy', aiLevel: level },
      { titan: m.b, controller: m.ai ? 'ai' : 'dummy', aiLevel: level },
    ],
    startState: 'intact',
    infinite: false,
    startGap: m.gap ?? 380,
    footwork: 'orbit',
    zdepth: false,
    witness: true,
  };
  // D36: the colossus is its own titan ('colossus'), so every fighter plays getTitanDef's definition
  const defOf = (id: TitanId): TitanDef => getTitanDef(id);
  const match = createMatch(config, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: STAGES[stage].arena,
    lighting: TITAN_SKY,
  });
  const scripts = [m.script0, m.script1];
  const src = (slot: 0 | 1): InputSource | null => {
    const s = scripts[slot];
    if (s) return createScriptSource(parseScript(s), ROUND_INTRO_TICKS);
    if (!m.ai) return null;
    return createAiSource(
      match,
      slot,
      createAI(level, defOf(config.slots[slot].titan), m.seed * 7 + slot, { footwork: 'orbit' }),
    );
  };
  match.setSources(src(0), src(1));
  for (let i = 0; i < ROUND_INTRO_TICKS + 1; i++) match.step();
  return match;
}
