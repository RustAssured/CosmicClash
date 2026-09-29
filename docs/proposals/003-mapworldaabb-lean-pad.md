# 003 — `mapWorldAABB` under-estimates the lean padding (B1 → Lead)

**What.** `contracts/space.ts::mapWorldAABB` pads the AABB horizontally by `|lean|`. But `leanShift` is `round(lean · (anchorY − ly) / anchorY)`, so rows *below* an anchor that
sits high in the map shift by up to `|lean| · (h − 1 − anchorY) / anchorY`, which exceeds `|lean|` whenever `anchorY < (h−1)/2` (e.g. anchorY = 20 in a 128-row map, lean = 10 → 54 px).
The cell mapping itself (`localToWorld` / `worldToLocal` / hit tests) is exact; only the AABB is too small, so anything that culls or clips by this AABB (broad-phase, dirty regions,
the renderer's destination rect) can clip a sheared body. The renderer computes its own exact bound (`src/render/layerMap.ts::placeLayer`, covered by a test that draws every mapped
pixel); other users of `mapWorldAABB` should not trust `pad`.

**Proposed diff** (`src/contracts/space.ts`):
```ts
export function mapWorldAABB(t: BodyTransform, w: number, h: number) {
  const xa = t.x + (0 - t.anchorX) * t.facing;
  const xb = t.x + (w - t.anchorX) * t.facing;
  const rowSpan = Math.max(Math.abs(t.anchorY), Math.abs(t.anchorY - (h - 1)));
  const pad = Math.ceil((Math.abs(t.lean) * rowSpan) / Math.max(1, t.anchorY)) + 1;
  ...
```
