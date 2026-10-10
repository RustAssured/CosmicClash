# Cinema mode: progress (TRAILER_V3)

The newest entry is first. Renders go to `press/cinema/` (not in git).

## P2: the Witness close-up (S5): rendered, WAITING FOR WJ'S APPROVAL

**Question for WJ:** does the eye read as THE Witness?

**Gate (`gates/p2.json` = 0:12–0:20):**
- Files: `press/cinema/p2-1080p.mp4` and `p2-2160p.mp4`, stills `p2-f*.png`.
- **halo-rise (0:12):** the real Witness backs out from behind World A. The planet is drawn in front (`match.front`), and the picture is turned a whole quarter (`camera.dutch: 1`), so "away" reads as "up" and its gold halo rises over the horizon like a sunrise.
- **eye-rings (0:15):** ×4, tracking the Witness (`camera.track`). Its halo arcs (the real atlas parts) are offset round the eye and click back into alignment in 6 whole notches.
- **eye-pupil (0:16):** ×8. The real eye cradle's pupil contracts to 35 %; the cells it gives up take the iris colour found just outside the pupil on the same ray.
- **gaze-wide (0:17):** the real Fracture Gaze (scripted signature) strikes World A. Card "It looked at us." sits in the lower bar.
- **gaze-macro (0:18.4):** MATTER CAM on the crust: crack, then time pushed through the lull, then shear.

**Pose overrides (`src/cinema/witness.ts`):** cinema-only beats, acting on the real Witness's own layers through copies. The fighter's layers are never touched.

**New camera features:**
- `track` (follow a fighter; `focus` becomes an offset from it);
- `dutch` in whole quarter turns (pixels move, never resample);
- `matter` (MATTER CAM).

The composer is separable and memoised: ×3 takes about 40 ms a frame and ×6 MATTER CAM about 270 ms.

## P1: World A and World B, MATTER CAM (S5): gate rendered

**Gate (`gates/p1.json`):**
- Files: `press/cinema/p1-1080p.mp4` and `p1-2160p.mp4`, stills `p1-f*.png`.
- Content: the two worlds side by side; the gaze wide; the crust macro (crack, hold, shear).

**Worlds (`src/cinema/world.ts`):** the REAL Planet (renderer, matter, damage) on a match slot (`match.worlds: { "0": "A", "1": "B" }`).
- The Director passes that slot's layers through re-coloured copies.
- Hue bands move while lightness and saturation stay, so cracks, scars and mantle read the same.
- **A:** blue seas, ochre land, hot orange core.
- **B:** teal seas, violet land, cold violet core.
- **Night side:** a stepped terminator, away from the one sky light. City lights are sparse emissive points on its land, breathing; they go out where the crust is gone.

**MATTER CAM (`camera.matter`):** each native pixel becomes a lit b×b cell.
- Colour: the pixel's own.
- Relief: from the brightness gradient of its neighbours (a crack is a trench), lit from the sky's direction.
- Edges: a lit top-left rim, a shaded bottom-right rim, and a grout line from ×16.

**Scripts:** tick 0 is now the tick the fight goes live (as in the harness), so every shot of one fight sees the same script.

**Known issue (renderer, S5):** on the film's black, a faint dithered rectangle shows between bodies that carry additive halos (both planets; the beam). It looks like the overlap of the halo sprites' quads in a pass that should ignore their transparent texels. I'll fix it before P8; it is hidden by the stage scenery in play.

## S7: P6 content (nameslam, edgepull, jawwipe, title): gate rendered

Actors are in `src/cinema/actors/`; each registers itself and imports no other actor. Shared code is in `src/cinema/p6/`.

| type | what |
|---|---|
| `nameslam` | A 6-frame name slam in the game's pixel font with a 1 px outline. Frame 0 is ×4 and white-hot, frame 1 is ×3, frames 2–5 are ×2 in the titan's accent with a 1 px recoil. Params: `titan` (planet, blackhole, supernova, nexus, asteroid, witness, uri), or `name`/`ko`/`accent`; `at`, `x`, `y`. The KO names are the site's (행성 PLANET, 블랙홀 BLACK HOLE, 초신성 SUPERNOVA, 넥서스 THE NEXUS, 소행성 THE ASTEROID, 마지막 하나 THE WITNESS, 우리 URI). |
| `edgepull` | 1:20–1:29. Stars along all four edges slide toward the rim (streaks), and the LOCKED Mouth's coils slide in along the bottom edge. Then the exponential pull-back: the arena shrinks to a small rectangle (with a dotted gold rim), the Mouth at its edge shrinks with it, and the coil heap fills the frame. |
| `jawwipe` | 1:29–1:31. The Mouth's head seen down its axis, so large that its mouth is wider than the frame. The jaw-rings and teeth rows close in as an iris; the gullet is cut out, so the scene shows through the opening; then the bite, and black. |
| `title` | The game's own logotype pixels at ×2, then 아득 (×2), FREE IN YOUR BROWSER (×2) and FINAL BOSS: COMING, each cutting on at its moment with a 1 px outline. No fades, no partial alpha. Colours are snapped to the master palette. |

**The Mouth is the LOCKED oracle, not a stand-in.**
- `tools/cinema/mouth-bake.ts` drives `mouth-LOCKED-full.html` headless like S5's `tools/press/trailer/mouth.ts`: same patches, seeded `Math.random`, no real-time loop. It also exposes the oracle's own building blocks: `braidPaths`, `drawPath`, `slime`, `head`, `compose` and its depth buffer.
- Three sequences:
  - `edge`: the full Mouth, coils sliding along the bottom edge.
  - `heap`: the rest of its body outside the arena. It is the oracle's 4×4 braid along a spiral spine, rendered natively at the camera's scale every frame, so it is never magnified.
  - `jaw`: the head-on head. The gullet is cut out using the oracle's own depth bias.
- `tools/cinema/mouth-pack.ts` snaps every pixel to the master palette and writes run-length frame packs, `press/cinema/work/mouth/{edge,heap,jaw}.cfp` (60 MB, not in git). The decoder, `p6/pack.ts`, is synchronous.
- The actors load the packs from `/press/cinema/work/mouth/` on the dev server. Node tools hand them in with `providePack`.
- The clock and geometry (pull-back curve, heap spine, jaw opening) live in one place, `p6/edge.ts`, shared by the bake and the actors.

**Word cues**, one per coil pass (`edgeWordCues()`, the moments the arena shrinks past 0.6, 0.38, 0.24 and 0.158 of the frame):

| word | time |
|---|---|
| HUNGER. | 85.02 |
| DEVOURS. | 85.98 |
| ENDS. | 86.97 |
| REPEATS. | 88.17 |

**For S5:**
- `setArenaSource(t => frame)` (in `actors/edgepull.ts`) hands the real fight's native frame to the pull-back. Until then the arena is dark.
- Stack the jaw wipe over whatever should be seen through it. My driver holds the pull-back's last frame.
- The words are yours, as cards at the cue times.

**Gate (`press/cinema/edge/`):**
- `stills.png`: 16 moments of 1:17–1:35, plus a nameslam strip (frames 0, 1, 2, 5).
- `edge-0117-0135.mp4`: rendered ×1 at 60 fps, delivered ×2 nearest.
- `edge-cues.json`.
- Made by `tools/cinema/p6-edge.ts` with `tools/cinema/standin.ts` (compose, bloom, palette snap). The arena stand-in is a still native game frame, HUD included.

## S7: P4 content (genesis, ruin, ark, parallax): committed in 852cdda

- **Actors:** `genesis`, `ruin`, `ark`, `parallax`. 우리 is assembled from its real rig parts (WJ's baked a/g sprites with chunk ids, `src/cinema/assets/`) on the timeline clock: WIN timing, a weld flash in the star-flash ramp, and the game's own impact VFX (`p4/sparks.ts` ports `VFX_FRAG`). It then braces into the guard stance and launches.
- **Drum cues:** `genesisCues()`.
- **Gate:** `press/cinema/genesis/` (stills, the 0:24–0:46 video, cue sheet), made by `tools/cinema/p4-genesis.ts`.

## P0: cinema core (S5): DONE, gate passed

**Contract (for S7 and every actor):**
- `src/cinema/types.ts` defines `Actor { id, depth, init?, draw(buf, ctx), dispose? }`, `NativeBuffer` (640×360 packed RGBA plus per-pixel emissive), `CineContext` (frame, t, shot, shotT, sceneT, camera, view, seeded rng, params) and `parallaxOf(depth)`.
- `src/cinema/actors/index.ts` is the registry (`registerActor(type, factory)`); `actors/all.ts` imports every actor module.

**The core:**
- `src/cinema/timeline.json`: the trailer skeleton.
  - All 28 shots of the treatment (0:00–1:35), each with a comment.
  - For now each shot is an animatic slate (backdrop, shot id, card) until its phase replaces it.
  - Retime by editing the numbers.
  - Gate timelines live in `src/cinema/gates/*.json`.
- `timeline.ts`: schema, validation (contiguous shots, a comment on every shot, whole-number card scales), time remap (`time: [shotT, rate]`; slow motion, freeze) and key interpolation.
- `director.ts`:
  - fixed 1/60 s steps of a real Match built exactly like the game harness (`match.ts`: same seeds replay tick for tick);
  - the remap decides the ticks per frame, and the fractional part is drawn through the renderer's own interpolation (render alpha), so no frames are held;
  - the game camera or a fixed/scripted camera;
  - actors handed to the real renderer as screen layers at their depth;
  - a fresh scenery per shot (`renderer.restartStage`), so a shot always starts from the same state.
- `camera.ts` (CineCamera): zoom is interpolated exponentially. Every native pixel is drawn as a whole b×b block, with b = round(S·zoom) at output scale S: exact ×S·zoom at rest, and growing one output pixel at a time during a zoom. The crop origin is snapped to the block grid, so nothing is ever resampled.
- `overlay.ts`: the 2.39:1 letterbox (640×268 picture, 46 px bars; animatable; shakes with the camera) and cards in the game's pixel font at whole-number scales with a 1 native px dark outline and no partial alpha.
- `cinema.ts` plus a `src/main.ts` hook: `?cinema=<timeline>` boots the renderer alone; `render=1` exposes `window.__CINEMA__.frame(n)`.

**Tools:**
- `tools/cinema/render.ts`: offline render. It reads the native frame back exactly, composes at ×3 (1080p) and ×6 (2160p), and pipes raw RGB to ffmpeg (`-sws_flags neighbor`, x264 `-tune animation -crf 12`). It also writes per-frame hashes and PNG stills.
- `tools/cinema/determinism.ts`: renders 5 frames in two cold page loads and re-renders each in the same page; the hashes must match.
- `src/cinema/cinema.test.ts` (vitest): timeline validity, time remap, exact b×b blocks at rest and mid-zoom, letterbox geometry, card outline and alpha.

**Gate (`gates/p0.json`, 5 s):**
- Content: a real fight (Planet vs Supernova, Quasar, seed 22), a 1 → 0.25 ramp into the flash, an exponential ×1 → ×2 zoom, the bars bursting open on the hit, a card, then a backdrop actor under a drifting fixed camera with a two-line card.
- `press/cinema/p0-1080p.mp4` and `p0-2160p.mp4`, with stills `p0-f*.png`.
- Determinism: the same hash in two cold runs and on re-render (frames 0–4).
