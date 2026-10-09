import { describe, expect, it, onTestFinished } from 'vitest';
import {
  Btn,
  CANCEL_WINDOW_FRACTION,
  HITSTOP_MAX_TICKS,
  HITSTOP_MIN_TICKS,
  INPUT_BUFFER_TICKS,
  MAX_FIGHTER_DX,
  MAX_FIGHTER_DY,
  type SimEvent,
} from '@/contracts';
import type { Match } from '@/sim';
import { PACE, type FighterImpl } from './fighter';
import { topSpeed } from './stats';
import { makeLab, measureCommand } from './testing/feelLab';
import { ManualSource, createFakeWorld, makeMatch, skipIntro } from './testing/harness';

/** A live fight against the fake world with hand-driven inputs. */
function duel(opts: { a?: 'lastone' | 'asteroid'; b?: 'lastone' | 'asteroid'; gap?: number } = {}): {
  m: Match;
  a: ManualSource;
  b: ManualSource;
  f0: FighterImpl;
  f1: FighterImpl;
  events: SimEvent[];
  step: (n?: number) => void;
} {
  const m = makeMatch({ ...opts, createWorld: createFakeWorld });
  const a = new ManualSource();
  const b = new ManualSource();
  m.setSources(a, b);
  skipIntro(m);
  const f0 = m.fighters[0] as FighterImpl;
  const f1 = m.fighters[1] as FighterImpl;
  if (opts.gap !== undefined) {
    f1.px = f0.px + opts.gap;
    f1.py = f0.py;
  }
  const events: SimEvent[] = [];
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      m.step();
      for (const e of m.events) events.push(e);
    }
  };
  return { m, a, b, f0, f1, events, step };
}

/** Press a button for exactly one tick. */
function tap(src: ManualSource, btn: number, step: () => void): void {
  src.held |= btn;
  step();
  src.held &= ~btn;
}

/** What the player sees of a fighter: its integer root and its integer row-shear lean. */
const drawn = (f: FighterImpl): [number, number, number] => [
  Math.round(f.px),
  Math.round(f.py),
  f.body.transform.lean,
];

describe('input → response (pixels, not state)', () => {
  it('every command changes a drawn pixel on its accept tick, and says so in its feel events', () => {
    const cases: [string, (s: ManualSource) => void, string][] = [
      ['strike', (s) => (s.held = Btn.STRIKE), 'strike'],
      ['crush', (s) => (s.held = Btn.CRUSH), 'crush'],
      ['surge', (s) => (s.held = Btn.SURGE), 'surge'],
      ['signature', (s) => (s.held = Btn.SIGNATURE), 'signature'],
      ['guard', (s) => (s.held = Btn.GUARD), 'guard'],
      ['stick forward', (s) => (s.moveX = 1), 'steer'],
      ['stick back', (s) => (s.moveX = -1), 'steer'],
      ['stick up', (s) => (s.moveY = -1), 'steer'],
    ];
    for (const [name, press, cmd] of cases) {
      const { a, f0, events, step } = duel({ gap: 300 });
      step(6);
      const before = drawn(f0);
      events.length = 0;
      press(a);
      step();
      const after = drawn(f0);
      expect(after, `${name}: a pixel moved on the accept tick`).not.toEqual(before);
      const feel = events.filter(
        (e): e is Extract<SimEvent, { t: 'feel' }> => e.t === 'feel' && e.slot === 0,
      );
      expect(feel.find((e) => e.kind === 'accept')?.cmd, name).toBe(cmd);
      const resp = feel.find((e) => e.kind === 'respond');
      expect(resp?.ticks, `${name}: respond ≤ 1 tick`).toBe(0);
      expect(['root', 'pose']).toContain(resp?.channel);
    }
  });

  it('a feint changes a pixel on its own accept tick', () => {
    const { a, f0, events, step } = duel({ gap: 300 });
    step(3);
    tap(a, Btn.CRUSH, step);
    step(4);
    const before = drawn(f0);
    events.length = 0;
    tap(a, Btn.FEINT, step);
    expect(drawn(f0)).not.toEqual(before);
    const resp = events.find((e) => e.t === 'feel' && e.kind === 'respond');
    expect(resp && resp.t === 'feel' ? resp.cmd : '').toBe('feint');
    expect(resp && resp.t === 'feel' ? resp.ticks : -1).toBe(0);
  });

  it('a stick push steps the root a whole pixel at once while the top lags behind (counter-rotation)', () => {
    const { a, f0, step } = duel({ gap: 300 });
    step(6);
    const x0 = Math.round(f0.px);
    const lean0 = f0.body.transform.lean;
    a.moveX = 1;
    step();
    expect(Math.round(f0.px)).toBeGreaterThan(x0);
    // the top leans BACK against the push first (world lean toward −x), then follows the motion
    expect(f0.body.transform.lean).toBeLessThan(lean0 + 1e-9);
    step(40);
    expect(f0.body.transform.lean).toBeGreaterThan(0);
  });

  it('settles within 0.35–1.2 s with a visible overshoot (stick, strike, guard)', () => {
    for (const cmd of ['steer-fwd', 'strike', 'guard'] as const) {
      const lab = makeLab({ gap: 300 });
      const r = measureCommand(lab, cmd, 120);
      expect(r.settle, cmd).not.toBeNull();
      expect(r.settle!, cmd).toBeGreaterThanOrEqual(21);
      expect(r.settle!, cmd).toBeLessThanOrEqual(72);
      expect(r.overshoot, `${cmd}: the lean swings past where it rests`).toBeGreaterThanOrEqual(2);
    }
  });

  it('turning round shows counter-rotation: the world lean carries over the mirror and the top lags behind the new forward', () => {
    // the foe sits above and just to the right: walking right passes under it and the fighter turns round
    const { a, b, f0, f1, step } = duel({ gap: 40 });
    f1.py = f0.py - 185;
    b.moveY = -1; // the foe holds its height (the altitude spring would bring it back down into the way)
    step(4);
    a.moveX = 1;
    let flipped = -1;
    let leanAfter = 0;
    for (let i = 0; i < 90 && flipped < 0; i++) {
      const before = f0.facing;
      step();
      if (f0.facing !== before) {
        flipped = i;
        leanAfter = f0.body.transform.lean * f0.facing;
      }
    }
    expect(flipped).toBeGreaterThan(0);
    // right after the turn the top still points the old way: backward relative to the new facing
    expect(leanAfter).toBeLessThan(0);
  });

  // D28 scale of motion: the root's velocity builds over ≥ 0.25 s after the first pixel (it used to be ~70 % at 0.2 s)
  it('builds speed like a colossus: well under 70 % of top speed at 0.2 s, ~70 % by 0.35 s, then on toward top speed', () => {
    const { a, f0, step } = duel({ gap: 420 });
    step(2);
    const top = topSpeed(f0.def, f0.stats);
    a.moveX = 1; // toward the foe (420 px away: nothing in the way)
    const v0 = Math.abs(f0.vx);
    expect(v0).toBeLessThan(2);
    step(12); // 0.2 s
    const early = Math.abs(f0.vx) / top;
    expect(early).toBeGreaterThan(0.3);
    expect(early).toBeLessThan(0.6);
    step(9); // 0.35 s
    expect(Math.abs(f0.vx) / top).toBeGreaterThan(0.64);
    step(60);
    expect(Math.abs(f0.vx) / top).toBeGreaterThan(0.97);
  });

  it('glides on release with a half-life of about 0.35 s and stays controllable (re-steer at once)', () => {
    const { a, f0, step } = duel({ gap: 420 });
    a.moveX = 1;
    step(70);
    const v = Math.abs(f0.vx);
    a.moveX = 0;
    step(21); // 0.35 s
    expect(Math.abs(f0.vx) / v).toBeGreaterThan(0.44);
    expect(Math.abs(f0.vx) / v).toBeLessThan(0.58);
    // reversing responds immediately: within 12 ticks the velocity has swung to the other side
    a.moveX = -1;
    step(12);
    expect(f0.vx).toBeLessThan(0);
  });

  it('leans into motion and overshoots a little on direction changes (inertia), as whole-pixel shear', () => {
    const { a, f0, step } = duel({ gap: 420 });
    a.moveX = 1;
    step(40);
    const lean1 = f0.body.transform.lean;
    expect(Number.isInteger(lean1)).toBe(true);
    expect(lean1).toBeGreaterThanOrEqual(3); // top leans toward +x, into the motion
    a.moveX = -1;
    let sawFlip = false;
    // a slow, heavy swing (D28): the lean comes over within about a second, not a quarter of one
    for (let i = 0; i < 60; i++) {
      step();
      if (f0.body.transform.lean < 0) sawFlip = true;
    }
    expect(sawFlip).toBe(true);
  });
});

describe('input buffer', () => {
  it('a press up to 9 ticks before the fighter is free still fires the move; earlier presses are dropped', () => {
    const early = duel({ gap: 420 });
    early.step(3);
    tap(early.a, Btn.STRIKE, early.step);
    // wait until 9 ticks before the strike's recovery ends
    const f = early.f0;
    let guard = 0;
    while (
      !(f.view.phase === 'recovery' && f.mv.recovery - f.mv.phaseTick === INPUT_BUFFER_TICKS - 1) &&
      guard++ < 200
    )
      early.step();
    const before = early.events.filter((e) => e.t === 'move').length;
    tap(early.a, Btn.STRIKE, early.step); // 8 ticks before free ⇒ buffered
    early.step(INPUT_BUFFER_TICKS + 2);
    expect(early.events.filter((e) => e.t === 'move').length).toBe(before + 1);

    const late = duel({ gap: 420 });
    late.step(3);
    tap(late.a, Btn.STRIKE, late.step);
    guard = 0;
    while (
      !(
        late.f0.view.phase === 'recovery' &&
        late.f0.mv.recovery - late.f0.mv.phaseTick === INPUT_BUFFER_TICKS + 2
      ) &&
      guard++ < 200
    )
      late.step();
    const before2 = late.events.filter((e) => e.t === 'move').length;
    tap(late.a, Btn.STRIKE, late.step); // 11 ticks before free ⇒ expired by the time it matters
    late.step(INPUT_BUFFER_TICKS + 6);
    expect(late.events.filter((e) => e.t === 'move').length).toBe(before2);
  });

  it('buffered input starts the next move on the very tick recovery ends (no dead frame)', () => {
    const { a, f0, events, step } = duel({ gap: 420 });
    step(3);
    tap(a, Btn.STRIKE, step);
    while (f0.view.phase !== 'recovery') step();
    while (f0.mv.recovery - f0.mv.phaseTick > 3) step();
    tap(a, Btn.STRIKE, step);
    const moves = (): number => events.filter((e) => e.t === 'move').length;
    const n = moves();
    let ticks = 0;
    while (moves() === n && ticks++ < 12) step();
    expect(ticks).toBeLessThanOrEqual(4);
    expect(f0.view.state).toBe('startup');
  });
});

describe('cancels: feint, guard, surge', () => {
  it('a windup can be cancelled into Surge during the first 40% of its startup, not after', () => {
    const inside = duel({ gap: 420 });
    inside.step(3);
    tap(inside.a, Btn.CRUSH, inside.step); // startup 30 ⇒ cancel window 12 ticks
    inside.step(4);
    expect(inside.f0.view.cancellable).toBe(true);
    tap(inside.a, Btn.SURGE, inside.step);
    expect(inside.f0.view.state).toBe('surge');
    expect(inside.f0.view.moveId).toBe('lastone.sidestep');

    const after = duel({ gap: 420 });
    after.step(3);
    tap(after.a, Btn.CRUSH, after.step);
    after.step(Math.ceil(30 * CANCEL_WINDOW_FRACTION) + 2);
    expect(after.f0.view.cancellable).toBe(false);
    tap(after.a, Btn.SURGE, after.step);
    expect(after.f0.view.moveId).toBe('lastone.shatter');
    expect(after.f0.view.state).not.toBe('surge');
  });

  it('holding Guard during the window cancels into Guard', () => {
    const { a, f0, step } = duel({ gap: 420 });
    step(3);
    tap(a, Btn.CRUSH, step);
    step(3);
    a.held |= Btn.GUARD;
    step();
    expect(f0.view.state).toBe('guard');
    expect(f0.view.guardUp).toBe(true);
    expect(f0.view.moveId).toBeNull();
  });

  it('FEINT cancels a windup (also while charging) into a short stumble with no hitboxes', () => {
    const { a, f0, events, step } = duel({ gap: 420 });
    step(3);
    a.held = Btn.SIGNATURE; // Gaze: startup 12 then hold to charge
    step(20);
    expect(f0.view.phase).toBe('charge');
    expect(f0.view.chargeFrac).toBeGreaterThan(0);
    a.held = Btn.SIGNATURE | Btn.FEINT;
    step();
    expect(f0.view.phase).toBe('recovery');
    a.held = 0;
    let total = 0;
    while (f0.view.moveId !== null && total++ < 40) step();
    expect(total).toBeLessThanOrEqual(12); // recoverable: ~10 ticks
    expect(events.filter((e) => e.t === 'release' && e.moveId === 'lastone.gaze')).toHaveLength(0);
  });
});

describe('hit-stun, hit-stop and the escape route', () => {
  it('hit-stop is clamped to 60–135 ms (heavy cap 8 ticks, D27) and scales with energy', () => {
    const { a, events, step } = duel({ gap: 150 });
    step(3);
    tap(a, Btn.STRIKE, step);
    step(30);
    const strike = events.find((e) => e.t === 'hitstop') as Extract<SimEvent, { t: 'hitstop' }> | undefined;
    expect(strike).toBeDefined();
    expect(strike!.ticks).toBeGreaterThanOrEqual(HITSTOP_MIN_TICKS);
    expect(strike!.ticks).toBeLessThanOrEqual(HITSTOP_MAX_TICKS);
    const crush = duel({ gap: 130 });
    crush.step(3);
    tap(crush.a, Btn.CRUSH, crush.step);
    crush.step(60);
    const hs = crush.events.find((e) => e.t === 'hitstop') as Extract<SimEvent, { t: 'hitstop' }> | undefined;
    expect(hs).toBeDefined();
    expect(hs!.ticks).toBeLessThanOrEqual(HITSTOP_MAX_TICKS);
    expect(hs!.ticks).toBeGreaterThanOrEqual(strike!.ticks);
  });

  it('hit-stun is short for heavy titans and never a stun-lock; Surge breaks out after a brief window', () => {
    // the stun mechanics at the matter's own scale: at the D34 pace the six lashes would KO the asteroid first
    const pace = PACE.damageTaken;
    PACE.damageTaken = 1;
    onTestFinished(() => void (PACE.damageTaken = pace));
    const { a, f1, step } = duel({ gap: 110 });
    step(3);
    // the asteroid (light) is battered by repeated lashes
    let longest = 0;
    let stun = 0;
    for (let i = 0; i < 6; i++) {
      tap(a, Btn.STRIKE, step);
      for (let t = 0; t < 46; t++) {
        step();
        if (f1.view.state === 'hitstun') stun++;
        else {
          longest = Math.max(longest, stun);
          stun = 0;
        }
      }
    }
    expect(longest).toBeGreaterThan(0);
    expect(longest).toBeLessThan(60);
    // escape: get stunned, then tap SURGE after the brief window
    const e2 = duel({ gap: 110 });
    e2.step(3);
    tap(e2.a, Btn.CRUSH, e2.step);
    let guard = 0;
    while (e2.f1.view.state !== 'hitstun' && guard++ < 80) e2.step();
    expect(e2.f1.view.state).toBe('hitstun');
    // too early: the escape is not open yet
    while (e2.f1.stunElapsed < 3) e2.step();
    tap(e2.b, Btn.SURGE, e2.step);
    expect(e2.f1.view.state).toBe('hitstun');
    e2.b.held = 0;
    while (e2.f1.stunElapsed < 9) e2.step();
    tap(e2.b, Btn.SURGE, e2.step);
    expect(e2.f1.view.state).toBe('surge');
    expect(e2.f1.view.intangible).toBe(true);
  });
});

describe('the arena: tether, walls and bodies', () => {
  it('never lets the fighters exceed MAX_FIGHTER_DX/DY, however long one runs away', () => {
    const { a, b, f0, f1, step } = duel();
    a.moveX = -1;
    a.moveY = -1;
    b.moveX = 1;
    b.moveY = 1;
    let maxDx = 0;
    let maxDy = 0;
    for (let i = 0; i < 600; i++) {
      step();
      maxDx = Math.max(maxDx, Math.abs(f0.view.x - f1.view.x));
      maxDy = Math.max(maxDy, Math.abs(f0.view.y - f1.view.y));
    }
    expect(maxDx).toBeLessThanOrEqual(MAX_FIGHTER_DX + 1e-6);
    expect(maxDy).toBeLessThanOrEqual(MAX_FIGHTER_DY + 1e-6);
  });

  it('keeps fighters inside the arena walls', () => {
    const { m, a, f0, step } = duel();
    a.moveX = -1;
    step(900);
    expect(f0.view.x).toBeGreaterThanOrEqual(m.arena.minX);
    expect(f0.view.x).toBeLessThanOrEqual(m.arena.maxX);
  });

  it('returns toward the rest altitude softly (a spring, not a floor)', () => {
    const { m, a, f0, step } = duel({ gap: 420 });
    a.moveY = -1;
    step(60);
    const high = f0.view.y;
    expect(high).toBeLessThan(m.arena.restY - 20);
    a.moveY = 0;
    step(300);
    expect(Math.abs(f0.view.y - m.arena.restY)).toBeLessThan(15);
  });

  it('bodies may overlap at the edges but the cores never pass through each other', () => {
    const { a, b, f0, f1, step } = duel({ gap: 300 });
    a.moveX = 1;
    b.moveX = -1;
    let minGap = 1e9;
    for (let i = 0; i < 400; i++) {
      step();
      minGap = Math.min(minGap, Math.abs(f0.view.x - f1.view.x));
    }
    const coreGap = f0.body.map.coreRadius + f1.body.map.coreRadius;
    expect(minGap).toBeGreaterThan(coreGap);
    // and they do come close enough that the silhouettes touch (edges overlap allowance)
    expect(minGap).toBeLessThan(180);
  });

  it('is intangible during the Sidestep window: the foe cannot probe it', () => {
    const { a, f0, step } = duel({ gap: 420 });
    step(2);
    tap(a, Btn.SURGE, step);
    step(3);
    expect(f0.view.intangible).toBe(true);
    const r = f0.probe({ kind: 'point', x: f0.view.x, y: f0.view.y, r: 30 });
    expect(r.cells).toBe(0);
    step(30);
    expect(f0.view.intangible).toBe(false);
    expect(f0.probe({ kind: 'point', x: f0.view.x, y: f0.view.y, r: 30 }).cells).toBeGreaterThan(0);
  });
});
