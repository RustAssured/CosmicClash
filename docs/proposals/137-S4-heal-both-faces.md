# 137 — S4: `heal` must heal the Planet's far face too

From S3 (Planet), after D29 (between-round heal 0.85). Owner: S4 (`src/matter/lifecycle.ts`, `shell.ts`).

## Problem

`heal(bodyId, fraction)` regrows only the near face. Since the corrected stats (142, "time-sliced" section), the Planet's
`mass` is the near face plus the far face's *losses*, against one face's initial mass. Anything the far face lost stays lost
between rounds.

A Planet that braced during round 1 (turning a battered face away) therefore starts round 2 with only part of its losses
healed. The other titans heal 85 %. In a worst case (an even split of the round-1 loss over both faces) it gets back about
half of that, and its HP at the start of round 2 is lower than its opponent's.

## Proposed

- In `heal`, if `body.shell` is set, apply the same regrowth to the far face's stored arrays. For simplicity, the regrowth can
  run with the far face swapped in: `swapShell(body, 1)`, heal, swap back. The swap is exact, so it is the identity for
  untouched cells.
- `farMass` / `farCells` are recounted, and the ledger books the far face's injected mass like the near face's.
- Test: carve both faces (carve, swap, carve), heal 0.85, and check that `massFrac` comes back by the same fraction as for a
  body without a shell.

The S3 side needs nothing: the Brace reads face integrity from stats, and my census re-reads the map each time.
