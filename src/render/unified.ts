import type { RenderLayer, StageLighting } from '@/contracts';

/**
 * The unified titan look (shared/UNIFICATION.md, D31-4): the one sky every titan is lit by, and the per-layer extras the
 * unified path reads (docs/proposals/167: they move into contracts/render.ts once approved).
 */

/**
 * ONE SKY for every titan (UNIFICATION §1). Stages keep their own lighting for their scenery; titans are lit by this.
 * - Key direction: upper-left-front, the oracles' own (uri/src/10_parts_render.js `LS` = normalize(−0.55, −0.62, 0.56), the
 *   same vector in three-titans-scene.html), FROM the surface TOWARD the light, view space (x right, y down, z toward camera).
 * - Key colour: neutral white (the oracles shade ramp steps, they do not tint the key).
 * - Rim: the oracle Witness's rim, rgb 127 180 255 (three-titans-scene.html), an entry of the oracles' shared palette.
 * - Ambient: the oracle Witness's shading floor (0.08 of the key).
 * - `screenPos` is unused for titans (god rays follow the stage's own light).
 */
export const TITAN_SKY: StageLighting = Object.freeze({
  dir: (() => {
    const l = [-0.55, -0.62, 0.56];
    const n = Math.hypot(l[0]!, l[1]!, l[2]!);
    return [l[0]! / n, l[1]! / n, l[2]! / n] as [number, number, number];
  })(),
  color: '#ffffff',
  ambient: '#141414',
  rim: '#7fb4ff',
  screenPos: [0.2, 0.1] as [number, number],
}) as StageLighting;

/**
 * Lit parts (proposal 167 §2): a layer with `light` carries, per atlas cell, the part's normal and its reference form light —
 * r = nx, g = ny (both (v − 128) / 120, as uri_rig.json), b = nz (v / 250), a = form light (0..255). The part pass then blends the
 * cell's form light with live light from TITAN_SKY by how far the part is rotated: wForm = 0.82 · max(0, cos θ)³ (URI_SPEC §2.3).
 * `wet` marks materials allowed to reach the palette's top step (UNIFICATION §3) — R8, per cell, 0 / 255.
 */
export interface LitLayerFields {
  light?: Uint8Array;
  wet?: Uint8Array;
}
export type RenderLayerLit = RenderLayer & LitLayerFields;

/**
 * Which layers are TITAN bodies (outlined, seamed, highlight-capped): world layers drawn normally in the body band z ∈ [0, 10).
 * The contract reserves z ≥ 10 for effects (10 front debris / particles, 20 per-titan FX); additive glows never count.
 */
export function isTitanLayer(l: Pick<RenderLayer, 'space' | 'blend' | 'z'>): boolean {
  return l.space === 'world' && l.blend !== 'add' && l.z >= 0 && l.z < 10;
}

/** The shared bloom (UNIFICATION §5): two additive blurred passes of the emissives, σ ≈ 3 px and ≈ 10 px (CSS blur radii in the
 * oracles' compose: `blur(3px)` at 0.38 and `blur(10px)` at 0.28, uri-LOCKED-kinetic-pass.html / three-titans-scene.html). */
export const SHARED_BLOOM = { nearPx: 3, nearGain: 0.38, farPx: 10, farGain: 0.28 } as const;
