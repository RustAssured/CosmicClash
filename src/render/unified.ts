import type { RenderLayer, StageLighting } from '@/contracts';
import type { UriLiveFx } from './uriLive';

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
    // the titans' paint (sim state) depends on this vector: sqrt, not Math.hypot (implementation-approximated, STEP0.md)
    const n = Math.sqrt(l[0]! * l[0]! + l[1]! * l[1]! + l[2]! * l[2]!);
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
  /**
   * 우리's shading plane (src/matter/uri/rig.ts uriShadePlane): per cell RGBA8 = (surf 1 warm / 2 cool, tone, edge distance, material
   * code). With it (and light), the part pass shades exactly as the oracle's shadeAt; the atlas colour then only gives coverage.
   */
  shade?: Uint8Array;
  /** 우리's chunk id per atlas cell (uri_rig.json chunk, uint16): the fists are drawn chunk by chunk. */
  chunk?: Uint16Array;
  /** 우리's live elements (cores, loop, orbit), drawn after the chamber part (uriLive.ts). */
  uriLive?: UriLiveFx;
}
export type RenderLayerLit = RenderLayer & LitLayerFields;

/**
 * Which layers are TITAN bodies (outlined, seamed, highlight-capped): world layers drawn normally in the body band z ∈ [−1, 10)
 * (the Witness's and 우리's rig atlases sit just behind their primary body, at z −0.5).
 * The contract reserves z ≥ 10 for effects (10 front debris / particles, 20 per-titan FX); additive glows never count.
 */
export function isTitanLayer(l: Pick<RenderLayer, 'space' | 'blend' | 'z'>): boolean {
  return l.space === 'world' && l.blend !== 'add' && l.z >= -1 && l.z < 10;
}

/** The shared bloom (UNIFICATION §5): two additive blurred passes of the emissives, σ ≈ 3 px and ≈ 10 px (CSS blur radii in the
 * oracles' compose: `blur(3px)` at 0.38 and `blur(10px)` at 0.28, uri-LOCKED-kinetic-pass.html / three-titans-scene.html). */
export const SHARED_BLOOM = { nearPx: 3, nearGain: 0.38, farPx: 10, farGain: 0.28 } as const;

/**
 * 우리 and the highlight ceiling (UNIFICATION §3 vs the oracle, which uses the stone's top step): WJ decides at Gate 2A.
 * true = 우리's stone may reach its ramp top as in the oracle; false = the shared ceiling applies. One switch.
 */
export const URI_CEILING_EXEMPT = false;

/**
 * D34 (WJ, 2026-10-09: the original's vivid colour and spectacle back, the best of both): which parts of the unified look stay.
 * Kept: the outline and depth seams, the one sky, 우리's shading, the shared VFX. Relaxed (each one switch):
 *  - `snapFinal`: the final 128-colour master snap of every pixel (off: titans keep their own colours, scenery its stage palette
 *    dither, glow and flashes add smoothly, quantised by the post pass's own Bayer steps as in the original);
 *  - `ceiling`: the highlight ceiling (only meaningful with the snap);
 *  - `stagePull`: stage palettes pulled toward the master (off: each stage its own palette);
 *  - `sharedBloom`: the two-pass shared bloom (off: the original five-level pyramid, stronger and wider);
 *  - `relight`: titans relit by the other bodies' lights (the original's warm cross-light).
 */
export const UNIFIED_LOOK = {
  snapFinal: false,
  ceiling: false,
  stagePull: false,
  sharedBloom: false,
  relight: true,
};

/**
 * D34 spectacle vs comfort. The comfort setting (UI "flash", 0..1) scales the screen-wide flashes; at or below COMFORT_D5 the
 * frame never washes (D5's limits: local light only, the luminance governor at its strict limit). Above it the washes come in
 * linearly and the governor relaxes toward SPECTACLE_GOVERNOR (the original game's washes reached a 0.32 rise).
 */
export const COMFORT_D5 = 0.5;
export const SPECTACLE_GOVERNOR = 0.4;
/** 0 at or below COMFORT_D5, 1 at full comfort scale 1 (no comfort reduction). */
export const spectacleOf = (comfort: number): number =>
  Math.max(0, Math.min(1, (comfort - COMFORT_D5) / (1 - COMFORT_D5)));
