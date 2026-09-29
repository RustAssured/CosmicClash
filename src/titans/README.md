# src/titans — data, procedural art, rigs

Pure TypeScript (no DOM / `three` / `Math.random`), deterministic. Turns a titan's JSON definition into a **pixel matter map** that reads at 64 px and whose layers
reveal as damage carves it.

## Public API (`@/titans`)

| export | what |
|---|---|
| `IMPLEMENTED_TITANS: TitanId[]` | `['lastone', 'asteroid']` (Phase 2 adds the other four — they are *content*, see below) |
| `TITAN_DEFS`, `getTitanDef(id): TitanDef` | the JSON definitions (`lastone.json`, `asteroid.json`); throws for unimplemented titans |
| `generateTitanBody(def, seed, lighting): { map, materials, rig }` | ready for `world.createBody`: painted `MatterMap` (material ids, densities, lit `baseColor`, relief `height`, `coreX/Y/Radius`), resolved material table (`specs[i]` ⇒ id `i+1`, 0 = void) and the **rig** |
| `paintTitanMap(def, seed, lighting)` | the painting step alone (no material table) |
| `renderPortrait(id, seed?, lighting?)` | cropped pristine sprite `{ pixels, w, h }` for menus (cached) |
| `buildRigFor(def, seed)` (`@/titans/rigs`) | recompute the rig from the recipe alone (used for `existingBody`) |
| `blend(c0, c1, t)`, `hash01` | alpha-safe opaque colour blend and a fast hash (see *Notes*) |

**Rig** (per titan, produced with the pixels): Last One — tendril roots `{x,y,nx,ny,len,phase,kind}`, eye, core, halo, material ids; Asteroid — core, radius, prow, material ids.
Deterministic in `(def, seed)`; painting is memoised per `(titan, seed, lighting)` and every call returns a private map copy (~1 ms), so tournaments and rematches are cheap.

## The art toolkit (`src/titans/art/`)

Generic, layered, and the same for every titan — a new titan is a new *painter* file plus JSON, not new engineering:

| file | role |
|---|---|
| `noise.ts` | integer-hash gradient/value noise, fbm, ridged, Worley (cellular), Bayer 4×4/8×8 |
| `sdf.ts` | signed-distance primitives (ellipse, tapered capsule, polygon, plane…) with smooth min/max for organic joins |
| `field.ts` | exact Euclidean distance transform, box blur, largest-connected-component |
| `canvas.ts` | `ArtCanvas`: material ids + relief + tone offsets + colour overrides → `render()`; `buildLitRamps` |
| `color.ts` | `blend` (opaque, rounded) |
| `lastone.ts`, `asteroid.ts` | the per-titan feature passes (silhouette, layering, features, rig) |

Pipeline: **domain-warped SDF silhouette → distance-to-boundary layering (crust → mantle → core, veins, strata, inclusions) → relief height → normals lit by the stage key light
(`lightXBias` tames the horizontal component so mirrored sprites stay top-lit) → cavity AO → ramp index → ordered dither between ramp steps → rim light on the lit silhouette edge and a selective dark
outline on the other → hand-painted overrides (eye, core, gems, ice)**. Ramps are the JSON hue-shifted ramps tinted once by the stage light (shadows toward `ambient`, highlights toward `color`), so only ramp
colours ever reach the output: palette-clean pixel art.

* **The Last One** — weathered celadon idol: heavy-lidded almond eye set in a bevelled, gilt-inlaid socket (layered iris, black pupil, wet highlights), tilted gilt halo on fine spokes with jade gems, robe with drapery
  pleats and a gilt collar, petal seams radiating from the socket, glaze craquelure and patina, chipped outline; under the glaze a pale crystalline lattice with dark fault ribs and a golden lantern-core glowing through the porcelain.
* **The Asteroid** — faceted iron-nickel wanderer: horn-like prow and silhouette-breaking crags, pitted regolith skin, Widmanstätten kamacite/taenite lamellae in Voronoi crystal domains, meandering ice veins (cyan, emissive),
  pallasite olivine gems, impact craters whose floors expose bare metal, a dense copper-gold core.

Seams/fault lines are distinct **materials** with weaker bonds (JSON `physics.bond`), so FRACTURE follows the same lines the player sees.

## Data (JSON)

`TitanDef` (see `contracts/titan.ts`). Move data conventions the combat module reads (`MoveDef.extra`):

| key | meaning |
|---|---|
| `shell` (guard move) | `{ absorb: { [DamageType]: 0..1 } }` — Guard effectiveness per damage type |
| `followUp` (surge) | `{ button, from, to, move }` — a `button` press in `[from,to)` becomes `move` (Sidestep → lunging strike) |
| `followUpOnly` | the move is never chosen directly for its slot |
| `pose` | `{ startup|charge|active|recovery: { lean } }` cosmetic lean (px) |
| `chargePower`, `chargeReach` | hold-to-charge scaling: energy `×(1..1+chargePower)`, lengths `×chargeReach[0..1]` |
| `ctl` | per-phase steering multiplier override (e.g. the Swarm gives the stick to the fragments) |
| `swarm`, `cascade`, `spin`, `eyeFlare`, `halo` | behaviour parameters/flags for the titan's behaviour class |
| `recoil` | 0..1: fraction of the damage dealt that comes back on the attacker (rams). Read by the AI only (it values such blows net); the matter world produces the actual backlash |

Frame data is validated by `validateTitanDef` (feel targets) in `titans.test.ts`; `docs/TITANS.md` is generated from the JSON by `npx tsx tools/titans/docs.ts`.

## Adding a titan (Phase 2 = content)

1. `src/titans/<id>.json` — attributes, resource, materials (physics archetype + ramp), art recipe params, moves (all frame data in ticks), AI weights.
2. `src/titans/art/<id>.ts` — a painter using the toolkit + a rig; register it in `generate.ts` (`PAINTERS`) and `rigs.ts`; add the def to `defs.ts` and `IMPLEMENTED_TITANS`.
3. `src/combat/behaviours/<id>.ts` — a `Behaviour` for the body-external parts and failure mode; register in `behaviours/index.ts`.
4. Look at it: `npx tsx tools/titans/sheet.ts <id>` and `npx tsx tools/titans/frame.ts out.png --a=<id>`; read the PNGs.

## Tuning knobs

Everything visual that is a number lives in the JSON `art.params` (sizes, counts, seam density) or at the top of the painter; light response constants are in `canvas.ts` (`v = 0.10 + 0.64·diffuse`, contrast, dither width per material in the painter's `shade[…]` table).

## Testing & tools

`npx vitest run src/titans` — definitions (feel targets, attributes, follow-up references), generator determinism, lighting, size/budget, connectivity, core placement, material coverage, alpha, cache independence, portraits.
`npx tsx tools/titans/sheet.ts [lastone|asteroid] [--light=nursery|cold|noon]` — 1×/4× renders to `.scratch/titans/`.

## Notes

* `mix` from `contracts/color.ts` truncates alpha to 254 on opaque inputs (float → byte); art code uses `blend`. (Reported to the Lead.)
* Titans are authored facing right; `lightXBias` (default 0.7) keeps mirrored sprites plausibly lit.

## Supernova and Planet (Phase 2, Track B)

* **Supernova** (`art/supernova.ts`, `supernova.json`) — one continuous star gradient over granulated Voronoi cells at two scales, limb darkening, faculae, sunspots, a chromosphere ring, tapered violet coronal streamers and braided prominences (loops and hooked plumes). Materials are concentric (photosphere → convective shell → core) and use slices of the same gradient, so stripped layers leave a smaller, hotter star. The corona and prominences are deliberately *heavy* matter with raised resistances so burning fuel (which sheds the outermost matter first) eats them across the whole fuel bar. `supernovaGranules(def, seed)` gives the per-cell granule field the fighter animates.
* **Planet** (`art/planet.ts`, `planet.json`) — a lit globe painted from a lat/lon surface (seas with shallows and a sun glint, forests, deserts, mountains, ice), a thin atmosphere ring with cloud wisps, and concentric materials (surface class → crust → mantle → magma → core). Face colours hide the depth; the fighter draws the real strata wherever damage exposes them. The rig carries per-cell sphere coordinates and a wrapping cloud texture. `generateMoonBody(def, seed, lighting, i)` paints the cratered moons (materials live in `art.params.moons[i].materials`, not in `def.materials`).
* The JSON of both is generated by `tools/titans/author/{supernova,planet}.ts` (`npx tsx tools/titans/author/<id>.ts && npx prettier --write src/titans/<id>.json`); edit numbers there, then regenerate.
