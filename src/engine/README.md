# src/engine — fixed-tick loop and the heavy camera

Owner: B1 (Engine & Render). Browser APIs allowed here (`performance.now`, `requestAnimationFrame`, `document.visibilitychange`), but
both modules are written so they run in Node: the clock, rAF and visibility source are injectable, the camera is a pure function of
`tick()` calls.

```ts
import { createLoop, createCamera } from '@/engine';
```

## `createLoop(opts): Loop` — `src/engine/loop.ts`

A rAF-driven accumulator that turns real time into **fixed 60 Hz simulation ticks** (D10: the sim never sees a variable dt).

```ts
const loop = createLoop({
  tick: () => match.step(),                       // exactly one fixed tick
  frame: (alpha, dtSec) => draw(alpha, dtSec),    // alpha ∈ [0,1): fraction of a tick since the last tick
  // optional: tickHz = 60, maxCatchUp = 5, now, requestFrame, cancelFrame, onVisibility (injected in tests)
});
loop.start();
loop.timeScale = 0.3;      // KO slow-mo = fewer ticks per second, clamped to [0.05, 1]; never a variable dt
loop.pause(); loop.resume();
loop.stepTicks(120);       // deterministic harness: run exactly n ticks, then render once at alpha 0 (pass `false` to skip the render)
loop.stats;                // { msPerTick, msPerFrame, ticksPerFrame, droppedFrames } rolling averages
```

Guarantees (all unit-tested in `loop.test.ts`):

- at most `maxCatchUp` (5) ticks per frame; any further backlog is **dropped** (`stats.droppedFrames`) — no spiral of death;
- a frame longer than 250 ms (debugger, GC, slow device) is treated as a stall and clamped;
- a hidden tab pauses the clock and resumes without a burst of ticks;
- `pause()` freezes ticking but keeps calling `frame(0, dt)` so the harness can still screenshot;
- `stepTicks` never touches the real clock.

## `createCamera(tuning?): CameraApi` — `src/engine/camera.ts`

Feels like a huge crane, not a webcam. Pure and deterministic; advanced only by `tick()`.

```ts
const cam = createCamera();
cam.reset(x, y);                        // snap (round start)
cam.tick({ a, b, arena, focus? }, events);   // once per SIM tick; `events` = the tick's SimEvent[] (shake / zoom / roll / hit / ko)
const { state, view } = cam.sample(alpha);   // per rendered frame; the SAME objects are returned every call (copy what you keep)
```

- **Framing.** Weighted midpoint of the two fighters (weight leans toward whoever is moving, smoothed), a lookahead along their mean
  velocity, then a hard constraint that both fighters' bounds stay in frame (margins 36/28 px when they fit; when they cannot fit the
  union is centred so both clip equally). No zoom-out (D5). Clamped inside the arena.
- **Motion.** Critically damped springs with half-lives 0.42 s (x) and 0.72 s (y): the camera *arrives late* and the universe moves with it.
- **Impulses.** `shake` → 5–9 Hz damped oscillation biased along the blow, ~0.4 s tail; `zoom` → micro-zoom pulse (peak ≤ 1.06, eased back in
  ~0.25 s); `roll` → |roll| ≤ 1.5° (the fighters emit roll from the SPIN a blow put into the target, so a centre hit does not roll the view).
  `hit` events with high energy / `heavy` add shake (and zoom for heavy blows) **only when the batch carried none of its own** (defensive),
  and `ko` kicks shake, zoom and roll. `focus` (ultimate choreography) pulls the framing toward a point with a zoom bias, still capped at 1.06.
- **Scenery push-in (D27, sprites stay 1:1).** `state.dolly` 0..1: a heavy windup (`move` of a Crush/Ultimate) pushes in slowly toward 0.55
  (0.9 for an ultimate, τ 0.4 s); `release` / a heavy `hit` holds it 8 ticks (a heavy hit also punches +0.15), then it pulls back late
  (half-life 0.55 s); a feint/guard/surge accept or the windup being struck releases it. `state.kickX/Y`: the impact parallax kick, an
  underdamped spring (ω 11 rad/s, ζ 0.55) shoved along a heavy blow (6 px per 1000 energy, ≤ 10 px at depth 1). The renderer moves scenery
  layers by `kick × (parallax − 1)` and dollies the 3-D scenery by `dolly`.
- **The wound is the star.** For ~1.2 s after a heavy hit the framing leans 30 % (fading) toward where it landed, inside the both-in-frame
  constraint.
- **Integer snapping.** `sample()` snaps the shake and the view rect to integers: `state.shakeX/Y` and `view.x0/y0` are integers (so
  pixels never shimmer), `state.x/y` stay float. `view` is `{x0,y0,w:640,h:360}` clamped inside the arena.
- Tuning knobs: `DEFAULT_CAMERA_TUNING` (`halfLifeX/Y`, `lookaheadSec/Max`, `marginX/Y`, `shakeTau`, `shakeHzMin/Max`, `zoomTau`, `maxZoom`,
  `rollHalfLife`, `maxRoll`, `dolly*`, `kick*`, `wound*`); pass a `Partial<CameraTuning>` to `createCamera`.

## Testing

`npx vitest run src/engine` — tick cadence, catch-up cap, time scale, pause/hidden-tab behaviour, stepTicks, spring convergence
and "arrives late", arena clamping, tethered fighters stay in frame, shake integer snapping / directionality / decay, zoom cap 1.06,
roll cap 1.5°, defensive hit shake, windup push-in / lagged pull-back, impact kick, wound framing, determinism (bit-identical output for
identical inputs), NaN safety, interpolation, reset.
