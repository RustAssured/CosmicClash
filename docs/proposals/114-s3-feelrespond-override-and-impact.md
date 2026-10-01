# 114 — S1 → S3: `override` on `PlanetBehaviour.feelRespond`, and the Impact choreography

**Owner of the change:** S3 (`src/combat/behaviours/planet.ts`). **Requested by:** S1 (answering proposal 131).

## 1. One word, needed for `tsc`

`Behaviour.feelRespond(cmd): 'light' | 'fx' | null` now exists in `src/combat/behaviour.ts`, as proposed in 131. On the
accept tick, if nothing the command did moved the root or the lean, the fighter asks the behaviour. A non-null answer is
reported as `respond` through that channel (`FeelTracker.respondVia`), and no 1-px root nudge is added.

`tsc` (`noImplicitOverride`) now errors at `src/combat/behaviours/planet.ts:586`:

```diff
- feelRespond(cmd: string): 'fx' | null {
+ override feelRespond(cmd: string): 'fx' | null {
```

## 2. Angular ownership

`FighterImpl.ang` stays public (`readonly ang = new Angular()`; `angle`, `spin` and `impulse(dw, params)`). Order in
`tick()`: integrate → `stepAngular()` (spin keys, then the spring/drag step) → depth → `applyTransform()` → accept-pixel
check → … → `behaviour.update()` → `syncView()`. After `behaviour.update` the fighter does NOT reapply the transform.
`resolvePair`, which runs after both fighters ticked, only re-places `t.x/t.y` and leaves `facing`/`lean` alone. The
difference trick works as you describe; no extra seam is needed.

## 3. Impact `spinKeys` (S1's block)

Per your note, the commit now spins the world UP in the load's sense (a flywheel), then brakes:
`[{ at: 0, w: −1 }, { at: 26, w: −3 }, { at: 46, w: +1.2 }]` (facing-relative; the fighter applies `w × facing`).

Frame data: startup 34 (0.57 s), active 8, recovery 56 (1.63 s total). The pose leans are all 0. Root motion:
- load −70 px/s;
- commit +560 px/s at tick 26, so 8 ticks before the blow;
- re-balance −150 px/s at tick 46.

The hitbox now sweeps from ox 96 to 124 (r 44 → 48). It connects from a 230 px gap on the real world (test:
`src/combat/choreo.test.ts`).
