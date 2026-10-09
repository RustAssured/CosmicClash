# 178 — S6 → Lead: update `e2e/ui-audio.spec.ts` for the D34 sound (cataclysm pass)

**Owner of the change:** Lead (e2e is outside S6's paths). **Why:** D34 ("drop high-pitched sounds and whistles in favour of huge,
dramatic impacts") removes the very brightness a few assertions were written to protect. Per SLICE_COMMON, an assertion that
encodes behaviour the brief now forbids is updated, and said so.

## Assertions that encode the old (glass / whistle) design

1. **Line 78** `glassCentroid > 1.5 × rockCentroid` (a FRACTURE hit on the Witness vs a KINETIC hit on the Asteroid, shared
   layers included). The Witness is no longer glass (587–1480 Hz bells, 2–7 kHz shards); it is sacred ceramic and bronze, and both
   hits now share a heavy, low three-layer impact. Measured: 603 Hz vs 583 Hz. The Witness's OWN body voice is still the
   brightest material (`character.bodyCentroidHz`: Witness 1054 Hz, next Supernova 989, Asteroid 695).
   Proposed:
   ```ts
   // the Witness's ceramic body is still the brightest material, on its own voice (shared impact layers excluded)
   for (const c of t.character.filter((x) => x.titan !== 'lastone'))
     expect(by.lastone!.bodyCentroidHz, `ceramic brighter than ${c.titan}`).toBeGreaterThan(c.bodyCentroidHz);
   ```
2. **Lines 100–106** material order `glass > chain > plasma > rock > planet`. Chains are now colossal low rings (Nexus body
   366 Hz). Replace with item 1's assertion plus the D34 guard below.
3. **Line 111** message "Hawking glitter": the measure still passes (+16.4 dB in 3–12 kHz when nearly out of mass), but the sound
   is now a dark crackle; rename the message only.

## Still failing after this pass (S6 follow-ups, not threshold changes)

- **Line 112** Nexus pulse `high > 1.8 × low`: 4.6 vs 2.9 beats/s (×1.58). The colossal-chain bed counts extra peaks at low graph.
- **Line 167** Nursery `hotRms − calmRms < 4`: 4.4 dB (the laptop voicing's +7 dB at 500 Hz lifts the taiko and shaker layers
  more than the drone).
- **Line 78** see item 1 above: 610 vs 617 Hz on the full-hit measure.

## New guard worth adding (the D34 regression test in a real browser)

```ts
// D34: no whistles. Every titan event alone keeps < 5 % of its power above 2 kHz (was up to 99 %: hiss, glitter, Doppler).
```
needs a `hiShare` per event in `EventMetric` (S6 can add it to `dev/ui/audio-render.ts` on request). The unit-level guard already
exists: `src/audio/engine.test.ts` "no fight sound is a whistle" (no oscillator above 1.6 kHz in any titan's or shared voice).

## Not caused by D34 (pre-existing, for the record)

- **Lines 56–57** menu sounds `> −26 dB`: `ui tick` −32, `ui move` −31 … The UI's absolute level is unchanged by this pass (the
  calibration came down 3 dB, `UI_LEVEL_DB` went up 3 dB to match).
- **Lines 124–125** five stages / `minPairDistance > 0.8`: the stage list now has seven (mausoleum, shearfield); min distance 0.79.
