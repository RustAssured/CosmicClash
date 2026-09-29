# src/combat — the Fighter framework

Pure TypeScript (no DOM / `three` / `Math.random`), deterministic, zero per-tick allocation in the hot paths (≈1 KB/tick of incidental garbage measured for a full fight, see *Performance*).
`createFighter(opts: FighterOptions): Fighter` (`FighterFactory`) is what `src/sim` passes to the Match. A fighter owns its body (`world.createBody`), per-tick transform, movement,
input buffer, the move state machine, hit resolution against the foe's matter, Guard, hit-stun/knockback, meter and resource, live stats from mass, KO, the mutable `FighterView`, and its `RenderLayer`s.

```
tick(ctx) ─ note presses in the 9-tick buffer ─ refreshStats (world.stats → live stats → KO check)
          ─ state machine: free / guard / move(startup→charge→active→recovery) / hitstun / guardbreak / ko / victory
          ─ integrate (steering, glide, altitude spring, soft walls) ─ face foe ─ tether + pixel-mask body separation
          ─ applyTransform (integer pixels, idle bob, lean spring) ─ resolveMoveHits (probe → DamageEvent → foe.receive)
          ─ behaviour.resolveVolumes / update (tendrils, fragments, overlays) ─ threats ─ syncView
```

## Files

| file | role |
|---|---|
| `fighter.ts` | `FighterImpl implements Fighter` — everything above |
| `behaviour.ts`, `behaviours/*` | `Behaviour` base (all hooks default to no-ops) and the per-titan behaviours: `lastone.ts` (tendrils, eye, halo, beams), `asteroid.ts` (pebbles, momentum, rubble pile, swarm, storm), `tendrils.ts` (verlet chains) |
| `move.ts` | `ActiveMove` (preallocated runtime of the move in progress), frame resolution, aim from stick, displacement prediction |
| `shapes.ts` | `FatShape` (one mutable object that can play any `DamageShape`), template → world instantiation with sweeps, containment/intersection tests |
| `inputBuffer.ts`, `stats.ts`, `tuning.ts` | 9-tick buffer; live stats from mass; **every feel knob in one place** |
| `fx/overlay.ts` | tiny software-rasterised world-space layer (dirty-box tracked, closure-free capsules, additive glow) |
| `testing/fakeWorld.ts`, `testing/harness.ts` | `MatterWorld` test double; Match/duel helpers used by tests and tools |

## Public API

* `createFighter(opts)`, `FighterImpl` (extra public fields for behaviours/tests: `px,py,vx,vy,mv,meter,resource,stats,behaviour,rig,liveHitShape(),strike(),addThreat(),guardStrength()`).
* `Behaviour` — hooks: `attach, reset, update, adjustStats, onMoveStart/Release/End, onKo, onDealt, onDamaged, resolveVolumes, probeParts, intercept, guardMultiplier, leanBias, renderLayers, debugShapes, onFreeze, setVictory`.
* `TUNING`, `computeStats`, `topSpeed`.

### Contract details worth knowing (integration notes)

* **`SimEvent` semantics** — `hit.titan` is the **target's** titan (the material that was struck); `hit.type` the attacker's damage type. `zoom.amount` is a fraction (0.008–0.05 ⇒ ×1.008–×1.05). `shockwave.hue` is a 0..1 hint (0.42 celadon, 0.1 warm). `rumble` is emitted for both slots (victim stronger).
  Continuous beams rate-limit their `hit`/`shake` events (every 5 ticks) and never emit `hitstop`. The killing blow emits `ko` + `timescale 0.3 ×45 ticks` + `flash` + `shake` + `shockwave`. Tendril pip changes are announced as `resource {spend|gain}`; cues: `tendril-sever`, `eye-exposed`, `momentum`, `rubble-pile`, `fragment-lost`.
* **`freeze(ticks)`** is called once by the Match; the fighter is not ticked during hit-stop, so the vibration is driven from the render call count (≤ `ticks` frames, victim strong / attacker weak) and cleared on the next `tick`.
* **`FighterView`** is mutated in place; the `threats` array holds *pooled* `ThreatShape` objects that are rewritten every tick — copy what you keep. Upcoming shapes are published **where the attack will be when it goes live** (scheduled lunges included; ramming point hitboxes are published as swept capsules).
* **`receive()` refreshes the defender's view** immediately so a same-tick reader (the attacker, the AI) sees hit-stun/KO without waiting for the defender's own tick.
* **`FighterView.bounds*` come from `world.liveBounds()`** (which scans the whole map), cached in the fighter: refreshed when the map's `version` changes, the body flips, or every 8 ticks, otherwise shifted by the transform delta. Body separation uses the same bounds plus a per-row cell-edge probe.
* **Layers** — the body layer wraps `map.pixels/emissive/version` and follows the render dirty protocol: each `renderLayers()` copies `map.dirty` into the layer's own rect (union with any rect the renderer has not consumed yet) and sets `map.dirty = null`; Last One: `lastone-tendrils-back` (z −1), `-front` (z +1), `lastone-eye` (z 0.5, moving pupil + blink), `lastone-fx` (z 20, 768×560, additive beams/glows/halo: large enough for a full-charge Gaze and the Last Light sweep);
  Asteroid: `asteroid-orbit-back/front` (pebbles, swarm), `asteroid-fx` (800×384, additive ram flare, storm haze and streaks). Overlays are world-space, facing 1, integer-anchored, and accumulate their own dirty rect until the renderer consumes it.
* **Move data conventions** (`MoveDef.extra`, see `src/titans/README.md`): `shell`, `followUp`, `followUpOnly`, `pose`, `chargePower`, `chargeReach`, `ctl`, `swarm`, `cascade`, `spin`, `eyeFlare`, `recoil` (AI only).
  Surge: the first movement key's magnitude is the dash speed and its direction is the stick (8-way, neutral = toward the foe); other moves' keys are facing-relative impulses added to velocity; `damp` = velocity retention per second.
  Hitbox `reachScale` defaults to 1 (lengths authored at REACH 5). Tags: `armor` = hits do not interrupt the move.

## Feel (measured in `feel.test.ts`)

Input → visible response on the **same tick** (state change + `move` event + first movement key) · ~70% of top speed at 0.2 s (τ = 0.166 s) · glide half-life 0.35 s · 9-tick buffer (a press 9 ticks early fires, 11 does not) ·
Guard/Surge cancels in the first 40% of startup, FEINT cancels any windup/charge (10-tick stumble) · hit-stop 4–13 ticks scaled by energy and both masses · hit-stun short for heavy titans, combo-scaled inside a 40-tick grace window, **Surge breaks stun after 9 ticks**
(cooldown 90) · tether never exceeds `MAX_FIGHTER_DX/DY` · cores never pass through each other · soft altitude spring.

## Failure modes

* **Last One — Bared Eye.** 24 verlet tendrils rooted on shell anchors are also the eye's shield: blows that sweep through them are soaked (≤35%), damage tendrils (hp 100; a hit at node *k* cuts the chain there, the tip falls away as a dissolving piece with shards + motes and a `tendril-sever` cue) and only then reach the body.
  `parts`/`resource` = tendrils left **by remaining length**. Exposure = 1 − length fraction; a blow that reaches the eye deals up to +90% × exposure extra to the eye disc as a second `applyDamage`. Guard strength scales `0.3 + 0.7 × length fraction`. Passive: after 150 quiet ticks a tendril regrows a node every 7 ticks.
  Whipping tendrils **elongate** (×4.4 max) toward their hitbox tip so the visual matches the reach; the eye tracks the foe and blinks; the halo ignites on the ultimate; the Gaze/ultimate beams are drawn from the live hitbox lines.
* **Asteroid — Rubble Pile.** Below 35% mass (hysteresis to 42%) `body.cohesionScale = 0.55`, `damageMul ×0.8`, `reachMul ×0.94`, crumbs fall from it, orbiting pebbles scatter — it stays fast (lighter ⇒ faster). **Momentum** (passive): each landed blow +1 stack (max 5): speed +5.5%/stack, tempo +4%/stack, decays after 150 quiet ticks.
  **Swarm**: spends 8 of 12 fragments, releases a steerable flock (the stick steers the flock's target, the body coasts); each fragment is a small KINETIC `strike` (rehit 14 ticks, ricochets); the foe's blows can shatter fragments (no refund); survivors home in when the active window ends and refund the resource.

## Tuning knobs

`tuning.ts` (speeds, accel τ, glide, altitude spring, control multipliers, stun, guard drain, meter rates, hit-stop scale). Per-move numbers live in the JSON. Behaviour constants sit at the top of each behaviour file (`TENDRIL_DAMAGE`, `SOAK_MAX`, `EXPOSURE_GAIN`, `REGROW_QUIET`, `RUBBLE_ENTER`, `MOMENTUM_MAX`…).

## Testing

`npx vitest run src/combat` — `feel.test.ts` (measured feel targets, buffer, cancels, hit-stop/stun/escape, tether, walls, separation, intangibility), `hits.test.ts` (pixel-accurate probe vs live cells, aim, per-type Guard, guard break,
meter/ultimate, KO thresholds, live stats, scars between rounds, tendrils/eye/regrowth, momentum, rubble, swarm, threats), `determinism.test.ts` (identical scripted fights ⇒ identical hashes on the **real** matter world, incl. mirror matches).
Tools: `npx tsx tools/titans/frame.ts out.png --script0="1:right*62,66:strike" --t=92` (composited frame), `npx tsx tools/titans/bench.ts` (ms/step with the real world), dev sandbox `npx vite --port 5203` → `/dev/titans/`.

## Performance (real matter world, scripted busy fight, node/V8)

See `tools/titans/bench.ts`; numbers are recorded in `docs/BALANCE.md`-adjacent notes in the final report. Idle overlays redraw the tendrils every other tick; per-tick garbage is ≈1 KB (events and one-off closures), well below one scavenge per minute.
