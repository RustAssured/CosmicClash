# 500 — npm script for the balance autotune (B3 to Lead)

`package.json` is not mine to edit. Please add, next to `"balance"`:

```json
"autotune": "tsx tools/ai/autotune.ts"
```

Until then it runs as `npx tsx tools/ai/autotune.ts [--n=24] [--iters=12] [--titans=...] [--dry]` (see the header of the file).
