# Signature animations

Every titan should have one striking motion that says what it is. A signature animation moves the titan's **drawing**, not
its matter. The body map, the sim, hit-testing and damage stay exactly where they are, deterministic and netplay safe. The
renderer draws the body layer through one generic pass that warps **where each screen pixel samples the live body map**.
Because it samples the live map, a hole punched in the body travels with the animation.

The Black Hole is the first titan to use it (its accretion disk orbits). Its code is the worked example:
`src/combat/behaviours/blackhole.ts` (`buildSignature`, `renderLayers`).

## How it works

- `src/render/signature.ts` holds the plain data: `SignatureFx`, the cell roles `SIG_ROLE` and the switch `SIGNATURE`.
  There is no GL in it, so a behaviour can import it.
- `src/render/signaturePass.ts` holds the shader and its slots. The layer compositor (`compositor.ts`) draws any plain world
  layer with a `signature` through it, using the same placement (facing, lean, anchor), outputs and blending as a normal
  layer. The unified look (outline, seams, palette snap) treats it like any other body.
- No compositor edit is needed for a new titan. The hard-coded passes (`UriLivePass`, `MouthPass`) stay as they are, but new
  titans should use this pass instead.

Each body-map cell has a **role** (one byte per cell):

| role | what the pass does with the cell |
| --- | --- |
| `still` | Draws it where it is (limbs, jets, anything that is not the motion). |
| `flow` | Re-samples it through the motion: rigid spin, differential twist, radial pulse, Doppler relight and co-moving brightness arms. Mark the whole region the flow occupies as `flow`, empty cells included, so its ragged edge travels with it. |
| `occluder` | Draws it where it is: a horizon, a core. The part of the flow behind it is hidden; a `flow` cell over it (the near side) passes in front of it. |
| `lensed` | An image of the flow's far side, bent round the occluder. Its own cells stream round the centre, each half wrapping on itself. |

The motion parameters (all in body-map cells and radians) are listed below. The full comments are in `signature.ts`.

- **Plane:** `cx, cy, tilt, squash, rIn, rOut` describe the tilted, squashed disc the flow lives in. Use `squash = 1` and
  `tilt = 0` for a face-on circle.
- **Spin:** `spin` is an angle, not a rate. Accumulate it from snapshotted ticks so the titan can speed up without a jump.
- **Twist:** `shearRate, shearK, shearPeriod` make the inner flow turn faster. It is drawn as two bounded twists dissolved
  into each other, so the texture never winds up.
- **Pulse:** `pulseAmp, pulseRate, pulseWave` make it breathe (wave 0) or send rings outward (wave > 0).
- **Doppler:** `doppler, dopplerX, dopplerY` keep the painted beaming fixed on screen while the matter moves through it. Set
  them to undo the brightness gradient your painter baked in.
- **Arms:** `streak, streakArms, streakWind` add bright spiral arms in the matter's own angle. They ride the gas, and they
  are what makes a fine painted texture read as motion.
- **Occluder and lensing:** `hole, lensRing, lensSpin, lensGain`.

## Opting a titan in

1. In `attach`, build the signature once with `makeSignature(map.w, map.h)`. Fill `roles` from the painter's own geometry
   (repeat its tests, as `buildSignature` does) and set the fixed parameters.
2. Override `decorateBodyLayer(layer)` and add `(layer as RenderLayerSig).signature = this.sig`.
3. In `renderLayers(view, alpha, out)`, write the moving fields (`t`, `spin`, and anything the titan modulates) from state
   the tick snapshotted (`drawTick + alpha`, ticks held, mass). Never use the wall clock, and never write sim state there
   (S19: `src/combat/renderpure.test.ts`).
4. If the titan has a CPU overlay that faked the motion, gate it on `SIGNATURE.on` and keep it as the fallback. The Black
   Hole kept its photon-ring glow, jets and motes, added escaping photons and jet streaks, and dropped the brightness wave.
5. Capture it with `npx tsx tools/titans/signature.ts <id>` (`--sig=0` for the before; `--mode=aivai --t0=1500` for a
   damaged body; `--perf=1` for the interleaved on/off GPU timing) and look at every frame.

Current limits:

- Only plain body layers are supported. A rig body (`parts`, the 우리 pelvis) is not warped yet.
- Up to four signed layers per frame (`SignaturePass.MAX`).
- A drawn pixel may sit where the matter is not, and the reverse (that is the agreed trade). Hits land on the matter, so keep
  the motion inside the body's own silhouette. A rotating flow does this; a large pulse would not.

## Quality tiers and cost

- Tier 0 draws the rigid spin only: one fetch, no mirror or angle-search fallbacks, no ring snap, no lensed images.
- Tiers 1 and 2 draw everything.
- The pass runs at the logical resolution over the body's rectangle, so its cost does not grow with the display.
- On the target (Ryzen 5 5500U, Vega 7, headless Edge), measured A/B interleaved in one page on the Black Hole at rest:
  - Tier 1: about +0.1 ms GPU (p50 3.08 ms on against 2.97 ms off).
  - Tier 0: no measurable difference.
- Sequential runs drifted by 2–3 ms between runs because of other GPU load on the machine, so only trust interleaved numbers.

## The next titans

**The approved living-idle prototypes come first.** WJ approved an idle prototype for each of the nine roster titans
(the idle handover package). Those designs set the look, and the package's art rule forbids warp and displacement. The
pass re-samples whole pixels with no filtering, but it is still a displacement. So use it for a roster titan only where
WJ explicitly says so; there is no DECISIONS entry for it yet.

That rules out the obvious defaults for two roster titans:

- **Supernova:** its approved idle swells on the beat and never scales, so a pulse warp is wrong for it.
- **The Cradle:** its approved claw frames replace the sail warp. Its disc is also a rig region, which the pass cannot
  draw.

For a new titan without an approved prototype, use these as starting points:

- **The Remainder (rotating, pulsing wormhole core):**
  - Make the throat `occluder` and the core annulus `flow` with `squash` around 0.85.
  - Use a fast `spin`, a strong `shearRate` (the throat swallows light faster than the rim), and a slow breathing
    `pulseAmp`.
  - Paint a ring of `lensed` cells around the throat, with a negative `lensSpin` so the far side streams against the near
    side.
