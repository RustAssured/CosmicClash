# Living idles: the port

The nine approved "living idle" prototypes (the idle handover package from the claude.ai prototyping thread: specs, built
pages, data) are rebuilt in the game one titan at a time, each approved by WJ side by side before the next. The package itself
stays outside the repo (about 10 MB); its specs are the source of truth for each titan's numbers.

**Shared kit:** `src/combat/fx/idle.ts`. It holds:
- the approved 8×8 Bayer table;
- the prototypes' hash and value noise, plus `NoiseLattice`, which gives the same noise with one hash per lattice point a frame;
- a table sine (`fsin`): `DMath.sin` is exact but slow in per-cell loops and allocates, and the sim lint bans `Math.sin` in `src/combat`;
- the seeded LCG;
- `IdleClock`, one fixed 1/60 s step per sim tick, caught up in full, so the idle depends on the ticks alone;
- preallocated pools;
- `BodySkin`, the body's pixels presented in place of the body layer, so an idle can recolour, hide or add body cells
  without ever writing the hashed matter map;
- `BodySpaceLayer`, a larger layer in the body's map space that mirrors and moves exactly with it.

**Checks per titan:**
- `npx tsx tools/titans/idle-compare.ts <titan> --proto=<built page>`: a sheet of the prototype on a virtual clock in
  lockstep with the game; `--video=<file.mp4>` makes a side-by-side clip;
- `npm run perf:gate -- --only=<titan>`: a mirror storm, plus the titan's clashes and its idle cost line;
- the render-purity test (`src/combat/renderpure.test.ts`) and the titan's idle tests.

## 1. Supernova 초신성 (ported 2026-10-17, waiting for WJ's side-by-side)

`src/combat/behaviours/supernovaIdle.ts`, wired into `supernova.ts`. Evidence:
- `docs/gallery/idle/supernova-compare.png` (row 1 prototype, row 2 game, every 40 ticks, Tussenruimte);
- `evidence/idle/supernova-side-by-side.mp4` (prototype left, game right, 8 s; footage stays out of git).

**What is in:** the full spec (§3–§5).
- **Heartbeat:** a held breath, then a swell. It grows the rim by whole pixels and loses one on the inhale; the light ring
  reaches the limb late; a burst of tongues answers each beat about 1.2 s later.
- **Disc:** the granules boil on their own beats and the lanes drift. A flare brings a Moreton wave.
- **Corona:** pixel fire whose tips burn away and regrow.
- **Prominences:** living ones that rise, braid, snap and rain (resident ones start pre-aged). Plumes tear loose.
- **Ejecta and sparks:** CME ejecta every third beat, and sparks.
- **Fuel:** it cools the star down its gradient and breaks the rhythm.
- **Hurt:** it quickens the beat and adds flicker.
- **The fight:** the idle yields over about 8 ticks to moves, hitstun and KO; boil and fire stay at least half on.
  The collapse startup keeps its old whitening.

**Changed from the spec, and why:**
- **Damage test.** The spec said to recolour a cell only while `map.pixels === map.baseColor`. In the game the matter
  module lights `map.pixels`, so that test never holds, and the whole star would show the painted pixels. A cell is now
  "changed by the fight" when the sim says so: integrity below 255, or burning, cracked, charred, assimilated or glowing.
- **Sine.** The prototypes' `Math.sin` became a table sine; the lint rule bans `Math` transcendentals in `src/combat`.
- **Flame layer depth.** The flames, sparks and prominences are drawn at z 10.5, above the body and the fight-plane
  debris. At the spec's z 0.5 the unified look outlined every tongue and spark in black, which the prototype never does.
- **No size resample.** The prototype's `size` resample is not ported; it is a scaling, and the game already shrinks the
  star with real shed matter (as the spec says).
- **Seeds.** Each fighter seeds its own idle, so in a mirror match the two stars do not beat in unison. That is also why
  the clip's beats fall at different moments from the prototype's fixed seed.

**Numbers** (WJ's laptop, 1080p ×3 full screen, tier auto, `npm run perf:gate -- --only=supernova`):
- **Mirror storm** (AI vs AI, full meters): 60.0 fps mean, 1 % low 49.5–53.6, 0 frames under 30 fps. GATE PASS.
- **GC:** V8 pauses max 3.1 ms, none over 4 ms.
- **Idle line** (both stars idling): 6.7 ms CPU and 3.5 ms GPU a frame; it was 3.3 ms CPU before the port. The idle's own
  draw is about 1.8 ms a star (skin 1.45 ms, flames 0.36 ms, in Node).
- Tests: render purity green, three idle tests (the same picture at any frame rate, the matter map never written, a hole
  stays a hole), and the full suite green.

**Decisions for WJ:**
1. **Bloom.** The game's shared bloom is softer and smaller than the prototype's own glow. Keep the shared look, or raise
   the Supernova's emissive and halo toward the prototype?
2. **Sunspots.** The game's painted sunspots stay dark; the prototype shows none. Keep them, or let the idle brighten them?
3. ~~**Streamer outline.**~~ **Decided (WJ, 2026-10-17): no outline.** The Supernova's body sets `outline: false` (a new
   optional `RenderLayer` field, checked by `isTitanLayer`), so the unified look draws no dark contour or depth seams
   round it. Every other titan keeps its outline.
4. **Bob and sway.** The fighter's whole-body bob (3.2 px, 5 s) and sway are kept, as the spec defaults. The prototype
   has none. Dropping them changes replay hashes.
5. **Embers.** `feel.fx` embers (`idleRate 8`) overlap the idle's sparks. Lower them? That is a JSON change.

## 2. The Nexus 넥서스 (ported 2026-10-17, waiting for WJ's side-by-side)

`src/combat/behaviours/nexusIdle.ts`, wired into `nexus.ts`. It replaces `drawGraphFx`: the sliding glow dots, the node
breathing, the hub glow and the crystal shimmer. Evidence:
- `docs/gallery/idle/nexus-compare.png` (row 1 prototype, row 2 game, every 40 ticks, Tussenruimte);
- `evidence/idle/nexus-side-by-side.mp4` (12 s; covers a decision and a lean).

**What is in:** the full spec (§3–§5).
- **Gem ticks:** staccato keyframes in whole pixels: a 1 px pull-back, an overshoot, a settle. One gem moves at a time,
  every 0.18–0.6 s.
- **Chains forged anew every frame:** they slacken when the gems close in, pull taut when they part, and rattle when a gem
  moves. They use the painter's link geometry and tone hash.
- **Thoughts:** signals run along the chains as heat and pass from gem to gem.
- **The heart:** its facets light in turn, and a pupil slit watches the prey during a lean.
- **The decision** (every 7–11 s): clench, fire every spoke, snap the rim out, reset gem by gem.
- **The hunting lean:** ring by ring toward the prey, and the nearest gem twitches.
- **Sinew:** pendulums kicked by the gems' own motion.
- **Veins and buds:** veins of assimilation creep and withdraw; buds of crystal push out of the rim and crumble.
- **Yielding:** a clockwork snap home within 5 ticks on any move or hit; on KO everything stops. Thoughts keep running in
  a fight, faster during a harvest.

**Changed from the spec, and why:**
- **State lives render-side.** The spec put the scheduler in `update()`. Instead, each tick's inputs (at rest, KO, harvest,
  real growth, prey side, live gems, intact chains) are recorded in `update()` and the idle steps once per tick from them
  at render time. That is the same as the Supernova: deterministic at any frame rate (tested), and no cost added to sim
  ticks (rollback, AI runs).
- **Chain colours come from the painted body.** Each forged link knows where it sits at rest and takes the painted colour
  of the cell under it, so a resting chain is the painted one: 32 of 10,121 cells differ at rest, apart from the heart's
  facets, which are the animation. Heat still steps up the prototype's ladder.
- **Sparse glow.** The Nexus's materials carry strong emissive (gems 84, cores 230, crystal 46), so in game the whole graph
  bloomed far past the prototype. The composite now sets the gems' emissive itself, as the prototype does: cores faint at
  rest, flaring with a thought; hot links, vein tips and bud cores. Cells the fight changed keep their own (heat glow).
- **Off-palette colours.** The prototype's white-hot is the heart's own brightest painted colour, and the pupil is the
  darkest painted crystal colour (spec §6).
- **Not ported:** cut-chain debris (the game already makes real debris and whips), dark-gem sag and fade (`goDark` greys
  them), and the sky.

**Numbers** (`npm run perf:gate -- --only=nexus`):
- **Mirror storm:** 60.0 fps mean, 1 % low 58.1–58.3, 0 frames over 25 ms. GATE PASS.
- **GC:** V8 pauses max 1.0 ms.
- **Idle line:** 4.6 ms CPU and 3.8 ms GPU a frame for two Nexuses, up from 3.4 ms CPU.
- **A note:** one sim tick in the storm reaches about 20 ms. That is the fight's sim; the idle is render-side.
- Tests: render purity green, four idle tests (the same at any frame rate, the map never written, chains at rest are the
  painted ones, a hole stays a hole), full suite green.

**Decisions for WJ:**
1. **Pupil colour:** the darkest painted crystal colour. Check it in the clip.
2. **Sway and bob.** The prototype has no smooth whole-body sway (`lean` ±1.8 px) or bob (2.2 px, 4.2 s). Both are kept
   (sim side; dropping them changes replay hashes).
3. **Lean triggers.** The lean comes on the random 8–14 s timer only. The spec suggests also when the foe starts a move or
   comes into reach.
4. **Glow.** It is now the prototype's (sparse). Today's strong whole-graph bloom is gone at rest; say if you want some
   of it back.

## 3. The Asteroid 소행성 (ported 2026-10-17, waiting for WJ's side-by-side)

`src/combat/behaviours/asteroidPose.ts` (sim) and `asteroidIdle.ts` (render), wired into `asteroid.ts`. WJ's choices,
recorded as D39 (`docs/DECISIONS.md`): real rotation, real darts at full range, the spin on real momentum. Evidence:
- `docs/gallery/idle/asteroid-compare.png` (row 1 prototype, row 2 game, every 20 ticks);
- `evidence/idle/asteroid-side-by-side.mp4` (12 s).

**What is in:**
- **Sim (the pose), stepped in the new `Behaviour.bodyPose` hook** (`fighter.ts` adds its offset like the bob and sway, and
  writes its rotation):
  - head snaps: 2 ticks of travel, 2 ticks a notch past, dead still, a lock;
  - darts: 1 tick back, ease-out travel, 2 ticks a pixel past, a dead stop;
  - the feint: crouch, charge, tremble, lunge, dust ring, two hops home;
  - the spin.
  - It is deterministic and folded into the hash.
- **Render:**
  - the spring swarm: its count is the real fragment resource, and it is hidden while the fragments are out;
  - travel smears with speed lines, rotation smears, and afterimages cooled toward ice;
  - the copper heart's lub-dub, light running along the ice veins (all lit while charging), and olivine winks, drawn in a
    skin that the renderer rotates with the body;
  - the horn's glint on a lock and while charging, sniffs at the horn, gas jets for every dart, dust and rings.

**Changed from the spec, and why:**
- **Prey.** It is the opponent's anchor (`foe.view`), not the pointer.
- **Smears and afterimages trace a cheap silhouette.** They sample the rotated body with one nearest texel per pixel,
  cached per angle, instead of the engine's 3×3 vote. They are dithered and darkened, so the difference does not show, and
  it keeps a new angle under 0.5 ms. They come only from the pose's own motion (darts, lunge, turns), not from walking or
  knockback.
- **Off-palette colours are mapped onto the rock's own ramps** (spec §6): white-hot is the brightest ice, the afterimage
  is the ice ramp by brightness, and the gas and ring tails are ice and regolith.
- **The old idle is replaced.** The slow tumble sway is gone at rest (the darts replace it; a rotated body ignores lean
  anyway), and so are the six orbiting pebbles. The Tumble surge's fast spin lean and the momentum embers are kept.
- **Live bounds.** `Fighter.liveBounds()` now also rescans when the rotation changes (spec §6).
- **One existing test changed.** `src/combat/layers.test.ts` checks the fighter's own dirty-rect protocol. It now stubs the
  behaviour's layers, because a living idle presents its own skin afterwards.

**Numbers** (`npm run perf:gate -- --only=asteroid`):
- **Mirror storm:** 60.0 fps mean, 1 % low 57.9–58.3, 0 frames over 25 ms, worst sim tick 8.1 ms. GATE PASS.
- **GC:** V8 pauses max 1.1 ms.
- **Idle line:** 4.0 ms CPU and 3.1 ms GPU a frame for two Asteroids, up from 2.6 ms CPU.
- Tests:
  - five idle tests: the horn lands where the head points (facing ±1); no offset or rotation in any move tick;
    deterministic hashes; a crater stays a hole in the turned body;
  - render purity green, and the full suite green.

**Decisions for WJ:**
1. **The engine's rotation sampler versus the prototype's RotSprite.** The body turns with the game's shared 3×3 sampler,
   not the prototype's Scale2x×8 RotSprite. Look at the horn tip and the 1 px ice veins in the clip. If they are not
   right, a third sampler mode can reproduce RotSprite (in both the CPU contract and its GLSL twin).
2. **The ±45° idle range.** The spec suggested it and asked you to verify. A wider range lets the horn follow a foe above
   or below.

## 4. The Planet 행성 (ported 2026-10-18, approved by WJ, e4418da)

`src/combat/behaviours/planetIdle.ts` (render side), `planetFrames.ts` and `src/titans/art/planetBake.worker.ts` (the
rotation frames), wired into `planet.ts`. WJ's choices (2026-10-17): a 45 s day as in game, the 1 px impact jolt drawn
only (`PLANET_JOLT`), no lensed stars, the moons at game speed. Evidence:
- `docs/gallery/idle/planet-compare.png` (row 1 prototype, row 2 game against a still Asteroid, every 75 ticks);
- `evidence/idle/planet.mp4` (12 s; the first quake at about 2 s, the gravity pull at about 6 s).

**What is in:**
- **The world turns:** 240 painted frames of the face, stepped exactly as painted, phased from the world's own spin and
  its Brace half-turn, slowing in the pull's anticipation. The clouds stall with it.
- **The surface lives:** plate seams as faint scars; quakes tear a seam open in magma and shift the plate a whole pixel or
  two, leaving a dark gap; tsunamis with a foam front, a dark trough and coastal spray; craters, hot, then rimmed, healing;
  a tidal bulge under each moon; the moons' shadows.
- **The gravity pull** (every 10–15 s at rest): stall, yank, a third of the ring falls in, 26 rocks are dragged in from
  space and strike (jolt, dust, flash, sometimes a quake), the air whitens, aurora and halo flare, the moons lurch.
- **The ring of rubble:** 150 rocks (more as the world breaks) on the prototype's tilt and flattening, lit from the upper
  left, half behind the globe and half before it. It replaces the old dotted debris ring and keeps its meaning: commitment
  and Tidal Draw pull it in.
- **The fight:** new events start only at rest (no move, Guard, Draw, half-turn, comet or KO); a KO stops them at once.
  The face is drawn on pristine cells only: holes, cracks and exposed strata keep the fight's drawing.

**Changed from the spec, and why:**
- **Bake.** The 240 frames come from the game's own painter (`paintPlanetFace`, the face only; a test checks it gives
  `paintPlanet`'s colours exactly), baked in a Web Worker nearest-first in the direction of turn. A frame not baked yet
  holds the last one. The painter was made 4× faster for this (`gradNoise` memoises its gradients; bit-identical).
- **The face is redrawn 30 times a second** (on even ticks), not 60. A tsunami front moves about 0.4 px a tick, so it
  still advances a pixel at a time, and the picture is still the same at any frame rate (tested).
- **At most three quakes at once.** A pull lands about 80 rocks; at the spec's 18 % each, the pool filled with quakes.
- **No outline on the rubble.** At the spec's depths the unified look outlined every pebble.
- **Off-palette colours** are steps along the Planet's own lit ramps: foam is the top of the ocean and ice ramps, the gap
  a moved plate leaves is the darkest crust.

**Numbers** (`npm run perf:gate -- --only=planet`). The gate fails today on its 58 fps mean target **before the port
too**: on the last commit the same scenarios average 56.5 fps on this laptop.

| Colossus v Planet clash | before the port | with the idle | idle without the bake |
|---|---|---|---|
| 1 % low | 40–47 | 25–30 | 43–48 |
| frames over 34 ms (per run) | 1–3 | 6–10 | 1–2 |
| sim tick p99 | 15 ms | 17–19 ms | 14–15 ms |

- **Idle line** (two Planets idling): 5.4–5.7 ms CPU, 5.8–6.0 ms GPU a frame, against 3.5 / 4.5 ms before the port.
- **Storm** (Planet v Black Hole): 1 % low 48–53, unchanged.
- **The cause is the bake running beside the fight**, not the drawing: with the bake switched off the clash matches the
  baseline. A face costs about 100 ms to paint, and the world needs about 5 a second while its first day turns, so for the
  first ~45 s of a match the worker keeps a core half busy, and on this laptop that slows the main thread and the GPU.
  Resting the worker longer between frames did not help. After the first day every frame exists and the cost is gone.
- Tests: three idle tests (the same at any frame rate; damaged cells keep the fight's drawing; the ring on both sides
  and the whole day turning), the face painter test, render purity, determinism, and the full suite green (one HUD timing
  test fails only under full-suite load and passes alone).

**WJ's decisions (2026-10-18):**
1. **The bake: kept as is** (240 frames, the spec's rotation), to be optimised later. Options on file: cache what does
   not turn in the face painter (relief, bands, tone, layout: ~20–25 %), pause the bake while a move is active, or fewer
   frames.
2. **Halo: about 80 % of the prototype's.** The halo sprite is now the prototype's falloff out to 1.7 R in its colour
   ([90,170,255] × 0.16), at 80 %; it still flares with the pull (× (1 + 1.9 · yank)). It was a 2.2 R sprite near full
   strength.
3. **Rocks brighter and clearly visible:** the upper half of the crust ramp, and more of them 2 px.
4. **The atmosphere thinner and calm, like the prototype's** (render only: the matter keeps its 8 px of air, so heat
   absorption and the stripped-air phase are unchanged). The Planet presents its own copy of the body's pixels
   (`BodySkin`):
   - the ring is drawn 4 px thick in solid bands lit toward the key light (the painter's Rayleigh edge without its
     checker dither and noise); the outer 4 px are not drawn;
   - its emissive is 6, the prototype's 0.025, instead of the material's 40, which the shared bloom spread into a wide
     white haze;
   - the pull whitens the whole ring a step or two at once instead of in dithered dots;
   - the glow pass's random atmosphere twinkles are gone;
   - the cloud deck over the face is drawn as solid shapes (one threshold at the middle of the old dithered band) while
     the air is whole, so a drifting deck no longer crawls with checkerboard; a stripped, thinning deck still breaks up.

## 5. The Witness 목격자 (repo id `lastone`; ported 2026-10-18, approved by WJ, abdf036)

Naming: the Witness is `lastone` (`LastOneBehaviour`, `TendrilSystem`). The `witness*.ts` files belong to the Last One
(`colossus`) and are untouched. Files: `lastonePose.ts` (sim), `lastoneIdle.ts` (render), the idle veil in `tendrils.ts`,
wired into `lastone.ts`. WJ's choices (2026-10-18): the veil's motion is real but idle only; the swim is real and replaces
the bob and sway; the tilt is the row-shear lean (D4); the hem pull-in is ported (drawn only). Evidence:
- `docs/gallery/idle/witness-compare.png` (row 1 prototype, row 2 game against a still Asteroid, every 60 ticks);
- `evidence/idle/witness.mp4` (14 s; a pulse, a taste and a Five Witnesses moment).

**What is in:**
- **Sim (deterministic, in `hash()`):**
  - the idle weight, easing in only while calm and out in ~0.25 s;
  - the pulse (every 4.2–5.0 s): the body lifts on the stroke and the veil draws together, then flares, root first;
  - the taste (every 5–10 s): the two front or hem tendrils nearest the foe reach for it;
  - the Five Witnesses (every 12–18 s): the body rises 4 px, the veil lifts into a crown;
  - taste and the Witness start only when fully idle with the foe out of reach (190 px); a move or a blow ends them;
  - the swim spring (a 3 × 2 px drift, the stroke's lift) through `bodyPose`, the tilt through `leanBias` (row shear);
  - the veil: the chains spring toward the prototype's rest curve (the raw root normal, curl and S-wave, a travelling
    wave, the crown's fern curl, the water drag), each joint's heading following the one before it at the prototype's
    rate; the sag fades out while idle. Hits still read the chains: what is drawn is what is hit.
- **Render (a body skin, plus one overlay):**
  - the hem pulls in by whole-pixel rims on the stroke;
  - the lantern beats, and its light runs out through the lattice and seams; the seams flood for the testimony;
  - a glint crosses the glaze along its crazing; the halo's glint runs the ring and its gems precess, gathering behind
    the lead eye for the testimony;
  - five eyes, five minds: the lead eye follows the foe with overshooting saccades, one darts, one looks behind, one
    lags, one looks where the foe was 1.6 s ago; out-of-step blinks; a lock narrows every pupil; the socket bevels turn
    like apertures and align for the testimony; in a fight every eye is on the foe; hitstun half-closes the lids and a
    KO closes them, as before;
  - spores off the tips, the tips igniting one by one, the testimony marks closing on the foe with threads of sight.

**Changed from the spec, and why:**
- **The tendril tips' light bias** (front +0.05, back −0.12) is not added to `SplinePen`; the tips' ignition is drawn
  on the overlay instead of through the pen.
- **Shatter's whips start from the flowing rest.** On the first active tick their tips average 22.5 px in front of the
  body instead of 25 (the back tendrils now rest behind it). `tendrils.test.ts`'s bound is 20 px, with the reason.
  Dropping the idle at once on a move start knotted the recovery, so the idle still eases out over ~0.25 s.
- **The old eye overlay is gone:** the skin draws the eyes (the shared gaze, blinks, hitstun and KO lids carry over).
- **The idle's clock counts the round intro**, so in the comparison the game's moments run a little ahead of the
  prototype's.
- **Gems** are found from the painted colours at attach (a frame-rate test caught them depending on the first frame).
- **One AI test samples twice as many seeds.** `ai.test.ts` "higher levels dodge a telegraphed Crush" has the Witness
  defend. At 24 seeds the idle's swim and veil moved one strike, and levels 3 and 5 tied at 7/24; at 48 seeds the
  ladder holds clearly (levels 1 / 3 / 5: 34 / 15 / 13 of 48), so the test now uses 48 (it takes ~170 s).

**Numbers** (`npm run perf:gate -- --only=lastone`, 2026-10-19, with Blender ×2 and Steam open, so measured against the
last commit under the same conditions):

| two Witnesses idling | last commit (e4418da) | with the port |
|---|---|---|
| CPU a frame | 8.1 ms | 11.4 ms |
| GPU a frame | 16.8 ms | 18.4 ms |
| mirror storm mean | 29–31 fps | 29 fps |

- The skin's lantern and glaze visit only the band of cells their fronts are crossing (sorted once, a range search per
  tick): 1.7 → 0.7 ms a tick in Node. The idle's spores and marks draw on the existing `fx` overlay (no layer of their own).
- The gate fails on this machine before and after the port (the storm runs at ~30 fps with Blender open); a run on a quiet
  machine is still owed.
- Tests: four idle tests (render purity through 1,300 calm ticks with a Five Witnesses moment; the moment lifts the
  veil; the same picture at any frame rate; a hole stays a hole), the D28 spectrum test, determinism, render purity.

**Decisions for WJ:**
1. **Shatter reach.** The whips arrive 2.5 px less far forward on the first active tick (see above). Fine, or tune?
2. **Taste and the crown in a fight.** Both are idle only and need the foe beyond 190 px. Say if the distance should
   differ.

## 6. The Last One 마지막 하나 (repo id `colossus`; ported 2026-10-19, approved by WJ)

Naming: the Last One is `colossus`, drawn by `WitnessBehaviour` in `witness.ts` (the old names). Files:
`colossusPose.ts` (sim), `colossusIdle.ts` (render), wired into `witness.ts`; `colossus.json` bob and sway set to 0. WJ's
choices (2026-10-19): the scythes, halo and chandelier move on the real rig, idle only; the breath, shifts and drop move
the real body and replace the bob and sway; the spires' swing is drawn only; the prototype's springs are kept. No blink
(WJ: "it just sees"). Evidence: `docs/gallery/idle/colossus-compare.png`.

**What is in:**
- **Sim (deterministic, in `hash()`, 4 substeps a tick as the page's 240 Hz):** the 9 s breath (a 0 / −2 px bob, held
  while witnessing); the heavy body spring with its shifts toward the foe and the drop (ramped over 9 ticks); the scythes'
  root and blade springs with the stretch (counter-move, lift, curl, snap); the halo arcs rocking in their sectors (arc 2
  against and 1 px out of true, the ring's vertical lag in whole pixels); the chandelier's pendulum; the witnessing
  (every 12–18 s, first at 9 s), which locks the halo, sets the arms and holds the breath. The angles are handed to the
  rig's own drives (targets, and a little stiffness while calm), and the breath moves the kinematic eye so the structure
  lags it. What is drawn is what is hit.
- **Render:** the atlas is recoloured in source space before the parts rotate: the carapace's breath rim and parting
  seams (channels, then gold, then the abyss, whose inner eyes open for the witnessing), crack waves along the fracture
  network and shimmering hairlines; the scythes' vein signals, edge glints, gold sparkle and orb-eyes (peeks, then all
  open and staring for the witnessing, closing in a wrong order); the chandelier's spires swinging (drawn only) and gold
  drips; the halo brightening. The great eye (a skin): saccades with overshoot, a glance at nothing, the pupil breathing
  a ring and going to a pinpoint. Behind the atlas: the light ring completing from the sigil, the crosshair ticks, dust off
  the snapped spires. On the fx overlay: the reticle landing on the foe and the line of sight.

**Changed from the spec, and why:**
- **Stiffness.** To carry the prototype's springs the idle stiffens the drives it steers, but only by ×1.25 and only while
  calm: at ×2.5 a blow's load reached the arms too soon (`witness.test.ts` "the load reaches the arms later" protects
  the carapace-first wave). The rig's own dynamics soften the scythes' quick snap a little.
- **The idle lets go** over ~0.15 s when a move starts and over ~0.6 s after a blow.
- **Ladders** come from the painted template and the ramps (a lit colour off its ladder is placed by luminance), so the
  drawing never depends on when the first frame was drawn (a frame-rate test caught it).
- **The rim swell** is drawn only inside each region's own atlas rectangle.
- **Kept, not in the prototype:** the existing arm fragments, the shrine light and the steady eye glow. Say if they go.

**Numbers:**
- Node, render: the idle's atlas shading 1.2 ms a tick (from 2.5 before cell lists and the shear skip), the eye 0.2 ms.
- Node, sim (a colossus mirror, both AIs fighting, 1,500 ticks): mean tick 1.61–1.68 ms against 1.46–1.56 on the last
  commit (+0.1 ms; the pose's sines use the deterministic table sine), p99 within the run-to-run noise (7.3–9.4 vs 7.2–9.1).
- The browser gate ran with Blender ×2 and Steam open and swung wildly both ways (the last commit's Uri v Colossus
  storm ran at 25 fps, the port's at 36–54; the port's colossus mirror at 30 against 50): no conclusion. A run on a quiet
  machine is owed.
- Tests: three idle tests (render purity through a whole witnessing; the same atlas at any frame rate; the body breathes
  and the idle comes in), `witness.test.ts`, determinism, render purity, choreo, hits.

**WJ's decisions (2026-10-19):** keep the softer snap (the carapace-first load wave wins), and keep the extra fx (arm
fragments, shrine light, eye glow).

## 7. The Cradle 태반체 (ported 2026-10-19, approved by WJ 2026-10-20, 9f16fa0)

Files: `src/combat/behaviours/kit/cradle/pose.ts` (sim), `cradle/idle.ts` (render), wired into `kit/cradle.ts`; the
approved frames in `src/titans/kit/cradle/cradle_frames.bin` (zlib, 1.7 MB) and `cradle_frames.json` (palette, frame
boxes, the rest disc), extracted from the built prototype by `tools/titans/cradle-frames.ts`; `frames.ts` loads them
(the browser fetches them at boot, never awaited; Node reads them synchronously). WJ's choices (2026-10-19): ship the
approved frames, with the paint seed pinned to 7 (`CRADLE_PAINT_SEED`) so the frames match the painted body; accept the
claw drawing 10–21 px inside the hit mask; the quickening only with the foe within 240 px; the cord real, idle only.
Evidence: `docs/gallery/idle/cradle-compare.png` (across a quickening, `gap=240`).

**What is in:**
- **Sim (deterministic, in `hash()`):** the idle weight (in over 0.5 s, out over 0.15 s); the cord's rest sway (3.5° over
  9.5 s running down the links, plus 1.5° at 0.41 rad/s) as targets on the links' own drives; the coil (every 8–14 s,
  first at 5 s) aiming the jaw-organ at the foe; the quickening (7 s; first at 9 s, then every 14–19 s, only with the foe
  within 240 px) aiming the cord, then pulling it taut (2.2–3.5 s) and hushing the sway. What is drawn is what is hit.
- **Render:** the sail is the approved frame for the current tilt and claw (phi precessing over 26 s, the spread spring,
  the claw pulses), recoloured through the stage palette, with the contraction running hub → rim, vessel pulses, the
  sacs' level fluid line sloshing, their masses kicking, the cold lumen flicker, the quickening's spiral of lit sacs and
  the release ring. Every frame cell maps back to its rest-disc cell: destroyed → nothing, changed by the fight → the live
  pixel. The cord: the bolus swallowed down it, muscle bands, the jaw-organ tasting. The knot: the embryo cleaving
  1 → 16 and collapsing. On the fx overlay during the quickening: the filaments reaching the foe, beads, twigs, the web.

**Changed from the spec, and why:**
- **The frames are shipped, not baked in game:** a frame costs ~0.6 s to bake and the claw's code was lost; the seed is
  pinned so the painted body and the frames agree.
- **Sac identity** is the nearest painted sac by angle (the spec's §6 note), cached per frame in a small LRU.
- **The quickening needs the foe within 240 px** (anchor to anchor). At the default round-start gap (380 px) it waits
  until the fighters close in; with a big foe (the Asteroid) 240 px is nearly touching.
- **The sail redraws every other tick** (every 4th at the lowest detail); the cord and knot every tick while the idle runs.

**Numbers:**
- Node (a Cradle v Asteroid idle at 200 px, 1,500 ticks, 3 reps, against the last commit): render avg 1.41–1.55 ms, p95
  3.0–3.4 (before: 1.61–1.87, p95 4.9–5.1: the old sail warp is gone); sim avg 0.38–0.45 ms against 0.33–0.37.
- Tests: four idle tests (render purity through a quickening; no quickening with the foe beyond 240 px; the same atlas
  at any frame rate; a sail with no matter left draws nothing), `cradle.test.ts`, determinism, cross-engine, render purity.

## 8. 우리 Uri, "The Refusal: still here" (ported 2026-10-20, approved by WJ 2026-10-22, in 9f380e1)

Files: the idle's sim in `src/combat/uri/kinetics.ts` (`URI_IDLE`, `idleTick`, `idleGoals`, off by default so the oracle
parity harness is untouched; `UriBehaviour` turns it on), the slam's events in `behaviours/uri.ts`, the drawing in
`render/uriLive.ts` (`UriIdleFx`, the loop packet, stateless jigs and specks), `render/uriLivePass.ts` (cores dimming, the
speck set), `render/shaders.ts` `PART_FRAG` (cities, slit, the chunk path) and `render/compositor.ts`. WJ's choices
(2026-10-20): the Refusal only as in the prototype (on its own every 13–17 s at rest; never during a move or once broken;
a hit neither triggers nor cancels it); the first one 8 s into a round; the slam's ring, flash and shake as the prototype's;
the three near-white idle colours kept exact. Evidence: `docs/gallery/idle/uri-compare.png`.

**What is in:**
- **Sim (deterministic, its own seeded stream, in `hash()`):** the 2.6 s weight shift (root sway and dip, arks rolling,
  torso lean toward the foe), the guard with the arm on the opponent's side leading (never mirrored), a fist clenching
  every 2.6–5.6 s, the loaded side's lobe stretching and pylon burning harder, the moon looking toward the foe (during
  moves too, as the approved build), and the Refusal: loosening over 1.6 s, the slam at +2.1 s (loop, cores and root
  kicked; fists clenched hard and stiff), the guard until +5.2 s, done at +5.6 s. A move cancels it on the same tick.
- **Render (stateless: functions of the kinetic clock, which freezes in hitstop, and hashes):** the cities' day–night
  line sweeping the body every ~19.6 s, the Refusal's wave out from the cores and cities failing while it comes apart;
  the moon's slit scanning (white for the slam); the loop's packet lapping every 2 s, the loop thinning and dropping out
  while loose (drawn only); the cores dimming; every part's chunks pushed out by the Refusal (whole px, x jitter when fully
  loose), the slam's blue edge flicker; a chunk jigging out a pixel every ~0.65 s and snapping back with a blue flicker;
  specks shed from the cracks (some pulled back in, field blue) and 60 specks pulled in at the slam. On the slam: the
  game's shockwave ring, a small flash and shake 4 at the cores' barycentre.

**Changed from the spec, and why:**
- **The pelvis never takes the chunk path:** it is the fighter's own body layer, not an atlas part (it has 81 of ~1,300
  chunks and 10 city cells). It sways with the body and its cities stay lit.
- **Jigs and specks run on fixed slots** (a jig slot every 0.65 s with jittered start, a speck slot every 1/6 s) rather
  than the prototype's random chains: stateless, so rendering can never feed back. A jig picks a live chunk by hash on the
  GPU's chunk table, so torn chunks are never picked.
- **Offsets are whole px** (the LOOSE push and its jitter are rounded); the jig is 1 px at game scale.
- **The flash** is the game's `flash` event at 0.25 (0.5 washed the whole chest white; the prototype's is 4 px and gone
  in ~4 frames). The ring is the game's own shockwave, not the prototype's thin ellipse.
- **The chunk table cap is 256** (it was 160; the chamber has 233).

**Numbers:**
- Node (a Uri v Planet idle, 1,200 ticks, 3 reps, against the last commit): sim avg 0.24–0.44 ms against 0.16–0.21 (the
  swaying body moves its matter every tick); render CPU under 0.02 ms. The GPU cost of the chunk path during a Refusal
  is not measured yet (the machine is loaded): owed with the quiet-machine gate.
- Tests: seven idle tests (render purity through a Refusal; its timing and one slam; a move cancels it; the lead arm
  follows the foe; a bare `UriKinetics` rests as before; broken apart, no idle; jigs and specks stateless and never on a
  gone part), `kinetics.test.ts` oracle parity (idle off), `uri*.test.ts` (the layout tests run with the idle off),
  render purity, determinism, the render suite.
