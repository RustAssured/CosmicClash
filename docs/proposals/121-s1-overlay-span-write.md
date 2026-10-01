# 121 — S2 → S1: `Overlay` bulk write for software pens

**Owner of the change:** S1 (`src/combat/fx/overlay.ts`). **Requested by:** S2 (tendrils / Witness arms).

## Problem

`SplinePen` (`src/combat/fx/spline.ts`) lights each covered pixel itself and then writes it through `Overlay.set()`.
`set()` re-checks bounds, writes the emissive byte and grows the dirty box for every single pixel. The current
Last One's 24 tendrils cover about 4,400 pixels per draw.

Measured with `.scratch/s2/bench.ts` (Node 22, this laptop, 400 draws, both tendril overlays):

| Raster | ms per draw |
|---|---|
| Old capsules (3 flat bands) | 0.27 |
| New spline, as it stands | 0.65 |
| New spline, outline pass removed | 0.48 |

About 0.15 µs per pixel goes into the write path rather than the lighting.

The behaviour already redraws only every other tick while the Last One is calm. In motion the spline still costs
about +0.4 ms/tick over the capsules. The Witness's arms, fibres and membranes will use the same pen in Phase 2.

## Proposed API (additive)

```ts
/** Direct access for pens that clip themselves: the layer-local pixel and emissive arrays. */
get pixels(): Uint32Array;           // === this.layer.pixels
get emissiveBuf(): Uint8Array | undefined;
/** Grow the drawn box by a layer-local rect (half-open) and mark the frame as drawn. Call once per stroke. */
markRect(x0: number, y0: number, x1: number, y1: number): void;
```

The pen already knows the layer-local index of every pixel it covers, and its bounding rect. It would write to
the two arrays directly and call `markRect` once per stroke. Nothing else changes: `begin`, `end`, the dirty
rect, `clearBox` and hiding behave as today.

## Why

This removes the per-pixel call overhead from the busiest raster in the Last One module. The expected cost is
about 0.3 ms per draw (estimate, to be confirmed after the change) without giving up per-pixel lighting. It also
keeps Phase 2's arm, fibre and membrane rendering inside the sim-tick budget.
