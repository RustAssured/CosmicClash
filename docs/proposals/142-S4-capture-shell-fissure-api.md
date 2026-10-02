# 142 — S4: contract additions for capture, the two-face shell, fissure light and the chunk cap

From S4 (matter), slice Phase 2, tasks 1, 2, 3 and 5. Answers S3's proposal 132 and the Lead's wound-light note. Owner of the
contract: the Lead. Everything below is implemented on `MatterWorldEx` (`src/matter/world.ts`) and tested; this asks for it to be
promoted to `MatterWorld` in `src/contracts/matter.ts`.

## 1. Make required (implemented)

- `bodyToChunk(bodyId, vx, vy, spin): number`
- `jointHealth(bodyId, cells): number`
- `spawnChunk(spec): number`: it now returns the chunk id (comets).

## 2. Capture: Tidal Draw, comets, ring armour (S3 132 §2)

```ts
setOrbit(slot: 0 | 1, spec: { x: number; y: number; radius: number; omega: number; flatten?: number } | null): void;
chunksInShape(shape: DamageShape, out: Int32Array): number;              // ids; a point shape also counts disc overlap
chunkState(id: number, out: ChunkStateOut): boolean;                    // x y vx vy angle spin mass radius mode owner origin temp
captureChunk(id: number, slot: 0 | 1): boolean;                         // any chunk, severed enemy matter included
releaseChunk(id: number): boolean;
launchChunk(id: number, vx: number, vy: number, creditBodyId: number, slot?: 0 | 1 | -1): boolean;
strikeChunk(id: number, x: number, y: number, energy: number, dirX: number, dirY: number): boolean;
```

**Capture and pinning.**
- A captured chunk rides its owner's ring. Each chunk gets its own lane (radius ±6 px, set from its id) and is steered
  deterministically.
- `flatten` is the ring's vertical scale. 0.26 gives S3's ring in the moons' plane.
- A captured chunk is pinned: the cap never degrades it.
- Clearing the ring lets every captured chunk go, and each keeps its speed.

**Launch.**
- A launched chunk ignores wells and its thrower's bodies (`creditBodyId`, or any body of `slot`).
- It lands one uncapped KINETIC blow: energy ½·m·(v/60)², with `sourceBodyId = creditBodyId`.
- After that, or once it slows below 60 px/s, it is ordinary debris again.

**Strike (ring armour, struck comets).**
- `strikeChunk` knocks a chunk out of its ring.
- If the chunk is big enough it splits into 2–3 free pieces. Mass is conserved.
- S3 intercepts a blow by calling `chunksInShape(blow.shape)`, then `strikeChunk`.

## 3. The two-face shell (S3 132 §1)

```ts
defineShell(bodyId: number, shell: number | Uint8Array): boolean;  // radius (magmaR) or a map-sized mask (r > magmaR + 2)
swapShell(bodyId: number): boolean;                                // commit a half-turn
shellFace(bodyId: number): number;                                 // 0 original face toward the viewer, 1 the other, -1 none
```

Differences from S3's sketch (`createShellStore` / `swapShell(body, store, mask)`):

- **No second body.** The far face is stored inside the body (`shell.ts`). It is hashed, counted in the ledger and counted in
  the body's stats. Nothing has to keep it out of ticking, hit-testing or drawing.
- **The mask is given once,** at definition.
- **Edge bonds are exact.** A bond with either end in the shell is swapped with its face. Bonds are not rebuilt with a scar
  factor, so two swaps are the identity bit for bit. A wound that reached the boundary comes back with its exact bonds.
- **The far face is the pristine body mirrored about the core column.** It is stored in the coordinates it will be drawn at
  after the next turn, so a swap is a plain per-cell exchange.
- **A swap first settles everything in flight.** Held wound slabs shear and leave. Queued slow cuts sever. Crack fronts and
  shrapnel fuses end.
- **Stats: the far face adds tactics, not durability** (the Lead's balance note; this supersedes the first version, which
  counted both faces in full and doubled the Planet's HP).
  - `initialMass` and `initialCells` stay the one-face values.
  - `stats.mass = near + pool + far − far's pristine mass`, and `cells` likewise. Matter lost on either face counts 1:1, a
    swap never changes stats, and KO takes the same total destruction as before the shell existed.
  - `map.mass` is the near face and pool only. The ledger counts both faces exactly.
  - `regionGrid` and `coreIntegrity` describe the near face and the shared core.
- **Painted far face (S3's proposal 135).** `defineShell(bodyId, shell, far?)` takes `far = { material, density, height,
  baseColor }` as map-sized arrays, of which only the shell cells are read. It is the far side as it will be drawn after
  the next turn (S3's `paintPlanet` at `lonShift = π`), so its own sunlight is right. Its bonds are the ones a body of
  those materials is born with (`bodyinit.buildBonds`: grains, faults, layer factor, cohesion). Without `far`, the pristine
  body is mirrored as before.
- **`restore` resets both faces.** `heal` heals only the near face (known gap).

Cost: one swap on a 96×96 test planet (~8k shell cells) takes well under 1 ms. The exchange is linear in shell cells; the
full rebuild afterwards costs the same as `restore`.

## 4. Fissure / wound light (Lead, Phase 2)

```ts
setFissureGlow(bodyId: number, colour: number | null | undefined): void;
```

- **Default** (`undefined`): a body that holds a magma-archetype material shows that material's `glowRamp[0]` in its CRUSH
  fissures. Every other body cracks dark. CRUSH sets `Body.magma` only on a body with fissure light.
- **`null`:** dark fissures.
- **A colour:** that light in every non-gas material's fissures. The Witness uses this for white-gold or cyan.

These now follow the struck material's authored `glowRamp`:
- the impact flash and sparks (`blowfx.ts`), which no longer use a fixed orange ramp;
- the cooling glow of chunks and wound slabs;
- vapour steam (a per-material ramp, replacing the fixed warm `HOT_GAS`);
- ember particles.

Fast streaks now tint toward white-hot from their own colour instead of a fixed orange.

## 5. Chunk cap

Please raise `MAX_DEBRIS_CHUNKS` from 400 to **640**. Matter uses `DEBRIS_CHUNK_CAP = max(MAX_DEBRIS_CHUNKS, 640)` until then.

Bench, pools full, 22k-cell bodies, load-robust:

| Cap | step p99 | renderLayers avg |
|---|---|---|
| 400 | 5.44 ms | 1.65 ms |
| 640 | 3.66 ms | 1.35 ms |

The two runs had different machine load, so the honest reading is "no measurable cost".

## Update (Gate C prep): the swap is time-sliced

- **New signature:** `swapShell(bodyId, ticks = 18): boolean`. It returns false while a swap is still running.
  `shellProgress(bodyId)` reports rows moved / h, 1 when idle and -1 with no shell.
- **When it happens:** the call itself only settles in-flight wounds and cuts (0.04 ms). The exchange runs inside `tick()`
  in row bands, top to bottom. `ticks ≤ 1` keeps the one-shot swap.
- **During a swap:**
  - Every row is wholly one face, so drawing and hit-testing agree on every tick (tested).
  - The body's connectivity is held, so matter is never shed across the band edge.
  - Blows separate at once and hold no slabs.
  - The swap state is hashed.
  - `shellFace` flips when the last band moves.
  - `restore` and `heal` finish a running swap first.
- **Result:** byte-identical to a one-shot swap, so two swaps are still the identity (tested).
- **Cost** on a 216² planet with 44.7k shell cells:

  | tick | cost |
  |---|---|
  | swap call | 0.04 ms |
  | band ticks | ≤ 0.71 ms |
  | final tick (connectivity) | 1.68 ms |
  | before (one-shot, one tick) | 7.9 ms |

- **S3:** call `swapShell(id)` at the start of the turn instead of the midpoint, so the 0.3 s of bands sits under the cloud
  cover. Read `shellProgress` if the globe overlay should follow the bands.
