# 167 — S5 → Lead: contract additions for the unified look (Phase 1, D31)

**Owner of the change:** Lead (contracts, app). **Author:** S5. **Status:** proposed. Everything is additive. It works today
through typed extensions in `src/render/unified.ts` and `src/render/vfx.ts`.

## 1. One sky for titans: `TITAN_LIGHTING` in contracts, passed by the app

- **Today:** `src/render/unified.ts` exports `TITAN_SKY: StageLighting`.
  - Direction: the oracles' `LS` = normalize(−0.55, −0.62, 0.56), upper-left-front.
  - Key: `#ffffff`.
  - Rim: `#7fb4ff`, the oracle Witness's rim.
  - Ambient: `#141414`, the oracle shading floor.
- **Ask:**
  - Move the constant to `contracts/render.ts` as `TITAN_LIGHTING`.
  - `app.ts` passes it to `createMatch` (`lighting:`) and to `renderPortrait`, instead of `stage.lighting`.
- The match lighting feeds the titan painters and the matter shading only. Stages keep `StageInfo.lighting` for their scenery, palette and god rays.
- `dev/render/unify.ts` already does this for the Gate 1 captures.
- **Check:** grep found no sim or physics use of the lighting, so match hashes should be unchanged.

## 2. Lit parts: `RenderLayer.light` and `RenderLayer.wet`

```ts
interface RenderLayer {
  // …
  /** Per atlas cell: r = nx, g = ny ((v − 128) / 120), b = nz (v / 250), a = reference form light (URI_SPEC §3 fields). */
  light?: Uint8Array;   // w × h × 4
  /** Per cell 0 / 255: wet or emissive materials allowed to reach the palette's top step (UNIFICATION §3). */
  wet?: Uint8Array;     // w × h
}
```

- The part pass blends the reference form light with live light from the one sky.
  - `wForm = 0.82 · max(0, cos θ)³`, where θ is the part's rotation step.
  - The painted atlas is the rest look; the part is scaled by `lum(θ) / lum(0)` and the final snap steps it back onto its ramp.
- 우리 (Phase 2) fills these fields from `uri_rig.json`. The Witness may opt in.
- `layerCache` / `LayerTextures` upload them with the layer, and recreate the texture when the arrays change.
- GPU check: "lit parts" passes. At rest the result is identical to the unlit part (120.0 vs 120.0). Turned 180° it is relit, 83.0 vs 120.0.

## 3. `FrameFx.vfx`: the shared impact VFX

```ts
interface VfxImpact { x: number; y: number; weight: 0 | 1 | 2 | 3; age: number; dirX: number; dirY: number; seed: number;
  matter: 'rock' | 'witness' | 'planet' | 'mouth' | 'uri' }
interface FrameFx { /* … */ vfx?: readonly VfxImpact[] }
```

- `FxState` fills it from `hit.weight` (proposal 171). The weight index is `BLOW_WEIGHTS.indexOf`; it could take `BlowWeight` directly once this lands.

## 4. Which layers are titan bodies

- **Today:** `isTitanLayer` treats a layer as a titan body when it is world space, normal blend, and `0 ≤ z < 10`. That follows the contract's reserved bands (effects at z ≥ 10).
- Titan bodies get the outline, depth seams and highlight ceiling.
- **Ask (optional):** an explicit `RenderLayer.role?: 'titan' | 'effect' | 'backdrop'`, so a titan glow or a backdrop in the body band is never outlined by accident.
