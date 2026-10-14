# Netplay Step 0: cross-engine determinism (S18)

Online "challenge a friend" will use input-only lockstep, and possibly rollback later. Both need the same inputs to give
the same sim state on every browser, OS and CPU. This step finds out whether that holds and makes it hold. It adds no
networking code.

**Result:**
- **Before:** the sim was deterministic on one engine only. Edge diverged from Node in 47 of 55 pairings and Firefox in 54
  of 55. Many diverged at tick 1, because the titans' paint already differed.
- **After:** the sim path uses `DMath`, deterministic maths built only from exactly specified operations. Node, Node
  `--jitless`, Edge 155 and Firefox 158 now agree on every tick's full state hash:
  - all 55 pairings, 3,000 ticks each;
  - six long matches of 12,000 ticks, played through KOs, round resets and the match end.

## 1. Audit of the sim path

The sim path is everything a match tick runs: src/sim, src/matter, src/combat (behaviours, kit titans, the Cradle, the
Mouth, 우리's kinetics), src/ai, the painters in src/titans (the painted map is sim state), src/contracts, and
`TITAN_SKY` (src/render/unified.ts), which feeds the painters.

| # | Finding | Where | Risk | Status |
|---|---|---|---|---|
| 1 | Implementation-approximated `Math.sin/cos/tan/atan/atan2/asin/acos/exp/log/pow/hypot/cbrt/tanh`: about 1,210 calls. Some already differ between Node 24 and Edge 155, both V8 (see §2). | matter 113, combat 699 (the Mouth's core/geom 107, planet 99, falsebirth 64, fighter 46, kinetics 33…), titans 367 (lastone art 99, cradle paint 77), ai 24, contracts 5 (rotation LUT `rotation.ts:36-37`, `math.ts` damp), sim 1 (`hazards.ts`) | **High** | Fixed: DMath |
| 2 | The `**` operator is `Math.pow`; SpiderMonkey computes integer powers by repeated multiplication, so `x ** 3` differs in 305 of 2,000 probes. 78 uses. | lastone art 26, cradle 14, fighter 4, xpbd 2… | **High** | Fixed: `sq()` / `DMath.pow` |
| 3 | `TITAN_SKY.dir` normalised with `Math.hypot`; the painters light every titan with it. | src/render/unified.ts:22 | Medium | Fixed: `Math.sqrt` |
| 4 | Mutable global tuning read by the sim: `MOUTH_LIVE` (combat/mouth/tuning.ts:163), `PACE.damageTaken` (combat/fighter.ts:121), `TUNING` (combat/tuning.ts:5), matter `tuning` (matter/thermal.ts:15), 우리's and the Mouth's debug knobs (behaviours/uri.ts:1132, mouth/knobs.ts:34, debug/matchKnobs.ts). The debug overlay or the backquote panel can move them mid-match. | listed | Medium (netplay only) | Open: Step 1 must lock the debug panels and always put `pace` / `roundSeconds` in the config (the replay tool does). |
| 5 | Settings read at match start: footwork, zdepth and ROUND LENGTH go into `MatchConfig` (app/app.ts:453-461). Comfort mode and quality are render-only. | app/app.ts | Low | The config must be exchanged whole. |
| 6 | Wall clock / `Math.random` / `performance.now` on the sim path: **none**. Seeds come from `Date.now` in the UI (ui/ui.ts:306, ui/screens/ladder.ts:119) and `Math.random` in attract mode (app/app.ts:1026-1033). These sit outside the sim; the host picks the seed. | ui | None | — |
| 7 | GPU: the matter hit-tests use the CPU sampler (`rotSampleAt` and the Q14 LUT in contracts/rotation.ts). The GPU only receives the integer LUT pair. The sim never reads anything back from the GPU (no WebGL, canvas or readPixels on the sim path; the luminance read-back is telemetry). The LUT is unchanged under DMath (0 of 256 entries differ). | contracts/rotation.ts, matter/rotation.ts | None | Verified |
| 8 | Sorts: typed-array numeric sorts, or comparators that are consistent. `Array.prototype.sort` is stable since ES2019, so the order is fully specified. | connectivity.ts:494, lifecycle.ts:230/373, planet.ts:155, falsebirth.ts:348, cradle.ts:341, witness.ts:209, moves.ts:89, lastone art 332, cradle paint 384 | Low | OK |
| 9 | Map/Set/object iteration: insertion order (string and object keys) is specified. No `for…in` over numeric-looking keys whose order matters. | — | Low | OK |
| 10 | Float32Array next to doubles: the rounding is IEEE and identical everywhere. | particles, chunks | None | OK |
| 11 | Endianness: `hashBytes` reads Float32/Uint16 arrays as Uint32 words, and 우리's asset is viewed as Uint16 (titans/uri/asset.ts:79). Both assume little-endian, which every browser platform is. DMath checks the byte order itself. | matter/util.ts:111, uri/asset.ts | Low | Noted |
| 12 | NaN payloads in hashed floats: engines may canonicalise NaN bits differently, which would report a desync where there is none. Fighter state is checked finite (determinism.test.ts). | matter/hash.ts | Low | Noted |
| 13 | `toFixed` is used only in AI debug log strings (ai/controller.ts, ai/mouth.ts:258), never in decisions. No locale or `Intl`. | ai | None | OK |
| 14 | Slow motion is fewer ticks per second, never a variable dt (engine/loop.ts). `timeScale` derives from sim state. | engine/loop.ts | None | OK |
| 15 | Hidden state outside the `Match` object graph: WeakMaps keyed by objects (generate.ts:107 `RIGS`, chunks.ts:344, materials.ts:12, lastone art 2365), module caches, and source closures. They don't affect lockstep, but they **break a naive snapshot** (§5). | listed | Rollback only | Open (Step 2) |

## 2. Measurement

**Tools** (tools/netplay/):
- `record.ts`: two level-5 AIs fight; every tick's input frame is logged for both slots, and the tool checks that playing
  the log back with no AI gives the live run's hashes.
- `replay-core.ts`: the engine-neutral replay. It returns the state hash of every tick (`Match.hash`), the checksum, and
  checkpoints every 500 ticks.
- `crossengine.ts`: bundles the sim with esbuild, serves it, replays every recording on each engine, and compares every
  tick with Node. It also probes each engine's own Math on 2,000 inputs.
- `costs.ts`: the costs measured in §5.
- `paintdiff.ts`: compares the titans' paint between two source trees.

**Recordings** (in .scratch/netplay, not committed):
- All 55 pairings of the 10 titans: the 9 on the roster (the Cradle and 우리 included) plus the Mouth, mirrors included.
- 3,000 ticks each; every third pairing is on the Shearfield, which has arena comets.
- Six long matches of 12,000 ticks, played to the match end.

**Engines run on this laptop:**
- Node 24.19 (V8);
- Node `--jitless` (V8 interpreter only);
- Edge 155 (Chromium / V8) through Playwright;
- Firefox 158 (SpiderMonkey). This is the installed Firefox, launched headless with a throwaway profile; no download was
  needed.

Playwright's own Firefox and WebKit builds are **not installed**, and per the brief I didn't download them. Firefox updated
itself from 157 to 158 during the session.

### The engines' own Math (2,000 probes per function, mismatches against Node)

| | sin | cos | tan | atan | atan2 | asin | acos | exp | log | `x**3` | `x**1.3` | hypot | hypot3 | cbrt | tanh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Edge 155 | 47 | 39 | 64 | 57 | 377 | 37 | 61 | 89 | 92 | 0 | 0 | 0 | 0 | 145 | 373 |
| Firefox 158 | 34 | 40 | 62 | 0 | 0 | 0 | 0 | 0 | 0 | 305 | 2 | 706 | 150 | 0 | 0 |
| every DMath function | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Even two V8 builds (Node 24 and Edge 155) disagree in the last bit. For example, `atan2` returns −0.9236960460167971 in
Node and −0.923696046016797 in Edge. Native Math cannot be trusted even Chrome-to-Chrome across versions.

### Replays (per-tick full state hash compared with Node)

| | Before (HEAD 5f266ad) | After (DMath) |
|---|---|---|
| Edge 155 | **47 of 55 diverge**: 19 at tick 1 (the paint differs); the rest between tick 131 and 2,432 | 55 of 55 identical every tick |
| Firefox 158 | **54 of 55 diverge**: 19 at tick 1; the rest between tick 128 and 1,451 | 55 of 55 identical every tick |
| Node `--jitless` | not run | 4 of 4 identical (first 600 ticks; about 90 ms a tick) |
| Long matches (6 × 12,000 ticks, to the match end), Edge and Firefox | not run | 6 of 6 identical every tick |

The checksum (§4) matched as well. Before the fix, only matchups with little or no painting survived (on Edge: mouth v
mouth and several blackhole/supernova pairings).

**Regression test** (`src/sim/crossengine.test.ts`):
- It runs five AI-vs-AI fights twice. The second run uses a perturbed Math: every implementation-approximated function is
  a few ulp off, as another engine's library would be. The modules are reloaded, so module-level tables are covered too.
- The hash and the checksum must be identical every tick.
- Putting a single `Math.hypot` back in orbit.ts makes it fail at tick 186.

## 3. The fix

- **`src/contracts/dmath.ts`:** the deterministic maths.
  - `DMath.sin/cos/tan/atan/atan2/asin/acos/exp/log/pow/hypot/cbrt/tanh` and `sq(x)`, ported from fdlibm with its
    coefficients.
  - It uses only `+ − × ÷`, `Math.sqrt/round/floor/abs` and the bits of a double. Reduction is Cody-Waite with 33-bit
    pieces of π/2; `ldexp` / `frexp` are exact.
  - `pow` follows the ECMAScript special cases. Integer exponents up to 64 use binary powering, so `x²` is exact.
  - Accuracy against V8: sin, cos, atan, exp and log within 1 ulp; atan2 and hypot within 2; tan within 4. The pinned
    output digest is in dmath.test.ts.
- **Routing:** a TypeScript-AST codemod rewrote 1,287 call sites in 85 files in sim, matter, combat, ai, titans and
  contracts (fx and draw code included: harmless, and it keeps the lint rule simple). Separately, `TITAN_SKY` now uses
  `Math.sqrt`.
- **Behaviour preserved:** every titan's painted map (material, density, lit colour) is **byte-identical** to before in
  Node (paintdiff.ts). Tick-time maths moves by at most an ulp or two. Inputs replayed through the new sim diverge from the
  old one only chaotically, the way any 1-ulp change does.
- **Golden values:** no test stored a golden hash. Every determinism test compares run against run, and all of them still
  pass. Cinema determinism passes (same hash twice).
- **Lint:** eslint.config.js bans the Math transcendentals (`no-restricted-properties`) and `**` / `**=`
  (`no-restricted-syntax`) in those six directories. Test files and dmath.ts itself are exempt. The error message points
  to DMath.
- **Docs:** docs/TITAN_GUIDE.md §4 tells kit authors to use DMath.

## 4. The desync detector: `Match.checksum()`

- **API:** `MatchApi.checksum(): number`, built on `MatterWorld.checksum?()` (matter/hash.ts `checksumWorld`).
- **What it covers:** everything `hash()` covers except the per-cell arrays. That is every body's transform, mass economy,
  crack fronts, fuses, wound head, last blow and RNG, plus the motion of every debris chunk, the particle and debris
  totals, the ledger, the world RNG, pending jobs, and each fighter's `stateHash`.
- **Cost on this laptop:** median **31 µs**, worst pairing 130 µs (the colossus, because of its rig `stateHash`). The full
  `hash()` costs a median of **0.7 ms**, worst 2.3 ms.
- **Proposed protocol:** send the 32-bit checksum with every tick's input, and the full hash every 60 ticks. The first
  mismatching tick locates the desync, and the replay tool can then bisect it offline from the input log.

## 5. Costs that decide lockstep against rollback (Node 24, this Ryzen 5 5500U)

**Sim tick** (`Match.step()`, replaying recorded inputs with no AI, 55 pairings × 3,000 ticks):

| | Median | p95 | Worst max |
|---|---|---|---|
| Median of the pairings | 1.07 ms | 3.08 ms | — |
| Worst pairing | 2.59 ms (lastone v blackhole) | 16.2 ms (blackhole v supernova; also supernova mirror 14.3, blackhole v cradle 13.8) | 636 ms (uri v cradle) |

The spikes come from the matter work in big moments: False Birth, break-aparts, full connectivity floods, and GC. In the
browser the sim runs at about 1–1.4× Node's speed: with per-tick hashing, Edge and Firefox replayed at 5.9 and 5.0 ms a
tick against Node's 4.3.

**Snapshot and restore** (a generic deep copy of the whole `Match` graph at mid-fight, 11 pairings):

| | Range |
|---|---|
| Size | 15–55 MB, almost all typed arrays: per-cell matter maps plus scratch, caches and shared assets |
| Take | 36–110 ms |
| Restore | 28–91 ms |

The restored copy replayed identically in only **5 of 11** pairings. The others diverged after 2–85 ticks, from hidden
state outside the graph (row 15: WeakMaps keyed by objects, module caches). **A naive snapshot is too big, too slow and
wrong.**

## Recommendation for Step 1

1. **Input-delay lockstep.** It needs no snapshots, and determinism is now proven across V8 and SpiderMonkey.
   - Delay `D = ceil((RTT/2 + jitter p95 + 4 ms) / 16.7 ms)`, measured during the handshake and clamped to 2–6 ticks.
   - Start at **3 ticks (50 ms)**: fine for the same city or country (RTT ≤ 60 ms). 4–5 for cross-country, 6 for
     intercontinental play.
   - A tick advances only when both inputs are in. Show a "waiting" indicator rather than speeding up.
   - Inputs are 5 bytes a tick: quantise `moveX` / `moveY` to int8 (the AI's analog values are arbitrary doubles), plus
     the held mask as a uint16.
   - Exchange the full `MatchConfig` (seed, stage, titans, footwork, pace, roundSeconds) and a build id at the handshake.
     Lock the debug overlay and the knob panels, and send the checksum every tick.
2. **Rollback is not feasible with the current sim, but it could become feasible.**
   - Re-simulating 6–8 ticks per frame costs 6–25 ms at the median and over 100 ms in spike frames. That doesn't fit a
     16.7 ms frame on this laptop.
   - Rollback would need all three of:
     - an explicit, minimal save/restore per system: only the live arrays, with pristine and scratch arrays shared;
       estimated at 1–3 MB;
     - no hidden state (move the WeakMaps and caches into the world);
     - flattening the sim's spike frames.
   - Revisit after lockstep ships. A hybrid also works: rollback only the fighters' motion while the matter runs in
     lockstep.

## For WJ

- **Safari / JavaScriptCore** is the engine left. It uses Apple's libm, which is the most different. DMath should hold
  there too, because it calls no engine maths, but it should be confirmed once on Apple hardware.
  1. On this PC, run:
     ```text
     npx tsx tools/netplay/crossengine.ts --engines=node,serve --host=0.0.0.0 --limit=10
     ```
     Allow Node through the Windows firewall when it asks.
  2. On a Mac or iPhone on the same Wi-Fi, open `http://<this PC's IP>:8765/?engine=safari` and leave the tab open in the
     foreground for about 5 minutes. The comparison prints in the terminal when the page reports done.
- **Playwright's own Firefox / WebKit builds** (optional, about 250 MB download):
  ```text
  npx playwright install firefox webkit
  npx tsx tools/netplay/crossengine.ts --engines=node,pw-firefox,webkit
  ```
  WebKit on Windows is JavaScriptCore, but with a different maths library from Safari's.
- **Rerun everything after a sim change:**
  ```text
  npx tsx tools/netplay/record.ts
  npx tsx tools/netplay/crossengine.ts
  npx tsx tools/netplay/costs.ts
  ```
