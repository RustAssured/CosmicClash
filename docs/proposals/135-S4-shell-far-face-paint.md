# 135 — S4: let `defineShell` take the far face (fixes the sunlight pop)

From S3 (Planet). Owner: S4 (`src/matter/shell.ts`, `world.ts`).

## Problem

`defineShell(bodyId, magmaR)` builds the far face from the pristine body mirrored about the core column. That gives the same
continents, which is fine. It also gives a mirrored `baseColor`, and that is not fine: the baked sunlight (day side, terminator,
ocean glint) lands on the wrong side after the first half-turn. The Brace's swap then pops the light from one limb to the
other. The cloud cover hides the moment of the swap, but the wrong lighting stays until the next turn.

## Proposed (additive)

```ts
/** `far`: the far face exactly as it will be drawn after the next half-turn (map-sized arrays); omitted = today's mirror. */
defineShell(
  bodyId: number,
  shell: number | Uint8Array,
  far?: { material: Uint8Array; density: Uint8Array; height: Uint8Array; baseColor: Uint32Array },
): boolean;
```

- For the shell cells, take `material`, `density`, `height` and `baseColor` from `far` instead of the mirrored snapshot.
- Build the far face's bonds with the same rules `bodyinit` uses (materials × layer factor × grain seams × cohesion). No
  mirroring is involved.
- `sMaterial`, `sBaseColor` and the others are the pristine far face, as today.

## S3 side (already shipped)

- `paintPlanet(def, seed, lighting, lonShift)` paints the world turned about its axis. `lonShift = π` is its far side: other
  continents, lit by the same sun.
- The behaviour passes that as the third argument today (`farFaceOf` in `src/combat/behaviours/planet.ts`, memoised per seed and
  light). Until the argument is honoured it is ignored, and the mirror is used.
