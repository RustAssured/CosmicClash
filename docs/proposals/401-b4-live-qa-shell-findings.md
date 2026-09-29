# 401 · B4 live-QA findings for the app shell (`src/app`, Lead-owned)

Found while driving the built game (`vite build --outDir .scratch/b4dist`, `?q=0`, software GL at ~1 frame a second, a loaded
machine) by keyboard. UI-side fixes are already in `src/ui`; these need a shell change or a decision.

## 1. `?mode=fight|training&p1=human` never assigns a device, so the fighter cannot be controlled

`src/app/app.ts` `bindSources` wraps `this.input.source(slot)`, but the input manager only assigns devices to slots when a pad
is plugged in or when the Assign screen has run (`input.assign(slot, 'kb:kb1')`). A harness boot skips the Assign screen, so
`/?mode=training&p1=human` shows a fighter that ignores every key and every pad button (measured: Escape and Tab had no effect;
the tick counter advanced, the pause never opened). The cause is inferred from reading the code (no assigned device), not yet
confirmed by a fix.

**Expected:** a human slot with no assigned device falls back to the keyboard. **Suggested (2 lines in `installHarness` or
`App` start-up):** when a match starts with `controller: 'human'` in slot 0 or 1 and `input.assignment()[slot] === null`, call
`input.assign(0, 'kb:kb1')` / `input.assign(1, 'kb:kb2')`. Device ids are the layout `profileKey`s in `src/input/keyboard.ts`.
Everything else about human play by URL (pause, training toggle, scripted opponents) then works.

## 2. `announcerText` (`src/app/announcer.ts`) is now superseded by the UI

The UI derives its call-outs from the phase (`src/ui/hud.ts` `announcement`) because the shell's strings lose information:
`FIGHT` has no `!`, `roundend` shows only `승리!` after 30 ticks (no winner, and a round the rival won looked like a DRAW because
`MatchApi.winner` is only the MATCH winner), `FINAL ROUND` is never shown. The UI ignores the shell's standard words
(`ROUND`, `FIGHT`, `K.O.`, `TIME`, `승리!`, `FINAL ROUND`) and still shows any other `HudState.announcer` string verbatim. You can
leave `announcerText` as is, or return `null` and let the UI speak; both work.

## 3. `onMatchEnd` (`app.ts` ~line 331) calls `ui.showResults` on tick 1 of `matchend`

That covered the winner's call-out with the results screen at once. `showResults` now holds the switch for 110 sim ticks while
the HUD state says `matchend` (so the "… WINS" call-out is seen over the fight), then shows the results. No shell change needed;
noted so nobody "fixes" the delay away. If you change `ROUND_INTRO_TICKS`-style constants, the UI constant is
`RESULTS_DELAY_TICKS` in `src/ui/ui.ts`.

## 4. Keyboard-only path to a live match (for `e2e/game.spec.ts`)

Nine presses, and each must be followed by a wait for at least one rendered frame (menus act once per frame; a key tapped
between frames is latched, but two presses inside one frame count as one, which is why a fixed sleep stalls when the machine
is loaded):

`Space` (boot → title) · `ArrowDown` (VERSUS → VS AI) · `Space` (→ difficulty) · `Space` (→ assign) · `Space` (join P1) ·
`Space` (continue → titans) · `Space` (lock the Last One) · `Space` (lock the rival; the screen advances after a short beat)
· `Space` (stage → match).

Since the first launch now opens HOW TO PLAY over the title, either seed storage before the page loads
(`page.addInitScript(() => localStorage.setItem('adeuk.ui.v1', '{"seenHowTo":true}'))`) or add one `KeyK` (Back = skip the
pages) after the first `Space`. `e2e/ui-live.spec.ts` is a working example of the wait-for-frames helper.
