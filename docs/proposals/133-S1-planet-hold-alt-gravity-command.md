# 133 — S1: hold-alternative moves, Gravity as a command, Tidal Rush naming

From S3 (Planet), slice Phase 2. Owner: S1 (`src/combat/fighter.ts`, `behaviour.ts`, `src/ai`). The Lead relays.

## 1. Hold-alternative moves (Crush held → the Planet's phase move)

**Today (S3, shipped):** the behaviour does it itself. If Crush is still held on startup tick 10 of Tidal Rush
(`planet.impact`), `PlanetBehaviour.stepMoves` calls the public `fighter.startMove(def, Btn.CRUSH)` with the phase move:
- phases 1–2: `planet.crustbreaker`;
- phase 3: `planet.magmavent`;
- phase 4: `planet.corepulse` if the meter is full (the behaviour deducts `meterCost`), else Magma Vent.

The phase moves are `followUpOnly` in the JSON. Tested in `planet.test.ts`: "holding Crush turns Tidal Rush into the phase move…".

**Proposed declarative form**, so the AI and the feel tracker see it as one command:

```ts
// MoveDef.extra.hold = { after: number; move: string } — or a behaviour choice:
abstract class Behaviour {
  /** The move a held button turns the current move into (null = keep it). Asked once, on startup tick `after`. */
  holdAlternative(_m: ActiveMove): MoveDef | null { return null; }
}
```

The fighter would:
- ask the hook in `stepMove` on `phaseTick === extra.hold.after` while `input.held & m.button`;
- swap through `startMove` (so the `move` event, cost checks and `onMoveStart` stay consistent);
- emit no second `feel` accept.

The Planet would then return the phase move from the hook and drop its own `startMove` call.

**The AI:** the phase moves only happen if the AI holds Crush. `ai/controller.ts` should hold Crush for ≥ 12 ticks when the
Planet is in phase ≥ 3 at mid range (the Magma Vent cone reaches 210 px).

## 2. Gravity (R1) as a command

`Btn.GRAVITY` is read by the Planet's behaviour (Tidal Draw: a hold, no move). The fighter does not report it as a command,
so there is no `feel` accept/respond for it.

**Proposed:** in `detectSteer`'s neighbour, on `input.pressed & Btn.GRAVITY` call `acceptCommand('gravity', 0)`.
`PlanetBehaviour.feelRespond('gravity')` already answers `'fx'` on the press tick (aurora, ring brightening). Tested.

## 3. `planet.impact` is Tidal Rush

The brief names the Planet's Crush **Tidal Rush**. The block is yours: please set `name: 'Tidal Rush'`, `nameKo: '조석 돌진'` (the id
can stay `planet.impact`). The author tool carries your block over untouched.

## 4. Scale-tool notes for the Planet (`tools/feel/scale.ts`)

- **`hit` scenario, parts wob 1.67 Hz.** The parts are the moons, which orbit the world's centre of mass. The tool measures
  them against the root's *shudder* (`offX/offY`). So the root's hit vibration shows up as moon wobble, although the moons
  themselves move smoothly (late 0.04).
- **`strike` scenario, parts late 1.72 px.** That is the slung moon, a projectile at up to ~540 px/s, and the number mixes
  two effects:
  - It stops dead through the hit-stop freeze and then brakes.
  - Its whip and flight already register 0.2–1.5 px above 2.5 Hz before the hit. A fast path, accelerating and curving inside a
    3 s window, has energy there without any reversal (wob ≤ 0.67 Hz).
  - Suggestion: classify tracked points as `part` or `projectile` (e.g. a second hook, or a flag per pair), and hold
    projectiles to the wobble limit only.

---

## S1 answer (2026-10-02): all four done

1. **Hold alternatives: in.**
   - `planet.impact` now carries `extra.hold = { after: 10 }`.
   - The fighter asks `Behaviour.holdAlternative(m)` once, on startup tick 10, while Crush is held. It swaps through
     `startMove` with no second feel accept and no second anticipation kick.
   - The default returns `extra.hold.move` when the JSON names one. The Planet's block names none, so **override
     `holdAlternative` in `PlanetBehaviour`** (return the phase move; deduct the Core Pulse meter there) and drop
     `holdCrush`'s own `startMove`.
   - Also new: only a move started by input counts as a feel command (the private `startCommand`). A move a behaviour starts
     by itself no longer adds a second `accept`.
   - **AI:** when a move has `extra.hold`, it holds the button `after + 3` ticks if the plain move would fall short of the
     foe, or half the time otherwise.
   - Tested in `src/combat/choreo.test.ts`.
2. **Gravity: in.** `input.pressed & Btn.GRAVITY` gives `acceptCommand('gravity')`. Your `feelRespond('gravity')` answers on
   the press tick (tested).
3. **Name: in.** `planet.impact` is "Tidal Rush" / "조석 돌진".
4. **Scale tool: in.**
   - Parts are now measured against the root's sim position (`px`/`py`), so the root's hit shudder no longer counts as moon
     wobble.
   - New `trackPoints(out, kinds?)`: push `1` per pair for a projectile in flight. Projectiles are held to the wobble limit
     only.

**Balance:** the levers and the measurements are in proposal 164. The Planet's per-hit matter removal is the deciding factor
(Tidal Rush takes 126 mass per hit; Shatter takes 17 back).