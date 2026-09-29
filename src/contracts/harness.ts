import { STAGE_IDS, type StageId } from './render';
import { TITAN_IDS, type TitanId } from './titan';
import { Btn, type ScriptEvent } from './input';

/**
 * Deterministic debug harness via URL params, for reproducible screenshots and tests:
 *   ?stage=nursery|rim|redgiant|quasar|tussenruimte
 *   &a=lastone&b=asteroid            (titan ids for slot 0 / slot 1)
 *   &seed=1234
 *   &t=180                           (advance N ticks, then freeze)
 *   &state=intact|50|10              (start both bodies pre-damaged)
 *   &mode=fight|aivai|title|controller|select|training
 *   &ai=3                            (difficulty for AI-controlled slots; 1..6)
 *   &p1=human|ai|dummy&p2=...        (controllers; default dummy for p1/p2 unless mode says otherwise)
 *   &script0=20:crush,80:sig*30      (scripted input for slot 0; see parseScript)
 *   &script1=...
 *   &hud=0|1  &debug=0|1  &freeze=1  &scale=2
 * Also exposed at runtime as window.__ADEUK__ (see src/app/harness).
 */
export interface HarnessParams {
  stage: StageId;
  a: TitanId;
  b: TitanId;
  seed: number;
  t: number;
  state: 'intact' | '50' | '10';
  mode: 'fight' | 'aivai' | 'title' | 'controller' | 'select' | 'training' | 'menu';
  ai: 1 | 2 | 3 | 4 | 5 | 6;
  p1: 'human' | 'ai' | 'dummy';
  p2: 'human' | 'ai' | 'dummy';
  script0: ScriptEvent[];
  script1: ScriptEvent[];
  hud: boolean;
  debug: boolean;
  freeze: boolean;
  /** True if ANY harness param was present (the app skips the title and boots straight in). */
  active: boolean;
}

const BTN_NAMES: Record<string, number> = {
  strike: Btn.STRIKE,
  crush: Btn.CRUSH,
  surge: Btn.SURGE,
  sig: Btn.SIGNATURE,
  signature: Btn.SIGNATURE,
  ult: Btn.ULTIMATE,
  ultimate: Btn.ULTIMATE,
  guard: Btn.GUARD,
  feint: Btn.FEINT,
};
const DIRS: Record<string, [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
  upright: [0.7071, -0.7071],
  upleft: [-0.7071, -0.7071],
  downright: [0.7071, 0.7071],
  downleft: [-0.7071, 0.7071],
  neutral: [0, 0],
};

/**
 * Script grammar: comma-separated `tick:action` or `tick:action*hold`. `action` is a button name (strike, crush, surge,
 * sig, ult, guard, feint) or a stick direction (left,right,up,down,upright,…,neutral). `*hold` = ticks held
 * (buttons: hold ticks; directions: ticks the stick stays deflected, default 1e9 = until the next direction event).
 * Example: `20:crush,90:right*30,140:sig*45`.
 */
export function parseScript(s: string | null | undefined): ScriptEvent[] {
  const out: ScriptEvent[] = [];
  if (!s) return out;
  for (const raw of s.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+):([a-z]+)(?:\*(\d+))?$/.exec(part);
    if (!m) continue;
    const tick = parseInt(m[1]!, 10);
    const name = m[2]!;
    const n = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
    if (name in BTN_NAMES) {
      out.push({ tick, buttons: BTN_NAMES[name]!, hold: n ?? 0, moveX: 0, moveY: 0, moveTicks: 0 });
    } else if (name in DIRS) {
      const d = DIRS[name]!;
      out.push({ tick, buttons: 0, hold: 0, moveX: d[0], moveY: d[1], moveTicks: n ?? 1e9 });
    }
  }
  return out.sort((x, y) => x.tick - y.tick);
}

export function parseHarnessParams(search: string): HarnessParams {
  const q = new URLSearchParams(search);
  const has = (k: string): boolean => q.has(k);
  const stageQ = q.get('stage');
  const aQ = q.get('a');
  const bQ = q.get('b');
  const stage = (STAGE_IDS as readonly string[]).includes(stageQ ?? '') ? (stageQ as StageId) : 'nursery';
  const a = (TITAN_IDS as readonly string[]).includes(aQ ?? '') ? (aQ as TitanId) : 'lastone';
  const b = (TITAN_IDS as readonly string[]).includes(bQ ?? '') ? (bQ as TitanId) : 'asteroid';
  const stateQ = q.get('state');
  const state = stateQ === '50' || stateQ === '10' ? stateQ : 'intact';
  const modeQ = q.get('mode');
  const modes = ['fight', 'aivai', 'title', 'controller', 'select', 'training', 'menu'];
  const mode = modes.includes(modeQ ?? '') ? (modeQ as HarnessParams['mode']) : 'fight';
  const aiN = Math.min(6, Math.max(1, parseInt(q.get('ai') ?? '3', 10) || 3)) as HarnessParams['ai'];
  const ctl = (v: string | null, d: 'human' | 'ai' | 'dummy'): 'human' | 'ai' | 'dummy' =>
    v === 'human' || v === 'ai' || v === 'dummy' ? v : d;
  const keys = [
    'stage',
    'a',
    'b',
    'seed',
    't',
    'state',
    'mode',
    'ai',
    'p1',
    'p2',
    'script0',
    'script1',
    'freeze',
  ];
  return {
    stage,
    a,
    b,
    seed: parseInt(q.get('seed') ?? '1', 10) || 1,
    t: Math.max(0, parseInt(q.get('t') ?? '0', 10) || 0),
    state,
    mode,
    ai: aiN,
    p1: ctl(q.get('p1'), mode === 'aivai' ? 'ai' : 'dummy'),
    p2: ctl(q.get('p2'), mode === 'aivai' ? 'ai' : 'dummy'),
    script0: parseScript(q.get('script0')),
    script1: parseScript(q.get('script1')),
    hud: q.get('hud') !== '0',
    debug: q.get('debug') === '1',
    freeze: q.get('freeze') === '1' || (has('t') && q.get('freeze') !== '0'),
    active: keys.some(has),
  };
}
