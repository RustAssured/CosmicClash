import {
  AIM_DIRS,
  TICK_DT,
  type AimDir,
  type DamageType,
  type MoveDef,
  type MoveSlot,
  type ShapeTemplate,
  type TitanDef,
} from '@/contracts';
import { DamageFlag } from '@/contracts';
import { instantiateTemplate, makeFatShape, shapeBounds } from '@/combat/shapes';

/**
 * Precomputed facts about one aim variant of one move: frame data and the region its hitboxes sweep, relative to the anchor
 * for a right-facing fighter at nominal reach. This is the AI's "lightweight model" of a move: enough to ask
 * "if I press this now, can it reach the foe, when, and for how much?" without simulating anything.
 */
export interface MoveInfo {
  /** Index in the titan's MoveInfo list (stable): keys the AI's per-variant "is this landing?" memory. */
  idx: number;
  def: MoveDef;
  slot: MoveSlot;
  aim: AimDir;
  startup: number;
  active: number;
  recovery: number;
  chargeMax: number;
  total: number;
  /** Union AABB of every hitbox (start and end of sweeps), relative to the anchor, facing +1, nominal reach. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Nominal total energy if everything connects (continuous hitboxes count up to a sensible dwell). */
  energy: number;
  type: DamageType;
  beam: boolean;
  projectile: boolean;
  heavy: boolean;
  /** Forward travel (px) accumulated by the movement keys before the active phase starts / during it. */
  lungeBefore: number;
  lungeDuring: number;
  /** Fraction of the damage dealt that comes back on the attacker (rams: `extra.recoil` in the move JSON). */
  recoil: number;
  /** Plants an infection (a setup for a harvest) / tears infected matter out (pays off only on an infected foe). */
  latch: boolean;
  harvest: boolean;
  meterCost: number;
  resourceCost: number;
  /** Tick range (relative to the first active tick) in which any hitbox is live. */
  hitFrom: number;
  hitTo: number;
  hasHitboxes: boolean;
  /**
   * The axis of the move's principal straight hitbox (a fixed, non-sweeping line: beams) relative to the anchor, facing +1,
   * nominal reach. A diagonal beam's bounding box is mostly empty corner, so hit probability is judged along this axis instead.
   */
  line: { x0: number; y0: number; x1: number; y1: number; width: number } | null;
}

const tmp = makeFatShape();
const bb = { x0: 0, y0: 0, x1: 0, y1: 0 };

function templateExtent(
  t: ShapeTemplate,
  scale: number,
  into: { x0: number; y0: number; x1: number; y1: number },
): void {
  instantiateTemplate(t, { x: 0, y: 0, facing: 1, scale }, tmp);
  shapeBounds(tmp as never, bb);
  into.x0 = Math.min(into.x0, bb.x0);
  into.y0 = Math.min(into.y0, bb.y0);
  into.x1 = Math.max(into.x1, bb.x1);
  into.y1 = Math.max(into.y1, bb.y1);
}

/** Forward displacement of the anchor caused by a move's movement keys, simulated tick by tick with the same decay maths. */
function travel(
  keys: readonly { at: number; ix: number; iy: number; damp?: number }[],
  until: number,
  from = 0,
): number {
  let v = 0;
  let x = 0;
  let damp = 1;
  let ki = 0;
  const sorted = keys.slice().sort((a, b) => a.at - b.at);
  for (let t = 0; t < until; t++) {
    while (ki < sorted.length && sorted[ki]!.at <= t) {
      const k = sorted[ki++]!;
      v += Math.hypot(k.ix, 0) * Math.sign(k.ix);
      if (k.damp !== undefined) damp = k.damp;
    }
    v *= Math.pow(damp, TICK_DT);
    if (t >= from) x += v * TICK_DT;
  }
  return x;
}

/**
 * The model of a move whose hit volumes come from the live body rather than JSON hitboxes (the Witness's kit): a union box
 * (facing +1, px from the anchor), the window in which any volume is live (ticks from the first active tick), and what a
 * clean connection is worth. A move may publish its own as `extra.aiReach` (one descriptor, or one per aim; proposal 167);
 * otherwise the stand-ins below apply. The AI learns the real yield against each foe (`damageLearned`), so these only have
 * to put the move in the right place and order of magnitude.
 */
export interface AiReach {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  from: number;
  to: number;
  energy: number;
  line?: { x0: number; y0: number; x1: number; y1: number; width: number };
  beam?: boolean;
  projectile?: boolean;
}

/**
 * Stand-ins derived from `src/combat/behaviours/witnessKit.ts` and the v3 Witness (f4e48d6), keyed by `extra.witness`:
 *  - halo: five arcs (radius 100 round the eye) swing through the lane and each sheds a shard AT THE FOE at 9 px/tick for
 *    34 ticks, launched at move tick 12 + 3k (110 energy per shard, 90 per arc that touches): the volley converges on the
 *    foe from a ±100 px spread and reaches ≈ 300 px;
 *  - sweep (up / forward): the front arm blades (six crescent arms, tips ≈ 185 px from the eye, 440 energy each) sweep the
 *    front during the active phase and the first 60 % of recovery;
 *  - revelation: 3 + open-eye gaze beams of 276 px fanned ±0.65 rad (± a slow 0.35 rad turn) round the aim, 70 energy every
 *    6 ticks, each landing beam laying a 170-energy fracture.
 */
const KIT_REACH: Record<string, AiReach> = {
  // aimed shards land more of the volley than the old parallel ones (~3 of 5 against the Planet): 330
  halo: { x0: -20, y0: -100, x1: 300, y1: 100, from: 2, to: 50, energy: 330, projectile: true },
  sweep: { x0: 30, y0: -125, x1: 185, y1: 135, from: 0, to: 34, energy: 700 },
  revelation: {
    x0: 20,
    y0: -150,
    x1: 276,
    y1: 150,
    from: 0,
    to: 84,
    energy: 1100,
    line: { x0: -2, y0: -1, x1: 276, y1: 0, width: 60 },
    beam: true,
  },
};

function standInReach(m: MoveDef, aim: AimDir): AiReach | null {
  const own = m.extra?.['aiReach'] as AiReach | Partial<Record<AimDir, AiReach>> | undefined;
  if (own) return 'x0' in own ? (own as AiReach) : ((own as Partial<Record<AimDir, AiReach>>)[aim] ?? null);
  const kit = m.extra?.['witness'] as string | undefined;
  return kit ? (KIT_REACH[kit] ?? null) : null;
}

export function buildMoveInfos(def: TitanDef): MoveInfo[] {
  const out: MoveInfo[] = [];
  const reach = def.attributes.reach / 5;
  for (const m of def.moves) {
    for (const aim of AIM_DIRS) {
      const v = m.variants[aim];
      const fr = { ...m.frame, ...(v.frame ?? {}) };
      const ext = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      let energy = 0;
      let type: DamageType = def.destruction;
      let beam = false;
      let hitFrom = 1e9;
      let hitTo = -1;
      let bestE = -1;
      let line: MoveInfo['line'] = null;
      let bestLineE = -1;
      let latch = false;
      let harvest = false;
      for (const hb of v.hitboxes) {
        const s = Math.pow(reach, hb.reachScale ?? 1);
        templateExtent(hb.shape, s, ext);
        if (hb.sweepTo && hb.sweepTo.kind === hb.shape.kind) templateExtent(hb.sweepTo, s, ext);
        const continuous = (hb.damage.flags & DamageFlag.CONTINUOUS) !== 0;
        // a foe rarely stays inside a beam for its whole window: count a realistic dwell
        const dwell = continuous ? Math.min(hb.to - hb.from, 14) / Math.max(1, hb.rehit ?? 1) : 1;
        energy += hb.damage.energy * dwell;
        if (hb.damage.type === 'ASSIMILATION') {
          if ((hb.damage.params.harvest ?? 0) > 0) {
            harvest = true;
            // tearing out converted matter costs the target far more than the raw energy says (measured 6x on the Nexus)
            energy += hb.damage.energy * dwell * 6 * hb.damage.params.harvest!;
          } else if ((hb.damage.params.latch ?? 0) > 0) latch = true;
        }
        if (hb.damage.energy > bestE) {
          bestE = hb.damage.energy;
          type = hb.damage.type;
        }
        if (continuous && hb.shape.kind === 'line') beam = true;
        if (hb.shape.kind === 'line' && !hb.sweepTo && hb.damage.energy > bestLineE) {
          bestLineE = hb.damage.energy;
          instantiateTemplate(hb.shape, { x: 0, y: 0, facing: 1, scale: s }, tmp);
          line = { x0: tmp.x0, y0: tmp.y0, x1: tmp.x1, y1: tmp.y1, width: tmp.width };
        }
        hitFrom = Math.min(hitFrom, hb.from);
        hitTo = Math.max(hitTo, hb.to);
      }
      let has = v.hitboxes.length > 0 && ext.x1 > -1e8;
      // a move whose volumes come from the live body (no JSON hitboxes) is judged by its stand-in reach
      const stand = has ? null : standInReach(m, aim);
      if (stand) {
        has = true;
        ext.x0 = stand.x0;
        ext.y0 = stand.y0;
        ext.x1 = stand.x1;
        ext.y1 = stand.y1;
        energy = stand.energy;
        hitFrom = stand.from;
        hitTo = stand.to;
        line = stand.line ?? null;
        beam = stand.beam ?? false;
      }
      out.push({
        idx: out.length,
        def: m,
        slot: m.slot,
        aim,
        startup: fr.startup,
        active: fr.active,
        recovery: fr.recovery,
        chargeMax: fr.chargeMax,
        total: fr.startup + fr.active + fr.recovery,
        x0: has ? ext.x0 : 0,
        y0: has ? ext.y0 : 0,
        x1: has ? ext.x1 : 0,
        y1: has ? ext.y1 : 0,
        energy,
        type,
        beam,
        projectile: m.tags.includes('projectile') || m.tags.includes('swarm') || !!stand?.projectile,
        heavy: m.slot === 'crush' || m.slot === 'ultimate' || energy >= 700,
        lungeBefore: travel(v.movement, fr.startup),
        lungeDuring: travel(v.movement, fr.startup + fr.active, fr.startup),
        recoil: (m.extra?.['recoil'] as number | undefined) ?? 0,
        latch,
        harvest,
        meterCost: m.meterCost,
        resourceCost: m.resourceCost,
        hitFrom: has ? hitFrom : 0,
        hitTo: has ? hitTo : 0,
        hasHitboxes: has,
        line: has ? line : null,
      });
    }
  }
  return out;
}

/** Distance a surge covers (px) along its dash direction, from the move's first movement key. */
export function surgeDistance(def: TitanDef): number {
  const m = def.moves.find((x) => x.slot === 'surge');
  if (!m) return 0;
  const k = m.variants.forward.movement[0];
  if (!k) return 0;
  const damp = k.damp ?? 0.05;
  const rate = -Math.log(Math.max(1e-4, Math.min(0.999, damp)));
  return Math.hypot(k.ix, k.iy) / rate;
}
