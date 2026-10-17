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
