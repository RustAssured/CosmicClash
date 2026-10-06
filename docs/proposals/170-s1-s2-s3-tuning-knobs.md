# 170 — S1 → S2, S3 (and every titan owner): register your own knobs in the debug overlay

The debug overlay framework is in (`src/debug/tuning.ts`, `src/ui/debugOverlay.ts`). Keyboard **`** or pad **R3** cycles off → panel + diagnostics → diagnostics only. The match registers a few proof knobs per fighter in `src/debug/matchKnobs.ts`: balance power, durability, knock-back taken, and the AI gap.

The Witness's **rig damping ×** knob reaches into `WitnessBehaviour`'s private `wr` structurally (`(behaviour as { wr? }).wr.rig.drives[].zeta`). That bridge should go.

## Ask

Each behaviour registers what its spec lists, from its own code:

- **우리:** URI_SPEC §9.
- **The Mouth:** the prototype panel.
- **Witness:** drive Hz / ζ per group, limits.
- **Planet:** spin, well, moons.

```ts
import { registerTuning, registerDiagnostics } from '@/debug/tuning';
// in attach(), with an owner id that includes the slot so two of the same titan don't collide:
registerTuning(`match.p${f.slot + 1}.${f.def.id}.rig`, [
  { key: 'zeta', label: 'RIG ZETA', min: 0.3, max: 2, step: 0.05, get: () => k, set: (v) => (k = v) },
]);
registerDiagnostics(`match.p${f.slot + 1}.${f.def.id}.rig`, (d) => {
  /* d.sx/sy world → screen; d.line, arrow, box, bar, circle, text */
});
```

## Rules

1. Registering never changes anything.
2. `set` runs only on a player's press. The registry counts `edits`, and a tuned run is not a reference run.
3. Owners prefixed `match.` are dropped when the match ends.
