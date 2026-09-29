/**
 * Damage model contract. Destruction IS the health system: a DamageEvent is applied to a matter map and the
 * target's MATERIALS decide the outcome. All geometry is in WORLD coordinates (logical px); the matter world
 * converts to body-local through `space.ts`. Facing/mirroring is therefore never the caller's problem.
 */

export const DAMAGE_TYPES = ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Shapes: point (disc), line (capsule/beam), cone (wedge), ring (annulus), field (soft radial falloff). */
export type DamageShape =
  | { kind: 'point'; x: number; y: number; r: number }
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number; width: number }
  | { kind: 'cone'; x: number; y: number; dirX: number; dirY: number; range: number; halfAngle: number }
  | { kind: 'ring'; x: number; y: number; r0: number; r1: number }
  | { kind: 'field'; x: number; y: number; r: number; falloff: number };

/** Bit flags altering how a type resolves. */
export const DamageFlag = {
  /** Effect continues through the whole shape instead of stopping at the first surface layer. */
  PIERCE: 1,
  /** FRACTURE: plant a crack network at the contact that spreads over the following seconds. */
  SEED_CRACK: 2,
  /** ASSIMILATION: chains latch (infection begins at the contact and spreads along bonds). */
  LATCH: 4,
  /** KINETIC: leave embedded shrapnel that fractures outward after `embedDelay` ticks. */
  EMBED: 8,
  /** Effect is a continuous field applied every tick (Gaze, Tidal pull): energy is PER TICK. */
  CONTINUOUS: 16,
  /** Ignore the target's Guard shell (unblockable / grabs). */
  UNBLOCKABLE: 32,
  /** Reveal-only tuning knob for the finishing blow: extra debris scatter. */
  FINISHER: 64,
} as const;

/** Type-specific tuning. All optional; the matter world documents the defaults it uses. */
export interface DamageParams {
  /** FRACTURE/KINETIC/CRUSH: max depth in cells the effect may bore. */
  penetration?: number;
  /** FRACTURE: number of crack seeds planted when SEED_CRACK is set. */
  crackSeeds?: number;
  /** FRACTURE: stress carried by each crack front (higher spreads further/faster). */
  crackStress?: number;
  /** THERMAL: heat units deposited per cell inside the shape (per event, or per tick if CONTINUOUS). */
  heat?: number;
  /** THERMAL/CRUSH: radial shock impulse imparted to loosened material (px/s scale). */
  shock?: number;
  /** KINETIC: shrapnel fragments embedded. */
  embed?: number;
  /** KINETIC: ticks before embedded shrapnel fractures outward. */
  embedDelay?: number;
  /** ASSIMILATION: infection deposited per cell (0..255 per event/tick). */
  latch?: number;
  /** ASSIMILATION: 0..1 how aggressively converted lattice is harvested (torn out and credited to attacker). */
  harvest?: number;
  /** TIDAL: force scale of the pull toward (originX, originY). */
  pull?: number;
  /** CRUSH: compression depth in cells; also sets crater size. */
  compress?: number;
  /** KINETIC/CRUSH: crater radius in cells (overrides shape-derived default). */
  crater?: number;
  /** Extra debris scatter multiplier (1 = default). */
  scatter?: number;
}

export interface DamageEvent {
  type: DamageType;
  shape: DamageShape;
  /**
   * Abstract energy. Calibration (matter world must honour): 1 energy ≈ enough to fully destroy ONE cell of a
   * baseline material (density 1, integrity 255, resistance 1). A Strike is ~150–500, a Crush ~800–2500,
   * an Ultimate ~4000–9000. Energy is spread over the cells inside the shape, weighted by the shape's falloff.
   */
  energy: number;
  /** Unit direction of the force in world space (where the blow is heading). */
  dirX: number;
  dirY: number;
  /** Ticks over which energy is delivered (0/1 = instant). With CONTINUOUS the energy is per tick. */
  duration: number;
  /** Attacker's current effective mass (relative to titan MASS attribute scale ×, i.e. 1..~12+): scales impulse/debris speed. */
  sourceMass: number;
  /** Body id of the attacking body (credit target for mass transfer: accretion/harvest). -1 if environmental. */
  sourceBodyId: number;
  /**
   * World-space focal point of the attacker (Black Hole centre, Nexus hub, Supernova core): where TIDAL matter is
   * pulled to and ASSIMILATION harvest flows to; mass arriving here is credited to `sourceBodyId`.
   */
  originX: number;
  originY: number;
  flags: number;
  params: DamageParams;
}

/** What the caller (combat) learns immediately from an applied event. */
export interface DamageResult {
  /** Solid cells the shape touched (0 = whiff). */
  cellsTouched: number;
  /** Cells removed from the body outright this call. */
  cellsRemoved: number;
  /** Mass (in mass units) removed, and how much of it became attacker-credited transfer. */
  massRemoved: number;
  massTransferred: number;
  /** World-space centroid of the affected cells (contact point for FX/audio); NaN if nothing touched. */
  contactX: number;
  contactY: number;
  /** Momentum imparted to the body (mass·px/s, world space) — combat converts to knockback via its own mass. */
  impulseX: number;
  impulseY: number;
  /** 0..1 how much of the effect landed on already-weakened matter (drives "punish damaged regions" feedback). */
  onDamagedFraction: number;
  /** True if this call exposed core/interior layers that were hidden before. */
  revealedInterior: boolean;
}

export const EMPTY_DAMAGE_RESULT: Readonly<DamageResult> = Object.freeze({
  cellsTouched: 0,
  cellsRemoved: 0,
  massRemoved: 0,
  massTransferred: 0,
  contactX: NaN,
  contactY: NaN,
  impulseX: 0,
  impulseY: 0,
  onDamagedFraction: 0,
  revealedInterior: false,
});

/** Read-only pixel-accurate overlap probe (hit detection). */
export interface OverlapResult {
  /** Number of solid cells inside the shape. */
  cells: number;
  /** World centroid of overlapping cells (NaN if none) and the cell nearest the shape origin. */
  x: number;
  y: number;
  nearestX: number;
  nearestY: number;
  /** Fraction of integrity-weighted matter overlapped, 0..1 of a full shape. */
  coverage: number;
}
