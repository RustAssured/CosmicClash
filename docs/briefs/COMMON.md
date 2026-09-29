# Builder common brief — read this first, then your own brief

You are one of four builders on **ADEUK: TITANS** (working title), a browser game where colossal cosmic entities fight and
**physically wear each other down** — the destruction of pixel matter *is* the health system. A Lead agent directs, owns the
contracts and integrates. Work in `/home/user/CosmicClash` (a git repo, branch `claude/charming-franklin-b4ddfk`).

## Read before writing code (in this order)
1. `docs/DESIGN.md` — the design bible (architecture, tick order, coordinates, feel targets, roster).
2. `docs/DECISIONS.md` — settled decisions. Don't re-litigate them.
3. `src/contracts/*.ts` — **the typed contracts. They are law.** Import from `@/contracts`. `constants.ts`, `space.ts`, `matter.ts`,
   `damage.ts`, `sim.ts`, `render.ts`, `titan.ts`, `input.ts`, `audio.ts`, `ai.ts`, `ui.ts`, `harness.ts`, `validate.ts`.
4. Your own brief in `docs/briefs/`.

## Ownership & boundaries
- You may create/edit files **only inside the directories your brief lists**. Never edit `src/contracts`, `docs/DESIGN.md`, `package.json`,
  configs, or another builder's directory. If you need a contract change, a new dependency or a change elsewhere, write
  `docs/proposals/NNN-<short-title>.md` (what, why, exact proposed diff) and **carry on with a local adapter** — the Lead applies proposals between rounds.
  You may add *new types* inside your own modules freely.
- Other builders work **in the same working tree at the same time**. Their files may be half-written. So:
  - **Do NOT run `git commit`, `git add`, `git stash`, `git checkout`, `git reset`** or anything that touches git state. The Lead commits.
  - Do NOT run `prettier --write .` or `eslint --fix .` on the whole repo: format/lint **only your own paths** (`npx prettier --write src/<yours> dev/<yours> tools/<yours>`).
  - `npx tsc --noEmit` checks the whole project; other people's in-progress errors may appear. Filter to yours: `npx tsc --noEmit 2>&1 | grep -E '^(src/<yours>|dev/<yours>|tools/<yours>)'`.
  - `npx vitest run src/<yours>` runs only your tests.
  - Use your own dev-server port (B1 5201 · B2 5202 · B3 5203 · B4 5204): `npx vite --port 52xx --strictPort`.
- Purity boundary (DESIGN §1): `src/matter`, `src/titans`, `src/combat`, `src/ai`, `src/sim`, `src/contracts` are pure TS — **no DOM, no `three`,
  no `window`/`document`/`performance`, no `Math.random`** — they must run in Node. Determinism is a hard requirement there.
- Dependencies available: `three`, `pngjs` (dev), `vitest`, `@playwright/test`, `tsx`. Nothing else. No network at runtime, no external assets, no CDN,
  no web fonts: **everything is procedural or inlined**. (The sandbox proxy blocks most outbound hosts anyway.)

## Definition of done for anything you hand back
- `npx tsc --noEmit` clean **for your paths**, `npx eslint <your paths>` clean, `npx vitest run <your paths>` green, `npx prettier --check <your paths>` clean.
- No `TODO`/`FIXME`/placeholder art/stub functions/`console.log` left in shipped code (`console.warn/error` only for real problems). No console errors when run.
- Tests for real behaviour (not just "it doesn't throw"): determinism where relevant, invariants (mass conservation), boundary cases, contract conformance.
- Zero allocation in per-tick/per-frame hot paths (preallocate, pool, reuse typed arrays). Measure; don't guess.
- **Look at your work.** For anything visual, render it to PNG and *read the PNG* with the Read tool (it displays images). Iterate until it looks
  beautiful, not merely "working". Helpers: `tools/lead/png.ts` (`writePng`, `writeContactSheet` — nearest-neighbour upscale, run with `npx tsx`),
  `tools/lead/shot.mjs` (Playwright screenshot of a URL with software WebGL2; run `node tools/lead/shot.mjs http://localhost:52xx/dev/<x>/ .scratch/x.png --wait=2000`).
  Put scratch images in `.scratch/` (gitignored). Curated keepers go in `docs/gallery/`.
- Document your module in `src/<module>/README.md` (public API, invariants, tuning knobs, how to test). Keep it accurate.

## Quality bar (the whole game is judged on this)
- **Pixel art, not primitives.** No plain circles/rectangles/lines as final art. Sculpted structures, fine detail, hue-shifted ramps
  (`hueShiftRamp` in contracts/color.ts), dithering, selective outlines, rim light, emissive glints, secondary motion. It must look like the work of a
  careful pixel artist with a procedural toolkit — beautiful first, correct second.
- **Weight without sluggishness.** Big slow-landing moves, but input is immediate (≤1 frame to first visible response) and the player is never stuck.
- **Determinism** in sim modules: same seed + same calls ⇒ identical state hash.
- **Performance budgets**: sim ≤ 5 ms/tick (two full bodies + debris); render ≤ 16 ms/frame on a mid-range laptop.
- Prefer clarity and small, well-named functions outside of hot loops; inside hot loops prefer flat typed-array code. Comments explain *why*.

## Report format (your final message back to the Lead)
1. **Delivered** — files/modules and the public API (signatures), mapped to the contracts.
2. **Verified** — commands run and results (test counts, perf numbers, screenshot paths you looked at and what you saw).
3. **Deviations / proposals** — anything you couldn't do to spec; proposals written (`docs/proposals/…`).
4. **Known issues & next tasks** — honest list, ranked by player impact.
Be candid. Do not claim something works unless you ran it.
