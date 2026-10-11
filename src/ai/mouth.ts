import {
  Btn,
  REACTION_MS,
  Rng,
  type AIContext,
  type AIController,
  type Difficulty,
  type InputFrame,
  type TitanDef,
} from '@/contracts';

/**
 * The Mouth's AI (D37): a crane at the edge. It observes only public state (its own view's `mouth` frame and the foe's
 * view) through the level's reaction delay, slides its anchor along the perimeter to bring the foe into its arc and reach,
 * and strikes along a drawn path — Bite most, Sweep at an angle, Coil & crush when the foe is close and slow. Height: high
 * for a far foe (longest reach), low for a near one (fastest).
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

const GAP: Record<Difficulty, number> = { 1: 170, 2: 130, 3: 95, 4: 70, 5: 50, 6: 36 };
const DELAY_CAP = 40;

export class MouthAI implements AIController {
  readonly level: Difficulty;
  readonly log: string[] = [];
  engageGap: number;
  currentPlan = 'watch';
  restTicks = 0;
  private rng: Rng;
  private readonly delay: number;
  /** Delayed foe observations: x, y, vx, vy per tick (ring buffer). */
  private readonly hist = new Float64Array(DELAY_CAP * 4);
  private n = 0;
  private press = 0;
  private height = 0;
  private lastStrike = -1e9;

  constructor(level: Difficulty, _def: TitanDef, seed: number) {
    this.level = level;
    this.rng = new Rng(seed >>> 0 || 1);
    this.delay = Math.min(DELAY_CAP - 1, Math.round((REACTION_MS[level] / 1000) * 60));
    this.engageGap = GAP[level];
  }

  reset(seed: number): void {
    this.rng = new Rng(seed >>> 0 || 1);
    this.n = 0;
    this.press = 0;
    this.lastStrike = -1e9;
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
    const i = (this.n % DELAY_CAP) * 4;
    this.hist[i] = foe.x;
    this.hist[i + 1] = foe.y;
    this.hist[i + 2] = foe.vx;
    this.hist[i + 3] = foe.vy;
    this.n++;
    const k = ((Math.max(0, this.n - 1 - this.delay) % DELAY_CAP) + DELAY_CAP) % DELAY_CAP;
    const fx = this.hist[k * 4]!;
    const fy = this.hist[k * 4 + 1]!;
    const fvx = this.hist[k * 4 + 2]!;
    const fvy = this.hist[k * 4 + 3]!;
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
    const per = m.per;
    // where to be: the perimeter point under (or over) the foe, on the long edge nearer along the perimeter
    const W = ctx.arena.maxX - ctx.arena.minX;
    const H = ctx.arena.maxY - ctx.arena.minY;
    const lx = Math.max(60, Math.min(W - 60, fx + fvx * 0.4 - ctx.arena.minX));
    const sTop = lx;
    const sBottom = W + H + (W - lx);
    const arc = (a: number, b: number): number => {
      let d = (((b - a) % per) + per) % per;
      if (d > per / 2) d -= per;
      return d;
    };
    const dTop = arc(m.s, sTop);
    const dBot = arc(m.s, sBottom);
    const want = Math.abs(dTop) < Math.abs(dBot) ? dTop : dBot;
    const busy = m.move !== null;
    if (!busy && Math.abs(want) > 40) out.moveX = Math.sign(want) * Math.min(1, Math.abs(want) / 120 + 0.35);
    this.currentPlan = busy ? `strike:${m.move}` : Math.abs(want) > 40 ? 'slide' : 'aim';
    if (busy) return;
    // strike when the foe is inside the arc and the reach
    const dx = fx - m.exitX;
    const dy = fy - m.exitY;
    const dist = Math.hypot(dx, dy);
    const ang = Math.acos(Math.max(-1, Math.min(1, (dx * m.nx + dy * m.ny) / (dist || 1))));
    const gap = this.engageGap * (0.75 + this.rng.next() * 0.5);
    this.restTicks = Math.max(0, Math.round(this.lastStrike + gap - ctx.tick));
    if (ctx.tick - this.lastStrike < gap) return;
    if (ang > 1.2 || dist < 70) return;
    const reach = m.reach;
    if (dist > reach * 1.08) return;
    const slow = Math.hypot(fvx, fvy) < 90;
    const r = this.rng.next();
    let bit: number;
    let name: string;
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
    // height: high reaches furthest, low arrives fastest
    this.height =
      dist > reach * 0.88
        ? -1
        : dist < 230
          ? 1
          : this.rng.next() < 0.25
            ? this.rng.next() < 0.5
              ? -1
              : 1
            : 0;
    out.moveY = this.height;
    this.press = bit;
    this.lastStrike = ctx.tick;
    this.note(`${name} h${this.height} at ${dist.toFixed(0)} px, ${(ang * 57.3).toFixed(0)}°`, ctx.tick);
  }
}
