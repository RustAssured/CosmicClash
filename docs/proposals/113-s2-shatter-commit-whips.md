# 113 — S1 → S2: what the new Shatter Blow choreography needs from the tendrils (`steerWhips`)

**Owner of the change:** S2 (`src/combat/behaviours/lastone.ts`, `tendrils.ts`). **Requested by:** S1, who owns the
`lastone.shatter` move block.

## The new choreography (`lastone.json` → `lastone.shatter`)

Frame data: startup 30, active 8, recovery 44 (82 ticks, 1.37 s). The windup is feintable during ticks 1–12.

| Choreography tick (`f.effTick()`) | Root motion (along the attack axis) | Pose / torsion |
|---|---|---|
| 0 (press) | Load: −110 px/s back, slight sink, damp 0.03. About 20–27 px back by tick 22 (the soft tether eats some of it at long range). | Lean snaps toward −6 on the press tick; `spinKeys` −0.6 rad/s (the whole body twists back). |
| 22 (8 ticks before the blow) | Commit: +640 px/s forward, slight rise, damp 0.05. About 70 px covered before the first active tick; more if it whiffs. | Lean already pitching forward (+8 × 0.55); `spinKeys` +1.3 rad/s. |
| 30–37 (active) | Still travelling. On contact the lunge's momentum is EXCHANGED with the foe (`resolvePair`): the foe is shoved, not the attacker stopped dead. | Lean +8 plus torsion: about 18 px at the top (the clamp). |
| 42 | Re-balance: −170 px/s back-step, damp 0.08. | `spinKeys` −0.8 rad/s; lean swings back past upright (−2…−4 px), then settles. |

Up/down aims commit diagonally (iy −160 / +130). In orbit footwork the whole thing turns with the attack axis:
`f.aimUx/aimUy`, and `f.liveHitShape(k, at)` already returns the rotated cone.

## What the tendrils should do

1. **Load (ticks 0–21).** Draw the whips back with the body: trailing the −x root motion and the backward twist. Not four
   fixed horizontal rows behind the body (the old rake). Their roots move with `f.body.transform`, which leans up to
   about 18 px now. Use `f.ang.angle` for the twist.
2. **Commit (22–29).** The body moves about 9 px/tick before contact, so the whips should lag, then overtake. The tips
   arrive at the cone ON the first active tick (tick 30), fanned across the cone (your current fan is right), bowed by
   the lunge's velocity (`f.vx/vy`).
3. **Contact.** Hit-stop is now at most 8 ticks (it was 13), so do not depend on a long freeze to show the fan.
4. **Recovery (42+).** The whips follow the back-step and the counter-twist (they trail forward as the body steps back),
   then relax.

Your `tendrils.test.ts` "Shatter: the whips fan…" measured spread 0.593 against 0.6 during my integration run (before I
changed the JSON). Please re-check it against the new timings. The fan should now be measured relative to
`f.aimUx/aimUy`, not +x, if you want it to hold in orbit mode.

**Currently failing with the new choreography:** "Shatter: whips are bowed arcs while active … recovery folds back without
knots". `crossingsRecovery` was 150 at first and is 3 on the last run (expected 0); the active-phase straightness
assertion passes. The knots come in the
recovery. The body steps BACK (−170 px/s at tick 42) and twists back (−0.8 rad/s) while the whips are still extended
forward, so the chains fold through themselves. The fix belongs in the whip release (item 4 above): let go of the scripted
targets before tick 42, or retarget the tips to trail the back-step, so the chains swing back as one arc. I would rather
not remove the re-balance: the brief asks for a recovery that visibly re-balances. If you need a different timing for
it, tell me the tick and I will move the key.
