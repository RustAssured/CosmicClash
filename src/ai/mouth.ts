import {
  Btn,
  REACTION_MS,
  Rng,
  type AIContext,
  type AIController,
  type Difficulty,
  type FighterState,
  type InputFrame,
  type TitanDef,
} from '@/contracts';
import { DMath } from '@/contracts/dmath';

/**
 * The Mouth's AI (D37): a crane at the edge. It observes only public state (its own view's `mouth` frame and the foe's
 * view) through the level's reaction delay, slides its anchor along the perimeter to bring the foe into its arc and reach,
 * and strikes along a drawn path — Bite most, Sweep at an angle, Coil & crush when the foe is close and slow. Height: high
 * for a far foe (longest reach), low for a near one (fastest).
 *
 * The upper levels (S11: "make the Mouth a genuine threat") add a hunter's habits, each a probability by level:
 * - **Spacing:** rather than sitting right under the foe (where its head idles within the foe's reach), the anchor holds a
 *   diagonal at about two thirds of the reach, so the foe has to come to the head — and whiff.
 * - **Punish:** a foe committed to a move (startup / active / recovery long enough for the bite to arrive), stunned or guard-
 *   broken is struck at once, outside the breathing gap; low (the fastest) when near.
 * - **Grab:** a guarding or committed foe within the coil's reach is coiled (the crush goes through Guard; the escapes stay).
 * - **Patience:** in neutral it prefers a foe that is not running across its line (a locked bite misses a fast foe).
 *
 * Inputs are the player's: stick X slides (right = clockwise along the perimeter, the oracle-literal mapping), stick Y held at
 * the press picks the height, Strike / Crush / Signature are Bite / Sweep / Coil. `engageGap` (ticks between strikes) is the
 * debug overlay's knob, as for the UtilityAI.
 */

interface MouthObs {
  s: number;
  per: number;
  exitX: number;
  exitY: number;
  nx: number;
  ny: number;
  beat: string;
  move: string | null;
  reach: number;
}

const GAP: Record<Difficulty, number> = { 1: 170, 2: 130, 3: 95, 4: 70, 5: 50, 6: 30 };
/** Per level: how often it spaces, punishes a committed foe, and grabs a guarding / committed one (S11). */
const SPACING: Record<Difficulty, number> = { 1: 0, 2: 0, 3: 0, 4: 0.4, 5: 0.75, 6: 1 };
const PUNISH: Record<Difficulty, number> = { 1: 0, 2: 0, 3: 0.15, 4: 0.45, 5: 0.75, 6: 0.95 };
const GRAB: Record<Difficulty, number> = { 1: 0, 2: 0, 3: 0.1, 4: 0.3, 5: 0.5, 6: 0.65 };
const DELAY_CAP = 40;
/** Ticks from the press to the bite's beat, by height (load .42 s + strike .18 s ÷ 1.18 ÷ the height factor). */
const BITE_TICKS = { high: 36, straight: 35, low: 33 };
/** Foe states that keep it in place (it cannot step out of a locked bite). */
const COMMITTED: ReadonlySet<FighterState> = new Set([
  'startup',
  'charge',
  'active',
  'recovery',
  'hitstun',
  'guardbreak',
]);
const STATE_CODE: readonly FighterState[] = [
  'intro',
  'idle',
  'move',
  'startup',
  'charge',
  'active',
  'recovery',
  'hitstun',
  'guard',
  'guardbreak',
  'surge',
  'ko',
  'victory',
];

export class MouthAI implements AIController {
  readonly level: Difficulty;
  readonly log: string[] = [];
  engageGap: number;
  currentPlan = 'watch';
  restTicks = 0;
  private rng: Rng;
  private readonly delay: number;
  /** Delayed foe observations: x, y, vx, vy, state code, ticks left in its move, guard up (ring buffer). */
  private readonly hist = new Float64Array(DELAY_CAP * 7);
  private n = 0;
  private press = 0;
  private height = 0;
  private lastStrike = -1e9;
  /** Which side of the foe the spacing anchor holds (+1 / −1 along x), kept until the foe crosses it. */
  private side = 1;
  /** Holding the spacing diagonal (rolled after each strike, by level). */
  private spacing: boolean;

  constructor(level: Difficulty, _def: TitanDef, seed: number) {
    this.level = level;
    this.rng = new Rng(seed >>> 0 || 1);
    this.delay = Math.min(DELAY_CAP - 1, Math.round((REACTION_MS[level] / 1000) * 60));
    this.engageGap = GAP[level];
    this.spacing = SPACING[level] >= 1;
  }

  reset(seed: number): void {
    this.rng = new Rng(seed >>> 0 || 1);
    this.n = 0;
    this.press = 0;
    this.lastStrike = -1e9;
    this.side = 1;
    this.spacing = SPACING[this.level] >= 1;
  }

  private note(msg: string, tick: number): void {
    this.log.push(`${tick} ${msg}`);
    if (this.log.length > 60) this.log.shift();
  }

  decide(ctx: AIContext, out: InputFrame): void {
    const self = ctx.self as typeof ctx.self & { mouth?: MouthObs };
    const m = self.mouth;
    const foe = ctx.foe;
    // the foe as it was `delay` ticks ago
    const H = this.hist;
    const i = (this.n % DELAY_CAP) * 7;
    H[i] = foe.x;
    H[i + 1] = foe.y;
    H[i + 2] = foe.vx;
    H[i + 3] = foe.vy;
    H[i + 4] = Math.max(0, STATE_CODE.indexOf(foe.state));
    H[i + 5] = foe.moveId ? Math.max(0, foe.moveTotal - foe.moveTick) : foe.hitstunTicks;
    H[i + 6] = foe.guardUp ? 1 : 0;
    this.n++;
    const k = (((Math.max(0, this.n - 1 - this.delay) % DELAY_CAP) + DELAY_CAP) % DELAY_CAP) * 7;
    const fx = H[k]!;
    const fy = H[k + 1]!;
    const fvx = H[k + 2]!;
    const fvy = H[k + 3]!;
    const fState = STATE_CODE[H[k + 4]!]!;
    // what is left of its move (or stun) NOW: it has run on for `delay` ticks since we saw it
    const fLeft = H[k + 5]! - this.delay;
    const fGuard = H[k + 6]! > 0;
    out.moveX = 0;
    out.moveY = 0;
    out.held = 0;
    if (!m || self.ko || foe.ko || ctx.roundTick <= 0) {
      this.currentPlan = 'wait';
      return;
    }
    // a strike being pressed: hold the button one tick (the source derives the edge), the height held with it
    if (this.press) {
      out.held = this.press;
      out.moveY = this.height;
      this.press = 0;
      return;
    }
    const lv = this.level;
    const per = m.per;
    const reach = m.reach;
    const W = ctx.arena.maxX - ctx.arena.minX;
    const H_ = ctx.arena.maxY - ctx.arena.minY;
    // where to be: the perimeter point under (or over) the foe, on the long edge nearer along the perimeter; the upper levels
    // hold a diagonal instead, about two thirds of the reach from the foe, on the side they are already on
    const relX = fx + fvx * 0.4 - ctx.arena.minX;
    const anchorX = m.exitX - ctx.arena.minX;
    let off = 0;
    if (this.spacing) {
      const dTop = Math.abs(fy - (ctx.arena.minY + 48));
      const dBot = Math.abs(ctx.arena.maxY - 48 - fy);
      const dv = Math.min(dTop, dBot);
      const ideal = reach * 0.66;
      // …but inside the strike arc (≤ 0.95 rad off the edge normal: the arena is only 360 px tall)
      off = Math.min(Math.sqrt(Math.max(0, ideal * ideal - dv * dv)), dv * 1.4);
      // keep the side we are on unless the foe has crossed well past us
      const rel = anchorX - (fx - ctx.arena.minX);
      if (Math.abs(rel) > 60) this.side = rel >= 0 ? 1 : -1;
      // never into a corner: flip to the open side
      const target = relX + this.side * off;
      if (target < 90 || target > W - 90) this.side = -this.side;
      off *= this.side;
    }
    const lx = Math.max(60, Math.min(W - 60, relX + off));
    const sTop = lx;
    const sBottom = W + H_ + (W - lx);
    const arc = (a: number, b: number): number => {
      let d = (((b - a) % per) + per) % per;
      if (d > per / 2) d -= per;
      return d;
    };
    const dTopS = arc(m.s, sTop);
    const dBotS = arc(m.s, sBottom);
    const want = Math.abs(dTopS) < Math.abs(dBotS) ? dTopS : dBotS;
    const busy = m.move !== null;
    if (!busy && Math.abs(want) > 40) out.moveX = Math.sign(want) * Math.min(1, Math.abs(want) / 120 + 0.35);
    this.currentPlan = busy ? `strike:${m.move}` : Math.abs(want) > 40 ? 'slide' : 'aim';
    if (busy) return;
    // strike when the foe is inside the arc and the reach
    const dx = fx - m.exitX;
    const dy = fy - m.exitY;
    const dist = DMath.hypot(dx, dy);
    const ang = DMath.acos(Math.max(-1, Math.min(1, (dx * m.nx + dy * m.ny) / (dist || 1))));
    if (ang > 1.2 || dist < 70) return;
    if (dist > reach * 1.08) return;
    const speed = DMath.hypot(fvx, fvy);
    // punish: a committed foe (its move or stun outlasts the bite's arrival) is struck at once, outside the gap
    const committed =
      COMMITTED.has(fState) && fLeft >= BITE_TICKS.low - 4 && ctx.tick - this.lastStrike >= 20;
    const grabbable = dist < 330 && (fGuard || (committed && fLeft >= 30));
    let bit = 0;
    let name = '';
    let why = '';
    if (grabbable && this.rng.next() < GRAB[lv]) {
      bit = Btn.SIGNATURE;
      name = 'coil';
      why = fGuard ? 'guard' : 'punish';
    } else if (committed && this.rng.next() < PUNISH[lv]) {
      bit = Btn.STRIKE;
      name = 'bite';
      why = 'punish';
    }
    const gap = this.engageGap * (0.75 + this.rng.next() * 0.5);
    this.restTicks = Math.max(0, Math.round(this.lastStrike + gap - ctx.tick));
    if (!bit) {
      if (ctx.tick - this.lastStrike < gap) return;
      // patience (upper levels): a foe running across the line would leave a locked bite behind
      if (PUNISH[lv] >= 0.7 && speed > 160 && this.rng.next() < 0.8) return;
      const slow = speed < 90;
      const r = this.rng.next();
      if (slow && dist < 330 && r < 0.2) {
        bit = Btn.SIGNATURE;
        name = 'coil';
      } else if (r < 0.42 && ang > 0.35) {
        bit = Btn.CRUSH;
        name = 'sweep';
      } else {
        bit = Btn.STRIKE;
        name = 'bite';
      }
    }
    // height: high reaches furthest, low arrives fastest (a punish takes the fastest that reaches)
    this.height =
      dist > reach * 0.88
        ? -1
        : dist < 230 || why === 'punish'
          ? dist < reach * 0.8
            ? 1
            : 0
          : this.rng.next() < 0.25
            ? this.rng.next() < 0.5
              ? -1
              : 1
            : 0;
    out.moveY = this.height;
    this.press = bit;
    this.lastStrike = ctx.tick;
    // after each strike: hold a diagonal until the next one, or come straight under the foe
    this.spacing = SPACING[lv] > 0 && this.rng.next() < SPACING[lv];
    this.note(
      `${name}${why ? ` (${why})` : ''} h${this.height} at ${dist.toFixed(0)} px, ${(ang * 57.3).toFixed(0)}°`,
      ctx.tick,
    );
  }
}
