import { Btn, type MatterWorld, type SimEvent, type TitanId } from '@/contracts';
import type { Match } from '@/sim';
import type { FighterImpl } from '../fighter';
import { makeFatShape } from '../shapes';
import { createFakeWorld, makeMatch, ManualSource, skipIntro } from './harness';
import { createMatterWorld } from '@/matter';

/**
 * A scripted feel laboratory shared by the feel tests and `tools/feel/measure.ts`: one fighter (slot 0) receives a command
 * against an idle foe, and the lab records what the PLAYER would see — the integer root and lean every tick — next to the
 * fighter's own `feel` events.
 */
export interface Lab {
  m: Match;
  a: ManualSource;
  b: ManualSource;
  f0: FighterImpl;
  f1: FighterImpl;
  events: SimEvent[];
  step(n?: number): void;
  /** Optional view of the same lab with the two fighters' roles swapped (a tool that needs the foe to strike). */
  swap?: Lab;
}

export interface LabOptions {
  a?: TitanId;
  b?: TitanId;
  /** Anchor gap (px) between the two fighters; the foe sits to the right. */
  gap?: number;
  /** Vertical offset of the foe (px, +down). */
  dy?: number;
  real?: boolean;
  seed?: number;
  footwork?: 'classic' | 'orbit';
  zdepth?: boolean;
  witness?: boolean;
}

export function makeLab(o: LabOptions = {}): Lab {
  const m = makeMatch({
    a: o.a ?? 'lastone',
    b: o.b ?? 'planet',
    seed: o.seed ?? 7,
    createWorld: o.real ? (s): MatterWorld => createMatterWorld(s) : createFakeWorld,
    footwork: o.footwork,
    zdepth: o.zdepth,
    witness: o.witness,
  });
  const a = new ManualSource();
  const b = new ManualSource();
  m.setSources(a, b);
  skipIntro(m);
  const f0 = m.fighters[0] as FighterImpl;
  const f1 = m.fighters[1] as FighterImpl;
  if (o.gap !== undefined || o.dy !== undefined) {
    f1.px = f0.px + (o.gap ?? 380);
    f1.py = f0.py + (o.dy ?? 0);
  }
  const events: SimEvent[] = [];
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      m.step();
      for (const e of m.events) events.push(e);
    }
  };
  // let the bodies come to rest where they were put
  step(12);
  events.length = 0;
  return { m, a, b, f0, f1, events, step };
}

export type FeelCommand =
  'strike' | 'crush' | 'surge' | 'signature' | 'guard' | 'feint' | 'steer-fwd' | 'steer-back' | 'steer-up';

export interface FeelRecord {
  cmd: FeelCommand;
  /** Fighter-reported (feel events, ticks since accept). */
  respond: number | null;
  channel: string | null;
  settle: number | null;
  /** Observed: ticks from the press to the first changed integer root / lean (what the player sees). */
  firstPixel: number | null;
  /** Lean overshoot (px) past the lean it finally rests at, after the command. */
  overshoot: number;
  /** Root travel along the facing (px): most backward before the blow, most forward after it, and where it came to rest. */
  back: number;
  fwd: number;
  rest: number;
  /** Ticks from the press to the first active tick (anticipation) and the move's total, 0 when not a move. */
  anticipation: number;
  total: number;
}

const BUTTON: Partial<Record<FeelCommand, number>> = {
  strike: Btn.STRIKE,
  crush: Btn.CRUSH,
  surge: Btn.SURGE,
  signature: Btn.SIGNATURE,
  guard: Btn.GUARD,
};

/** Issue `cmd` to fighter 0 and record the response over `ticks` ticks. */
export function measureCommand(lab: Lab, cmd: FeelCommand, ticks = 200): FeelRecord {
  const { a, f0, events, step } = lab;
  const t = f0.body.transform;
  const facing = f0.facing;
  const x0 = f0.px;
  let prevRx = Math.round(f0.px);
  let prevRy = Math.round(f0.py);
  let prevLean = t.lean;
  let firstPixel: number | null = null;
  let back = 0;
  let fwd = 0;
  let anticipation = 0;
  let total = 0;
  const leans: number[] = [];
  events.length = 0;
  for (let k = 0; k < ticks; k++) {
    // drive the input for this tick
    a.held = 0;
    a.moveX = 0;
    a.moveY = 0;
    if (cmd === 'guard') a.held = k < 40 ? Btn.GUARD : 0;
    else if (cmd === 'feint') a.held = k === 0 ? Btn.CRUSH : k === 5 ? Btn.FEINT : 0;
    else if (cmd === 'steer-fwd') a.moveX = facing;
    else if (cmd === 'steer-back') a.moveX = -facing;
    else if (cmd === 'steer-up') a.moveY = -1;
    else if (k === 0) a.held = BUTTON[cmd]!;
    step();
    const rx = Math.round(f0.px);
    const ry = Math.round(f0.py);
    const pressTick = cmd === 'feint' ? 5 : 0;
    if (firstPixel === null && k >= pressTick && (rx !== prevRx || ry !== prevRy || t.lean !== prevLean))
      firstPixel = k - pressTick;
    prevRx = rx;
    prevRy = ry;
    prevLean = t.lean;
    leans.push(t.lean * facing);
    const d = (f0.px - x0) * facing;
    if (f0.mv.def && f0.mv.phase === 'startup') back = Math.min(back, d);
    fwd = Math.max(fwd, d);
    if (f0.mv.def && f0.mv.phase === 'active' && anticipation === 0) anticipation = f0.mv.tick - 1;
    if (f0.mv.def && total === 0) total = f0.mv.startup + f0.mv.active + f0.mv.recovery;
  }
  const mine = events.filter((e): e is Extract<SimEvent, { t: 'feel' }> => e.t === 'feel' && e.slot === 0);
  const want = cmd.startsWith('steer')
    ? 'steer'
    : cmd === 'feint'
      ? 'feint'
      : cmd === 'guard'
        ? 'guard'
        : cmd;
  const resp = mine.find((e) => e.kind === 'respond' && e.cmd === want);
  const sett = mine.find((e) => e.kind === 'settle' && e.cmd === want);
  const final = leans[leans.length - 1] ?? 0;
  let overshoot = 0;
  for (const l of leans) overshoot = Math.max(overshoot, Math.abs(l - final));
  return {
    cmd,
    respond: resp ? resp.ticks : null,
    channel: resp?.channel ?? null,
    settle: sett ? sett.ticks : null,
    firstPixel,
    overshoot,
    back: Math.round(back),
    fwd: Math.round(fwd),
    rest: Math.round((f0.px - x0) * facing),
    anticipation,
    total,
  };
}

export interface HitProbe {
  cls: string;
  dw: number;
  dvx: number;
  dvy: number;
}

/**
 * Land a scripted blow on fighter 1 at an offset (px) from its anchor, along +x, through fighter 0's real strike path, and
 * report how the body took it (class, spin, velocity change).
 */
export function probeHit(lab: Lab, offX: number, offY: number, energy = 900, kbx = 700, kby = 0): HitProbe {
  const { f0, f1, step } = lab;
  step();
  const sh = makeFatShape();
  sh.kind = 'point';
  sh.x = f1.view.x + offX;
  sh.y = f1.view.y + offY;
  sh.r = 9;
  const vx0 = f1.vx;
  const vy0 = f1.vy;
  // knockback is facing-relative: (kbx, kby) pushes away from the attacker
  f0.strike(
    sh,
    { type: 'KINETIC', energy, duration: 1, flags: 0, params: {} },
    kbx,
    kby,
    0.5,
    10,
    'crush',
    'probe',
  );
  return { cls: f1.lastHitClass, dw: f1.lastDeltaW, dvx: f1.vx - vx0, dvy: f1.vy - vy0 };
}
