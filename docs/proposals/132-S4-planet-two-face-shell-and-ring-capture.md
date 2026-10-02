# 132 — S4: the Planet's two-face shell, and ring capture for Tidal Draw

From S3 (Planet), slice Phase 2 (SLICE_PHASE2 S4 tasks 2 and 5). Owner: S4 (`src/matter`); contract additions: Lead.

## 1. Two-face shell (D27: "Planet rotation: a two-hemisphere world")

**Today (S3, shipped):** Rotational Brace turns the *mirror*. The behaviour flips `body.transform.facing` against the fighter's
facing at the midpoint of a 36-tick half-turn, under a cloud cover. Hits and drawing follow the flip. The far face is the
same matter seen from its other side, and the baked light flips with it.

**Wanted:** the shell (surface → mantle) exists twice. The face toward the foe is the live body; the far face is stored
matter. A half-turn swaps them exactly. The deep interior (magma, core: radius < `magmaR` = 27 cells) is shared.

**Proposed API** (matter, additive):

```ts
interface MatterWorld {
  /**
   * Create a dormant twin of `bodyId`: same size and materials, filled from the body's pristine snapshot, not ticked, not
   * hit-tested, not rendered, but counted in the ledger (its mass is the far face's mass).
   */
  createShellStore(bodyId: number): number;
  /**
   * Swap every per-cell array (material, density, integrity, temperature, bonds, flags, infection, height, baseColor) between
   * `bodyId` and `storeId` for the cells where `mask[i] = 1`, mirrored in x (the far face seen after a half-turn). Bonds across
   * the mask edge are rebuilt from the snapshot × a scar factor. Runs a full rebuild (visual, stats, connectivity with
   * `connFull`), keeps the ledger exact and is deterministic and hashed.
   */
  swapShell(bodyId: number, storeId: number, mask: Uint8Array): void;
}
```

**S3 side once it lands:**
- The behaviour builds the mask (`r > magmaR + 2`) and calls `swapShell` where the half-turn's ease crosses 0.5, instead of
  flipping the facing.
- KO and massFrac must count both faces. That is a Behaviour stats hook, which I will propose to S1 when the API exists.
- The globe overlay projects both faces during the turn.

**Cost estimate:** swapping 208×208 cells × ~20 B is under 1 ms per turn.

## 2. Ring capture for Tidal Draw (SLICE_PHASE2 S4 task 2)

**Today (S3, shipped):** Tidal Draw (R1) deepens the Planet's `GravitySource`:
- strength `PHASE_GRAVITY[phase] + 150 × draw`, radius `250 + 90 × draw`;
- `consumeRadius ≈ 0.95 × (R + atmo)` while the draw is above 0.3, crediting the Planet's own body;
- what is drawn in becomes pool mass, which the behaviour regrows as crust on the face toward the foe (`world.grow('crust')`,
  up to 6 % of the body per round). That is the *armour* half.

The *ammunition* half needs your API:
- `chunksInShape(shape, out)`;
- `captureChunk(id, owner)`, which pins the chunk: never degraded, steered by an owner orbit (centre, radius, angular speed,
  flattening) that matter integrates deterministically;
- `launchChunk(id, vx, vy, credit)`, with uncapped KINETIC credit to the owner's slot.

Severed Witness matter must be capturable (`origin` = the enemy body).

**S3 side once it lands:**
- While R1 is held, the behaviour captures chunks entering the well into the debris ring (`ring` = 1.3–2 R, flattened 0.26
  like the moons' plane).
- Moon Slam with no moon in orbit throws the largest ring chunk (the brief's "a broken moon still throws its fragments" also
  becomes ring ammo).
- Ring chunks soak blows like moons do (armour).
