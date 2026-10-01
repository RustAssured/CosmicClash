# 112 — S1 → S5 (and Lead for one constant): what the renderer should read from the camera and the depth prototype

**Owner of the change:** S5 (`src/render`, `src/stages`). Lead, only if the depth constants move into `contracts`.
**Requested by:** S1.

## What the camera now publishes (`CameraState`, `src/engine/camera.ts`)

| Field | Range | Meaning |
|---|---|---|
| `dolly` | 0..1 | Scenery push-in. A heavy windup (Crush) eases toward 0.55 (τ 0.4 s); an Ultimate goes toward 0.9. The release or a heavy hit holds it for 8 ticks; a heavy hit also adds a punch of +0.15. Then it pulls back late (half-life 0.55 s). A feint, guard or surge out of a windup releases it about 3× faster. |
| `kickX`, `kickY` | ≤ ±10 px | The impact parallax kick at depth 1: an underdamped spring (ω 11 rad/s, ζ 0.55) shoved along a heavy blow (6 px per 1000 energy). It swings back past rest once and dies in about 0.6 s. |
| `roll` | ≤ 1.5° | Now driven by the SPIN a blow put into the target (fighter `roll` events ∝ Δω). A centre hit does not roll the view. |

Requested rendering (D27: sprites stay 1:1):
- Dolly the 3-D scenery camera toward the fight by `dolly`. For example, move the scenery camera forward by
  `dolly × k` world units, or narrow its FOV by up to about 12 %. Scale parallax layers about the view centre by
  `1 + dolly × 0.1 × (1 − parallax)`. Never scale the 2-D sprite layers.
- Offset each scenery/parallax layer by `kick × (parallax − 1)`. The near dust then moves against the blow and the far
  sky barely moves.

## Depth offset prototype (`zdepth=1`)

`FighterView.z` (px, + toward the viewer, |z| ≤ 36) is hashed and returned to the plane by a spring.

Render hints, in `src/combat/orbit.ts` until a contract home exists:
- `zScale(z) = 1 + 0.12 × clamp(z / 36, −1, 1)` is the ±12 % draw scale. Applying it to sprites is a Gate B A/B question.
  If you want it, a sharp-bilinear upscale of only that body's layer (the same filter as the sprite-push A/B).
- `zParallax(z) = 0.25 × clamp(z / 36, −1, 1)`: the extra parallax factor for that body's layers.
- Draw order: the body with the larger `z` draws in front, including its behaviour layers.
- Collision and hits are suppressed while `|Δz| > 18` (sim side, done).

**Lead, optional:** move `ZDEPTH.max/scale/collide` and `zScale` into `src/contracts/constants.ts`, so the renderer does
not import from `@/combat`. The values are listed above.
