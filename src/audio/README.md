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
| `generic.ts` | a small flavour table so Nexus, Black Hole, Supernova and Planet already sound different (not stubs; not yet as deep as the two above) |
| `ui.ts` | menu sounds and their per-sound level trims (`UI_TRIM`) |

A `TitanVoice` implements any subset of `onMove / onCharge / onRelease / onSurge / onHitDealt / onHitTaken / onGuard / onKo /
onUltimate / onCue / onMatter / update / stop`; anything it leaves out (or, for `onMatter`, returns `false` from) falls back to the
shared sounds, so no event is ever silent and a new titan can ship with a partial voice.

## The adaptive score (`score/`)

`plan.ts` is pure and deterministic (seeded RNG) and unit-tested: a 16-step bar, tempo 0.92× to 1.2× of the stage BPM with intensity;
sub pulses first, then taiko-like hits, then airy percussion; a heartbeat and a tense minor-second cluster as integrity falls;
menus get an occasional bell instead of any rhythm. `engine.ts` turns a `StepPlan` into sound: a drone (saw + triangles + sub through
a breathing low-pass), a gliding three-voice pad on the stage's mode, and the rhythm layers. Five stages, five musical identities
(`dsp/scales.ts`: Lydian, Aeolian, Phrygian, whole-tone, suspended). A KO is a hush; a round end blooms into an open chord. Intensity
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
5. **Two renders of one seed differ by float noise** (about −83 dB) in Chromium's offline graph, so the verification compares RMS of
   the difference, not samples.

The strict fake (`testing/fakeContext.ts`) throws AND records every Web Audio rule it enforces (`takeViolations()`), because the
engine deliberately swallows exceptions from a misbehaving voice: tests must assert the record is empty, not that nothing threw.

## Verification (`dev/ui/audio-verify.ts`, run by `e2e/ui-audio.spec.ts`)

Renders the real engine through an `OfflineAudioContext` and measures it. Last run, headless Chromium, 44.1 kHz:

| Check | Result |
|---|---|
| NaN / infinite samples across every render | 0 |
| 24 fuzz renders (every titan pair, damage type, event mix), limiter bypassed | worst raw peak 1.2 (a diverging voice shows as 1e3+) |
| Worst-case storm, ~1,900 events in 6 s | peak 0.67 with the limiter; **2.4 without it** (it would clip) |
| Event to first audible sample | 16.4 ms (6 ms scheduling look-ahead plus the compressor's own delay; output device latency comes on top) |
| Every event, bed subtracted | audible (> −30 dB peak) and never hot (< −2 dB raw peak); the one silent windup (`lastone.gaze`) is silent on purpose, its sound is the `charge` voice |
| Menu sounds | −23 to −9.6 dB peak, above the calm menu score |
| Heaviest blow's reverb tail, event alone | 1.16 s to −40 dB |
| Glass vs rock, spectral centroid above 300 Hz | 1806 Hz vs 786 Hz |
| Score, calm menu vs full-intensity fight | peak −17.2 → −9.7 dB, 50 ms envelope spread 2.4 → 11.3 dB |
| Same seed, two renders | differ by −83 dB (float noise) |
| Master volume | 0 → silent; ½ → −11.5 dB (the squared taper's −12 dB) |

```bash
npx tsx tools/ui/audio-verify.ts [--quick] [--json]      # prints the table above; --quick is per-event levels only (~1 min)
npx playwright test e2e/ui-audio.spec.ts                 # the same run, asserted
npx vitest run src/audio                                 # 55 unit tests against the strict fake context
```

## Tuning knobs

`MOVE_TRIM`, `SURGE_TRIM`, `CUE_TRIM` (engine.ts) and `UI_TRIM` (voices/ui.ts): per-class level trims, the one place the mix is
decided. `POLYPHONY`, `LOOKAHEAD`; compressor settings and send levels in `Engine.build`; `limiterCurve(knee, ceiling)`;
`generateImpulseResponse({ decay, preDelay, brightStart, brightEnd })`; `STAGE_MUSIC` (root, mode, BPM, chords per stage); `planStep`
thresholds for when each rhythm layer enters.

## Known limits

- Never listened to; levels and timbres are set by measurement and by ear-less judgement.
- Nexus, Black Hole, Supernova and Planet use the flavour table in `generic.ts`, and their KO is the shared one; their levels are
  measured (−10 to −20 dB peak for hits and windups) but they are not characterful yet.
- `latencyMs()` reports what the browser exposes (`baseLatency + outputLatency`); Safari and Firefox report less than Chrome.
- Whether a gamepad press counts as a gesture for `AudioContext.resume()` differs by browser; the engine retries on every frame and
  `autoUnlock` catches the first click, key or touch.
