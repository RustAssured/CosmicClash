# 111 — S1 → Lead: pass `footwork` / `zdepth` through pacing, duel/balance and the app's AI

**Owner of the change:** Lead (`tools/lead/pacing.ts`, `src/app/app.ts`), plus `tools/ai/duel.ts` / `balance.ts` if you want
tournaments in orbit mode. **Requested by:** S1.

## Problem

`footwork: 'orbit'` and `zdepth` exist on `MatchConfig`, and the fighters honour them. Two things are missing:

- `tools/lead/pacing.ts` cannot run the orbit mode headless.
- The AI does not know the mode. It does latch orbit footwork by itself the first time its OWN view reports an orbital
  state, which happens within the first few ticks of movement. Telling it up front avoids those few classic-style ticks.

## Proposed diff

`tools/lead/pacing.ts`:

```ts
const ORBIT = args.includes('--orbit');
const ZDEPTH = args.includes('--zdepth');
// in the MatchConfig
footwork: ORBIT ? 'orbit' : 'classic',
zdepth: ZDEPTH,
// when building the AIs
createAI(level, def, seed, { footwork: ORBIT ? 'orbit' : 'classic' })
```

`src/app/app.ts` `bindSources` (and `setDummy`):

```ts
createAI(level, defs[slot], s.config.seed * 7 + slot, { footwork: s.config.footwork ?? 'classic' })
```

`tools/ai/duel.ts` `playMatch`: the same two fields, behind a `--orbit` flag.

`createAI(level, def, seed, opts?)` already takes the optional `opts` (S1, `src/ai/index.ts`), so nothing else changes.

## Why

The Gate B decision on orbital footwork needs headless pacing and win-rate numbers in that mode, alongside the footage.
