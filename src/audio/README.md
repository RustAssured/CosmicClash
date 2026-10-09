# `src/audio`: procedural WebAudio engine

`createAudioEngine(): AudioEngine` (contract `audio.ts`). **No assets, no samples, no network**: every sound is synthesised, the
reverb impulse response is generated, and the adaptive score is composed on the fly.

> **Measured, not heard.** The engine is verified numerically in a real browser (below). Nobody has listened to it yet. Use
> `dev/ui/audio.html` with headphones before believing any of it is good.

## Public API (`import … from '@/audio'`)

```ts
const audio = createAudioEngine({ seed?, context?, unsafeBypassLimiter? });   // returns AudioEngineExt
await audio.unlock();                  // from a user gesture; safe to repeat. Builds the graph, resumes the context
audio.autoUnlock(document);            // optional: resume on the next click / key / touch / pointer (returns an unsubscribe)
audio.handle(events);                  // AudioEvent[] (every SimEvent + { t: 'ui', id }), once per frame, cheap when empty
audio.update(scene, dt);               // AudioScene, once per frame: continuous voices and the adaptive score
audio.setVolumes({ master, music, sfx });     // 0..1, squared taper
audio.ready;  audio.dispose();
// diagnostics and offline hooks (AudioEngineExt): context, handleAt(events, when), updateAt(scene, dt, horizon),
//   readPeak() → { pre, post }, latencyMs(), volumes
```

`context` lets tests and the verification page render through an `OfflineAudioContext`; `unsafeBypassLimiter` is **test-only** (it
skips the compressor and the limiters so a test can show that a storm would clip without them). Never set it in the app.

Wiring (what the app calls when) is in `docs/proposals/400-b4-ui-input-audio-wiring.md`; `dev/ui/main.ts` is a working example.

## Signal path (D6, slice Phase 1)

```
impact voices ─► IMPACT bus (sfx fader) ───────────────────────────────┐
     └ sends ─► cavern reverb (HP 90, LP 3.2k, return 0.75) ───────────┤
ui sounds ─► UI bus (sfx fader, −9 dB) ────────────────────────────────┤
titan beds (sfx fader) ┐                                               ├─► mix ─┬─► HP 50 Hz (24 dB/oct) ─► calibration
score (music fader) ───┼─► BED bus (−3.5 dB) ─► glue 2:1 ─► DUCK ──────┘        └─► WEIGHT (sub band → rectifier → 70–420 Hz) ─┘
bed sends ─► bed reverb┘                                       ─► MASTER ─► TRUE-PEAK LIMITER (−1 dBTP) ─► clip
```

- **Impacts never pass a compressor**; only the bed is glued (2:1 at −18 dB, its automatic makeup gain taken back).
- **Bed duck**: 4–6.5 dB for 350–550 ms under heavy blows and the big rings (Planet quake, moon slams, nova). **A KO is a hush**
  (D34): the whole bed falls `KO_HUSH_DB` = 14 dB for `KO_HUSH_SEC` = 1.6 s, and the titan's catastrophe lands into it.
- **The score breathes**: −8 dB at neutral, full when a fighter commits (wind-up, charge, strike) or the fight heats up.
- **Laptop speakers (D27, D34)**: the output is high-passed at 50 Hz. "Huge" is made readable in 80–250 Hz twice over: every low
  body in `voices/epic.ts` is SATURATED (its 3rd/5th harmonics carry it), and the master's `WEIGHT` stage takes the sub band
  (< 100 Hz, 4th order), passes it through an even, rectifying curve (`weightCurve`: no fundamental, only the 2nd, 4th…
  harmonics, in proportion to the sub's own level) and adds the 70–420 Hz result back. The ear hears the missing fundamental;
  headphones still get the real sub.
- **The cavern** (D34): one generated IR, 4.2 s, dark from its first reflections (`brightStart` 0.3), its sends high-passed at
  90 Hz (the weight band reaches the tail) and low-passed at 3.2 kHz (no tail ever hisses).
- **Limiter**: `worklets/limiter.ts`, lookahead 2.5 ms, 4× true-peak detection, a sliding-minimum/moving-average gain (no clicks), release 120 ms. Its core class is the exact code the AudioWorklet runs (stringified), unit-tested in Node. Master sits before it: linear under the ceiling, nothing passes it.
- **D34 measured** (`--pairs`, real AI fights, 60 s, seed 21, the sim of 2026-10-09 afternoon): −18.2 … −20.5 LUFS integrated
  for every pair with heavy blows, ≤ −1.2 dBTP, LRA 8–17, heavy blows 13–17 dB over the bed, duck 4–6 dB; share of the output's
  power above 2 kHz 0.11–0.20 % (was 0.4–9.6 %), 80–250 Hz 59–74 %, 250 Hz–2 kHz 16–26 %. Through a laptop-speaker model
  (`dev/ui/audio-laptop.ts`) the fights play as loud as before (−22.9 / −26.3 / −24.2 vs −22.3 / −26.7 / −23.6 LUFS).
- **Pre-D34 measured** (`npx tsx tools/ui/audio-verify.ts --round`, a scripted 60 s Witness-vs-Planet round, BS.1770 via `src/telemetry/loudness.ts`): −20.2 LUFS integrated, −1.2 dBTP, LRA 11.7 LU, heavy blows 18.8 dB over the bed (short-term, median), bed duck 5.3 dB for 400 ms, limiter 2–5 dB on heavy blows.
- `taps()`: `output` = speakers, `music` = the whole bed after its duck, `sfx` = the impact bus.
## Voices (`voices/`)

| File | |
|---|---|
| `synth.ts` | the primitives: `tone`, `noiseHit`, `partials` (glass / iron / chain / bronze bell / tink sets), `gravel` (granular rock in three nodes), `thump` (the score's tuned drum), `riser` (menu only), all with click-free envelopes |
| `epic.ts` | **the cataclysm kit (D34)**: `boom` (the tectonic drop: a saturated, pitch-falling body, its 80–250 Hz knock, a 200–600 Hz crunch, a dark contact), `rumble` (a long heaving cavern tail), `swell` (a reversed swell into a hit), `whoosh` (a shockwave / mass passing: air sweeping DOWN while it pans; replaces every Doppler whistle), `roar` (detuned low saws through a closing filter), `lowBell` (colossal bells and hulls, nothing above 1.6 kHz), `grind` (rock/metal dragging, chopped by a slow ratchet), `crackle` (low-passed embers and grit), `hush` and `catastrophe` (the KO: the inhale, two drops, a decay of seconds). No tone in the kit sits above ~1.6 kHz (unit-tested) |
| `sfx.ts` | titan-neutral layers: the three-layer impact (drop, crunch, cavern tail; heavy blows add a deeper drop, a lingering rumble and falling rubble), the six damage-type flavours (all low), guard, shockwave (drop plus a pressure whoosh), KO (`catastrophe`), matter, ultimate, cues |
| `lastone.ts` | **The Witness**: a temple bell struck by a mountain — colossal bronze (`BELL` on D1–D3) over fired-clay cracks and grinding stone slabs, tendrils that snap like ridge-sized cables (a LOW Karplus–Strong pluck), the Gaze as a low choir whose filter opens as the eye fills and a beam that roars, a low breathing choir bed (D2 A2 D3) |
| `asteroid.ts` | **The Asteroid**: a tumbling mountain — rock crunch and rubble under 1.6 kHz, a drop on every blow, iron veins ringing like a city-sized anvil (IRON on 70–120 Hz), a hail of boulders for the swarm, a rolling grinding rumble under it |
| `nexus.ts` | **Nexus**: colossal chains and machinery — chain links as huge hollow rings (`CHAIN` on 69–139 Hz) with a dark knock and grinding metal, a latch is a tower-sized bolt seating home, a node going dark tolls down, and a saturated 43–55 Hz heartbeat that throbs faster the more of the graph is alive |
| `blackhole.ts` | **Black Hole**: gravity itself — a saturated sub drone whose pitch FALLS as mass grows, pockets of near-silence, an accretion disk that roars low, tidal pull as pressure converging and sinking, gulps, and a dark crackle of evaporation (not glitter) as it runs out of mass |
| `supernova.ts` | **Supernova**: a furnace — a deep convecting roar and low ember crackle that follow the fuel, flares that roar past, whumps with long sub tails, and a breath in and a blast that rolls on for seconds when it goes |
| `planet.ts` | **Planet**: tectonic rumble, crust groans, cosmic wind (130/300/620 Hz) that fades for good when its atmosphere is stripped, moon slams with an orbital bronze ring, magma and a boiling ocean as slow low blurps |
| `uri.ts` | **우리**: a war-body of two dismantled worlds — a megastructure hull that rings like a colossal plate (`HULL`) and grinds when it moves, a dead civilisation's hum (A1 E2 A2 saws), the two worlds' cores thrumming 2.5 Hz apart (41 / 43.5 Hz, saturated), a bowed-metal strain that rises as the loop (its health) gives, fists of planetary matter, and the loop snapping on `break-apart` |
| `kit.ts`, `cues.ts` | shared building blocks (`scrape`, `bubbles`, beds with a registry of sources, ...) and the cue keyword table |
| `index.ts` | `createTitanVoice(id)`: one voice module per titan (all seven); an unknown id gets an empty voice (all shared layers) |
| `ui.ts` | menu sounds and their per-sound level trims (`UI_TRIM`) |

Cue ids (`SimEvent { t: 'cue' }`) are free-form strings owned by each titan. Voices react to the KIND of cue by keyword, so an id
this engine has never seen still lands on something sensible: `sever`, `dark`, `lost`, `shed`, `break`, `boil`, `strip`,
`collapse`, `harvest`, `swarm`, `merge`, and the ones the newer titans' own ids need: `blow` (layer-blow), `crack` (crust-crack), `burn` (fuel-burn),
`latch` (chain-latch), `consume`, `hawking` (`voices/cues.ts`, first keyword found in the id wins; anything else is a generic blip).
`CUE_TRIM` is per titan (D34: empty; every voice authors its cues at full level).

A `TitanVoice` implements any subset of `onMove / onCharge / onRelease / onSurge / onHitDealt / onHitTaken / onGuard / onKo /
onUltimate / onCue / onMatter / update / stop`; anything it leaves out (or, for `onMatter`, returns `false` from) falls back to the
shared sounds, so no event is ever silent and a new titan can ship with a partial voice.

## The adaptive score (`score/`)

`plan.ts` is pure and deterministic (seeded RNG) and unit-tested: a 16-step bar, tempo 0.92× to 1.2× of the stage BPM with intensity;
sub pulses first, then taiko-like hits, then airy percussion; a heartbeat and a tense minor-second cluster as integrity falls;
menus get an occasional bell instead of any rhythm. `engine.ts` turns a `StepPlan` into sound: a drone (saw + triangles + sub through
a breathing low-pass), a gliding three-voice pad on the stage's mode, and the rhythm layers. Five stages, five musical identities:
`STAGE_MUSIC` (root, mode, tempo, chords) plus `STAGE_FEEL` (how it is VOICED; `dsp/scales.ts`):

| Stage | Mode, BPM | Character |
|---|---|---|
| Stellar Nursery | Lydian, 68 | warm and hopeful: open and bright, full pad, the most rhythm, a few bright motes |
| Galactic Rim | Aeolian, 56 | vast and slow: a deep wide pad in a huge space, little rhythm |
| Red Giant's Wake | Phrygian, 58 | mournful and heavy: darkest filters, strongest drone, a permanent minor-second ache |
| Quasar Void | whole-tone, 76 | tense and sparse: thin and high, one rhythm layer in four, the unresolved cluster always faintly present |
| Tussenruimte | suspended, 52 | near-silent stillness: at least 8 dB below every other stage, no rhythm at all, glass motes falling into a very large space |

Everything pitched (drone, pad, taiko bodies, sub pulse, heartbeat, bells) is a degree of the stage's own mode: the taiko is tuned
to root / drone fifth / octave (`fifthOf`: the mode's degree nearest a perfect fifth), the bells use the stage's scale. Intensity
adds layers (sub, taiko, percussion, heartbeat, motes) rather than only gain: at full intensity the Nursery plays 14 hits a bar
where the calm menu plays none, while the RMS level rises by about 2 dB. A KO is a hush; a round end blooms into an open chord. Intensity
rises with a 0.35 s time constant and falls with 2.2 s, so it needs a steady per-frame `update`.

The exact ids the shell emits (`layer-blow`, `crust-crack`, `fuel-burn`, `collapse`, `moon-lost`, `atmo-strip`, `ocean-boil`, `node-dark`,
`harvest`, `chain-latch`, `disk-shed`, `consume`, `hawking`) each have their own sound, asserted to differ from the generic blip
(`engine.test.ts`), and each has a button on the audition page.

## Chromium behaviours that bit, and the rules they produced

Found by running the real engine in headless Chromium (the strict fake in Node could not see them), then locked in with tests:

1. **Overlapping automation on one `AudioParam` diverges.** ~30 overlapping `setValueAtTime` + ramp events on one gain made it
   explode (peaks of 1e8, then NaN in every filter downstream, which silences the output for good). `gravel` now lays its grains
   in order without overlap; `envelope()` keeps the attack strictly inside the duration; the fake context rejects any event that
   lands inside an existing ramp (`FakeParam.insert`).
2. **`setTargetAtTime` starts from the value BEFORE a same-instant `setValueAtTime`**, not from that set. A voice that did both
   started at the node default (1.0) and decayed to its level: a full-scale click. Start silent through the param's own `.value`.
3. **Voices that are retargeted every tick must not use ramps** (a `hold` event landing inside a pending ramp is rule 1 again): the
   Gaze charge uses `setTarget` only.
4. **A compressor between the voices and the master fader makes the fader nearly useless** (see Signal path).
5. **A second `setTargetAtTime` at the same instant as another, with a different time constant, restarts from the parameter's default
   value.** The score used to create its drone, then retarget it a moment later on the first stage change, at the same time: the
   whole score glided down from 440 Hz into key over several seconds (found by measuring the pitch of the render, not by any unit
   test). Voices are now created on their pitch through `.value`, and the fake context rejects that pattern.
6. **Two renders of one seed differ by float noise** (about −83 dB) in Chromium's offline graph, so the verification compares RMS of
   the difference, not samples.

The strict fake (`testing/fakeContext.ts`) throws AND records every Web Audio rule it enforces (`takeViolations()`), because the
engine deliberately swallows exceptions from a misbehaving voice: tests must assert the record is empty, not that nothing threw.

## Verification (`dev/ui/audio-verify.ts`, run by `e2e/ui-audio.spec.ts`)

Renders the real engine through an `OfflineAudioContext` and measures it. Last run, headless Chromium, 44.1 kHz:

| Check | Result |
|---|---|
| NaN / infinite samples across every render | 0 |
| 24 fuzz renders (every titan pair, damage type, event mix), limiter bypassed | worst raw peak 1.2 (a diverging voice shows as 1e3+) |
| Worst-case storm, ~2,900 events in 6 s from all six titans | peak 0.67 with the limiter; **2.55 without it** (it would clip) |
| Event to first audible sample | 16.4 ms (6 ms scheduling look-ahead plus the compressor's own delay; output device latency comes on top) |
| Every event, bed subtracted | audible (> −30 dB peak) and never hot (< −2 dB raw peak); the one silent windup (`lastone.gaze`) is silent on purpose, its sound is the `charge` voice |
| The four newer titans: 93 events (moves, releases, hits dealt/taken, guard, KO, ultimate, matter, every cue keyword) | all within −26 to −3 dB raw peak |
| Body voice brightness (spectral centroid of `onHitTaken` alone) | Last One 2799 > Nexus 1687 > Supernova 1416 > Asteroid 975 > Planet 447 Hz (glass > chain > plasma > rock > planet rumble) |
| Continuous voices | Black Hole drone 39 Hz heavy vs 68 Hz light, Hawking sparkle +18.7 dB, share of the bed below 120 Hz 0.85 (highest); Nexus pulse 1.7 -> 4.3 beats/s with more of the graph lit; Supernova roar −34.4 vs −37.3 dB with a full vs empty tank; Planet wind −5.4 dB after two `strip` cues |
| Stage scores (calm vs full fight) | see the table below; all in key within 31 cents (the Quasar's is its deliberate detune) |
| Menu sounds | −23 to −9.6 dB peak, above the calm menu score |
| Heaviest blow's reverb tail, event alone | 1.16 s to −40 dB |
| Stage scores, calm RMS / fight RMS / bass fit to drone / pad fit to scale (dB, dB, cents, cents) | Nursery −32.5 / −30.4 / 2 / 6; Rim −30.1 / −28.4 / 1 / 7; Red Giant −29.1 / −28.8 / 14 / 6; Quasar −35.5 / −33.6 / 16 / 30; Tussenruimte −43.8 / −42.3 / 4 / 0.1 |
| Stage rhythm, hits per bar at full intensity (from the planner) | Nursery 14.4, Rim 9.1, Red Giant 14.4, Quasar 4.0, Tussenruimte 0; Tussenruimte's motes 13 a minute against at most 3.4 |
| Glass vs rock, spectral centroid above 300 Hz | 3936 Hz vs 776 Hz |
| Score, calm menu vs full-intensity fight (Nursery) | peak −16.4 → −10.4 dB, 50 ms envelope spread 2.6 → 10.0 dB |
| Same seed, two renders | differ by −83 dB (float noise) |
| Master volume | 0 → silent; ½ → −11.5 dB (the squared taper's −12 dB) |

```bash
npx tsx tools/ui/audio-verify.ts [--quick|--titans|--stages|--body] [--json]   # the table above (~4 min); the modes are the parts (--body: seconds)
npx tsx tools/ui/audio-verify.ts --audit [--top=40] [--out=f.json]   # every sound source alone: where its energy lives (the whistle audit, ~30 s)
npx tsx tools/ui/audio-verify.ts --pairs [--seconds=60] [--wav=dir]  # real AI fights for 7 titan pairs: LUFS, dBTP, LRA, over-bed, duck, band shares (~2.5 min each)
npx playwright test e2e/ui-audio.spec.ts                 # the same run, asserted
npx vitest run src/audio                                 # 70 unit tests against the strict fake context
```

## Tuning knobs

`MOVE_TRIM`, `SURGE_TRIM`, `CUE_TRIM` (engine.ts; the last per titan) and `UI_TRIM` (voices/ui.ts): per-class level trims, the one place the mix is
decided. `POLYPHONY`, `LOOKAHEAD`; compressor settings and send levels in `Engine.build`; `limiterCurve(knee, ceiling)`;
`generateImpulseResponse({ decay, preDelay, brightStart, brightEnd })`; `STAGE_MUSIC` (root, mode, BPM, chords per stage) and `STAGE_FEEL` (density, body, darkness, pad level and register, space, tension, motes); `planStep`
thresholds for when each rhythm layer enters.

## Known limits

- Never listened to; levels and timbres are set by measurement and by ear-less judgement.
- The four newer voices are characterful on paper and in numbers (brightness order, pitch tracking mass, beat rate, wind, roar); that
  they sound GOOD is unknown. The stage rhythm counts come from the planner, because detecting beats in the rendered score by
  onset measured no better than chance.
- `latencyMs()` reports what the browser exposes (`baseLatency + outputLatency`); Safari and Firefox report less than Chrome.
- Whether a gamepad press counts as a gesture for `AudioContext.resume()` differs by browser; the engine retries on every frame and
  `autoUnlock` catches the first click, key or touch.
