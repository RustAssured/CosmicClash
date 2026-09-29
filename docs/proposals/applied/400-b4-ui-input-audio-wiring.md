# 400 — Builder 4: contract gaps, app wiring, and what is NOT verified

B4 ships local adapters for everything below, so nothing blocks. The Lead applies proposals between rounds.
`dev/ui/main.ts` is a working reference for section 2: it wires the real input manager, UI and audio engine exactly the way the
app should, and `e2e/ui.spec.ts` drives it.

## 1. Contract gaps (src/contracts/ui.ts, src/contracts/audio.ts)

### 1a. `UIAction` cannot carry three things the UI needs to say

| Need | Where it comes from | Local adapter today |
|---|---|---|
| Render quality 0/1/2 changed | Options screen | `UIDeps.onQuality(q)` callback |
| Training dummy mode, reset positions, heal both | Training pause menu | `UIDeps.onExtra(UIExtraAction)` callback |

Callbacks work, but they bypass `drainActions`, so the app has to wire two more hooks and the actions never appear in the one
queue that scripted tests and the harness can inspect. Proposed additions to the union:

```diff
 export type UIAction =
   | { type: 'startMatch'; config: MatchConfig }
   …
   | { type: 'setVolume'; master?: number; music?: number; sfx?: number }
+  | { type: 'setQuality'; quality: 0 | 1 | 2 }
+  | { type: 'setDummy'; mode: 'idle' | 'guard' | 'ai' }
+  | { type: 'resetPositions' }
+  | { type: 'healBoth' }
   | { type: 'toggleTraining' }
```

When applied, `createUI` emits them instead of calling `onQuality` / `onExtra`; B4 will delete the callbacks in the same change
(`src/ui/types.ts`: `UIExtraAction`, `UIDeps.onQuality`, `UIDeps.onExtra`; `src/ui/screens/{options,pause}.ts`).

### 1b. `AudioEngine` has no way to read levels

The contract comment on `ready` mentions "Peak level since last call … used by tests to prove the limiter holds", but the
interface has no such member. B4's `AudioEngineExt` adds `readPeak(): { pre: number; post: number }` (pre = the mix before the
dynamics, post = what reaches the speakers). Proposed: add it to `AudioEngine` so the harness can assert "nothing clips" on the
real engine, or drop the stray comment.

## 2. What the app must do (the wiring the UI and audio assume)

Per animation frame, in this order (see `dev/ui/main.ts`):

1. `input.poll(now)` — once. `ui.update()` calls `input.pollIfStale()`, which is a no-op when the app already polled this frame
   whatever timestamp it passed. (Passing a `requestAnimationFrame` timestamp to `poll` and letting the UI poll with
   `performance.now()` used to double-poll and swallow menu edges; that is fixed, but polling once yourself is still right.)
2. Per **sim tick**, in tick order: `input.source(0).poll(tick, frame0)` and `input.source(1).poll(tick, frame1)`. These sample the
   devices at tick time and latch taps shorter than a tick. Do not call them from the render loop.
3. `ui.update(dt)`, then `ui.drainActions(buf)` and act on each action:
   - `unlockAudio` → `audio.unlock()` (this is a real user gesture: the first press on the boot screen). Also call
     `audio.autoUnlock(document)` once at startup as a fallback for browsers that do not count a gamepad press as activation.
   - `setVolume` → `audio.setVolumes(a)`.
   - `resume` → the app resumes the sim **and** calls `ui.showPause(false)` (the pause menu pops itself but the app owns the state).
   - `quitToTitle` → tear the match down and `ui.showTitle()`.
   - `attractStart` / `attractStop` → start/stop the AI-vs-AI match; the UI switches screens itself.
   - `startMatch` → build the match from `config`.
4. `audio.handle(simEvents)` with the SimEvents of the tick(s) just run, and `audio.update(scene, dt)` once per frame
   (`phase: 'menu'` outside matches). The score smooths intensity with a 0.35 s rise, so it needs a steady per-frame `update`.
5. Rumble: forward `SimEvent { t: 'rumble' }` to `input.rumble(slot, strong, weak, ms)`. The manager gates it (a device without an
   actuator, or one that a stronger effect is already occupying, is skipped) and does nothing when there is no actuator.
6. `UIDeps.sound` → `(id) => audio.handle([{ t: 'ui', id }])`, so menu sounds share the engine and its limiter.

`UIDeps.newSeed` defaults to a time-derived seed; the app may pass its own so a "rematch" replays the same fight.

## 3. What is verified, and what can only be verified against fakes (read this before shipping)

**No physical controller, no Bluetooth stack, no sound hardware exists in the build sandbox.** Everything below is honest about that.

Verified against **fake Gamepad objects** (unit tests in `src/input`, browser specs in `e2e/controller.spec.ts` through a
replacement `navigator.getGamepads`): id parsing across Chrome/Firefox/Safari formats, the six layout tables, hat decoding, radial
deadzone, rotation, calibration, tick-time sampling and latching, hysteresis, auto-repeat navigation, P1/P2 assignment, hot-plug,
remapping and persistence, corrupt storage, the rumble gate, and the Controller Check UI.

**Not verified on hardware — every one of these is written from documented browser behaviour and needs ten minutes with a real Pro
Controller (and, ideally, a Joy-Con pair and an Xbox pad):**

- that Chrome/Firefox/Safari on each OS report the id strings, `mapping` values, button/axis counts and hat values the fakes use
  (in particular the Pro Controller's non-standard DirectInput path: B A Y X L R ZL ZR − + L3 R3 Home Capture, hat on axis 9,
  neutral ≈ 1.29);
- the single sideways Joy-Con stick rotation defaults (`defaultRotation`) and the SL/SR button indices;
- that `vibrationActuator.playEffect('dual-rumble', …)` actually rumbles a Pro Controller in each browser (Chrome yes on some OSes;
  Firefox/Safari have limited or no support); the optional WebHID HD-rumble report encoder (`encodeRumble`) is **unverified
  against hardware** and is off unless the player opts in on the Controller Check screen;
- WebHID report parsing (`parseStandardReport`) against a real 0x30 report;
- whether a gamepad press counts as a user activation for `AudioContext.resume()` in each browser (the engine retries on every
  frame and on the next click/key/touch, so the worst case is "sound starts on the first key or click");
- the WebHID permission prompt needs a click, so it cannot be triggered by a pad press.

The Controller Check screen exists to make this cheap to settle: it shows the raw button/axis numbers, lets the player remap any
action (stored as RAW references, so a wrong layout table can never corrupt a remap), calibrate, rotate, and test rumble.

**Audio has never been heard.** `dev/ui/audio-verify.ts` renders the real engine through an `OfflineAudioContext` in headless
Chromium and measures it (no NaN, no clipping under a worst-case storm, every sound audible against the ambience, score reacts to
intensity, glass brighter than rock, volume law, latency). That proves the engine is safe and responsive; it cannot say a note is
beautiful. Put on headphones and use `dev/ui/audio.html`.

## 4. Suggestions for shared files (Lead-owned)

- `package.json` scripts: `"audio:verify": "tsx tools/ui/audio-verify.ts"`, `"ui:sheet": "tsx tools/ui/sheet.ts"`.
- `playwright.config.ts`: B4's specs start their own Vite dev server (`tools/ui/devserver.ts`, watch and HMR off), so they work
  with the existing `webServer` block untouched. CI installs Chromium with `npx playwright install --with-deps chromium`
  (already in `.github/workflows/ci.yml`).
- `vite.config.ts`: the dev pages under `dev/` are not part of `vite build`; nothing to do.
- The dev sandbox (`dev/ui/main.ts`) and `tools/ui/sheet.ts` fall back to fixture portraits when a titan generator throws (other builders'
  code is edited in the shared tree while B4 works), which would hide a broken generator on the UI screens: read `e2e/ui.spec.ts` as a
  check of the UI, not of B3's art.
