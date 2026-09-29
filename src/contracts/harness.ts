import { STAGE_IDS, type StageId } from './render';
import { TITAN_IDS, type TitanId } from './titan';
import { Btn, type ScriptEvent } from './input';

/**
 * Deterministic debug harness via URL params, for reproducible screenshots and tests:
 *   ?stage=nursery|rim|redgiant|quasar|tussenruimte
 *   &a=lastone&b=asteroid            (titan ids for slot 0 / slot 1)
 *   &seed=1234
 *   &t=180                           (skip the intro, then advance N fight ticks, then freeze)
 *   &state=intact|50|10              (start both bodies pre-damaged to HUD integrity 50% / 10%; 0% would be KO)
 *   &mode=fight|aivai|title|controller|select|training
 *   &ai=3                            (difficulty for AI-controlled slots; 1..6)
 *   &p1=human|ai|dummy&p2=...        (controllers; default dummy for p1/p2 unless mode says otherwise)
 *   &script0=20:crush,80:sig*30      (scripted input for slot 0; see parseScript)
 *   &script1=...
 *   &q=0|1|2|auto                    (renderer quality tier; default auto)
 *   &meter=1                        (start ultimate meters full so `script0=4:ult` fires)
 *   &gap=380                         (px between the fighters at round start; 40..700)
 *   &hud=0|1  &debug=0|1  &freeze=1  &scale=2

 * Script tick 0 = the tick the fight goes live (intro is fast-forwarded silently in harness mode).
 * Also exposed at runtime as window.__ADEUK__ (`AdeukHarnessApi` below).
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
  /** Distance in px between the fighters at round start (default 380). */
  gap: number;
  /** Start both ultimate meters at this fraction (0..1); -1 = leave at 0. Lets scripts fire ultimates. */
  meter: number;
  /** Renderer quality tier: 0 | 1 | 2, or 'auto' (default). Tests force 0 in software GL. */
  q: 0 | 1 | 2 | 'auto';
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
    q: ((): 0 | 1 | 2 | 'auto' => {
      const v = q.get('q');
      return v === '0' ? 0 : v === '1' ? 1 : v === '2' ? 2 : 'auto';
    })(),
    meter: ((): number => {
      const v = parseFloat(q.get('meter') ?? '');
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : -1;
    })(),
    gap: Math.min(700, Math.max(40, parseInt(q.get('gap') ?? '380', 10) || 380)),
    hud: q.get('hud') !== '0',
    debug: q.get('debug') === '1',
    freeze: q.get('freeze') === '1' || (has('t') && q.get('freeze') !== '0'),
    active: keys.some(has),
  };
}

/** Snapshot of one fighter for logs and evidence tables. */
export interface HarnessFighterSummary {
  titan: TitanId;
  state: string;
  moveId: string | null;
  x: number;
  y: number;
  integrityPct: number;
  massFrac: number;
  resource: number;
  meter: number;
  ko: boolean;
  cells: number;
}

export interface HarnessSummary {
  tick: number;
  phase: string;
  round: number;
  wins: [number, number];
  fighters: [HarnessFighterSummary, HarnessFighterSummary];
  hash: number;
}

export interface HarnessPerf {
  /** Mean / p95 / max ms spent in Match.step() since the last reset. */
  simMsMean: number;
  simMsP95: number;
  simMsMax: number;
  /** Mean CPU ms of one full frame (camera + layers + renderer.draw + ui) and of renderer.draw alone. */
  frameMsMean: number;
  drawMsMean: number;
  /** Wall-clock frames per second over the sample window (software GL in CI is pessimistic). */
  fps: number;
  ticks: number;
  frames: number;
}

/** Exposed as `window.__ADEUK__` whenever the app runs (always safe; used by Playwright evidence/perf tools). */
export interface AdeukHarnessApi {
  readonly ready: boolean;
  readonly params: HarnessParams;
  /** Advance exactly `n` sim ticks (deterministic, no wall clock), then render one frame. */
  step(n: number): void;
  /** Render a frame at the current state (no ticks). */
  renderNow(): void;
  summary(): HarnessSummary;
  hash(): number;
  /** Replace the scripted input of a slot (see parseScript grammar); tick 0 = now. */
  setScript(slot: 0 | 1, script: string): void;
  /** Run the sim for `ticks` ticks measuring cost per tick, with rendering off. */
  benchSim(ticks: number): HarnessPerf;
  /** Run `frames` full frames (1 tick + render each) and report timings. */
  benchFrames(frames: number): HarnessPerf;
  /** Latest final 640×360 frame, packed RGBA, top row first. */
  captureLogical(): Uint32Array;
  /** Ordered list of sim events seen since the last call (for evidence/logging). */
  drainEventLog(): unknown[];
  /** Current UI screen id ('boot' | 'title' | … | 'hud' | 'pause' | 'results'). */
  uiScreen(): string;
  /** Whether a match is running, and its phase ('none' otherwise). */
  matchPhase(): string;
}

declare global {
  interface Window {
    __ADEUK__?: AdeukHarnessApi;
  }
}
