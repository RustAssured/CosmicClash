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

## Signal path

```
voices ─ per-voice pan + dry ─► sfx bus ───┐                         ┌─ dry ─┐
       └ reverb send (long dark IR) ─►     ├─► mix ─► high-pass 22 Hz ─► compressor ─► soft limiter (4× oversampled) ─► MASTER ─► hard clip ─► speakers
score ─► music bus ─► (+ send) ────────────┘
                              wet: one ConvolverNode, procedural IR (RT60 3.4 s, decorrelated stereo, dark, energy-normalised), send high-passed at 140 Hz
```

- **Master volume is after the dynamics.** Before them, a ratio-5 compressor flattened the level the player asked for (master at
  ½ changed a hit by −1.3 dB); now ½ is −11.5 dB, and because master ≤ 1 it can never push the limiter's output past its ceiling.
- **Nothing clips.** Soft limiter: linear to 0.72, then a `tanh` shoulder asymptoting to 0.98 (`limiterCurve`), at 4× oversampling.
  The oversampler's down-sampling filter can overshoot its own ceiling by ~1 dB on a hard-clipped signal, so the last node is a
  memoryless, non-oversampled hard clip at 0.98 (`hardClipCurve`): it can only ever touch those rare overshoots.
- **Polyphony cap** (28 concurrent one-shots; low-priority sounds are shed first, KO and ultimates never are), a look-ahead of 6 ms so
  start times are exact, and a ducking dip on the music bus for hits and hit-stop so impacts read louder without raising master.

## Voices (`voices/`)

| File | |
|---|---|
| `synth.ts` | the primitives: `tone`, `noiseHit`, `partials` (glass / iron / tink bell sets), `gravel` (granular rock in three nodes), `thump` (sub drop plus a knock for small speakers), `riser`, `whistlePass` (Doppler), all with click-free envelopes |
| `sfx.ts` | titan-neutral layers: impact, the six damage-type flavours, guard, shockwave, KO, matter, ultimate, cues |
| `lastone.ts` | **The Last One**: struck glass and ceramic on D pentatonic, tink transients, fracture cracks, a breathing tendril pad that follows its motion, the Gaze's rising eye-flare |
| `asteroid.ts` | **The Asteroid**: rock crunch, gravel, iron rings off ejecta, a Doppler whistle when it tumbles past, a rolling rumble under it |
| `nexus.ts` | **Nexus**: hollow inharmonic chain rings (`CHAIN`) that clank and drag, a click-lock when a chain takes hold, a ratcheting tear when it harvests, descending detuned pings when a node goes dark, and a 40-60 Hz heartbeat that throbs faster the more of the graph is alive |
| `blackhole.ts` | **Black Hole**: a sub-bass drone whose pitch FALLS as mass grows (39 Hz at 1.8x mass, 68 Hz at 0.5x) with pockets of near-silence, rising tidal spirals, gulps, and a Hawking glitter (3-12 kHz) as it runs out of mass |
| `supernova.ts` | **Supernova**: a broadband roar with crackle grains, both following the fuel (resource), whumps with sub tails, and a breath in and a blast when it goes |
| `planet.ts` | **Planet**: tectonic rumble, crust groans, wind that fades for good when its atmosphere is stripped (`strip` cues), moon slams with a bell-like orbital ring, boiling-ocean hiss |
| `kit.ts`, `cues.ts` | shared building blocks of the four (`scrape`, drones with a registry of sources, ...) and the cue keyword table |
| `index.ts` | `createTitanVoice(id)`: one voice module per titan; an unknown id gets an empty voice (all shared layers) |
| `ui.ts` | menu sounds and their per-sound level trims (`UI_TRIM`) |

Cue ids (`SimEvent { t: 'cue' }`) are free-form strings owned by each titan. Voices react to the KIND of cue by keyword, so an id
this engine has never seen still lands on something sensible: `sever`, `dark`, `lost`, `shed`, `break`, `boil`, `strip`,
`collapse`, `harvest`, `swarm`, `merge` (`voices/cues.ts`, first keyword found in the id wins; anything else is a generic blip).
`CUE_TRIM` is per titan (Last One and Asteroid 3, the others 1).

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
