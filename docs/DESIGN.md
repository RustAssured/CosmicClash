# ADEUK: TITANS — Design Bible

> Working title. A 2.5D cosmic pixel-art fighting game for the browser in which colossal cosmic entities fight
> and **physically wear each other down**. This document is the distilled spec. `/src/contracts` is its typed form.
> When this file and the contracts disagree, the contracts win and this file gets fixed.

## 0. The seven non-negotiables

1. **Destruction IS the health system.** Every titan's body is a simulated pixel-matter map. Damage removes, burns,
   infects, cracks, crushes or devours actual pixels, in the attacker's own way. A fight leaves both bodies visibly
   carved and the arena littered with their remains.
2. **Epic weight without sluggishness.** Moves are vast and slow to land, the universe seems to move with them — yet
   input feels immediate and the player is never stuck.
3. **Pixel art, not primitives.** No plain circles/rectangles/lines as final art. Sculpted pixel structures, fine detail,
   hue-shifted shading, secondary motion.
4. **Cosmic scenery through a pixel lens.** Real 3D (Three.js) nebulae/galaxies/dust rendered at low resolution, dithered
   into curated palettes, with bloom / god rays / lensing.
5. **Switch Pro Controller over Bluetooth is first-class.**
6. **Opponents are intelligent** — read space, exploit damage, punish, adapt.
7. **Nothing ships with placeholders, TODOs, stub art, console errors or failing tests.**

## 1. Architecture

```
                         ┌───────────────────────── src/app (Lead) ─────────────────────────┐
  keyboard / gamepad ──► │ input (B4) ─► InputSource ─┐                                      │
                         │                             ▼                                      │
  AI (B3, src/ai) ──────►│  InputSource ─────────► src/sim  Match (Lead, pure, headless)      │
                         │                             │  fighters (B3 combat) ◄─► foe        │
                         │                             │  world (B2 matter)                   │
                         │                             ▼                                      │
                         │        SimEvent[]  RenderLayer[]  FighterView  BodyStats           │
                         │           │             │                │                         │
                         │      audio (B4)   engine camera (B1)   ui/HUD (B4)                 │
                         │                        │                                           │
                         │                  render (B1): Three.js scenery ─► dither ─► 2D layers ─► post ─► upscale
                         └────────────────────────────────────────────────────────────────────┘
```

**Purity boundary.** `src/matter`, `src/titans`, `src/combat`, `src/ai`, `src/sim` and `src/contracts` are **pure
TypeScript: no DOM, no `three`, no `window`, no `performance.now` in logic.** They run identically in the browser and in Node
(tests, the balance tournament, replays). Only `src/engine`, `src/render`, `src/stages`, `src/input`, `src/ui`, `src/audio`
and `src/app` may touch browser APIs (and `ui` rasterises to typed arrays, so it stays testable).

### 1.1 Coordinates

- World units = **logical pixels**. +x right, **+y down**. Angles in radians (0 = +x, clockwise on screen).
- Logical resolution **640×360**, integer-scaled with nearest filtering, letterboxed. Sim tick **60 Hz** fixed; render
  interpolates between ticks.
- Arena default **1600×560** world px (a stage may override). Fighters are *tethered*: anchors never further apart than
  `MAX_FIGHTER_DX/DY` so both always fit on screen — the camera pans, it does not zoom out. Micro-zoom pulses (≤6%) are
  applied in the final nearest-neighbour upscale.
- A body's matter map is authored **facing right**; `facing = -1` mirrors it around the anchor. `lean` is a cosmetic
  **integer row shear** (no rotation — pixel art must not alias). All local↔world math is in `contracts/space.ts`.
  **All damage geometry is given in WORLD space**; the matter world converts.

### 1.2 Tick order (Match.step) — deterministic

1. Handle phase (intro / fight / ko / roundend), hit-stop (if `hitstopTicks > 0`: decrement, skip 2–5 but still run presentation).
2. Poll `InputSource`s → `InputFrame` per slot (AI decides from public `FighterView`s only; never sees the foe's pending input).
3. `fighter[0].tick(ctx)`, `fighter[1].tick(ctx)` — state machine, input buffer, movement, moves' hitboxes, **hit resolution**:
   attacker probes `foe.probe(shape)` (pixel-accurate), then `foe.receive(damageEvent)` → Guard/parts → `world.applyDamage`.
   Fighters set their body `transform` and gravity sources.
4. `world.tick()` — heat, cracks, burning, infection, tidal streams, connectivity + detachment, debris/particles, mass transfer.
5. Match: collect `SimEvent`s (fighter + world), apply `hitstop`, `timescale`; KO check; round logic.
6. Presentation (app): camera.tick(events) → renderer; audio.handle(events); rumble; HUD.

Hit-stop: Match freezes steps 2–4 for N ticks (fighters visually vibrate via `freeze()`), presentation continues.
Time dilation (KO 0.3×): the engine loop runs fewer ticks per second (accumulator scale) — deterministic per tick.

### 1.3 Data flow of pixels

`MatterMap.pixels` (owned/refreshed by matter) **is** the titan sprite. Fighters wrap it (plus tendrils, moons, beams, telegraphs) in
`RenderLayer`s. Matter also emits screen-space debris/particle layers. The UI is one screen-space layer. **`RenderLayer` is the
only way pixels travel to the renderer.** Packed pixel = little-endian RGBA in a `Uint32` (`contracts/color.ts`).

### 1.4 Determinism

Fixed 60 Hz tick, seeded `Rng` (sfc32), no `Math.random`, no wall-clock in logic, no `Map`/`Set` iteration order dependence
on non-integer keys, typed-array-only state. `world.hash()`/`match.hash()` must be identical for identical seeds + input scripts
(tests enforce it). Determinism is guaranteed within one JS engine (V8); cross-engine transcendental drift is out of scope.

## 2. The roster (six titans)

Shared attributes 1–10: **MASS** (inertia, knockback resistance) · **COHESION** (bond strength) · **HEAT TOLERANCE** ·
**GRAVITY** (pull on debris and opponent) · **REACH** · **TEMPO** (windup/recovery speed) · one unique **RESOURCE**.
Stats update live from remaining mass: losing matter → lighter, faster, weaker. The Black Hole grows heavier and stronger as
it feeds (and slower).

Every titan: **Strike** (light) · **Crush** (heavy) · **Surge** (drift/dash, brief intangibility) · **Signature** (unique, often
hold-to-charge) · **Ultimate** (meter) · **Guard** (shell) · a passive · a **Destruction Signature** · a **Failure Mode**.

| # | Titan | MASS COH HEAT GRAV REACH TEMPO | Resource | Destruction signature | Failure mode |
|---|-------|----|----|----|----|
| 1 | **The Last One** (De Laatste) — celadon `#A8BDB2` core, single ancient eye, halo, 20–30 verlet tendrils | 5 8 5 3 7 7 | tendrils | **FRACTURE** — shears the enemy apart along its weakest bonds; chunks tumble off as rigid debris. Tendril Lash carves a line; Shatter Blow seeds a spreading crack network; Gaze pierces a channel. Best Surge ("charge, and sidestep"). Ult *The Last Light*. | Tendrils sever one by one; the eye is exposed and takes heavy damage. |
| 2 | **The Nexus** (De Nexus) — crimson graph of nodes and hardened chains around a crystalline wireframe hub; grows | 6 6 4 4 8 4 | nodes | **ASSIMILATION** — chains latch in and convert enemy cells to crimson lattice spreading along bonds; the Nexus then *harvests* (tears out) lattice into its own graph. Hardened chains root & slow. Ult *Ingesloten Oog*: builds a shell around the enemy, crushing inward if completed. | Edges snap, nodes go dark, disconnected islands of the graph die. |
| 3 | **Black Hole** — true-black horizon, photon ring, accretion disk with Doppler brightening, jets; lenses the background | 8 9 10 10 5 2 | accreted mass | **TIDAL CONSUMPTION** — loose cells ripped away, spaghettified into streams, spiral into the disk and vanish; mass transfers to the Black Hole. | The horizon can't be hit — the disk can; a disrupted disk sheds mass; at low mass it evaporates in Hawking sparkle. |
| 4 | **Supernova** — dying star: granulation, prominences, corona filaments, pulsing | 7 3 10 6 6 5 | core fuel | **THERMAL** — heat diffuses into cells; above ignition they burn, fronts spread, char→ash→embers; shock rings blast loosened material. Spending fuel powers moves but shrinks the star; at zero fuel it collapses into a desperate final nova. | Outer layers blow off, exposing the core. |
| 5 | **Planet** — atmosphere, clouds, oceans, continents, crust, mantle, glowing core; 1–2 moons | 8 7 6 7 6 3 | moons | **CRUSH & TECTONICS** — gravity compression, impact craters with shock rings, moon slams, tectonic crack lines. Atmosphere absorbs heat; oceans boil away when burned. | Crust cracks reveal magma; atmosphere is stripped; moons can be knocked out of orbit and lost. |
| 6 | **Asteroid** — iron-nickel rock with regolith and ice veins, tumbling; smallest, quickest, still heavy | 3 6 5 1 4 9 | fragments | **KINETIC** — ballistic impacts carve craters, spray ejecta, embed shrapnel that fractures outward a moment later. Signature: split into a controlled swarm. | Fragments; at low mass becomes a rubble pile held by weak gravity. |

**Matchup physics must emerge from the simulation, not special cases:** burning lattice, ignited gas feeding the Black Hole,
atmosphere shielding heat, shrapnel embedded in Nexus nodes… These come from the material table (`resist` per damage type,
`heatAbsorb`, `flammableGas`, `assimilable`, `debris` kinds…) interacting in the shared simulation.

## 3. Destruction simulation (`src/matter`)

- **Matter map** at native logical resolution: 1 cell = 1 px; bodies 90–180 px across (≤ ~25k cells). Structure-of-arrays
  typed arrays (`contracts/matter.ts`): material, density, integrity, temperature, bondR/bondD, infection, emissive, detached,
  flags, height, baseColor, pixels.
- **Materials** = physics archetypes (matter library) + per-titan visual (`MaterialSpec`). Resistances per damage type:
  FRACTURE, ASSIMILATION, TIDAL, THERMAL, CRUSH, KINETIC. Internal layers are authored so damage **reveals** them.
- **DamageEvent**: type, shape (point/line/cone/ring/field), position, direction, energy, duration, params. Materials decide.
  Calibration: 1 energy ≈ destroys one baseline cell. Mass is conserved: removed matter becomes rigid debris chunks
  (connected islands with rotation), particles, gas/ash/embers, or is transferred (accreted/harvested).
- Crack propagation along the bond graph weighted by material and stress · heat diffusion with a stable scheme and ignition
  thresholds · tidal force vs bond strength with stretch rendering · infection spreading along bonds · connectivity flood-fill
  after damage (islands disconnected from the core anchor detach).
- **KO** when core-anchor integrity < `KO_CORE_INTEGRITY` (0.25) or mass fraction < `KO_MASS_FRAC` (0.22). HUD shows a live pixel
  portrait of each titan's remaining body plus integrity %. Damage persists between rounds as partially healed scars.
- **Budget**: ≤ 5 ms/tick for two full bodies + debris. Dirty-rect texture uploads, pooling, zero allocation in hot loops.

## 4. Feel: epic weight without sluggishness (measurable)

| Target | Value |
|---|---|
| Input → first visible response | ≤ 1 frame (anticipation pose, charge light) |
| Input → audio | ≤ 50 ms |
| Strike total | 0.5–0.8 s (30–48 ticks) |
| Crush total / anticipation | 1.2–2.0 s (72–120) / 0.35–0.7 s (21–42) |
| Ultimate | 3–5 s (180–300) with camera choreography |
| Cancel | windups cancellable/feintable into Guard or Surge in the first 40% |
| Input buffer | 8–10 frames (`INPUT_BUFFER_TICKS = 9`) |
| Movement | ~70% top speed within 0.2 s, then long glide; lean/trail on direction change; still controllable |
| Hit-stop | 60–220 ms scaled by energy and masses |
| Camera | slow heavy dolly, low-frequency damped shake, micro-zoom, roll ≤ 1.5°, radial shockwave refraction, 0.3× time dilation on KO blows |
| The universe moves | parallax + 3D background respond to fights: nebulae swirl after blasts, starlight bends near the Black Hole, dust ripples from shockwaves |

## 5. Combat

2.5D side-view 1v1 in a wide arena with deep parallax; best of 3. Left stick aims attacks up/forward/down and targets body
regions; damaged regions are weaker so players can carve toward the core. Hit detection on **actual cell masks**. Guard is a shell
whose effectiveness depends on damage type vs material; sustained Crush breaks it. Ultimate meter fills from dealing *and*
receiving damage. Frame data in data files, shown in Training mode.

Modes: Versus (local 2P) · vs AI · Training (frame data + destruction debug overlays) · AI-vs-AI attract after 60 s idle on title.

Round: intro 2 s · fight ≤ 90 s (timeout → higher `massFrac`/integrity wins) · KO with 0.3× dilation · outro 3 s.

## 6. AI (`src/ai`)

Utility-based decisions + short-horizon lookahead over frame data (spacing, enemy windups, feints, punishing recovery, targeting
weakened regions). Personalities: Last One patient sidestep-punisher · Nexus builds/traps/encloses · Black Hole zones and pulls ·
Supernova bursts then retreats to cool · Planet fortress with moon shields · Asteroid hit-and-run. Human-like: reaction 180–350 ms
by difficulty (`REACTION_MS`), imperfect execution, n-gram adaptation to player habits; **never reads inputs before they happen**.
Levels 1–5 plus 6 = "Titan". **Balance**: headless tournament ≥100 fights/matchup at equal difficulty; every matchup 35–65%,
every titan overall 45–55%.

## 7. Input (`src/input`)

Gamepad API. Primary: Nintendo Switch Pro Controller over Bluetooth (vendor `057e`). Also single sideways Joy-Cons (one per player),
combined Joy-Cons if exposed, Xbox/PlayStation pads, two keyboard layouts. Explicit index tables when `mapping !== 'standard'`.
Controller Check screen (live buttons/axes, remapping persisted in localStorage). Nintendo labels/positions (A right, B bottom,
X top, Y left) with positional-vs-label confirm option. Radial deadzones, stick calibration, hot-plug, "press any button" activation,
P1/P2 assignment. Rumble via `vibrationActuator`. Optional WebHID enhancement behind an explicit button (Chrome), silent degrade.
Default layout: **Y Strike · X Crush · B Surge · A Signature · ZR Ultimate · ZL Guard · L/R feint-cancel · + pause · − training overlay**.

## 8. Visual direction

Pipeline: (1) Three.js renders 3D scenery at logical res into a render target → (2) ordered/blue-noise dithering into a curated
per-stage palette (40–64 colours, hue-shifted ramps) → (3) 2D pixel layers (titans, debris, particles, FX) → (4) post: bloom from
emissives, god rays from the stage light, Black Hole lensing, shockwave refraction, subtle chromatic aberration, grain, vignette →
(5) integer upscale. Bar: finer detail, richer lighting, more life than the author's earlier dithered 3D-galaxy film.

Titans are procedural at load: noise-warped sculpted silhouettes, layered interiors damage reveals, shading from a derived
height/normal field lit by the stage star, rim light, emissive cores, secondary animation (tendril verlet, orbiting moons, disk rotation,
convection, graph pulses). Every titan must read clearly at 64 px.

Stages: **Stellar Nursery** (dust pillars, newborn stars, magenta/amber) · **Galactic Rim** (rotating 3D spiral galaxy) ·
**Red Giant's Wake** (planetary-nebula rings around a dying sun) · **Quasar Void** (relativistic jets across black) ·
**Tussenruimte** (between two galaxies; celadon & black; stillness). Each: parallax depth, volumetric-feeling particle nebulae and dust,
ambient life (comets, distant supernova flickers), reactions to the fight. Debris persists (capped) and drifts.

UI: crisp pixel art, Korean-minimalist restraint, pixel font, Hangeul welcome in titles. UI is rasterised in-pixel (not DOM).

## 9. Audio (`src/audio`)

Procedural WebAudio only. Per-titan sonic signatures — Last One glassy celadon tones · Nexus metallic chains over a low pulse · Black Hole
pitch-bending sub drone · Supernova roaring plasma & crackle · Planet tectonic rumble & wind · Asteroid rock crunch & whistle.
Adaptive score (drone + rhythm layers intensify with fight state). Sub-bass impacts with long reverb tails; a master limiter so nothing clips.

## 10. Repository layout & ownership

| Path | Owner | Notes |
|---|---|---|
| `src/contracts`, `src/sim`, `src/app`, `docs/`, `tests/`, `e2e/`, `tools/lead` | **Lead** | contracts, integration, review loop |
| `src/engine`, `src/render`, `src/stages`, `dev/render`, `tools/render` | **B1** Engine & Render | |
| `src/matter`, `dev/matter`, `tools/matter` | **B2** Matter & Destruction | |
| `src/titans`, `src/combat`, `src/ai`, `dev/titans`, `tools/ai` | **B3** Titans, Combat & AI | |
| `src/input`, `src/ui`, `src/audio`, `.github/`, `dev/ui`, `tools/ui` | **B4** Input, UI, Audio & Ship | |

Builders never edit outside their ownership. Cross-cutting needs → `docs/proposals/NNN-title.md` (Lead applies). New npm deps →
proposal. Tests are colocated (`*.test.ts`). Dev sandboxes live in `dev/<name>/` (Vite multi-page in dev only). Screenshots/WIP images go
to `.scratch/` (gitignored) or `docs/gallery/` (curated).

## 11. Quality gates

`npm run typecheck && npm run lint && npm test && npm run build` must be green before any handoff. No console errors at runtime.
Perf: sim ≤ 5 ms/tick, render ≤ 16 ms/frame on a mid-range laptop (software-GL numbers in CI are pessimistic — see PERF.md).
