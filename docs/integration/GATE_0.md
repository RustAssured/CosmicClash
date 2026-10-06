# GATE 0 — audit and integration plan for 우리 (URI) and the Mouth

**Status: waiting for WJ to approve the plan.** No code was changed in Phase 0. I read the codebase, the MASTER_PROMPT, both
packs (`uri/`, `mouth/`) and `shared/`, and looked at the oracle captures (`three-titans.png`, `uri-scale-witness-planet.png`).

## 1. The engine today

- **Runtime:**
  - TypeScript and Vite in the browser.
  - A **deterministic fixed 60 Hz sim**: seeded RNG, match hash, replay and determinism tests.
  - Pure-TS core modules: `src/matter`, `src/combat`, `src/sim`, `src/ai`, `src/contracts`.
  - Rendering is Three.js on WebGL2 (`src/render`); audio is WebAudio (`src/audio`).
- **Resolution:**
  - native **640×360** logical target, integer nearest-neighbour upscale (×3 at 1080p);
  - a dither + palette pass (OKLab, one curated palette per stage, `src/render/palette.ts`, `dither.ts`);
  - 5-level bloom, god rays, post.
- **How a titan is built:**
  - **Definition:** `TitanDef` JSON (`src/titans/*.json`) holds materials, moves (frame data, hitbox shapes, energies),
    resource, balance knobs and art params.
  - **Art:** a **painter** (`src/titans/art/*.ts`) paints pixel-matter maps (material, density, colour and relief per cell).
  - **Behaviour:** a **Behaviour** (`src/combat/behaviours/*.ts`) with hooks for attach, update, placeRegions, receive and
    onDealt, renderLayers, massFrame and hash.
  - **Fighter:** a generic **FighterImpl** (`src/combat/fighter.ts`) runs input → move state machine (startup / active /
    recovery), footwork (orbit, the default), hit resolution, hitstop and impact physics.
- **Input:** `InputFrame` (stick + `Btn` bits: Strike, Crush, Surge, Signature, Ultimate, Guard, Gravity, Feint), from the
  keyboard, Switch Pro or Joy-Con, script or AI.
- **Hits and health:**
  - Hits are matter: a move's hitbox becomes a `DamageEvent` applied to the target's matter bodies.
  - A wound cracks, holds and shears into slabs (D1). Debris persists.
  - **Health = matter integrity / mass** (KO thresholds), shown on the HUD.
- **The Witness:**
  - 24 **region bodies** in the matter world, placed every tick by an XPBD rig.
  - Rotated with a shared quantised sampler (`src/contracts/rotation.ts`: 256 steps, Q14 LUT, a 3×3 alpha-first vote) and its
    GLSL twin, so **what you see is what is hit**.
- **The Planet:** one matter body with a two-hemisphere shell, moons, gravity well, comets.
- **Camera and arena:**
  - the arena is a rectangle per stage (`ArenaInfo`, about 1600×560) with soft walls;
  - the orbit camera frames both fighters' live bounds (S1, after Witness v3); dolly / kick / shake.
- **Effects:** matter particles and debris layers, per-titan FX overlays, local impact lights (D5), a luminance governor,
  hitstop (capped at 135 ms) and shake.
- **Performance** (real time, Vega 7 iGPU, true 1080p, Gate C):
  - 60.0 / 59.9 fps, 1 % low 43–45;
  - sim p99 3.6–3.7 ms;
  - GC: 10 pauses > 4 ms per 3 minutes.

## 2. What the packs ask, and where they collide with the engine

| Topic | Packs | Engine | Proposal |
|---|---|---|---|
| Rotation | 우리: **4-sample majority** (≥ 2 of 4) | 3×3 alpha-first vote, shared by matter and GPU | Add a second sampler mode (`majority4`) to the contract and its GLSL twin, used by 우리's parts. Hit truth stays one function per mode. |
| Kinetics | 우리 links at **120 Hz**, drawn at 30 fps | fixed 60 Hz sim | Two substeps per tick (deterministic). Judge timing at 60 fps (±1 frame of the oracle's 30 fps = ±2 of ours). |
| Randomness | prototypes use `Math.random` | seeded RNG only | Port all random draws onto the fighter's RNG fork (determinism and replays). |
| 우리's matter | `uri_rig.json`: 13 parts with pixel grids, normals, form light, **chunk ids** | matter world: cells, connectivity, slabs | 우리's parts become matter region bodies (like the Witness), loaded **as is**. The chunk id rides in a per-cell field; a hit tears out its chunk. Necks, the 50 % rule and break-apart are in 우리's behaviour. |
| 우리's health | **loop integrity** (−3 × power per hit) | matter integrity / mass | A per-titan health model: the fighter view's integrity comes from the behaviour, so the loop is the HUD bar for 우리. |
| Shading | 우리: form-light / live-light blend from per-part normals; Mouth: flesh tubes, wet speculars | painted base colours on the GPU; parts pass only rotates | A **lit part pass** on the GPU: per-part normal and form textures, one global light. |
| The Mouth's body | procedural braided tubes, rings, teeth, throat (CPU look-dev) | everything hittable is matter | Render on the GPU (instanced capsule impostors, depth buffer). Hurtboxes are **analytic capsules** along the neck, the head and the visible coils (spec §9.2), not matter. Needs one additive contract: a fighter may expose capsule hurtboxes and take damage events itself. |
| The Mouth's movement | anchored on the **arena perimeter**, slides, never walks | orbit footwork | A new footwork, `perimeter`, owned by the Mouth's behaviour; the camera keeps the anchored edge in view (decision 3A). |
| Input | 우리: punch / cross / slam / uppercut chosen by target elevation and side. Mouth: slide + height + Bite / Sweep / Coil & crush | five move slots plus Guard and Gravity | **A mapping is needed (decision G0-2).** |
| Palette | one **master palette** (96–128 colours), Bayer dither, palette snap on every pixel | OKLab dither to a per-stage palette | Build the master palette as the union of the approved ramps. The final pass snaps to it. Stages keep their scenery, mapped into the master. Changes how the current game looks (decision G0-4). |
| Light | one sky, upper-left-front | `StageLighting` per stage | One global key / rim / ambient for titans. Stages keep their own lighting for scenery. |
| VFX | one recipe by weight: anticipation, star flash, distortion ring, debris sprites, dust, hitstop/shake table | lights + particles + overlays, hitstop cap 135 ms | Build the shared VFX module; map the Witness and Planet hits to the four weights. The **catastrophic hitstop 0.20–0.25 s is over our 135 ms cap** (decision G0-5). |
| Debug tuning | sliders + diagnostics in game | training overlay + telemetry only | A debug overlay framework (toggle, sliders bound to config, per-titan diagnostics) that any titan registers into. |
| Scale | 우리 about 300 px tall; Mouth head about 116 px, rings to 180; Witness about the same height as 우리 | Witness v3 is about 272 px (2.25× the Planet); Planet is 121 px | The scales already agree. The 우리 spec suggests **enlarging the Planet** to read as an equal (decision G0-6). |

## 3. Plan and owners (phases follow MASTER_PROMPT; every gate stops for WJ)

- **Phase 1, shared foundations.**
  - **S5:** the lit part pass, master palette and palette snap, the global light, shared bloom and outline rule, and the VFX
    module.
  - **Lead:** the contracts (sampler mode, capsule hurtboxes, the per-titan health model, the `perimeter` footwork hook)
    and the debug overlay framework.
  - **Gate 1:** captures of the four VFX weights on a neutral background, and the Witness and the Planet through the new
    path.
- **Phase 2, 우리.**
  - **S4:** the loader from `uri_rig.json` into matter region bodies, the `majority4` sampler, chunk tearing.
  - **S2:** the link system and move grammar, a port of `20_kinetics.js`.
  - **S5:** shading, cores, loop, command moon.
  - **S1:** input mapping, cancel windows, AI.
  - Gates 2A–2D as written: rest silhouette 100 %; per-move captures beside the oracle, double slam first; damage; WJ plays
    우리 vs the Witness.
- **Phase 3, the Mouth.**
  - **3A:** a written proposal for the four decisions (Lead with S1).
  - **3B:** the crane feel against the greybox (S3, S1).
  - **3C:** the GPU look (S5, S3).
  - **3D:** damage and knockouts (S3).
  - **3E:** in the game.
- **Phase 4, unification and balance** across the four titans (all owners, measured as in the slice).
- **Progress** is tracked in `PROGRESS.md` (repo root). Every gate gets a side-by-side, game vs oracle.

## 4. Decisions for you (Gate 0)

1. **Approve the plan** above, including running it now instead of the slice's Phase 3 (Gate C's open items carry into
   Phase 4).
2. **Input mapping.**
   - **우리:** Strike = lead straight punch; Crush = rear cross-body smash; Signature = uppercut; Ultimate = double slam.
     Or should the spec's "best move for the target" rule (elevation and side) pick among them from one button?
   - **Both titans:** what do Surge and Guard do? The packs define no movement verbs or defence for 우리, and no Guard for
     the Mouth. I won't invent them; tell me, or say "leave unbound".
3. **Health:** 우리's loop and the Mouth's 100 hp become their HUD bars. Is KO per round as now (best of three)?
4. **Master palette and one sky:** this visibly changes the current Witness, Planet and arenas toward the oracles' look.
   OK, with a before/after at Gate 1?
5. **Hitstop:** the VFX table's heavy (0.11 s) and catastrophic (0.20–0.25 s) values exceed today's cap of 135 ms, which came
   from the Gate B feel tuning. Raise the cap for those weights only?
6. **The Planet's size:** keep 121 px, or enlarge it so it reads as an equal next to 우리 (about 300 px) and the Witness?
7. **Roster:** add 우리 and the Mouth to the slice roster as they pass their D/E gates (menus show four titans)?

## 5. Risks

- **Performance:** two pixel-matter titans with part shading, plus the Mouth's tubes, plus the VFX, inside 6 ms. The Witness
  alone is about 0.3 ms of sim. The GPU passes are new cost on an iGPU, so every gate includes a bare real-time perf run.
- **The Mouth's analytic hurtboxes vs matter debris:** D30 debris and comets hit matter bodies. The Mouth needs a rule for
  debris against capsules (proposed: debris collides with its capsules and deals its damage model's coil and neck damage).
- **Effort:** this is larger than the whole slice phase. I'll run it gate by gate with fewer, larger agent tasks, as you
  asked.
