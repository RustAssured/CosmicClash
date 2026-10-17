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
