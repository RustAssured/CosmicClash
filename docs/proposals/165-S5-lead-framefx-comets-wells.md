# 165 — S5 → Lead: `FrameFx.comets` and `FrameFx.wells` into the contract

**Owner of the change:** Lead (contracts). **Author:** S5 (render / stages / audio). **Status:** proposed; working today through a typed extension.

## What

Two optional fields on `FrameFx` (`src/contracts/render.ts`), today declared as `FrameFxExt` in `src/stages/types.ts` and read through a cast:

```ts
export interface CometFx {
  x: number; y: number;      // world px (the nucleus, or the warning's entry point)
  vx: number; vy: number;    // px/s
  r: number;                 // nucleus radius px (0 for a warning)
  captured?: number;         // 0 free, 1 captured / shepherded (chunk mode 1 or owner ≥ 0)
  warn?: number;             // > 0: not in play yet, warning progress 0..1 (comet-warn → comet-enter)
}
export interface WellFx { x: number; y: number; radius: number; strength: number } // world px, pull 0..1

interface FrameFx {
  // …
  comets?: readonly CometFx[]; // ≤ 4 used
  wells?: readonly WellFx[];   // ≤ 2 used
}
```

## Who fills them

- **comets:** `FxState` (`src/app/fx.ts`) already fills it. It turns `hazard` events from `src/sim/hazards.ts` into tracks:
  - `comet-warn` → a warning entry;
  - `comet-enter` → the warning is replaced by chunk `id`;
  - `comet-retire` → the track is dropped.

  Every tick it re-reads each live comet with `match.world.chunkState(id)`, so Planet gravity, Tidal Draw and a Comet Shepherd capture all show. A track whose chunk is gone is dropped. On `sample(alpha)` the positions are extrapolated by the alpha.

  No extra wiring is needed in `app.ts`. The Shearfield is switched on with `STAGE_INFO.shearfield.arena.comets = { every: [300, 420], warn: 90, speed: [170, 240], mass: 90, maxLive: 2 }`.
- **wells:** nobody yet. The owner of Tidal Draw (S3) or of the Planet's gravity would publish its well through `FxState` (or a `FighterView` field the Lead names). The renderer already bends the Shearfield's asteroid rivers and the Mausoleum's fragments toward wells.

## Why it should become contract

The renderer and the scenery read these fields every frame. As long as they live behind a cast, a rename on either side compiles silently.

## Renderer behaviour (already in place)

- **Comets.** `Renderer.packFx` packs up to 4 comets in screen space; the Shearfield `comets` layer draws them.
  - A live comet gets a tail (from its velocity) and a dotted path ahead.
  - A captured comet is tinted toward the owner's orange.
  - A warning becomes a pulsing glint pointing into the arena, pinned to the frame edge when the entry point is off screen, plus its planned dotted line.
- **Wells.** Up to 2 are packed; `warpByForces` pulls matter layers toward them.

## Checks

- **GPU verify:**
  - §10g comet: tail Δ 67, path Δ 1.84, far Δ 0.
  - New warning check: left edge Δ 7.7 with the entry point off screen, far side Δ 0.
- **Unit tests:** `src/app/fx.test.ts` "FxState arena comets" (2 tests). They cover warn → enter → follow → capture → retire, a vanished chunk, and a warning that never enters.
- **Audio:** `hazard` events play `cometWarn` (a 1.5 s riser with two glints) and `cometEnter` (an airy pass in the direction of travel over a low rumble). `comet-retire` is silent.

## Ask

1. Move `CometFx`, `WellFx` and the two fields into `src/contracts/render.ts`. S5 then drops `FrameFxExt` and the casts.
2. Name the source of wells: who publishes Tidal Draw's centre, radius and pull.
3. `src/app/fx.ts` was S5's in Phase 1. The comet tracking above was added there at the Lead's request ("render them from the matter chunk state"). Please confirm the ownership, or take it over.
