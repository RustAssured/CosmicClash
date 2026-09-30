# Adding or changing a titan

Everything titan-specific is data plus three small code files. A titan is playable when it has a JSON definition, a painter, a behaviour,
a voice, and a line in each registry below. This guide is the checklist, in the order you will need it. The six shipped titans
(`lastone`, `asteroid`, `nexus`, `blackhole`, `supernova`, `planet`) are worked examples; copy the closest one.

## 0. Decide the identity first

Write down, in the JSON's `passive`, `failureMode` and `ai.style` text, before any code: the damage type it destroys with
(`destruction`), the one thing on its body that makes it fail when hit (the failure mode: tendrils, chain graph, disk, moons...), the
resource it manages, and the one thing it does that no other titan does. `docs/DESIGN.md` §4 has the table the roster is held to.

## 1. Files to create

| File | What it is |
|---|---|
| `src/titans/<id>.json` | The definition (attributes, resource, materials, art recipe, moves, AI weights, UI text, `feel`). Validated by `validateTitanDef` in `titans.test.ts`. |
| `src/titans/art/<id>.ts` | The painter: `build<Id>Rig(def, seed)` (positions of the parts the behaviour animates) and `paint<Id>(def, seed, lighting)` (the `MatterMap`). Procedural, deterministic in `seed`. Use the toolkit in `src/titans/art/` (`noise`, `sdf`, `field`, `canvas`, `color.blend`). |
| `src/combat/behaviours/<id>.ts` | A `Behaviour` subclass for everything outside the body cells: parts, failure mode, resource, passive, move side effects, overlay layers. Hooks are documented in `src/combat/behaviour.ts` (attach, reset, update, adjustStats, onMoveStart/onRelease/onMoveEnd, onDealt, onDamaged, resolveVolumes, probeParts, intercept, guardMultiplier, renderLayers, debugShapes, leanBias, onKo). |
| `src/audio/voices/<id>.ts` | The titan's voice: a continuous bed plus reactions to the `SimEvent` cues it emits. See "Audio hooks" below. |
| `src/combat/<id>.test.ts` | Titan-specific tests: failure mode triggers, resource rules, scripted-duel determinism on the real world. Copy `nexus.test.ts` or `blackhole.test.ts`. |

## 2. Registry edits (additive; re-read each file before editing, the other builders edit them too)

1. `src/contracts/titan.ts`: add the id to `TITAN_IDS`. **This is a contract file: propose the change in `docs/proposals/NNN-*.md`; the lead applies it.**
2. `src/titans/defs.ts`: import the JSON, add it to `TITAN_DEFS` and to `IMPLEMENTED_TITANS` (a titan that is not listed is absent from the game).
3. `src/titans/generate.ts`: add the painter to `PAINTERS` and the rig type to the `TitanRig` union.
4. `src/titans/rigs.ts`: a `case '<id>'` calling your `build<Id>Rig`.
5. `src/titans/index.ts`: export the rig type and any helper the behaviour or tests import.
6. `src/combat/behaviours/index.ts`: a `case '<id>'` returning your behaviour.
7. `src/audio/voices/index.ts`: register the voice. Cue names the voice reacts to must be listed in `src/audio/voices/cues.ts`.
8. `src/titans/titans.test.ts`: add the id to the design-bible `want` attribute table.

## 3. The JSON, block by block

* `attributes` (1 to 10): `mass`, `cohesion`, `heat`, `gravity`, `reach`, `tempo`. Must match the design bible table (a test asserts it).
  Mass sets knockback resistance, hit-stop and (through `feel` defaults) how heavy the body moves. Tempo sets top speed.
* `resource`: `{ id, name, nameKo, max, start, display }`. The behaviour owns the number (`f.resource`).
* `materials`: each `{ key, base, physics?, visual }`. `base` picks a physics archetype from `src/matter/archetypes.ts`; `physics` overrides
  any field (`density`, `bond`, `toughness`, `resist`, ...); `visual` is the ramp and emissive. The painter refers to materials by `key`;
  material id = index + 1. `resist` is a plain multiplier on damage taken per type (higher = takes more): it is the balance lever for
  matchups (`FRACTURE`, `KINETIC`, `CRUSH`, `THERMAL`, `TIDAL`, `ASSIMILATION`). Immune matter has resist 0.
* `art`: `{ w, h, coreX, coreY, coreRadius, params }`. `params` is free-form for your painter. Body 90 to 180 px across, never touching the map border.
* `moves`: exactly one per slot `strike`, `crush`, `surge`, `signature`, `ultimate`, `guard` (extra follow-up moves allowed). Each has `frame`
  `{ startup, active, recovery, cancelWindow, chargeMax, hitstop }` in ticks (60 per second) and three aim variants `up/forward/down`,
  each with `hitboxes` (`shape`, `damage { type, energy, duration, flags, params }`, `knockback { x, y }`, `guardPressure`, `from/to`, `rehit`)
  and `movement` keys. Feel targets are checked by the validator: Strike total 20 to 45 ticks, Crush startup 21 to 42 and total 72 to 120, etc.
  `extra` is a free-form object read by your behaviour or by the framework (`shell.absorb` on the guard, `followUp`, `pose`, `chargePower`,
  `chargeReach`, `recoil`, `noCredit`, `root`, `cage`, `well`; see `src/titans/README.md`).
* `ai.weights`: `aggression, patience, zoning, retreat, trap, punish, gaze` (0 to 1). These swing balance results more than an AI level does.
* `ui`: accent colours and tagline.
* `feel` (optional, all fields optional; defaults are derived from `mass`): see next section.

## 4. The `feel` block (body weight and scene presence)

The Fighter turns these into motion. Nothing needs setting for a first version.

```jsonc
"feel": {
  "bob":   { "amp": 4.5, "period": 6.5 },   // idle breathing bob, px and seconds (0 = none: the Black Hole)
  "sway":  { "amp": 2.0, "period": 8.0 },   // slower sideways drift, px and seconds
  "accelMul": 1.3,   // stick response lag: heavier = larger (default mass^0.55). Overshoots by design (see zeta)
  "glideMul": 1.2,   // slow drift after the stick is released: multiplies the 0.35 s half-life (default mass^0.35)
  "zeta": 0.6,       // damping of the speed filter: below 1 the body overshoots its target speed a little (default 0.9 - 0.045 x mass)
  "knockMul": 1.0,   // extra multiplier on knock velocity received
  "recoil": 1.0,     // multiplier on the lean/shear kick when hit (a heavy body shows the blow this way instead of moving)
  "shudder": 1.0,    // multiplier on hit vibration (victim) and follow-through (attacker)
  "thud": 1.0,       // multiplier on the low-frequency shake of a heavy Crush/Ultimate release, hit or whiff
  "fx": {            // continuous movement emissions (world particles); omit for none
    "kind": "gas",   // spark | ember | dust | gas | ash | glint | plasma | shard | mote
    "ramp": ["#e8f4ff", "#9cc4e8", "#4c6a90"],  // bright to dark over the particle's life
    "perHundredPx": 3, // particles per 100 px travelled (x sqrt(mass/5)); "idleRate": particles per second while hovering
    "size": 2, "life": [30, 60], "emissive": 0, "spread": 20, "behind": 40, "rise": -6
  }
}
```

What the framework does with them, so you know what to tune (all constants in `src/combat/tuning.ts`, `TUNING`):

* **Knockback** is an eased shove, not a launch. Received knock velocity = hitbox `knockback` (+ 2 % of the matter world's impulse) x `knockScale` (0.62)
  x (attacker mass / defender mass), capped at `knockMax` (580 px/s), and decays exponentially (`knockTau` 0.4 s; light blows die faster). A Crush on an
  equal-mass foe starts at about 7 px/tick and travels about 180 px; a heavier defender moves little and recoils (lean kick, `recoilGain`); a Strike is
  a nudge. The killing blow multiplies the launch by `koKnockMul` and lasts `koKnockTau`. So the JSON `knockback` numbers are RELATIVE strength: a
  Crush around 700, a Strike around 100.
* **Hit presence**: the victim vibrates 1 to 2 px, decaying (`shudder*`), the attacker pushes a few px through the contact and eases back (`follow*`), and
  shake, zoom and shockwave scale with combined mass. Visual offsets never move the body's position, only the drawn transform.
* **Movement FX** are emitted at most every third tick and at most 3 particles at a time.
* `transform.lean` is the whole-pixel row shear: velocity-driven, pose-driven per move (`extra.pose`), plus `Behaviour.leanBias()`. Keep leans below about 10 px.

## 5. Audio hooks

`src/audio/voices/<id>.ts` exports `create<Id>Voice(): TitanVoice`. It receives the per-frame voice context (positions, speed, mass fraction, resource) and
the `SimEvent`s: generic ones (`move`, `release`, `hit`, `guard`, `ko`, ...) and the cues your behaviour pushes with
`f.events.push({ t: 'cue', slot, titan, id, x, y, amount })`. Pick cue ids, emit them from the behaviour at the moment the thing happens, and list them in
`voices/cues.ts` (`cueKind`) so the voice and the tests know them. `engine.test.ts` has a table of `[titan, cue]` pairs that every voice must survive:
add yours. Keep continuous voices cheap: they run for the whole match.

## 6. Tests to write and run

* `src/titans/titans.test.ts` already runs for every implemented id: the JSON validates, the generator is deterministic, colours are opaque, the
  body is one connected piece, size and budget hold, lighting changes colours but not the silhouette, and every authored material appears
  (materials that only exist at runtime must be named `dead*`).
* Your `src/combat/<id>.test.ts`: the failure mode triggers, the resource rules hold, the signature and ultimate do something measurable, and a scripted
  duel on the real world is deterministic (`m.hash()` equal over two runs).
* `src/combat/feel.test.ts` and `presence.test.ts` cover the framework; run the whole set with `npx vitest run src/titans src/combat src/ai src/audio`.
* Definition of done for your paths: `npx tsc --noEmit`, `npx eslint <paths>`, `npx prettier --check <paths>`, vitest green.

## 7. Look at it (always)

```
npx tsx tools/titans/sheet.ts <id>                     # intact / 50 % / 10 % at 1x, 3x, 4x and a 64 px row -> .scratch/titans/<id>-*.png
npx tsx tools/titans/frame.ts out.png --a=<id> --b=asteroid --t=150 --script0="4:crush"   # one moment of a fight
npx tsx tools/titans/strip.ts out.png --a=<id> --b=asteroid --script0="4:crush" --ticks=34,40,54,80,100    # filmstrip (knockback, recoil)
npx tsx tools/titans/strip.ts out.png --a=<id> --b=lastone --gap=300 --script0="4:right*50,60:left*40" --ticks=20,45,62,85 --focus=0   # locomotion and movement FX
```

Read every PNG: the body must read at 64 px, damage states must still look like the titan, and the moving strips must show weight (lag, overshoot, drift)
and the wake.

## 8. Validate feel and balance

* **Feel targets** (frame data, response times) are asserted by the validator and `feel.test.ts`; change frame data, not the tests.
* **Pacing**: `npx tsx tools/titans/moveprobe.ts --a=<id> --b=asteroid` (and `--b=lastone`) or `npx tsx tools/ai/moves.ts --a=<id> --b=asteroid`.
  Targets, as a share of an idle opposing body: Strike about 2 to 5 %, Crush 6 to 15 %, Ultimate 25 to 45 %.
* **Duels**: `npx tsx tools/ai/duel.ts --a=<id> --b=<other> --la=3 --lb=3 --n=20 --seed=200 --swap` (real matter world, sides alternated). Read
  wins with a standard error of about 11 points at n = 20; use n >= 50 for decisions. Round length target: average 30 to 50 s.
* **Tournament** (unattended, resumable, all pairs, writes `docs/BALANCE.md` and `docs/balance-results.json`): `npm run balance -- --n=100 --level=3`.
  **Ladder** (does a higher AI level win, per titan): `npm run balance -- --ladder --n=50`.
* **Levers, in the order to try them**: move energies (`hitboxes[].damage.energy`), material `resist` overrides per attacker damage type,
  frame data, `knockback`, `attributes`, guard `shell.absorb`, resource costs, and `ai.weights` last (large effect, easy to overshoot).
  Change one lever, re-run the same seeds. Known traps are listed in `docs/BALANCE.md` (an accretor that is credited its victim's mass can never be KO'd:
  use `extra.noCredit`; immune matter raises the mass floor; per-titan AI weights swing results more than levels do).

## 9. Docs

`npx tsx tools/titans/docs.ts` regenerates `docs/TITANS.md` from the JSON. Add a gallery image or two under `docs/gallery/` (`titans-<id>-*.png`).
Update `src/titans/README.md` if you added an `extra` key.
