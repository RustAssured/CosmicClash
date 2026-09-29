# src/stages — arenas, palettes and the living backdrops

Owner: B1. `STAGES` (arena, lighting, palette for all five stages) is available **immediately and without GL**; scenery is created on demand and prepared in the background.

```ts
import { STAGES, createScenery, isStageImplemented } from '@/stages';
STAGES.nursery.lighting.dir;          // unit vector toward the key light — titan generators shade with this
STAGES.rim.lighting.screenPos;        // where the stage light sits on screen at the reference camera (god rays start here)
isStageImplemented('quasar');         // true for all five stages: every one has bespoke scenery
createScenery('tussenruimte');        // a StageScenery; the renderer prepares it (Renderer.prepareStage) and draws it
```

## The five stages

| stage | idea | palette | signature |
|---|---|---|---|
| **Stellar Nursery** (`nursery/`) | dust pillars rise into the glare of newborn suns | magenta · coral · amber · teal ionisation · blue-white | GPU-sculpted pillars with ionisation rims, diffraction-spiked newborn stars, luminous haze, god rays |
| **Galactic Rim** (`rim/`) | the edge of a vast turning spiral galaxy | teal · pale jade · gold · warm white | a **differentially rotating** grand-design galaxy (analytic disc + 30 k resolved 3-D stars, dust lanes) tilted across the top of the frame, far galaxies, torn dust banks lit teal |
| **Red Giant's Wake** (`redgiant/`) | a dying sun exhales its shells | ember · orange · rose · violet · teal | a giant star with convection cells just beyond the top edge, **expanding planetary-nebula shells** that cool ember → rose → violet → teal, a tail of shed gas, an ember wind streaming from the star |
| **Quasar Void** (`quasar/`) | almost nothing, and one thing of terrible power | near-black · ice-blue · violet · indigo · a sliver of ember | a razor **relativistic jet** with a violet sheath, knots racing along it, a slow helical writhe, plasma flecks; the core blazes beyond the corner; cosmic-web filaments |
| **Tussenruimte** (`tussenruimte/`) | between two galaxies there is only stillness | celadon · sage · pale warm · black | two dim galaxies at the frame edges, **a bridge** of gas and stars between them with a globular "lantern", the sparsest sky, almost no motion — so a shockwave visibly bends it |

Every stage has: parallax depth (sky 0.02 → far stars 0.03 → galaxies/star 0.05 → gas 0.1–0.45 → banks 0.55–0.9 → foreground motes 1.4–1.5), volumetric gas / dust, ambient life (comets and distant supernova flickers, **a pure function of the
clock**), fight reactions (shock rings ripple every layer, impulses swirl and warm them, `intensity` brightens and speeds them, `timeScale` slows all flow) and a screen-space lens that bends starlight (renderer).

## Files

* `info.ts` (pure, no three): `STAGE_INFO`/`STAGES` (`StageInfo` ×5, validated by `validateStageInfo` in `info.test.ts`) and `STAGE_RAMPS` (= `StageInfo.ramps`, used by the dither). `lighting.screenPos` is the design position of each stage's light at the reference camera.
* `types.ts`: `StageScenery` (v2): `prepare(ctx)` — a **generator** that builds every GL resource in small steps and yields progress (`Renderer.prepareStage` drives it over frames, 5 ms each), `init` (= `prepare` run to the end), `compile`,
  `setQuality(tier)`, `update(frame)`, `render(hdrTarget)`, `lightScreenPos(out)`, `dispose`. A scenery draws **linear HDR** (rgb = radiance, alpha = occluder opacity that cuts god rays; additive layers must not write alpha). `SceneryLook` carries
  the grade **and the fighter-readability tuning** (`spriteHalo`, `fightBand`, `glowDamp`, see below).
* `scenery.ts`: `createScenery` / `isStageImplemented`.
* `toolkit/`: the shared scaffolding — a stage is *content* built from it. `nursery/ rim/ redgiant/ quasar/ tussenruimte/`: one `SceneryBase` subclass each.

## The toolkit (`toolkit/`)

| module | what |
|---|---|
| `base.ts` | `SceneryBase`: owns the `SceneryKit`, runs your `*build(kit, ctx)` generator as `prepare`, forwards update/render/quality/compile/dispose. A stage supplies `id`, `look`, `noiseSeed`, `*build`, `lightScreenPos` (+ optional `onUpdate`, `disposeExtras`) |
| `kit.ts` | `SceneryKit`: one Scene of parallax layers drawn back-to-front into the HDR target with shared uniforms. `addSprites` (instanced soft sprites: puff / diffraction star / ring), `addFullscreen` (shader body with noise + force helpers), `addQuad` (baked texture), **`addInstanced`** (your own vertex + fragment shader per instance, with `vertexHeader`/`fragmentHeader` for uniforms and helpers), `setQuality`/`onQuality` (tiers thin additive clouds with brightness compensation and trim fbm octaves without rebuilding), `compile` |
| `glsl.ts` | texture-based value noise + fbm + curl (uniform-bounded loops), `warpByForces` (shock rings push, impulses swirl), `impulseGlow` |
| `nebula.ts` | `addNebula`: domain-warped fbm gas / dust layer with a lit-side term and spatial mask |
| `galaxy.ts` | **spiral / elliptical galaxies**: `addGalaxyDiscs` (analytic instanced discs: bulge + exponential disk + logarithmic arms + dust lanes + knots, warm core → mid → cool outer colour walked along the radius) and `addGalaxyStars` (a 3-D particle galaxy sharing the same projection, so both agree exactly), differential rotation ω ∝ 1/√(r+0.15) driven by the scenery clock (`setSpin` / `setDiscSpin`); `makeGalaxyStars` is the pure generator |
| `streams.ts` | **`addStreams`**: particles flowing from a source along a fan — stellar wind, jet plasma; position is a pure function of the flow clock (speeds up in a hot fight); `makeStreamAttributes` is the pure generator |
| `bank.ts` | `addDustBank`: a torn bank of dark dust along the bottom with a lit lip — the ground the fighters stand in front of |
| `compose.ts` | `REF_X0/REF_Y0`, `atRef`, `atCol`, `screenOf` (composition at the reference camera → layer coordinates and back), `addHeroStars` |
| `clouds.ts`, `stars.ts` | rejection-sampled particle clouds (`makeCloudSteps` for the sliced version), star fields with blackbody tints, `layerBounds` |
| `bake.ts` | GPU baking: `prepareBake` (compiles off-thread, `run()` later) / `runBake` |
| `ambient.ts` | comets + distant supernova flares as a **pure function of time** |
| `noise.ts`, `color.ts` | seeded CPU noise for placement; palette → linear ramps (`paletteRamps`, `rampAt`) so scenery colours are authored *on* the palette ramps |

Parallax model: a layer with parallax `p` shows content at `layer − floor(view.origin × p + 0.5)`; `p = 0` is screen-fixed, `1` moves with the fighters, `> 1` slides past faster. `layerBounds(arena, p)` gives the rectangle to fill.
**Compose against the reference camera** (arena centre: view origin 480,110) with `atRef(screenX, screenY, p)`; fighters stand at screen y ≈ 180 (`arena.restY − 110`), so keep the light and the bright structure away from a fighter's silhouette.

## Fighter readability (renderer + `SceneryLook`)

Every 2D layer (fighters, debris, particles) casts a soft dark, slightly desaturated **halo** and a thin dark **contact rim** into the scenery beneath it, multiplied in before the palette dither, and the scenery's highlights are compressed inside a
**fight band** (the vertical strip fighters live in). Bloom and god rays are damped *on* sprite pixels (they still glow around them). Defaults are tasteful; a stage tunes them in `look`:

```ts
spriteHalo: { strength: 0.24, radius: 9, desat: 0.3, rim: 0.45, rimReach: 1, lift: 0.2 }   // lift = backlight floor around DARK bodies on near-black stages (quasar)
fightBand: { top: -130, bottom: 110, feather: 50, ceiling: 0.5, keep: 0.3 }                   // world px around arena.restY; scenery above `ceiling` is compressed there
glowDamp: [0.6, 0.9]                                                                          // [bloom, god-ray] damping on sprite pixels
```

`verify.mjs` checks that a **pale celadon** body and a **near-black basalt** body keep luma contrast on every stage.

## Authoring rules learned the hard way (palette-aware scenery)

The renderer dithers into a 40–64 colour palette made of hue-shifted ramps. That is what makes the frame read as pixel art — and it dictates how to author:

1. **Dim warm light is brown.** Hue-shifted ramps drift shadows toward red; a *dim* gold or peach lands on rust. Use warm colours only where they are bright (cores, knots, stars), and light dim structure with the cool ramps.
2. **Never add two far-apart hues into one pixel** (teal + gold → olive mud). Walk one colour into the next *along a coordinate* (a galaxy's core → inner disk → outer arms) or add a **bridge ramp** (rim: pale jade, redgiant: rose-magenta, quasar: electric indigo, tussenruimte: sage).
3. **Thin bright edges quantise to flat neon lines; wide gradients quantise to bands** — fine when the hue family is the same. Lit lips on dust want ≈ 10 % of the screen height of gradient in a cool ramp.
4. **God rays wash the sky neutral-brown** when the light is large and warm; keep `godRayGain` low (0.1–0.5) unless the stage is a single hue (nursery 2.0).
5. **Restraint reads as beauty on black**: quasar and tussenruimte keep < 5 % of the frame lit; one strong element (the jet, the bridge) does the work.

## Adding a stage

1. Palette + lighting exist in `info.ts` (adjust the ramp specs; `ramps` follows; add bridge ramps for hue-adjacent pairs; set `lighting.screenPos` to the light's design position).
2. `class XScenery extends SceneryBase`: `protected *build(kit, ctx)` adds layers back-to-front with `addNebula` / `addSprites` / `addFullscreen` / `addQuad` / `addInstanced` / `addGalaxy…` / `addStreams` / `addDustBank` and `yield`s a progress fraction after each expensive step
   (use `yield* makeCloudSteps(...)` for particle clouds and `yield promise` from `prepareBake` for GPU bakes). Generate at full density: quality tiers thin additive clouds at draw time.
3. `onUpdate(frame)` for per-frame state (ambient life, galaxy spin — all functions of `frame.timeSec`), `lightScreenPos` → where the light is now (initialise the light position in a field initialiser so it is right before `prepare`).
4. Register it in `scenery.ts`. Look at layers alone with `node tools/render/layers.mjs out.png --url="stage=x&quality=2&freeze=1&t=5&text=0&ui=0&sparks=0" --only=a,b`, at the eight fight states with `capture.mjs --stage=x`, tile them with `montage.mjs`, and add the stage to the readability / distinctness checks in `dev/render/verify.ts` (they iterate the stage list).

## Stellar Nursery (`nursery/`)

Back to front: `sky` · `stars-far` · comets & flares · `glow` (luminous haze: intensity falls off from the newborn stars, ramp indigo → magenta → coral → amber → white, fbm + ridged filaments) · `gas-mid` · `nebula-far` (5.5 k soft
particles) · `stars-mid` · `hero-*` · `pillars-far` (hazy) · `dust-lanes` · **`pillars`** (art-directed columns, GPU-sculpted) · `wisps` · `dust-near` · `mist` (the ground) · `motes`.

**Pillars** (`pillars.ts`): a layout of round-cone chains (spine, flank lobes, crown knobs, EGG globules, curling fingers) is smooth-unioned into a signed-distance field in pass A (domain-warped, eroded at three scales,
fibre + billow noise). Pass B lights it: a **cylinder normal** from scanning to both edges (so the whole width shades as a rounded column), plus distance-field gradients for crowns and undercuts and fibre bumps, a *grazing* key light
(from `StageInfo.lighting.dir`, so titans and pillars agree), 12-step self-shadowing, a 4-stop dust ramp, and an **ionisation rim** — a 1 px white-gold line hugging the lit edges with a soft coral/magenta halo and a teal back-scatter
on the far side. Output is two textures (dust with opacity, additive glow), drawn NEAREST at whole-pixel parallax offsets so silhouettes stay crisp and never shimmer. The two bake shaders compile off-thread (`prepareBake`) while the game runs.

## Galactic Rim (`rim/`)

`sky` · `stars-far` (3.2 k) · comets & flares · `far-galaxies` (34 analytic discs, some larger) · **`galaxy-disc`** (grand-design 2-arm spiral, R = 500 px, inclination 64°, gold bulge → jade inner disk → teal arms, dust lanes, knots) ·
**`galaxy-stars`** (30 k resolved stars on the same arms + bulge + knots) · `galaxy-dust` (dark puffs on the concave arm edges) · `dust-lane` (rose-black lanes lit jade) · `hero-*` · `bank-far`/`bank-near` (torn dust,
teal-jade lips) · `motes`. The spin is 0.011 rad/s at unit ω: the outer arms turn ≈ 0.6°/s, the bulge ≈ 1.6°/s — visible over a round, never distracting.

## Red Giant's Wake (`redgiant/`)

`sky` · `stars-far` · comets & flares · **`star`** (a red giant of radius 240 px centred just above the frame: convection cells foreshortened toward the limb, sunspots, a hot rim and corona) · **`shells`** (concentric filamentary rings expanding at 3.2 px/s, colour
by radius: ember → rose → violet → teal; a shell keeps its identity as it moves out) · `wake` (a turbulent plume of shed gas trailing down-left, lit from the star) · `embers-far`/`embers-mid` (a fan of hot fragments streaming away from the star) · `dust`
(charred umber lit orange from above) · `hero-*` · `bank` · `motes`. The star's glare feeds the god rays (`godRayGain 0.32`).

## Quasar Void (`quasar/`)

`sky` · `web` (ridged cosmic-web filaments, barely there) · `stars-far` (cold, sparse) · `lensed` (14 tiny near-edge-on galaxies as bent arcs) · comets & flares · `core` (blinding point + glare spikes beyond the top-right corner) · `jet-far` (wide faint sheath at depth) · **`jet`** (a hair-thin
axis with knots that race outward, an ice-blue sheath, a violet cocoon, a helical kink growing with distance; brightens with fight intensity) · `plasma-far`/`plasma-near` (streams of flecks along the jet) · `bank` · `sparks` (ember accent).
`spriteHalo.lift = 0.2` keeps dark bodies from sinking into the black.

## Tussenruimte (`tussenruimte/`)

`sky` · `stars-far` (520) · `stars-mid` · a single comet, a single flare · `far-galaxies` · **`galaxies`** (a face-on-ish spiral at the left edge, a nearly edge-on one at the right, both dim, plus 16 k resolved stars and dust) · **`bridge-gas`** (an arc of celadon gas between them with a lit
underside) · `bridge-stars` (1.1 k stars torn from both) · `cluster` (a Plummer globular cluster hanging in the bridge) · `veil` (a celadon-lipped dust bank) · `motes` (the one warm accent). Star and gas layers use a *high* `forceK`, so the stillness is broken visibly by any shockwave.

## Testing

`npx vitest run src/stages` — stage info validation (all five: palette size, unit lighting, ramps partition the palette, hue bridging, `STAGE_RAMPS` mirror), every stage has bespoke scenery with a distinct class and noise seed and reports its light at `lighting.screenPos` before any GL exists, noise / star / cloud
determinism and distribution, `layerBounds` coverage, ramp splitting, ambient life (pure function of time), pillar layout, composition helpers (`atRef`/`screenOf` inverse), the galaxy particle generator (deterministic, arms traced, compact bulge), stream fans.
GPU behaviour — including per-stage fighter readability and stage distinctness — is covered by `node tools/render/verify.mjs` and `e2e/render.spec.ts`.
