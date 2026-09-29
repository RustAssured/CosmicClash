# 300 — Builder 3: two small fixes for shared code, and semantics worth writing down

Nothing here blocks anything: B3 carries local workarounds for both fixes (marked below). The Lead applies proposals between rounds.

## 1. `mix()` truncates alpha to 254 (src/contracts/color.ts)

`mix(c0, c1, t)` calls `rgba(pr(c0) * u + pr(c1) * t, …)` with fractional channels, and `rgba` masks with `& 255`, which truncates.
`255 * u + 255 * t` is `254.99999999999997` for some `t`, so two OPAQUE colours mix to alpha 254. A pixel with alpha 254 is not
`pa(c) === 255`, so any consumer that tests "opaque" (the matter world's live-cell colour, the software blitters, tests) sees it as
translucent. B3 hit this in the titan art (a whole ramp came out at 254) and now uses its own `blend()` (`src/titans/art/color.ts`),
which rounds. Proposed fix, one line and it keeps every existing call site correct:

```diff
 export function mix(c0: number, c1: number, t: number): number {
   const u = 1 - t;
   return rgba(
-    pr(c0) * u + pr(c1) * t,
-    pg(c0) * u + pg(c1) * t,
-    pb(c0) * u + pb(c1) * t,
-    pa(c0) * u + pa(c1) * t,
+    Math.round(pr(c0) * u + pr(c1) * t),
+    Math.round(pg(c0) * u + pg(c1) * t),
+    Math.round(pb(c0) * u + pb(c1) * t),
+    Math.round(pa(c0) * u + pa(c1) * t),
   );
 }
```

## 2. `createScriptSource`: a stick event at script tick 0 is never applied (src/sim/sources.ts)

Direction events are applied only when `t === e.tick` (`t = tick - offset`), so an event at exactly the first polled tick is lost if
the caller's `offset` is off by one. `Match.step()` increments `tick` BEFORE polling, so after a fast-forwarded intro (the harness
convention "script tick 0 = the tick the fight goes live") the first live poll is `offset + 1` when `offset = match.tick` at
phase `fight`. `?script0=0:right*60` therefore does nothing at all, while `1:right*60` works; button events are unaffected because they
use a range test. B3's tools/sandbox pass `match.tick + 1` as the offset. Suggested: make the stick test a range so the first poll
after the offset always sees it (and callers cannot get it wrong):

```diff
   let prevHeld = 0;
   let stickUntil = -1;
+  let lastT = -Infinity; // script time of the previous poll
   ...
-        } else if (e.moveTicks > 0 && t === e.tick) {
+        } else if (e.moveTicks > 0 && t >= e.tick && lastT < e.tick) {
   ...
+      lastT = t;
       prevHeld = held;
```
(An event is applied on the first poll at or after its tick, exactly once.) Alternatively just document `offset = match.tick + 1` next to
"script tick 0 = the tick the fight goes live" and have the app's harness do the same. Either way `0:right*60` should move the fighter.

## 3. Semantics B3 relies on (please keep or document in contracts)

* `SimEvent 'hit'`: `titan` is the **target's** titan id; `attacker`/`target` are slots. `heavy` is set for blows above ~600 energy.
* `SimEvent 'timescale'`: `scale` is a fraction of real speed (0.05..1) for `ticks` sim ticks; `zoom.amount` is a fraction (0.1 = 10 %).
* `SimEvent 'hitstop'`: the match calls `fighter.freeze(ticks)` on BOTH fighters exactly once per event; fighters do not advance their move
  clocks while frozen, but keep buffering input. The match's own hit-stop counter is what stops `world.tick()`.
* `RenderLayer.dirty` (render.ts doc, already updated): producers copy `map.dirty` into their own rect and clear it each
  `renderLayers()`; B3's body layer and overlays do this and accumulate until the renderer nulls the rect.
* `world.setArena(a)` should be called once per match (Lead does; the test double implements it as a no-op).

## 4. Observations for B2 (matter) from B3's real-world fights, at the time of writing

Measured with an idle victim and one scripted blow (tools in `docs/BALANCE.md`):

* The attacker of a heavy blow loses matter too: a Shoulder (260 KINETIC) took 2.1 % of an idle Asteroid's mass and 1.3 % of the attacker's
  in the following 50 ticks; the Meteor ram took 17.2 % of the attacker and 17.7 % of an idle Asteroid at a 130 px gap. B3 did not
  isolate the cause (debris chunks returning, body-to-body contact and embedded shrapnel all exist). If the chunk-impact path is
  responsible, a short grace for a body against chunks that came from its own blow would remove the "aggression is self-defeating"
  effect; if it is intended, fine, B3 now models it (`extra.recoil` in the move JSON) and the AI accounts for it.
* `FRACTURE` versus the Asteroid's iron interior: the Last One's Shatter Blow (1100 energy) removes 0 cells on impact and only
  seeds cracks; the damage arrives later as chunks leaving. Acceptable, but it makes "cells removed by the hit" a poor proxy.
* Matter loss between hits (cracks spreading, connectivity detaching chunks) is a large share of every fight's damage; that
  is probably what flattens the difficulty ladder in AI-versus-AI matches (docs/BALANCE.md; a hypothesis from fight logs, not proven). No change requested, just flagging that per-hit
  skill has less influence than the design probably wants; a shorter tail or a cap on delayed damage per blow would restore it.
