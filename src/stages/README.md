# src/stages — arenas, palettes and the living backdrops

Owner: B1. `STAGES` (arena, lighting, palette for all five stages) is available **immediately and without GL**; scenery is created on demand.

```ts
import { STAGES, createScenery, isStageImplemented } from '@/stages';
STAGES.nursery.lighting.dir;          // unit vector toward the key light — titan generators shade with this
isStageImplemented('nursery');        // true only for stages with bespoke scenery
createScenery('rim');                 // GenericScenery stand-in until Phase 2 (still reactive, palette-dithered, parallax)
```

* `info.ts` (pure, no three): `STAGE_INFO`/`STAGES` (`StageInfo` ×5, validated by `validateStageInfo` in `info.test.ts`) and `STAGE_RAMPS` (ramp lengths of each palette, used by the dither).
  Palettes are built from `hueShiftRamp`s. **Palette rules:** (a) write ramps dark → light and list each ramp's length in `STAGE_RAMPS`; (b) hue-adjacent ramps must be **bridged** (nursery: magenta → *coral* → amber),
  otherwise gradients between them jump; (c) keep 40–64 colours; (d) one near-black "void" ramp for the sky, dust ramp(s) for occluders, a hot ramp for stars; (e) when a ramp drifts across the red seam write
  `−0.01`/`1.03`, not `0.99`/`0.03` (hue interpolation is numeric). `npx tsx tools/render/palette-sheet.ts` writes swatches; `tools/render/dither-preview.ts` shows the dither on synthetic images.
* `types.ts`: `StageScenery { look, init(ctx), update(frame), render(hdrTarget), lightScreenPos(out), dispose() }`. A scenery draws **linear HDR** into the target the renderer hands it (rgb = radiance, alpha = occluder opacity that cuts
  god rays; additive layers must not write alpha). The renderer lenses, tone-maps and palette-dithers it. `SceneryFrame` carries the scenery clock (follows `fx.timeScale`), the integer view origin (parallax derives from it),
  the camera and screen-space packed fight forces.
* `scenery.ts`: `createScenery` / `isStageImplemented`. `generic.ts`: data-driven fallback (sky, warped fbm gas, particle puffs, dust lanes, stars, foreground motes) tinted per stage.
* `nursery/`: **Stellar Nursery** (see below). `toolkit/`: the shared scaffolding — stages 2–5 should be *content* built from it.

## The toolkit (`toolkit/`)

| module | what |
|---|---|
| `kit.ts` | `SceneryKit`: one Scene of parallax layers drawn back-to-front into the HDR target with shared uniforms (view origin, clocks, fight forces). `addSprites` (instanced soft sprites: puff / diffraction star / ring, curl-noise drift, twinkle, snap-to-pixel), `addFullscreen` (procedural shader body with noise + force helpers), `addQuad` (baked texture with fight displacement) |
| `glsl.ts` | texture-based value noise + fbm + curl (one fetch per octave), `warpByForces` (shockwave rings push, impulses swirl), `impulseGlow` |
| `nebula.ts` | `addNebula`: domain-warped fbm gas / dust layer with a lit-side term and spatial mask |
| `clouds.ts`, `stars.ts` | rejection-sampled particle clouds, star fields with blackbody tints, `layerBounds` (what a parallax layer must cover) |
| `bake.ts` | GPU baking (`runBake`): sculpt a texture once at load with a fragment shader instead of every frame |
| `ambient.ts` | comets + distant supernova flares as a **pure function of time** (identical for a given clock reading) |
| `noise.ts`, `color.ts` | seeded CPU noise for placement; palette → linear ramps (`paletteRamps`, `rampAt`) so scenery colours are authored *on* the palette ramps |

Parallax model: a layer with parallax `p` shows content at `layer − view.origin × p`; `p = 0` is screen-fixed, `1` moves with the fighters, `> 1` slides past faster. `layerBounds(arena, p)` gives the rectangle to fill.
Compose against the **reference camera** (arena centre: view origin 480,110) with `atRef(screenX, screenY, p)`.

## Stellar Nursery (`nursery/`)

Back to front: `sky` · `stars-far` · comets & flares · `glow` (luminous haze: intensity falls off from the newborn stars, ramp indigo → magenta → coral → amber → white, fbm + ridged filaments) · `gas-mid` · `nebula-far` (5.5 k soft
particles) · `stars-mid` · `hero-*` (newborn stars with a hot core, halo and thin 4-point + faint diagonal diffraction) · `pillars-far` (hazy) · `dust-lanes` · **`pillars`** (art-directed columns, GPU-sculpted) · `wisps` · `dust-near` ·
`mist` (the ground) · `motes`.

**Pillars** (`pillars.ts`): a layout of round-cone chains (spine, flank lobes, crown knobs, EGG globules, curling fingers) is smooth-unioned into a signed-distance field in pass A (domain-warped, eroded at three scales,
fibre + billow noise). Pass B lights it: a **cylinder normal** from scanning to both edges (so the whole width shades as a rounded column), plus distance-field gradients for crowns and undercuts and fibre bumps, a *grazing* key light
(from `StageInfo.lighting.dir`, so titans and pillars agree), 12-step self-shadowing, a 4-stop dust ramp, and an **ionisation rim** — a 1 px white-gold line hugging the lit edges with a soft coral/magenta halo and a teal back-scatter
on the far side. Output is two textures (dust with opacity, additive glow), drawn NEAREST at whole-pixel parallax offsets so silhouettes stay crisp and never shimmer. Hand-placed columns come from `atCol(screenX, crownScreenY, p)`.
Fight reactions: shock rings ripple every layer, impulses swirl and warm them (`impulseGlow`), `intensity` brightens the rims, `timeScale` slows all flow.

## Adding a stage (Phase 2 recipe)

1. Palette + lighting already exist in `info.ts` (adjust ramps, keep `STAGE_RAMPS` in sync).
2. `class XScenery implements StageScenery`, `init`: `const kit = new SceneryKit(ctx, seed)`; add layers back-to-front with `addNebula` / `addSprites` / `addFullscreen` / `addQuad`; author colours with `paletteRamps(info)`.
3. `update(frame)` → `kit.update(frame)` (+ your own per-frame state), `render(target)` → `kit.render(renderer, target)`, `lightScreenPos` → where the stage light currently is (follow its parallax), `dispose`.
4. Register it in `scenery.ts` (`IMPLEMENTED` + `createScenery`). Use `tools/render/layers.mjs --only=…` to look at layers alone and `capture.mjs` for the eight fight states.

## Testing

`npx vitest run src/stages` — stage info validation (all five, palette sizes, unit lighting), noise / star / cloud determinism and distribution, `layerBounds` coverage, ramp splitting, ambient life (pure function of time, comets and flares
appear, idle sprites parked), pillar layout (deterministic, segment budget, art-directed columns honoured, fillers never overlap them). GPU behaviour is covered by `node tools/render/verify.mjs`.
