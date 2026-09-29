import {
  Btn,
  Rng,
  TICK_DT,
  clamp,
  type AIContext,
  type AIController,
  type AimDir,
  type DamageType,
  type Difficulty,
  type FighterView,
  type InputFrame,
  type MoveSlot,
  type TitanDef,
} from '@/contracts';
import { levelParams, type LevelParams } from './levels';
import { buildMoveInfos, surgeDistance, type MoveInfo } from './moves';
import { NGram, type Token } from './predict';
import { ObservationRing, Snapshot } from './observe';
import { Plan, Steer } from './plan';

const TYPES: DamageType[] = ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'];
const GLIDE_TAU = 0.35 / Math.LN2;
const LOG_MAX = 80;

interface Cand {
  score: number;
  name: string;
  kind: Plan['kind'];
  /** What to build when chosen. */
  what: 'wait' | 'approach' | 'retreat' | 'strafe' | 'attack' | 'sidestep' | 'guard' | 'ultimate' | 'feint' | 'escape';
  info: MoveInfo | null;
  charge: number;
  dirX: number;
  dirY: number;
  ticks: number;
  delay: number;
  why: string;
}

const newCand = (): Cand => ({
  score: 0,
  name: '',
  kind: 'wait',
  what: 'wait',
  info: null,
  charge: 0,
  dirX: 0,
  dirY: 0,
  ticks: 0,
  delay: 0,
  why: '',
});

/** Weights from the titan JSON with sane defaults. */
interface Persona {
  aggression: number;
  patience: number;
  zoning: number;
  retreat: number;
  trap: number;
  punish: number;
  gaze: number;
  /** Preferred fighting range (px between anchors). */
  range: number;
}

function personaOf(def: TitanDef): Persona {
  const w = def.ai.weights;
  const g = (k: string, d: number): number => w[k] ?? d;
  const aggression = g('aggression', 0.5);
  const zoning = g('zoning', 0.3);
  return {
    aggression,
    patience: g('patience', 0.3),
    zoning,
    retreat: g('retreat', 0.3),
    trap: g('trap', 0.1),
    punish: g('punish', 0.7),
    gaze: g('gaze', 0),
    // aggressive titans fight closer; zoners keep their distance; reach matters
    range: 120 + def.attributes.reach * 14 + zoning * 110 - aggression * 50,
  };
}

/**
 * Utility-based fighting AI with short-horizon lookahead over frame data.
 *
 * Perception is DELAYED: the foe is only ever seen through a ring buffer, `REACTION_MS[level]` old, built from public
 * FighterViews (`decide` receives an AIContext and nothing else — there is no path to the foe's pending input). Each think it
 * scores candidate plans — defend (sidestep / guard / retreat / counter), punish (foe recovery, stun, guard-break), neutral
 * attacks (each aim variant of each move, weighted by hit probability against the foe's PREDICTED position and by how weak
 * the struck region already is), ultimate, spacing — samples one with a level-dependent temperature, and executes it as a
 * short script with human timing jitter and occasional blunders.
 */
export class UtilityAI implements AIController {
  readonly level: Difficulty;
  readonly log: string[] = [];
  private readonly P: LevelParams;
  private readonly def: TitanDef;
  private readonly persona: Persona;
  private readonly infos: MoveInfo[];
  private readonly bySlot: Partial<Record<MoveSlot, MoveInfo[]>> = {};
  private readonly surgeDist: number;
  private readonly guardAbsorb: Partial<Record<DamageType, number>>;
  private readonly followUp: { from: number; to: number; move: string } | null;
  private rng: Rng;
  private readonly ring = new ObservationRing();
  private readonly ngram = new NGram();
  private readonly plan = new Plan();
  private readonly cands: Cand[] = Array.from({ length: 40 }, newCand);
  private nCands = 0;

  /* perception state */
  private nowTick = 0;
  private lastThink = -1e9;
  private lastAge = 0;
  private lastVuln = 0;
  private decisionCount = 0;
  private blunderCount = 0;
  private noiseX = 0;
  private noiseY = 0;
  private prevMoveId: string | null = null;
  private prevState = '';
  private prevProcessedTick = -1;

  /* own bookkeeping */
  private lastSurgeTick = -1e9;
  private stunAge = 0;

  constructor(level: Difficulty, def: TitanDef, seed: number) {
    this.level = level;
    this.def = def;
    this.P = levelParams(level);
    this.persona = personaOf(def);
    this.infos = buildMoveInfos(def);
    for (const mi of this.infos) (this.bySlot[mi.slot] ??= []).push(mi);
    this.surgeDist = surgeDistance(def);
    const guard = def.moves.find((m) => m.slot === 'guard');
    this.guardAbsorb = ((guard?.extra?.['shell'] as { absorb?: Partial<Record<DamageType, number>> } | undefined)?.absorb ?? {}) as Partial<
      Record<DamageType, number>
    >;
    const surge = def.moves.find((m) => m.slot === 'surge');
    this.followUp = (surge?.extra?.['followUp'] as { from: number; to: number; move: string } | undefined) ?? null;
    this.rng = new Rng(seed);
    this.reset(seed);
  }

  reset(seed: number): void {
    this.rng = new Rng(seed ^ (this.level * 0x9e37));
    this.ring.reset();
    this.ngram.reset();
    this.plan.cancel();
    this.plan.count = 0;
    this.plan.index = 0;
    this.log.length = 0;
    this.lastThink = -1e9;
    this.decisionCount = 0;
    this.blunderCount = 0;
    this.prevMoveId = null;
    this.prevState = '';
    this.prevProcessedTick = -1;
    this.lastSurgeTick = -1e9;
    this.stunAge = 0;
  }

  /* ================================================================================================
   *  decide — one InputFrame per tick, from the public AIContext only
   * ============================================================================================== */

  decide(ctx: AIContext, out: InputFrame): void {
    out.moveX = 0;
    out.moveY = 0;
    out.held = 0;
    this.nowTick = ctx.tick;
    const S = ctx.self;
    this.ring.push(ctx.foe, ctx.tick);
    const F = this.ring.delayed(ctx.tick, this.P.reactionTicks);
    const age = ctx.tick - F.tick;
    this.lastAge = age;

    if (F.tick !== this.prevProcessedTick) {
      this.observeFoe(F);
      this.prevProcessedTick = F.tick;
    }
    if (S.state === 'ko' || S.state === 'victory' || S.state === 'intro' || ctx.roundTick <= 0) {
      this.plan.cancel();
      return;
    }
    // own state is always known exactly (proprioception): hit-stun bookkeeping for the escape route
    this.stunAge = S.state === 'hitstun' ? this.stunAge + 1 : 0;
    if (S.state === 'hitstun' || S.state === 'guardbreak') {
      this.stunned(S, F, out);
      return;
    }

    const dx = F.x - S.x + this.noiseX;
    const dy = F.y - S.y + this.noiseY;

    // urgent defence may pre-empt whatever is running, at any tick
    if (this.plan.kind !== 'defend' || !this.plan.active) {
      const urgent = this.scanThreats(S, F, age, true);
      if (urgent) {
        this.plan.cancel();
        this.lastThink = -1e9;
      }
    }
    const busy = S.moveId !== null && S.state !== 'guard';
    // an opening (foe recovering / stunned) pre-empts walking, waiting and guarding: seize it (once per window)
    if (this.plan.active && this.plan.kind !== 'attack' && !busy) {
      const vuln = this.vulnerableTicks(F, age);
      if (vuln > 10 && this.lastVuln <= 10 && this.rng.chance(this.P.punishSkill)) {
        this.plan.cancel();
        this.lastThink = -1e9;
      }
      this.lastVuln = vuln;
    } else this.lastVuln = this.vulnerableTicks(F, age);
    if (!this.plan.active && !busy && ctx.tick - this.lastThink >= this.P.thinkEvery) this.think(ctx, S, F, age);
    else if (busy && this.plan.kind === 'attack' && !this.plan.active) this.considerFeint(ctx, S, F, age);

    this.plan.run(out, dx, dy);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  perception
   * ---------------------------------------------------------------------------------------------- */

  private observeFoe(F: Snapshot): void {
    let tok: Token | null = null;
    if (F.moveId !== null && F.moveId !== this.prevMoveId) {
      tok = (F.moveSlot as Token | null) ?? 'idle';
    } else if (F.state !== this.prevState) {
      if (F.state === 'hitstun') tok = 'hurt';
      else if (F.state === 'guard') tok = 'guard';
    }
    if (F.moveId === null && this.prevMoveId === null && F.state === 'move') {
      const toward = Math.sign(F.vx) === Math.sign(F.facing);
      if (this.prevState !== 'move') tok = toward ? 'approach' : 'retreat';
    }
    if (tok) this.ngram.observe(tok);
    this.prevMoveId = F.moveId;
    this.prevState = F.state;
  }

  /** How many ticks the foe stays exploitable (from the delayed observation, minus how old it is). */
  private vulnerableTicks(F: Snapshot, age: number): number {
    if (F.state === 'hitstun') return F.hitstunTicks - age;
    if (F.state === 'guardbreak') return 44 - age;
    if (F.phase === 'recovery') return F.moveTotal - F.moveTick - age;
    if (F.state === 'surge' && F.phase !== 'startup') return Math.max(0, F.moveTotal - F.moveTick - 8) - age;
    return 0;
  }

  /** Overlap fraction between a hit region and a body's bounds (the body is treated as ~80% of its box). */
  private coverage(hx0: number, hy0: number, hx1: number, hy1: number, F: Snapshot, shiftX: number, shiftY: number): number {
    const w = F.bx1 - F.bx0;
    const h = F.by1 - F.by0;
    const fx0 = F.bx0 + shiftX + w * 0.1;
    const fx1 = F.bx1 + shiftX - w * 0.1;
    const fy0 = F.by0 + shiftY + h * 0.1;
    const fy1 = F.by1 + shiftY - h * 0.1;
    const ox = Math.min(hx1, fx1) - Math.max(hx0, fx0);
    const oy = Math.min(hy1, fy1) - Math.max(hy0, fy0);
    if (ox <= 0 || oy <= 0) return 0;
    const hw = Math.max(4, hx1 - hx0);
    const hh = Math.max(4, hy1 - hy0);
    return clamp((ox / Math.min(hw, fx1 - fx0)) * (oy / Math.min(hh, fy1 - fy0)), 0, 1);
  }

  /** Foe displacement (px) `ticks` after the delayed observation (glide model, same constants as the fighter). */
  private foeShift(F: Snapshot, ticks: number, axis: 'x' | 'y'): number {
    const v = axis === 'x' ? F.vx : F.vy;
    return v * GLIDE_TAU * (1 - Math.exp(-(ticks * TICK_DT) / GLIDE_TAU));
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moves as a lookahead model
   * ---------------------------------------------------------------------------------------------- */

  /** Expected damage and hit probability of pressing `mi` now from `S` against the foe's predicted position. */
  private evalMove(
    mi: MoveInfo,
    S: FighterView,
    F: Snapshot,
    age: number,
    out: { p: number; dmg: number; cx: number },
    reachBoost = 1,
  ): void {
    out.p = 0;
    out.dmg = 0;
    if (!mi.hasHitboxes) return;
    const tempo = Math.max(0.6, S.stats.tempoMul);
    const startup = mi.startup / tempo;
    const f: 1 | -1 = F.x + this.noiseX >= S.x ? 1 : -1;
    const rs = S.stats.reachMul * reachBoost;
    const t = age + startup + (mi.hitFrom + mi.hitTo) * 0.5;
    const sx = this.foeShift(F, t, 'x') + this.noiseX;
    const sy = this.foeShift(F, t, 'y') + this.noiseY;
    const disp = f * mi.lungeBefore;
    const x0 = f === 1 ? S.x + mi.x0 * rs + disp : S.x - mi.x1 * rs + disp;
    const x1 = f === 1 ? S.x + mi.x1 * rs + disp + f * mi.lungeDuring * 0.5 : S.x - mi.x0 * rs + disp + f * mi.lungeDuring * 0.5;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const y0 = S.y + mi.y0 * rs;
    const y1 = S.y + mi.y1 * rs;
    let p = this.coverage(lo, y0, hi, y1, F, sx, sy);
    if (p <= 0) return;
    // a foe that is already moving away / has a surge ready dodges some of it; a guarding foe blocks some
    p = Math.min(1, p * 1.25);
    if (F.intangible) p = 0;
    out.p = p;
    let regionBoost = 1;
    // weakened regions take more: read the foe's 8×8 integrity grid at the point of contact
    const cx = clamp((Math.max(lo, F.bx0) + Math.min(hi, F.bx1)) * 0.5, F.bx0, F.bx1);
    const cy = clamp((Math.max(y0, F.by0) + Math.min(y1, F.by1)) * 0.5, F.by0, F.by1);
    const gx = clamp(Math.floor(((cx - F.bx0) / Math.max(1, F.bx1 - F.bx0)) * 8), 0, 7);
    const gy = clamp(Math.floor(((cy - F.by0) / Math.max(1, F.by1 - F.by0)) * 8), 0, 7);
    const integ = F.region[gy * 8 + gx]!;
    regionBoost = 1 + 0.7 * (1 - integ);
    out.cx = cx;
    let e = mi.energy * S.stats.damageMul;
    // guard: a guarding foe absorbs by damage type (we cannot see its shell, so assume a middling profile)
    if (F.guardUp) e *= mi.slot === 'crush' || mi.slot === 'ultimate' ? 0.75 : 0.5;
    out.dmg = e * p * regionBoost;
  }

  private readonly ev = { p: 0, dmg: 0, cx: 0 };

  private aimSign(a: AimDir): number {
    return a === 'up' ? -0.9 : a === 'down' ? 0.9 : 0;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  threats
   * ---------------------------------------------------------------------------------------------- */

  private bestThreat = { danger: 0, until: 0, live: 0, type: 0, x0: 0, y0: 0, x1: 0, y1: 0, detached: false };

  /**
   * Find the most dangerous shape (as of the delayed observation) that will overlap my body. With `quick`, only report whether an
   * urgent one exists (cheap check used every tick).
   */
  private scanThreats(S: FighterView, F: Snapshot, age: number, quick = false): boolean {
    const b = this.bestThreat;
    b.danger = 0;
    let found = false;
    const mw = S.boundsX1 - S.boundsX0;
    const mh = S.boundsY1 - S.boundsY0;
    const mx0 = S.boundsX0 + mw * 0.1;
    const mx1 = S.boundsX1 - mw * 0.1;
    const my0 = S.boundsY0 + mh * 0.1;
    const my1 = S.boundsY1 - mh * 0.1;
    let topEnergy = 0;
    let soonest = 1e9;
    let latestEnd = -1e9;
    let ux0 = 1e9;
    let uy0 = 1e9;
    let ux1 = -1e9;
    let uy1 = -1e9;
    for (let i = 0; i < F.threatCount; i++) {
      const th = F.threats[i]!;
      const until = th.until - age;
      if (until + th.live < 0) continue; // over by now
      const ox = Math.min(th.x1, mx1) - Math.max(th.x0, mx0);
      const oy = Math.min(th.y1, my1) - Math.max(th.y0, my0);
      if (ox <= 0 || oy <= 0) continue;
      const cov = clamp((ox * oy) / (Math.max(8, Math.min(th.x1 - th.x0, mx1 - mx0)) * Math.max(8, Math.min(th.y1 - th.y0, my1 - my0))), 0, 1);
      // every hitbox of one move that will overlap me adds up (a lash is four separate whips)
      b.danger += (th.energy / 400) * (0.4 + 0.6 * cov);
      if (th.energy > topEnergy) {
        topEnergy = th.energy;
        b.type = th.type;
        b.detached = th.detached;
      }
      soonest = Math.min(soonest, until);
      latestEnd = Math.max(latestEnd, until + th.live);
      ux0 = Math.min(ux0, th.x0);
      uy0 = Math.min(uy0, th.y0);
      ux1 = Math.max(ux1, th.x1);
      uy1 = Math.max(uy1, th.y1);
      found = true;
    }
    if (!found) return false;
    b.until = soonest;
    b.live = Math.max(0, latestEnd - soonest);
    b.x0 = ux0;
    b.y0 = uy0;
    b.x1 = ux1;
    b.y1 = uy1;
    if (quick) {
      // urgent: it goes live within the surge's protective window and is not trivial
      return this.P.defends > 0.3 && b.danger > 0.5 && b.until <= 12 && b.until >= -2 && this.plan.kind !== 'defend' && this.rollDefend();
    }
    return true;
  }

  private defendRoll = 0;
  private defendRollTick = -1;
  /** One reaction roll per threat window: lower levels simply do not notice / do not react to some telegraphs. */
  private rollDefend(): boolean {
    if (this.defendRollTick < this.nowTick - 20) {
      this.defendRollTick = this.nowTick;
      this.defendRoll = this.rng.next();
    }
    return this.defendRoll < this.P.defends;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  think: candidate plans
   * ---------------------------------------------------------------------------------------------- */

  private add(name: string, kind: Plan['kind'], what: Cand['what'], score: number, why: string): Cand {
    const c = this.cands[this.nCands++]!;
    c.name = name;
    c.kind = kind;
    c.what = what;
    c.score = score;
    c.info = null;
    c.charge = 0;
    c.dirX = 0;
    c.dirY = 0;
    c.ticks = 0;
    c.delay = 0;
    c.why = why;
    return c;
  }

  private think(ctx: AIContext, S: FighterView, F: Snapshot, age: number): void {
    this.lastThink = ctx.tick;
    this.nCands = 0;
    // perception noise is re-rolled per think, not per tick (a stable misjudgement, like a human's)
    this.noiseX = this.rng.gauss() * this.P.noisePx;
    this.noiseY = this.rng.gauss() * this.P.noisePx * 0.5;
    const pers = this.persona;
    const dx = F.x - S.x + this.noiseX;
    const dy = F.y - S.y + this.noiseY;
    const dist = Math.abs(dx);
    // who is winning decides whether to gamble: playing safe only makes sense when ahead
    const ahead = S.integrityPct > F.integrityPct + 8;
    const behind = S.integrityPct < F.integrityPct - 8;
    const late = ctx.roundTicksLeft < 20 * 60;
    const lowHp = S.integrityPct < 34 && !behind;
    const vuln = this.vulnerableTicks(F, age);
    const predAttack = this.P.predicts && this.ngram.weight > 6 ? this.predictAttackProb() : 0.25;
    const surgeReady = this.def.moves.some((m) => m.slot === 'surge') && ctx.tick - this.lastSurgeTick > 40 && S.moveId === null;

    /* ---- defend ---- */
    if (this.scanThreats(S, F, age)) {
      const th = this.bestThreat;
      const until = Math.max(0, th.until);
      const sideDelay = Math.max(0, until - 8);
      if (surgeReady && this.P.defends > 0.2) {
        const dir = this.bestSidestepDir(S, th);
        const sc = th.danger * (0.95 + 0.5 * pers.patience) * this.P.defends;
        const c = this.add('sidestep', 'defend', 'sidestep', sc, `threat ${TYPES[th.type]} in ${th.until.toFixed(0)}t`);
        c.dirX = dir[0];
        c.dirY = dir[1];
        c.delay = sideDelay + this.jitter();
        c.ticks = 0;
        // Last One identity: a sidestep is followed by a lunging strike if the foe is in reach afterwards
        c.charge = this.followUp ? 1 : 0;
      }
      const absorb = this.guardAbsorb[TYPES[th.type]!] ?? 0.35;
      const gsc = th.danger * absorb * (0.5 + 0.5 * S.guardHealth) * 0.85 * this.P.defends * (th.detached ? 0.6 : 1);
      const g = this.add('guard', 'defend', 'guard', gsc, `guard vs ${TYPES[th.type]} (absorb ${absorb})`);
      g.delay = Math.max(0, until - 5) + this.jitter();
      g.ticks = Math.min(60, Math.round(until + th.live + 6));
      const rs = this.add('back off', 'defend', 'retreat', th.danger * 0.35 * this.P.defends * (0.5 + pers.retreat), 'give ground');
      rs.ticks = 16;
      rs.delay = this.jitter();
      // counter: something fast that lands before the threat goes live
      for (const mi of this.bySlot.strike ?? []) {
        this.evalMove(mi, S, F, age, this.ev);
        const startup = mi.startup / Math.max(0.6, S.stats.tempoMul);
        if (this.ev.p > 0.5 && startup + 3 < until) {
          const cc = this.add(`counter ${mi.def.name}`, 'defend', 'attack', th.danger * 0.75 * this.ev.p * this.P.punishSkill, `counter before t-${until.toFixed(0)}`);
          cc.info = mi;
          cc.delay = this.jitter();
        }
      }
    }

    /* ---- punish ---- */
    if (vuln > 6) {
      this.attackCandidates(S, F, age, dist, vuln, true);
    }

    /* ---- ultimate ---- */
    const ult = this.bySlot.ultimate?.[1];
    if (ult && S.meter >= 1 - 1e-6 && dist < 400) {
      for (const mi of this.bySlot.ultimate!) {
        this.evalMove(mi, S, F, age, this.ev);
        if (this.ev.p > 0.35 || vuln > mi.startup * 0.6) {
          const sc = (this.ev.dmg / 450) * (vuln > 30 ? 1.3 : 0.85) + 0.2;
          const c = this.add(`ultimate ${mi.def.name}`, 'attack', 'ultimate', sc, `meter full, hitP ${this.ev.p.toFixed(2)}`);
          c.info = mi;
          c.delay = this.jitter();
        }
      }
    }

    /* ---- neutral attacks ---- */
    if (vuln <= 6) this.attackCandidates(S, F, age, dist, 0, false);

    /* ---- spacing / patience ---- */
    // the distance an attack actually reaches from (anchor to anchor), and the standoff a patient titan prefers just outside it
    const range = this.attackRange(S) + pers.patience * 40 + pers.zoning * 30;
    const approachNeed = clamp((dist - this.attackRange(S) * 0.95) / 200, 0, 1.4);
    const tooClose = clamp((this.attackRange(S) * 0.3 - dist) / 50, 0, 1);
    const a = this.add('approach', 'space', 'approach', 0.25 + 0.55 * approachNeed * (0.5 + pers.aggression) - (lowHp ? 0.25 : 0) + (behind && late ? 0.3 : 0) - (ahead && late ? 0.25 : 0), 'close the gap');
    a.ticks = 10 + Math.round(this.rng.next() * 12);
    if (surgeReady && dist > range + 160 && pers.aggression > 0.5) {
      const dash = this.add('dash in', 'space', 'sidestep', 0.3 + 0.35 * approachNeed * pers.aggression, 'gap-close surge');
      dash.dirX = Math.sign(dx) || S.facing;
      dash.dirY = clamp(dy / 120, -0.5, 0.5);
      dash.delay = this.jitter();
    }
    const r = this.add('retreat', 'space', 'retreat', 0.1 + 0.6 * tooClose * (0.4 + pers.retreat) + (lowHp ? 0.5 : 0) + (ahead && late ? 0.25 : 0) + (dist < range * 0.8 && vuln <= 0 ? 0.08 * pers.retreat : 0) + (vuln <= 0 && F.phase === 'startup' ? 0.12 * pers.patience : 0), 'make room');
    r.ticks = 10 + Math.round(this.rng.next() * 14);
    const st = this.add('strafe', 'space', 'strafe', 0.16 + Math.abs(dy) / 260 * 0.4, 'line up height');
    st.dirY = Math.sign(dy) || (this.rng.chance(0.5) ? 1 : -1);
    st.ticks = 10;
    const w = this.add('wait', 'wait', 'wait', 0.2 + 0.35 * pers.patience * (F.phase === 'startup' || predAttack > 0.4 ? 1 : 0.3) - 0.15 * pers.aggression, 'let them come');
    w.ticks = 8 + Math.round(this.rng.next() * 10);
    // a pre-emptive guard only when an attack is genuinely expected AND the foe is close enough to deliver it
    if (dist < 240 && predAttack > 0.5 && vuln <= 0 && (F.moveId !== null || F.state === 'move')) {
      const g2 = this.add('guard up', 'defend', 'guard', 0.06 + (predAttack - 0.5) * 0.4 * this.P.defends * (lowHp ? 1.5 : 1), 'expect an attack');
      g2.ticks = 12;
    }

    this.commit(ctx, S, F);
  }

  private cachedRange = 0;
  private cachedRangeTick = -1e9;
  /** Anchor-to-anchor distance at which the best neutral attack starts to connect (≈ forward reach plus half a body). */
  private attackRange(S: FighterView): number {
    if (this.nowTick - this.cachedRangeTick > 30) {
      let best = 0;
      for (const slot of ['strike', 'crush'] as MoveSlot[])
        for (const mi of this.bySlot[slot] ?? []) if (mi.hasHitboxes) best = Math.max(best, (mi.x1 + mi.lungeBefore * 0.5) * S.stats.reachMul);
      this.cachedRange = best + 45;
      this.cachedRangeTick = this.nowTick;
    }
    return this.cachedRange;
  }

  /** Likelihood the foe attacks in the near future, from its observed habits. */
  private predictAttackProb(): number {
    this.ngram.predict();
    return this.ngram.prob('strike') + this.ngram.prob('crush') + this.ngram.prob('signature') + this.ngram.prob('ultimate') * 0.5;
  }

  private jitter(): number {
    return this.P.jitter > 0 ? Math.floor(this.rng.next() * (this.P.jitter + 1)) : 0;
  }

  /** Best of 8 directions to dash out of a threat region (largest clearance from its box), preferring backwards/sideways. */
  private bestSidestepDir(S: FighterView, th: { x0: number; y0: number; x1: number; y1: number }): [number, number] {
    let best = -1e9;
    let bx = -S.facing as number;
    let by = 0;
    const d = this.surgeDist * 0.9;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const nx0 = S.boundsX0 + ux * d;
      const nx1 = S.boundsX1 + ux * d;
      const ny0 = S.boundsY0 + uy * d;
      const ny1 = S.boundsY1 + uy * d;
      const ox = Math.min(th.x1, nx1) - Math.max(th.x0, nx0);
      const oy = Math.min(th.y1, ny1) - Math.max(th.y0, ny0);
      let score = -Math.max(0, ox) * Math.max(0, oy) * 0.05;
      // stay in the arena and near the foe's height: prefer moves that keep the fight on screen
      score -= Math.abs(uy) * 4;
      score += ux * -S.facing * 2; // away from the foe is safer, toward it is riskier but sets up a punish
      if (ox <= 0 || oy <= 0) score += 60;
      if (score > best) {
        best = score;
        bx = ux;
        by = uy;
      }
    }
    return [Math.abs(bx) < 0.05 ? 0 : bx, Math.abs(by) < 0.05 ? 0 : by];
  }

  private attackCandidates(S: FighterView, F: Snapshot, age: number, dist: number, vuln: number, punish: boolean): void {
    const pers = this.persona;
    const wantSlots: MoveSlot[] = ['strike', 'crush', 'signature'];
    const foeGuards = F.guardUp || F.state === 'guard';
    const foeIdle = F.moveId === null && F.state !== 'hitstun' && F.state !== 'guardbreak';
    for (const slot of wantSlots) {
      for (const mi of this.bySlot[slot] ?? []) {
        if (mi.def.extra?.['followUpOnly']) continue;
        if (mi.resourceCost > S.resource + 1e-6) continue;
        const cr = (mi.def.extra?.['chargeReach'] as [number, number] | undefined) ?? [1, 1];
        // charged beams: judge them at full-charge reach, then hold only as long as the distance requires
        this.evalMove(mi, S, F, age, this.ev, mi.chargeMax > 0 ? cr[1] : 1);
        let p = this.ev.p;
        let dmg = this.ev.dmg;
        let chargeTicks = 0;
        if (mi.chargeMax > 0 && p > 0) {
          const need = (dist + 24) / Math.max(20, mi.x1 * S.stats.reachMul);
          const frac = clamp((need - cr[0]) / Math.max(0.01, cr[1] - cr[0]), 0, 1);
          chargeTicks = Math.round(frac * mi.chargeMax * (0.55 + 0.45 * this.rng.next()));
          dmg *= 1 + frac * 0.7;
        }
        if (p < 0.12) continue;
        const startupEff = mi.startup / Math.max(0.6, S.stats.tempoMul) + chargeTicks;
        const per = dmg / 350;
        let score: number;
        if (punish) {
          // a punish is free damage: value it by what it does, gated by whether it fits in the window
          score = per * (0.35 + pers.punish * 0.5) * this.P.punishSkill;
          if (startupEff + 2 > vuln) score *= 0.1;
        } else {
          // neutral: a poke is cheap, a heavy is a commitment a reacting foe can punish — weigh by time and by whether it can react
          const react = clamp((startupEff - 16) / 34, 0, 1);
          let commit = react * (foeIdle ? 0.55 : 0.1);
          if (foeGuards && mi.slot === 'crush') commit -= 0.35; // crushes break guards
          const time = (mi.total / 60) * 0.32;
          score = per * (0.4 + pers.aggression * 0.55) * 0.85 - time - commit * (0.5 + pers.patience);
          const risk = ((mi.recovery + startupEff) / 100) * (1 - p) * (0.3 + 0.6 * pers.patience) * (1 - 0.5 * pers.retreat);
          score -= risk;
          if (F.phase === 'startup' || F.phase === 'charge') score -= 0.1; // do not walk into a windup
          if (mi.slot === 'signature') score += 0.3 * (pers.gaze + pers.zoning) * (mi.beam ? 1 : 0.55);
        }
        if (mi.projectile && dist < 90) score *= 0.5;
        const c = this.add(
          `${punish ? 'punish' : 'attack'} ${mi.def.name} (${mi.aim})`,
          'attack',
          'attack',
          score,
          `hitP ${p.toFixed(2)} dmg ${dmg.toFixed(0)}${punish ? ` vuln ${vuln.toFixed(0)}` : ''}`,
        );
        c.info = mi;
        c.charge = chargeTicks;
        c.delay = this.jitter();
      }
    }
    // approaching to punish a stunned foe is worth it if it is far but will stay down a while
    if (punish && vuln > 24 && dist > 130) {
      const a = this.add('rush', 'attack', 'approach', 0.6 * this.P.punishSkill * pers.punish, `foe down ${vuln.toFixed(0)}t`);
      a.ticks = Math.min(20, Math.round(vuln * 0.4));
    }
  }

  /** Sample a plan (softmax with the level's temperature), maybe blunder, and build it. */
  private commit(ctx: AIContext, S: FighterView, F: Snapshot): void {
    if (this.nCands === 0) return;
    this.decisionCount++;
    let pick = 0;
    if (this.rng.chance(this.P.blunder)) {
      this.blunderCount++;
      // a blunder: any candidate that is not the best (or does nothing)
      pick = this.rng.int(this.nCands);
      this.pushLog(ctx.tick, `blunder → ${this.cands[pick]!.name}`);
    } else {
      let max = -1e9;
      for (let i = 0; i < this.nCands; i++) max = Math.max(max, this.cands[i]!.score);
      let sum = 0;
      const T = this.P.temperature;
      for (let i = 0; i < this.nCands; i++) sum += Math.exp((this.cands[i]!.score - max) / T);
      let r = this.rng.next() * sum;
      for (let i = 0; i < this.nCands; i++) {
        r -= Math.exp((this.cands[i]!.score - max) / T);
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    }
    const c = this.cands[pick]!;
    this.build(c, ctx, S, F);
    if (c.what !== 'wait' && c.what !== 'strafe') this.pushLog(ctx.tick, `${c.name}: ${c.why} [score ${c.score.toFixed(2)}]`);
  }

  private build(c: Cand, ctx: AIContext, S: FighterView, F: Snapshot): void {
    const p = this.plan.begin(c.name, c.kind, ctx.tick, c.delay);
    const dx = F.x - S.x;
    switch (c.what) {
      case 'wait':
        p.add(0, Steer.Neutral, Math.max(4, c.ticks));
        break;
      case 'approach':
        p.add(0, Steer.Toward, Math.max(6, c.ticks), 0, 0, 1);
        break;
      case 'retreat':
        p.add(0, Steer.Away, Math.max(6, c.ticks));
        break;
      case 'strafe':
        p.add(0, Steer.Fixed, Math.max(6, c.ticks), 0, c.dirY);
        break;
      case 'guard':
        p.add(Btn.GUARD, Steer.Neutral, Math.max(6, c.ticks));
        break;
      case 'sidestep': {
        this.lastSurgeTick = ctx.tick + c.delay;
        p.add(Btn.SURGE, Steer.Fixed, 2, c.dirX, c.dirY);
        if (c.charge > 0 && this.followUp) {
          // the identity: sidestep, then lunge out of it while the follow-up window is open
          const wait = Math.max(0, this.followUp.from - 2 + this.jitter());
          p.add(0, Steer.Neutral, wait);
          p.add(Btn.STRIKE, Steer.Toward, 3, 0, 0, 1);
        }
        break;
      }
      case 'escape':
        p.add(Btn.SURGE, Steer.Away, 2);
        break;
      case 'ultimate':
      case 'attack': {
        const mi = c.info!;
        const btn = mi.slot === 'strike' ? Btn.STRIKE : mi.slot === 'crush' ? Btn.CRUSH : mi.slot === 'signature' ? Btn.SIGNATURE : Btn.ULTIMATE;
        const sy = this.aimSign(mi.aim);
        const hold = mi.chargeMax > 0 ? 1 + Math.round(mi.startup) + c.charge : 3;
        // approach first if the move reaches only when we are a little closer (lunges do part of the work)
        const dist = Math.abs(dx);
        const reachNow = mi.x1 * S.stats.reachMul + mi.lungeBefore + 40;
        if (mi.slot !== 'signature' && dist > reachNow + 20 && c.kind === 'attack' && c.what === 'attack') {
          const walk = clamp(Math.round((dist - reachNow) / (this.def.attributes.tempo * 13 + 130) * 60 * 0.8), 2, 24);
          p.add(0, Steer.Toward, walk, 0, 0, 1);
        }
        p.add(btn, Steer.Fixed, hold, 0, sy);
        // aimed variants need the stick held only while pressing; then let the fighter finish on its own
        if (this.P.feints && mi.slot === 'crush' && this.rng.chance(0.06 * this.persona.trap * 6) && mi.startup > 20) {
          p.count = 0;
          p.add(btn, Steer.Fixed, 6 + Math.floor(this.rng.next() * 8), 0, sy);
          p.add(Btn.FEINT, Steer.Neutral, 2);
          p.name += ' (feint bait)';
        }
        break;
      }
      default:
        p.add(0, Steer.Neutral, 6);
    }
  }

  /** While winding up: if a strong telegraph will land before our move does, feint out of it (levels ≥ 4). */
  private considerFeint(ctx: AIContext, S: FighterView, F: Snapshot, age: number): void {
    if (!this.P.feints || (S.phase !== 'startup' && S.phase !== 'charge')) return;
    if (this.scanThreats(S, F, age)) {
      const th = this.bestThreat;
      const remaining = S.moveTotal > 0 ? S.moveTick : 0;
      if (th.danger > 1.2 && th.until >= 0 && th.until < 14 && remaining >= 0 && this.rng.chance(this.P.defends)) {
        this.plan.begin('feint out', 'defend', ctx.tick, 0).add(Btn.FEINT, Steer.Neutral, 2);
        this.pushLog(ctx.tick, 'feint out of a windup: incoming threat lands first');
      }
    }
  }

  /** In hit-stun: after the brief window, break out with Surge (levels that know the trick). */
  private stunned(S: FighterView, F: Snapshot, out: InputFrame): void {
    this.plan.cancel();
    if (this.P.defends > 0.45 && this.stunAge >= 9 + this.jitter() && S.state === 'hitstun') {
      out.held = Btn.SURGE;
      out.moveX = -S.facing;
      if (this.stunAge === 9 + 0) this.pushLog(this.nowTick, `stun escape after ${this.stunAge} ticks`);
    }
    void F;
  }

  private pushLog(tick: number, msg: string): void {
    this.log.push(`t=${tick} ${msg}`);
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  /** Diagnostics: how old the foe observation used this tick is (≥ the level's reaction delay), and decision counters. */
  get perceivedFoeAge(): number {
    return this.lastAge;
  }
  get decisions(): number {
    return this.decisionCount;
  }
  get blunders(): number {
    return this.blunderCount;
  }

  /** Diagnostic access: the name of the plan being executed ('' when idle). */
  get currentPlan(): string {
    return this.plan.active ? this.plan.name : '';
  }
}
