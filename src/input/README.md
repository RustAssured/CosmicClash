# `src/input`: gamepad and keyboard input, Switch Pro first

Turns the browser's `navigator.getGamepads()` and `KeyboardEvent`s into the contract's `InputSource` (one `InputFrame` per player
per sim tick) and into menu navigation for the UI. Browser APIs are allowed here, but every piece of logic lives in a pure module
that is unit-tested in Node against fake gamepads.

> **Read this first.** No physical controller, Bluetooth stack or HID device exists in the build environment. Everything here is
> verified against **fake `Gamepad` objects** written from documented browser behaviour (`testing.ts`, and Playwright through a
> replacement `navigator.getGamepads`). What the fakes cannot prove is listed under [Not verified on hardware](#not-verified-on-hardware).

## Public API (`import … from '@/input'`)

```ts
const input = createInputManager(opts?: InputManagerOptions);
input.attach();                       // window listeners (gamepadconnected, key events, blur)
```

| Call | Meaning |
|---|---|
| `poll(nowMs?)` | Once per frame. Rescans pads, builds menu-nav frames, tracks "press any button" activity. Idempotent per timestamp. |
| `pollIfStale(maxAgeMs = 8)` | Poll unless something already did this frame (wall clock). The UI calls it, so the app may poll with any timestamp. |
| `source(0 \| 1): InputSource` | `poll(tick, out)` per **sim tick**: samples the assigned device at tick time. Edges are per tick. |
| `nav('any' \| 0 \| 1): NavFrame` | Menu navigation for this frame: `up/down/left/right` (with auto-repeat), `confirm/back/start/tab`, `any`. |
| `devices()`, `assignment()`, `assign(slot, id)`, `swapSlots()`, `autoAssign()` | Devices (`pad:<index>`, `kb1`, `kb2`, `hid:0`) and who is P1/P2. |
| `onDevices(cb)`, `onActivity(cb)`, `drainActivity(out)` | Hot-plug and "press any button". |
| `rumble(slot, strong, weak, ms)`, `rumbleDevice(id, …)` | Through the `RumbleGate` and `vibrationActuator`; a no-op without one. |
| `settings`, `updateSettings(patch)`, `onSettings(cb)` | Deadzone, label mode (auto / nintendo / xbox / playstation), confirm mode (by label / by position), rumble strength. |
| `familyOf`, `promptFamily`, `actionLabel`, `confirmLabel`, `backLabel`, `lastActiveDevice` | Prompt text for the UI (`Y`, `ZR`, `SPACE`…). |
| `live(id)`, `beginCapture`, `capture`, `clearBinding`, `resetBindings`, `beginCalibration`, `beginRotationWizard`, `setRotation` | The Controller Check backend: raw numbers, remapping, calibration, rotation. |
| `hidStatus`, `requestHid()` | Optional WebHID mode (Chrome/Edge, needs a click). |

`InputManagerOptions` (`window`, `getGamepads`, `storage`, `now`, `userAgent`, `hid`, `keyboard`) exist so tests and the e2e
harness can inject fakes; the defaults use the real browser.

Everything else exported from `index.ts` is a pure helper (`parseGamepadId`, `layoutFor`, `decodeHat`, `radialDeadzone`,
`computeAutoAssignment`, `NavRepeater`, `padButtonLabel`, …) with its own test.

## How a press travels

```
navigator.getGamepads()          parse.ts       "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)" → vendor, product, name, browser family
        │                        profiles.ts    profile (switch-pro, joycon-l/r, xbox, playstation, generic) + layout table + glyph family
        ▼                        mapping.ts     raw buttons/axes → canonical POSITIONAL buttons (Pad.SOUTH … SR), hat → 8 directions, stick rotation
   PadDevice.refresh()           deadzone.ts    calibration + radial deadzone; latch of sub-tick taps
        │                        bindings.ts    canonical position → action (Y Strike · X Crush · B Surge · A Signature · ZR Ultimate · ZL Guard · L/R Feint · + Pause · − Training)
        ▼                        storage.ts     per-device remaps stored as RAW refs, sanitised on load
 Manager.sampleSlot(tick)  →  InputFrame       (moveX/moveY, held, pressed, released)
 Manager.poll(now)         →  NavFrame         (nav.ts: press, delay, repeat; stick hysteresis)
```

Canonical buttons are **positional** (`Pad.SOUTH` is the bottom face button), so Nintendo, Xbox and PlayStation pads share one
binding table and muscle memory; only labels differ (`labels.ts`).

## Invariants

- **Tick-time sampling.** `source(slot).poll(tick, out)` reads the device when the sim asks, not when a frame poll last looked. A tap
  the frame poll saw but the tick did not is **latched** and delivered on the next tick; latches are dropped if no tick sampled for
  100 ms (menus), so a stale tap can never become a phantom press when a match starts. Key events are true events, so keyboard
  taps of any length are latched, for the sim and for menus.
- **`poll` is idempotent per frame.** Two polls in one frame with different timestamps (a `requestAnimationFrame` time and
  `performance.now()`) used to rebuild the nav frame and swallow an edge; the UI now uses `pollIfStale`.
- **Remaps are RAW references** (`{k:'b', i:5}`, `{k:'a', i, s}`, `{k:'h', d}`), never canonical positions, so a wrong layout table
  cannot corrupt a stored remap and a fix to a table does not invalidate it. Keyed by `vendor:product:mapping`.
- **Uncertain tables stay fixable.** Every non-standard layout (`nintendo-directinput`, `xbox-firefox-linux`, `ds4-legacy`,
  `joycon-directinput`, `generic-legacy`) is data in `profiles.ts` and can be overridden per device from the Controller Check.
- **Storage never throws or trusts.** `localStorage` access is guarded; corrupt or hostile JSON is ignored field by field.
- **Rumble is gated.** A weaker effect never interrupts a stronger one that is playing (`RumbleGate`, needs 1.3× to preempt), and
  a pad without `vibrationActuator` is skipped silently.
- **No allocation in steady state.** Device lookups are cached and rebuilt only on hot-plug; a poll cycle allocates a few dozen
  bytes (the browser's own `Gamepad` snapshots excluded).
- **Layout of the default binding is in POSITIONS** and is data (`bindings.ts`), tested.

## Devices and layouts

| Profile | Where | Table |
|---|---|---|
| Switch Pro, `mapping: 'standard'` | Chrome/Edge/Safari/Firefox where the OS provides it | W3C standard (0-16, plus 17 Capture, 18/19 SL/SR when present) |
| Switch Pro, no mapping | Firefox, older Chrome, no Nintendo driver | `nintendo-directinput`: B A Y X L R ZL ZR − + L3 R3 Home Capture, D-pad hat on axis 9 (neutral ≈ 1.29) |
| Single Joy-Con, sideways | either hand | `joycon-directinput` + `SIDEWAYS_PAD_BINDINGS` (SL = Guard, SR = Ultimate) and a default stick rotation |
| Joy-Con pair / grip | combined device | treated as a Pro |
| Xbox / PlayStation | standard mapping, or the Firefox-Linux / DS4-legacy tables | same positions |
| Keyboards | `kb1` WASD + J I K L O, `kb2` arrows + numpad | `keyboard.ts`, by `event.code` |

## Not verified on hardware

Every item is written from documentation, covered by tests against fakes, and **needs confirming on a real controller**:

- the id strings, `mapping` values, button/axis counts and hat values each browser/OS combination reports for a Pro Controller;
- the Joy-Con SL/SR indices and the sideways stick rotation defaults (`defaultRotation`);
- that `vibrationActuator.playEffect('dual-rumble', …)` rumbles the Pro in each browser;
- WebHID: the 0x30 report decode (`parseStandardReport`) and the HD-rumble encoder (`encodeRumble`) are built from community
  protocol notes and have never met a controller. They are off unless the player enables them, and they degrade silently.
- whether a gamepad press counts as a user gesture for `AudioContext.resume()` (the audio engine retries on every frame and on
  the next click, key or touch).

The **Controller Check** screen (`src/ui/screens/controller.ts`) is the safety net: it shows raw numbers, the decoded hat, and
the canonical position each raw input landed on, and lets the player rebind, calibrate, rotate and test rumble.

## How to test

```bash
npx vitest run src/input                              # 143 tests, Node, fake pads (testing.ts)
npx playwright test e2e/controller.spec.ts            # real browser, replacement navigator.getGamepads (tools/ui/e2e-fake-pads.ts)
```

`testing.ts` has `FakePad`, `createFakeGamepads()` and builders for realistic devices (`proStandard()`, `proDirectInput()`,
`joyconLeftStandard()`, `joyconRightDirectInput()`, `xboxStandard()`, `dualSenseStandard()`), including `HAT_VALUES`.

## Tuning knobs

`DEFAULT_REPEAT` in `nav.ts` (380 ms delay, 90 ms repeat), stick nav thresholds (`StickNav`: on 0.55, off 0.38), `PRESS_ON/OFF`
(0.5 / 0.32) for analog triggers, `DEFAULT_SETTINGS.deadzone` (0.18), `STALE_LATCH_MS`, `CAPTURE_TIMEOUT_MS`, the rumble gate ratio.
