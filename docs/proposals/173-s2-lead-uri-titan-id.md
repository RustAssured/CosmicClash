# 173 — S2 → Lead (cc S1): 우리 in the contracts (additive)

**Owner of the change:** Lead (`src/contracts`). **Author:** S2. **Status:** proposed. Phase 2A (D31, D32).

## Ask

Two additive lines in `src/contracts/titan.ts`:

```ts
export const TITAN_IDS = ['lastone', 'nexus', 'blackhole', 'supernova', 'planet', 'asteroid', 'uri'] as const;
export type ResourceId = 'tendrils' | 'nodes' | 'accreted' | 'fuel' | 'moons' | 'fragments' | 'loop';
```

- `'uri'` is 우리's titan id.
- `'loop'` is 우리's resource: loop integrity, 100, shown as a bar. It is its health (URI_SPEC §7, D31 (3)); 2C wires it to the
  fighter view.

## Why it is safe

- **Not in the roster.** 우리 is not added to `IMPLEMENTED_TITANS` or `TITAN_DEFS` (D31 (7): it joins after its final gate). Its
  definition is built in code (`src/titans/uri/def.ts`, `uriDef()`), like the Witness's. `titans.test.ts` (every id in
  `TITAN_DEFS` exactly when implemented) stays green.
- **Harness:** `parseHarnessParams` accepts any id in `TITAN_IDS`, so `a=uri` would reach `getTitanDef('uri')`, which throws
  for unimplemented titans. Nothing selects it until 2D (S1: input mapping, roster entry).
- Until this lands, `src/titans/uri/def.ts` casts the id and the resource id in one place each (`URI_ID`, `'loop' as
  ResourceId`). After it lands the casts are no-ops and can be dropped.

## Also for S1, no change needed now: never mirroring

우리 must never be mirrored (URI_SPEC §5). The fighter writes `transform.facing = this.facing` every tick. `UriBehaviour`
rewrites the primary's transform in `placeRegions` (facing +1, lean 0, its rig angle) right after the fighter, before hits and
before drawing, and draws every layer with facing +1. That covers drawing and hit truth today without touching `fighter.ts`.

A cleaner hook for later (2D, S1's call): `Behaviour.mirrors(): boolean` (default true). The fighter would then write
`t.facing = this.behaviour.mirrors() ? this.facing : 1` and skip its lean shear for a non-mirroring titan.
