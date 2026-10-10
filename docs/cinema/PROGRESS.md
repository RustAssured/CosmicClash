# Cinema mode: progress (TRAILER_V3)

The newest entry is first. Renders go to `press/cinema/` (not in git).

## P6: assembly in the Director (S5): full animatic at ×1 rendered, STOP for review

**Gate:**
- `press/cinema/animatic/trailer-360p.mp4`: 95 s, 60 fps, native ×1, no HUD, rendered entirely by `src/cinema` from `timeline.json`.
- `animatic-720p.mp4`: the same at ×2 nearest, for viewing.
- `sheet.png`: one still per second.
- Deterministic: frames 0, 150, 1300, 2790 and 5000 give the same hash in two cold runs.

**`timeline.json`:** 44 shots, every one commented.
- Act 0:
  - MATTER CAM ×48 on 우리's hot core (the P5 Planet fight);
  - an exponential 18-frame pull-back zooming about the core (`camera.about`), fist mid-swing;
  - a freeze, a cut to white, then 아득.
- Act I: the two worlds (palettes A/B, city lights, arks), then the P2 and P3 gates.
- Act II, S7's actors on the Director:
  - ruin, ark and parallax ×4, with genesis at start 27 / dur 14;
  - the assembly montage cuts on every drum cue from `genesis-cues.json`, alternating wide and MATTER CAM ×4;
  - the fists, the moon, the brace with VO subtitle, the launch.
- Act III:
  - the bars burst open at 0:46.3 on the same fist landing;
  - then the P5 takes vs Planet, Black Hole, Supernova, Nexus, Asteroid and Black Hole, each with S7's 6-frame `nameslam`;
  - two MATTER CAM wound inserts and the two cards;
  - the nova in ×0.3; the eye at ×8 with clicking rings (the rhyme with 0:15); the Witness's beams; cut to black.
- Act IV:
  - the after-fight wide;
  - S7's `edgepull` with the real fight handed in as the arena (`shot.arena` → `setArenaSource`), and the word cards on `edgeWordCues()`;
  - `jawwipe`, `title`, the sting.

**Grades:** `src/cinema/grade.ts` gives per-act grades (before, witness, mouth, build, hunt, edge) as fixed colour functions. Deviation from the brief: the frame is no longer master-snapped since D34, so the grades shift colour in the game's current space instead of mapping inside the 128-colour master.

**Known issues for the next pass:**
- The 30 s, 15 s and loop cuts aren't built yet (P8).
- There's no motion blur yet.
- Some montage takes open a few frames before their action.
- The hunt eye (1:05) is a different seed's Witness than the 0:15 eye.

## P5: gameplay takes (S5): gate rendered

**Tool:** `tools/cinema/p5-takes.ts`.
- 우리 (slot 0) runs a SCRIPTED input track (harness grammar, its real moves and real damage) against each opponent's AI (level 4).
- Opponents and arenas: Planet/Nursery, Black Hole/Tussenruimte, Supernova/Red Giant, Nexus/Shearfield, Asteroid/Rim, the Witness/Mausoleum.
- Three tracks:
  - `hunt`: walk in, crush, crush, signature;
  - `feint`: strike, back off, signature, ultimate;
  - `brawl`: strike-strike-crush chains.
- Seeds 1–4: 72 fights, scanned headless by the press worker (now able to script slot 0).
- Windows are ranked by 우리's landed heavy and catastrophic blows, KOs, break-aparts and ultimates. The top 5 per opponent, all from different fights, make 30 candidates.

**Gate:**
- `press/cinema/p5/preview-{0,1,2}.png`: contact sheets of the 30 candidates, 5 frames each, rendered by the real game in trailer mode.
- `candidates.json` (cfg, script and anchor tick for each) and `takes.json` (all scans).

**Picks used in the animatic (candidate #):**
- 2 (Planet, the cold open and the burst);
- 0 (Planet);
- 5 and 6 (Black Hole);
- 10 and 11 (Supernova, the nova);
- 16 (Nexus);
- 20 (Asteroid);
- 25 and 26 (the Witness's beams, the eye, the edge).

## P3: the Mouth's strike on World B (S5): gate rendered

**Gate (`gates/p3.json` = 0:20–0:24):** `press/cinema/p3-1080p.mp4` and `p3-2160p.mp4`, with stills `p3-f*.png`. Deterministic: the same hash in two cold runs, including frames 175 and 176 around the bite.

**The shot:**
- World B is the real Planet in palette B, a dummy. The camera is locked on where it stood (`camera.lock`), so it sits high on the left.
- The backdrop's stars along the frame edges slide sideways (`backdrop.slide`).
- The Mouth is the LOCKED oracle, baked frame by frame (`tools/cinema/mouth-strike.ts` → `mouth-pack.ts strike` → `press/cinema/work/mouth/strike.cfp`) and played by the new `mouth` actor:
  - the body slides in along the bottom edge from the right corner and the neck rises;
  - the head tracks World B, hanging clear of it;
  - at 2.35 s it begins its real bite (the oracle's MOVES.bite).
- At contact (2.92 s, sim tick 175) the bite is a real catastrophic blow on World B's matter (`match.blows`, Director `tickMatch`), with its presentation (shockwave, flash, shake, hit-stop).
  - Half the world is torn off, then the Planet's own failure sheds the crust and leaves the naked core. That is the "two naked cores" of the ruin.
  - The shake moves the letterbox bars.
- Card "It ate." in the lower bar.

## Fixes after WJ's P2 review (S5)

**MATTER CAM, which WJ found mushy:**
- Tight framing: ×24, about 27×15 native pixels, each a 72-px tile at ×3. The camera tracks the planet with an offset on the real crack line.
- Each pixel is now a distinct lit tile:
  - relief from its neighbours (a trench is darker);
  - a wide lit bevel top-left and a shaded bevel bottom-right;
  - a grout gap;
  - hot matter (the glowing fissure) stays emissive.
- Empty space draws no tiles.
- The glow overlays are dropped in the macro (`shot.hide`), so it shows matter only.
- The p1 crust macro and the p2 gaze macro are re-rendered. Each reads crack (×0.25) → hold (time pushed through) → shear.

**The dithered rectangle on black:** the post's relight lit the black backdrop as if it were a sprite: a Voronoi split of the body lights, Bayer-stepped, which is why it had a straight edge.
- In cinema mode (`renderer.setCinema`) the relight skips pure black.
- The body-light floor on empty space is 0.
- Shots with a backdrop actor hide the stage scenery (`renderer.setScenery`), so no stage light or bloom leaks through.
- The game's own look is unchanged.

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
