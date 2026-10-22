import type { RenderLayer } from '@/contracts';

/**
 * A titan's SIGNATURE ANIMATION (docs/SIGNATURE.md): render-only motion of the body layer itself. The matter (sim, hit-testing,
 * damage) stays where it is; the compositor draws the body layer through `signaturePass.ts`, which warps WHERE each screen
 * pixel samples the live body map: a rigid spin and a differential twist in a tilted flow plane, a radial pulse, a Doppler
 * relight, and lensed images of the far side of the flow around an occluder. Because it samples the live map, holes and damage
 * move with the animation.
 *
 * Plain data, no GL: a behaviour fills it (combat imports this type) from snapshotted tick state at render time (S19) and puts
 * it on its body layer (`decorateBodyLayer`); the sim never reads it.
 */

/** What each body-map cell does under the signature pass (one byte per cell in `SignatureFx.roles`). */
export const SIG_ROLE = {
  /** Drawn where it is (jets, limbs, everything not in the flow). */
  still: 0,
  /** Part of the flow: re-sampled through the spin / twist / pulse. Empty cells inside the flow's region should be `flow` too,
   *  so the flow's ragged edge travels with it. */
  flow: 1,
  /** The occluder at the centre (a horizon, a core): drawn where it is; the flow behind it is hidden, its front passes over it. */
  occluder: 2,
  /** A lensed image of the flow's far side (an arc hugging the occluder): shows the flow, bent round, where the cell exists. */
  lensed: 3,
} as const;

export interface SignatureFx {
  /** Role per body-map cell (w × h, `SIG_ROLE`); bump `rolesVersion` when it changes (it is uploaded once per version). */
  roles: Uint8Array;
  rolesVersion: number;
  /** Centre of the motion, body-map cells (sprite-local, unmirrored: the pass mirrors with the layer). */
  cx: number;
  cy: number;
  /** The flow plane: a disc rotated by `tilt` (rad) and squashed vertically by `squash` (1 = face on, a circle). */
  tilt: number;
  squash: number;
  /** Plane radii (cells) of the flow's inner edge (fastest) and outer edge. */
  rIn: number;
  rOut: number;
  /** Presentation time in seconds (from the snapshotted tick and the render alpha: never wall clock). */
  t: number;
  /** Rigid rotation of the whole flow, rad (+ = the plane's angle grows). An angle, not a rate, so a titan can speed up
   *  without a jump: accumulate it from snapshotted ticks (the Black Hole spins faster while it holds its Well). */
  spin: number;
  /** Differential rotation: extra rad/s at `rIn`, falling off as (rIn / r)^shearK to nothing at `rOut` (inner gas orbits
   *  faster). It is drawn as two bounded twists, reset every `shearPeriod` s and dissolved into each other, so the texture
   *  never winds up. 0 = rigid. */
  shearRate: number;
  shearK: number;
  shearPeriod: number;
  /** Radial pulse: the flow samples r · (1 − pulseAmp · sin(pulseRate · t − pulseWave · r)) (a breathing / travelling ring). */
  pulseAmp: number;
  pulseRate: number;
  pulseWave: number;
  /** Doppler relight: brightness ∝ 1 + doppler · (p · dir) / rOut in the plane; the painted beaming stays fixed on screen as
   *  the matter moves through it. dir = the approaching direction (plane unit vector). 0 = off. */
  doppler: number;
  dopplerX: number;
  dopplerY: number;
  /** Co-moving brightness arms: the flow is lit by ×(1 + streak · cos(streakArms · a − streakWind · r)) in the MATTER's own
   *  angle a (where the sample came from), so the light rides with the gas, spins and shears with it: it is what makes a fine
   *  painted texture read as orbiting. 0 = off. */
  streak: number;
  streakArms: number;
  streakWind: number;
  /** Occluder radius (cells, screen circle): a flow pixel left empty inside it shows the occluder (the cell at cx, cy). */
  hole: number;
  /** Lensed images (`lensed` cells): screen radius where the arc starts (informational), and how fast the arc's cells stream
   *  round the centre, as a multiple of `spin` (each half, over and under, wraps on itself; it runs opposite to the near side). */
  lensRing: number;
  lensSpin: number;
  /** Brightness of the lensed far side (1 = as painted). */
  lensGain: number;
}

/** A body layer with a signature (the compositor looks for `signature` on plain, non-rig layers). */
export type RenderLayerSig = RenderLayer & { signature?: SignatureFx };

/** Global switch (dev / A-B captures: `?sig=0`). Off = the plain body layer, the behaviours' fallback overlays. */
export const SIGNATURE = { on: true };

/** A signature with everything off (centre 0, nothing moves); fill the fields the titan uses. */
export function makeSignature(w: number, h: number): SignatureFx {
  return {
    roles: new Uint8Array(w * h),
    rolesVersion: 1,
    cx: w / 2,
    cy: h / 2,
    tilt: 0,
    squash: 1,
    rIn: 1,
    rOut: Math.max(w, h),
    t: 0,
    spin: 0,
    shearRate: 0,
    shearK: 1,
    shearPeriod: 4,
    pulseAmp: 0,
    pulseRate: 0,
    pulseWave: 0,
    doppler: 0,
    dopplerX: -1,
    dopplerY: 0,
    streak: 0,
    streakArms: 2,
    streakWind: 0,
    hole: 0,
    lensRing: 0,
    lensSpin: 1,
    lensGain: 1,
  };
}
