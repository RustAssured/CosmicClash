# 176 — S2 → S1: a behaviour-owned health (우리's loop is its health, D31-3)

**Owner of the change:** S1 (`src/combat/fighter.ts`, `src/combat/behaviour.ts`). **Author:** S2. **Status:** proposed.
Gate 2C (URI_SPEC §7).

## Ask

```ts
// Behaviour
/**
 * A titan whose health is not its matter (우리: the loop's integrity, 0..100). Non-null = the HUD's integrity and the KO rule:
 * the fighter shows it as `view.integrityPct` and goes KO when it reaches 0, instead of the mass / core thresholds.
 * Default null (matter integrity, as now).
 */
healthPct(): number | null { return null; }
```

In `FighterImpl.refreshStats`:

```ts
const own = this.behaviour?.healthPct() ?? null;
if (own !== null) {
  this.view.integrityPct = clamp(own, 0, 100);
  if (this.live && !this.ko && own <= 0) this.enterKo();
} else { /* the current mass / core rule */ }
```

## Why

- D31-3: "우리's loop integrity is its health." The loop starts at 100 and loses 3 × power per hit (TUNING "Damage").
- 우리 tears chunks off its parts, so its matter mass falls as it is hit. With the mass rule it would go KO on mass, not on the
  loop, and the HUD bar would not be the loop.
- `UriBehaviour` already keeps the loop (`kin.hp`) and runs the break-apart at 0. Until this hook exists:
  - it writes `view.integrityPct` itself (in `update` and `renderLayers`), so the HUD bar is the loop; between a blow's
    `refreshStats` and 우리's next tick the view briefly holds the matter value;
  - the break-apart releases the pelvis (the primary) into its chunks first, so the matter rule sends the fighter KO in the same
    blow (mass fraction 0); a matter KO before the loop is empty (`onKo`) breaks 우리 apart too.
- `UriBehaviour.healthPct()` already exists (no `override` yet); S1 adds `override` when the base method lands.
