# 152 — S5 → Lead: app, telemetry and contract wiring for D5 (flashes) and D6 (audio)

**Owner of the change:** Lead (`src/app/app.ts`, `src/telemetry`, `src/contracts`, `e2e/`).
**Requested by:** S5 (Phase 1). None of these block S5's work: until they land, everything runs at its defaults
(comfort 100 %, the D5 limits hold there).

## 1. Comfort reaches the renderer (`app.ts`, next to `fx.flashScale`, ≈ line 524)

```ts
case 'setAccessibility':
  this.fx.flashScale = Math.min(1, Math.max(0, a.flash));
  this.renderer.setComfort(this.fx.flashScale);   // NEW: tinted impulse glow, bloom gain, governor cap
```

`DebuggableRenderer.setComfort(flash)` scales the effects the renderer owns:
- the tinted impulse glow (×comfort);
- bloom gain (0.6 + 0.4·comfort);
- the luminance-governor cap (0.12 × (0.5 + 0.5·comfort)).

FxState already scales impact lights (0.3 + 0.7·comfort) and wound refraction (×comfort).

## 2. Telemetry: drop the canvas luminance read-back (D24: ≈ −12 fps)

The renderer now measures the frame's mean relative luminance on the GPU, using the governor's own reduction, and reads it
back asynchronously:
- a ring of 6 pixel-pack buffers and fences;
- collected ≥ 3 frames later at the start of `draw()`;
- no stall, and no console warnings in Edge/D3D11;
- measured collect cost ≤ 1.2–4 ms worst case, decaying max, in the headless verify. Note that this includes the page's own
  synchronous captures; the real-time cost is for your footage run.

```ts
// per frame, or every few frames:
for (const s of renderer.drainLuma()) lum.push({ tick: s.tick, frame: s.frame, L: s.mean });
// also: renderer.stats.luma (newest), s.raw (before the governor), s.gain, s.avg (its 300 ms average)
```

Differences from the canvas snapshot:
- `mean` excludes the UI layer. That is better for flash metrics: the HUD is static.
- It is Rec. 709 relative luminance on linearised sRGB, exactly what `telemetry.ts::frameLuminance` computes.
- One sample per drawn frame, 3–5 frames late (keyed by `frame` / `tick`).
- Samples are skipped (`debugLumaReadback().skipped`) only if 6 are in flight, i.e. the page never yields to the event loop.

## 3. Audio taps (`AudioEngineExt.taps()`)

- `output` is unchanged: the last node before the speakers.
- **`music` is now the whole BED bus after its duck**: titan beds + score + the bed's reverb. That is the bed an impact must
  rise above, so telemetry's `impactOverBed*` and `duck*` now measure what the brief means (Gate A measured against the score
  only).
- `sfx` is the impact bus.

New: `limiterReductionDb()` (diagnostics).

## 4. `push=1` URL flag

The renderer reads `push=1` from `location.search` itself (`RenderInitOptions.spritePush` overrides). Optional:
- add `push` to `HarnessParams`;
- pass `spritePush: harness.push` in `app.ts` `renderer.init`, so the flag is documented in one place.

## 5. Contract notes (doc-only now; additive later)

- `FrameFx.flash` no longer whitens anything. FxState fills it with the newest impact light's envelope (informational).
- `FrameFx.aberration` is now the LOCAL wound-refraction strength. The renderer applies it around the impact lights, shared out
  by their intensity. Please update the two doc comments in `contracts/render.ts`.
- Proposed additive field to make that explicit: `LightFx.refract?: number` (0..1 per impact light). The renderer will prefer
  it when present.
- Impact lights use `slot: -1`, `kind: 'impact'`.

## 6. e2e

- `e2e/render.spec.ts` (runs `dev/render/verify`):
  - the old "flash brightens the frame" check is now inverted ("flash never washes the frame");
  - new D5 checks: KO locality, governor, scripted fight;
  - new: sprite-push A/B, dolly/kick, rotation-spike parity and cost;
  - `?only=d5` runs just those.
- `e2e/ui-audio.spec.ts` assertions affected by the D6 re-stage are listed in S5's Phase 1 report. Please also add the
  round check: `npx tsx tools/ui/audio-verify.ts --round` exits 1 if a D6 target is missed.
