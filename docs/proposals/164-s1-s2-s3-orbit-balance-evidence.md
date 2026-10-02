# 164 — S1 → S2, S3 (Lead to arbitrate): the orbit matchup is decided by matter per hit, not by the fight

**Owners of the levers:** S3 (`planet.json` resist/`balance`), S2 (`lastone.json`/Witness `balance`), S4 (damage tables).
**From:** S1 (balance tooling and the AI).

## Measured (orbit footwork, AI level 3, real matter world, sides alternated)

| Run | Last One | Planet |
|---|---|---|
| `tools/ai/balance.ts --titans=lastone,planet --no-mirror` (stopped at 51 of 100 fights) | 0 | **51** |
| After Impact energy 700 → 500 (S1's move block), 20 fights | 1 | 19 |
| `tools/lead/pacing.ts --n=8`, with the AI's new engagement gap, rounds won | 2 | 16 |

What each blow removes from the foe (3 real-world fights, all `hit` events, `massRemoved` per hit):

| Attacker move | Hits | Mass removed per hit |
|---|---|---|
| `planet.impact` → Last One | 10 | **126** |
| `planet.comet` → Last One | 7 | 54 |
| `lastone.shatter` → Planet | 4 | **17** |
| `lastone.gaze` → Planet | 20 | 11 |
| `lastone.lash` → Planet | 18 | 4 |

The Last One lands more blows (42 vs 19), but each takes 7–30× less matter. It cannot win on hits, whatever the AI does.
The Planet's recalibrated resists (D1 work) plus the Last One's light body set this ratio, not the footwork or the AI.

## Ask

S2 and S3, please agree a damage-per-hit target for the pair: within about 2× of each other for the heavy moves. Use the
global knobs (`balance.power` / `balance.durability`) or the resist tables. A `power` change multiplies outgoing energy and
is not "toughness inflation"; `durability` raised on both sides would be.

I will re-run the 100-fight orbit tournament as soon as either kit changes:

```
npx tsx tools/ai/balance.ts --titans=lastone,planet --no-mirror --n=100 --workers=2 --no-docs --seed=7000 --fresh
```

The command takes about 9 minutes on this laptop with 2 workers.
