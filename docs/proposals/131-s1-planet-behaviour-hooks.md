# 131 — S1: Planet behaviour hooks (feel respond, angular ownership, presence test)

From S3 (Planet), slice Phase 1. Owner of the requested changes: S1 (`src/combat/fighter.ts`, `behaviour.ts`,
`presence.test.ts`). Nothing here blocks S3: the Planet works against the current fighter; these make the seams explicit.

## 1. Feel `respond` through light/fx (Behaviour hook)

**Problem.** The Planet answers every command on its input tick without anatomy (aurora flare, debris ring drawn in, the
acting moon swinging ahead, cloud deck redraw; `PlanetBehaviour.telegraph`). The fighter's feel tracker only sees root x/y
and lean (`fillDrawn`), so for a body with `feel.shear = 0` `ensureAcceptPixel` nudges the root 1 px instead, and the
telegraph is never credited.

**Proposed API** (`src/combat/behaviour.ts`):

```ts
/**
 * The channel through which this behaviour answers `cmd` (a move slot, 'guard', 'feint', 'steer') on THIS tick, or null.
 * Valid from the moment the command is accepted (a move's telegraph is armed in onMoveStart; a raised Guard is visible as
 * fighter.guardUp). The fighter treats a non-null answer as the accept-tick pixel.
 */
feelRespond(_cmd: string): 'light' | 'fx' | null {
  return null;
}
```

**Fighter** (`fighter.ts`): in `ensureAcceptPixel`, before nudging lean/root:
`const ch = this.behaviour.feelRespond(this.feelTrack.command); if (ch) { this.feelTrack.respondVia(ch, this.tickNo, this.slot, this.events); return; }`
(i.e. emit `{ t: 'feel', kind: 'respond', cmd, ticks: 0, channel: ch }` on the accept tick and skip the 1-px root nudge).

`PlanetBehaviour.feelRespond` already exists with this signature (public, not `override` yet: when the base method lands,
add `override` in `src/combat/behaviours/planet.ts`; S3 will do it on request). Tested in `planet.test.ts`
("answers every command on its input tick with light and fx…"): `feelRespond(cmd) === 'fx'` and ≥ 20 more lit fx pixels
than a no-press control on the press tick, for strike, crush, surge, signature and guard.

## 2. Angular ownership for a free spinner (the Planet)

**What S3 does now.** `planet.json feel.angular = { omega: 0, dragTau: 1000, maxSpin: 6 }` (free, no drag of its own). In
`behaviour.update` (after `stepAngular`, before `syncView`) the Planet:
1. reads `fighter.ang.spin − lastPublished` = the impulse the fighter added since (impact model `applyImpact`, move
   `spinKeys`) and folds it in whole;
2. runs its own spin model (day rate 0.14 rad/s prograde, commanded spin for its moves, under-damped return K = 9, ζ = 0.72,
   the Brace half-turn of π) and writes `fighter.ang.angle/spin` (and `view.angle/spin`).

So `syncView` publishes the Planet's state and the hash covers it.

**Requests.**
- Keep `FighterImpl.ang` public (it is read/written through a structural cast, so a rename silently disables the folding).
- Keep `stepAngular` before `behaviour.update`, and do not reapply the transform after it: the Planet also sets
  `body.transform.facing` (Rotational Brace: the far face toward the foe) and `transform.lean = 0` there.
- Alternative if you prefer an explicit seam: `Behaviour.ownsAngular(): boolean` + `onAngularImpulse(dw)`. Then the fighter
  skips `ang.step` and forwards impulses, and S3 drops the difference trick.

**Impact `spinKeys` (your block):** with `facing = +1`, `-1.2 @0` is prograde for the Planet (a wind-up: good), `+3.4 @26`
whips it retrograde and `-0.9 @46` brakes. The behaviour honours the keys (no commanded spin of its own for a move with keys)
and the day spring brings the world back with a 0.11 rad/s overshoot past its day rate. If you want the commit to read as
the world *spinning up* rather than reversing, author the commit key in the load's sense. Either reads as torque, not rolling.

## 3. `presence.test.ts` encodes a lean kick on the Planet

`'heavier defenders barely move but recoil (a lean kick)…'` uses the Planet as the heavy defender and expects
`transform.lean > 2`. The brief forbids it: a world does not shear (`feel.shear 0`, `recoil 0`, and the behaviour holds
`lean = 0`). Proposed: assert the Planet's recoil as spin instead, e.g. `expect(Math.abs(B.view.spin - spinBefore)).toBeGreaterThan(0.2)`,
or use another heavy, non-world titan for the lean assertion.

Note: that test (and the Crush shove test) also fails on its *travel* bound with the current fighter regardless of the
Planet data. Measured with the old Planet data (resist 4, no feel block): travel 213 px. With the new data: 194 px.
Bound: 175 px.
