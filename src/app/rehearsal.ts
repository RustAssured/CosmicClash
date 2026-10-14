import {
  LOGICAL_H,
  LOGICAL_W,
  ROUND_INTRO_TICKS,
  parseScript,
  type MatchConfig,
  type StageId,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { createFighter } from '@/combat';
import { arenaForMatch } from '@/combat/mouth/arena';
import { createMatterWorld } from '@/matter';
import { TITAN_SKY } from '@/render';
import { createMatch, createScriptSource } from '@/sim';
import { STAGES } from '@/stages';

/**
 * S21: a dress rehearsal of each titan's big moves on a throwaway Match (presentation-side: the real match is never touched,
 * and nothing of the rehearsal is shown, heard or kept).
 *
 * Why: the first time a titan's Ultimate (or first heavy blow) runs in a page, its code is cold (the JavaScript engine has not
 * compiled it yet) and its caches are empty, so the opening ticks and the first render-time effect frames cost 20–30 ms each
 * on WJ's Ryzen 5 5500U: a 33 ms hitch at the most spectacular moment of the fight. Warm, the same ticks cost 1–5 ms.
 *
 * When: in the background on the title and menus (`rehearseRoster`, a few ms a frame, stopped the moment a match starts), and
 * for any titan still missing behind the match's loading bar (`rehearse`). Each titan is rehearsed once per page.
 *
 * Safe for determinism and netplay: the rehearsal is its own Match instance (own world, own fighters, own RNG). Matches do not
 * depend on what ran before them in the page: online peers already meet with different histories of earlier local matches,
 * and the lockstep checksums prove each match independent (src/net).
 */
const REHEARSED = new Set<TitanId>();
/**
 * The rehearsal script (both fighters): the Ultimate, then a full Crush, the Signature, a Surge and a Strike (a fight's first
 * heavy blow cost 20 ms cold against 8 ms warm in Node), and the ticks rehearsed after the round goes live.
 */
const SCRIPT = '2:ult,230:crush*50,300:sig,360:surge,390:strike';
const LIVE_TICKS = 420;

export interface RehearsalDeps {
  defOf: (id: TitanId) => TitanDef;
  /** Wait for the next frame (the loading screen / menu keeps drawing). */
  nextFrame: () => Promise<void>;
  /** Main-thread budget per frame, ms (a cold tick can exceed it once: it runs whole). */
  budgetMs?: number;
  /** Checked every tick: true stops the rehearsal at once (its titans stay un-rehearsed). */
  cancelled?: () => boolean;
  now?: () => number;
}

/** True when `config` has a titan this page has not rehearsed yet. */
export function needsRehearsal(config: Pick<MatchConfig, 'slots'>): boolean {
  return config.slots.some((s) => !REHEARSED.has(s.titan));
}

/** Rehearse the titans in `config` not rehearsed yet (both at once, facing each other). False when cancelled. */
export async function rehearse(config: MatchConfig, deps: RehearsalDeps): Promise<boolean> {
  if (!needsRehearsal(config)) return true;
  const now = deps.now ?? ((): number => performance.now());
  const budget = deps.budgetMs ?? 8;
  const titans: [TitanId, TitanId] = [config.slots[0].titan, config.slots[1].titan];
  const stage = STAGES[config.stage];
  const cfg: MatchConfig = {
    seed: 0x5eed,
    stage: config.stage,
    mode: 'versus',
    slots: [
      { titan: titans[0], controller: 'dummy' },
      { titan: titans[1], controller: 'dummy' },
    ],
    footwork: config.footwork,
    zdepth: config.zdepth,
    witness: config.witness,
    pace: config.pace,
    roundSeconds: config.roundSeconds,
  };
  const match = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef: deps.defOf,
    arena: arenaForMatch(stage.arena, titans),
    lighting: TITAN_SKY,
  });
  const script = parseScript(SCRIPT);
  match.setSources(
    createScriptSource(script, ROUND_INTRO_TICKS),
    createScriptSource(script, ROUND_INTRO_TICKS),
  );
  const total = ROUND_INTRO_TICKS + LIVE_TICKS;
  const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  let t0 = now();
  for (let i = 0; i < total; i++) {
    if (deps.cancelled?.()) return false;
    if (match.phase === 'matchend') break;
    // a full meter until the Ultimate is called (the round intro may reset it)
    if (i <= ROUND_INTRO_TICKS + 3) for (const f of match.fighters) f.debugSetMeter?.(1);
    match.step();
    // the render-time effects too (the behaviours' CPU-rasterised overlays): every other tick, framed on the pair
    if (i > ROUND_INTRO_TICKS && i % 2 === 0) {
      const a = match.fighters[0].view;
      const b = match.fighters[1].view;
      view.x0 = Math.round((a.x + b.x) / 2 - LOGICAL_W / 2);
      view.y0 = Math.round((a.y + b.y) / 2 - LOGICAL_H / 2);
      for (const f of match.fighters) f.renderLayers(view, 0);
      match.world.renderLayers(view, 0);
    }
    if (now() - t0 >= budget) {
      await deps.nextFrame();
      if (deps.cancelled?.()) return false;
      t0 = now();
    }
  }
  for (const id of titans) REHEARSED.add(id);
  return true;
}

/**
 * Rehearse every titan of `roster` in pairs, in the background (menus): stops for good when `deps.cancelled()` turns true
 * (a match is starting; it rehearses whatever is still missing behind its own loading bar).
 */
export async function rehearseRoster(
  roster: readonly TitanId[],
  stage: StageId,
  settings: Pick<MatchConfig, 'footwork' | 'zdepth' | 'witness' | 'pace' | 'roundSeconds'>,
  deps: RehearsalDeps,
): Promise<void> {
  const todo = roster.filter((id) => !REHEARSED.has(id));
  for (let i = 0; i < todo.length; i += 2) {
    const a = todo[i]!;
    const b = todo[i + 1] ?? todo[0]!;
    const cfg: MatchConfig = {
      seed: 1,
      stage,
      mode: 'versus',
      slots: [
        { titan: a, controller: 'dummy' },
        { titan: b, controller: 'dummy' },
      ],
      ...settings,
    };
    if (!(await rehearse(cfg, deps))) return;
  }
}
