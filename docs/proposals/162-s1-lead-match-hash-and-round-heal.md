# 162 — S1 → Lead: fold fighter state into `match.hash()`; the round heal sets round 2–3 length

**Owner of the change:** Lead (`src/sim/match.ts`, `src/contracts/sim.ts`). **Requested by:** S1.

## 1. Rig state in the determinism hash (for the Witness, proposal 160)

The Witness's XPBD rig is simulation state that no `FighterView` field carries. S1 added `Behaviour.hash(h)` and
`FighterImpl.stateHash(h)`. Proposed:

```ts
// contracts/sim.ts, Fighter (optional, additive)
/** Fold sim state the view does not carry (a behaviour's rig) into the determinism hash. */
stateHash?(h: number): number;

// sim/match.ts, hash(): inside the per-fighter loop, after the view fields
if (f.stateHash) h = f.stateHash(h);
```

It is a no-op for every titan except the one whose behaviour overrides `hash`.

## 2. Round length is set by the round heal, not by the fighting

`ROUND_HEAL_FRACTION = 0.6` (`match.ts`). The loser of a round starts the next one with 40 % of its missing matter still
missing. In orbit, with the new AI pacing (an engagement gap of about 8 s per AI), `tools/lead/pacing.ts --n=6`
(lastone v planet, L3, `.scratch/feel/pace-gap480.json`) gives:

| Round | Length | Contacts | Contacts per minute |
|---|---|---|---|
| 1 | 30–56 s (4 of 6 in 45–90 s) | 5–10 | ≈ 9–10 |
| 2 and 3 | 13–20 s (none in range) | **2–3** | — |

The round-2/3 fighter dies in two contacts: the round is over before pacing can matter. Making fighters tougher is ruled out
("no toughness inflation"), and the AI cannot fix this. Options for the Lead/WJ:

- `ROUND_HEAL_FRACTION` 0.6 → **0.85**. Scars stay visible, but the second round is a fight. My estimate: round 2/3 length
  becomes about 35–50 s.
- Or full heal plus cosmetic scars only (the matter look stays, the integrity resets).

Either change is a design call on the meaning of scars (D-log), not a tuning knob I own. I will re-run pacing once you choose.
