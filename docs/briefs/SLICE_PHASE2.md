# Slice Phase 2: plan and ownership

Read `docs/briefs/SLICE_COMMON.md` (rules, machine limits, report format) and DECISIONS **D28** (Gate B outcomes) first.

## Priority 0: scale of motion (D28, WJ's top note)

WJ: *"tendrils and such and certain moves feel as if much smaller critters are fighting, wobbling fast instead of feeling like
they're scaled in terms of planets."*

Everything that moves must read at moon and planet scale: lower natural frequencies, longer arcs, heavier follow-through, and
no high-frequency jitter on bodies. **Input stays immediate:** a command still changes a pixel on its accept tick. What changes
is how the consequence unfolds, not when it starts.

**Shared spec.** S1 owns it and publishes it in `tools/feel/scale.ts` + `docs/briefs/scale-spec.md`. S2/S3 apply it to their
parts; the starting targets are below.

| Element | Target |
|---|---|
| Visible oscillation on bodies | Dominant frequency ≤ ~1.5 Hz. Above 2.5 Hz: only hit shake, and only within the first 150 ms. |
| Idle | Breathing period ≥ 3 s. |
| Tendril / arm sway | Period ≥ 2.5–4 s, travelling down the length; whip tips leave late and arrive later, no rapid back-and-forth. |
| Turns | ≥ 0.5 s, with counter-rotation. |
| Root velocity | Changes over ≥ 0.25 s after the first pixel. |
| Recoil and knock-back | Long and slow, never a spring jiggle. |
| Planet | Cloud, moon, aurora and ring motion read as weather and orbit: slow, continuous, lagging. Never twitchy. |
| Camera shake | Low frequency (≤ 4 Hz), heavily damped. |

**Measure:** spectral energy above 2 Hz in root, lean/angle, and tracked secondary points (tendril tips, moons), per move and
idle, before and after.

## Owners and tasks

### S1: feel core, AI, scale lead

1. Scale spec, plus the tool, plus the fighter side: springs, steering, top speed and acceleration curves, recoil, lean/angle, camera shake.
2. Orbit is the default now (D28). Tune the AI, balance and pacing **for orbit**:
   - rounds of 45–90 s through AI patience and spacing (target ~8–10 contacts per minute; ~25 now). Do not raise toughness.
   - equal-level matchup 45–55 % over ≥ 100 headless fights (`tools/ai/balance.ts`, orbit);
   - mirror matches sane.
3. **Multi-body fighters** for the Witness (with S2):
   - a fighter may own several region bodies (`BodyTransform.rot`, `anchorCells`);
   - KO, mass and integrity aggregate across them;
   - `probe` / `receive` route to the region hit;
   - `view.body` stays the portrait source (the eye cradle or a composite).
   This is the fighter-core half of the Witness.

### S4: matter

1. Proposal 140 into matter:
   - the `rot` routing (import the sampler from `@/contracts/rotation`; drop the private copy);
   - `anchorCells`, `bodyToChunk`, `jointHealth`;
   - `rot = 0` fast paths byte-identical for the other titans.
2. Tidal Draw and arena capture:
   - `chunksInShape`; capture/orbit/release of chunks by a gravity owner (incl. severed enemy matter);
   - a launch with uncapped KINETIC credit; pinned chunks are never degraded;
   - comets are big chunks (spawned by the Lead's arena module).
3. Debris persistence:
   - raise caps within budget;
   - cooling colour from white-gold / magma to dark;
   - drift.
4. Overlapping wounds shed in parallel (5 blows took ~2 s; each should keep its own 80–300 ms beat).
5. The Planet's two-hemisphere shell swap (S3's proposal).
6. Aftermath support: frozen world state rendered from any view, and a supersampled export path (with S5).
7. Allocation pooling in matter. GC: 8 pauses > 4 ms per 3 minutes; target 0.

### S2: the Witness, in game

1. Art v2 per `docs/briefs/witness-art-notes.md` and the Gate B review:
   - long sweeping scythes, not claws;
   - the halo as a large broken ring, not a flat bar;
   - longer hanging spires.
2. Region bodies created through the world (`rot`, `anchorCells`), driven by the XPBD rig, drawn through `RenderLayer.parts`.
3. **Motion at colossal scale** (Priority 0).
4. The six moves:
   - **Halo Shards** (Strike)
   - **Sweeping Architecture / Structural Shear** (Crush)
   - **Charge, and Sidestep** (Surge)
   - **Fracture Gaze** (Signature: delayed fracture lines)
   - **Halo Close** (Guard)
   - **Revelation** (Ultimate)

   Damage changes the kit: severed arms shorten reach, broken halo arcs weaken Guard, opened inner eyes add gaze angles.
5. The four reveal layers in game. Orb-eyes open with damage.
6. Joint failure via `jointHealth` → `bodyToChunk`.
7. The 2–4 s failure process: constraints give, the halo drifts, the eye goes out last.

**Depends on:** S4 task 1, S5 compositor parts, S1 task 3. Start with art v2 and the behaviour, using fallbacks until those land.

### S3: the Planet

1. Motion at world scale (Priority 0).
2. The seven moves:
   - **Moon Slam** (Strike)
   - **Tidal Rush** (Crush)
   - **Orbital Drift** (Surge)
   - **Comet Shepherd → Slingshot** (Signature)
   - **Tidal Draw** (R1, `Btn.GRAVITY`, from the Lead)
   - **Rotational Brace** (Guard)
   - **Crust Breaker → Magma Vent → Core Pulse** (Crush held, by phase)
3. Damage phases 1–4, each changing function.
4. The two-hemisphere world with S4.
5. The 2–4 s failure process: the atmosphere vents, the moons drift off, the crust slabs, the core goes out last.

### S5: world, light and sound

1. Compositor support for `RenderLayer.parts` (the GLSL twin is already in `src/render/rotsprite.ts`; the sampler is in `@/contracts/rotation`).
2. The two arenas, each with ≥ 3 reactive depth layers and sparse foreground:
   - **Fractured Orbital Mausoleum**
   - **Star-birth Shearfield**, which renders the sim comets
3. Material voices:
   - Witness: ceramic, stone shear, filament snap, strained sacred metal, wrong harmonics;
   - Planet: tectonic crack, sub pressure, atmospheric tear, magma vent, moon impact.
   Damage changes resonance.
4. Loudness re-check for orbit density (orbit fights measured −15.5 to −17.6 LUFS).
5. Renderer performance on Vega 7.

### Lead

- `Btn.GRAVITY` (R1; stick-click on a sideways Joy-Con).
- A deterministic arena hazard module: comet schedule + spawn as matter chunks.
- `SLICE.stages`.
- The aftermath screen: freeze at KO + 1 s; pan, zoom and orbit; HUD toggle; PNG export.
- A deterministic 60 fps reference-render tool for clips.
- Integration, captures, Gate C.
