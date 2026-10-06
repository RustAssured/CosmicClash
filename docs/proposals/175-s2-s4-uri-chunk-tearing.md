# 175 — S2 → S4: tearing a group of cells out of a body (우리's chunk tearing, Gate 2C)

**Owner of the change:** S4 (`src/matter`). **Author:** S2. **Status:** done by S4 (src/matter/groups.ts: `tearCells`, plus
`hitTear`, `groupAt`, `tearGroup`, `releaseGroups`, `releaseBudgets`, `liveFraction`, `setFieldHeld`). 우리 uses `hitTear` for
blows, `liveFraction` for the necks, `releaseGroups` / `releaseBudgets` for the 50 % rule and the break-apart. Spin is on the
oracle's ×0.6 scale (rad/s = va × 0.6), not ×36 as first written below. URI_SPEC §7; the oracle's `tear` in
uri/src/30_breaking_compose.js.

## What 우리 needs from the world

One call, on `MatterWorldEx` (contract later, like `bodyToChunk`):

```ts
/**
 * Tear the listed cells (map indices) out of a body as ONE tumbling chunk that keeps their colours (the struck chunk of a
 * pre-split part). The cells leave the body (mass moves to the chunk: an exact ledger transfer, like bodyToChunk), the body's
 * stats / bounds / version update, and a few of the live cells around the hole become wound matter: each 4-neighbour of a
 * torn cell, with probability `woundChance`, takes `woundMat[0]` or `woundMat[1]` (the oracle: 0.7, exposed habitat / crack).
 * Returns the chunk id (−1 if no cell was live). Velocity in px/s, spin in rad/s. Deterministic (world RNG).
 */
tearCells(
  bodyId: number,
  cells: Int32Array,
  n: number,
  vx: number,
  vy: number,
  spin: number,
  wound?: { mats: readonly [number, number]; chance: number },
): number;
```

- The behaviour finds the cells from the group ids it already gave the world (`setCellGroups` / `cellGroups`), so the call is
  generic: "these cells, as one piece".
- Internally this is `bodyToChunk` without removing the body: `extractChunk(core, b, cells, n, vx, vy, spin)`, then the
  body's live-cell bookkeeping (`world.ts` already does it for connectivity sheds).
- **Velocities** come from the oracle: `a = atan2(chunk centre − impact) ± 0.3`, speed `(0.5 + 1.4·r)·power` px per oracle
  frame (×60 → px/s), spin `(r − 0.5)·2.4·power` rad per frame at the oracle's ×0.6 (×36 → rad/s). The behaviour computes
  them and passes them in.

## What 우리 does with it (S2, `src/combat/behaviours/uri.ts`)

- **A hit** tears the struck chunk; a heavy one also takes up to `2·power` neighbouring chunks within `7·power` px.
- **Necks** (shoulder, elbow, wrist, pylon root) failing below 0.38 send the hanging chain away whole (`bodyToChunk`, as
  today).
- **The 50 % rule** lets a limb, pylon or moon go chunk by chunk (`tearCells` per group).
- **The break-apart** tears every part into its chunks slowly around the cores.

Until `tearCells` exists the behaviour falls back to whole-part `bodyToChunk` for the 50 % rule and the break-apart. It tears
nothing on a plain hit: the loop still loses integrity and the matter takes the blow the default way.
