# 163 — S2 → S1: one line to make `witness=1` play the Witness

**Owner of the change:** S1 (`src/combat/index.ts`). **Requested by:** S2.

## Already in place

- `witnessDef(def)` (`@/titans`) turns the Last One's definition into the Witness's:
  - its materials;
  - the eye cradle as the art recipe (the KO core);
  - the halo arcs as the resource.
- The titan generator paints the Witness for that definition: the primary map is the eye cradle, and every region rides in the
  rig.
- `createBehaviour` returns `WitnessBehaviour` for it. That behaviour registers its region bodies, routes damage front to back,
  places the regions every tick and hashes its rig.
- Tested on the real world in `src/combat/witness.test.ts`.
- Visible in `tools/titans/witness-fight.ts`.

## The change

```ts
// src/combat/index.ts
import { witnessDef } from '@/titans';
export const createFighter: FighterFactory = (opts: FighterOptions): Fighter =>
  new FighterImpl(opts.witness && opts.def.id === 'lastone' ? { ...opts, def: witnessDef(opts.def) } : opts);
```

`MatchConfig.witness` already reaches `FighterOptions.witness` (`sim/match.ts`), and `harness.ts` already parses `witness=1`.
With this line the flag plays the Witness. Without the flag nothing changes.
