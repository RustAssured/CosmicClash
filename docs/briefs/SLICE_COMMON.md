# Slice Phase 1: common rules for every specialist

You are one of five specialists working on the EXISTING game ADEUK: TITANS, in a **shared working tree**. The Lead integrates your work, commits it, captures real-time footage, and runs the gates. Read these first:
- `docs/SLICE_PLAN.md` (the plan WJ approved)
- `docs/DECISIONS.md` D23–D27 (Gate A outcomes)
- `docs/gates/GATE_A.md` §3 (baseline numbers)

## Axioms (non-negotiable, priority order when trading off)

1. The body is the state. Damage survives the animation that caused it.
2. The wound is the star. Effects peak, then clear, and the new shape must be readable.
3. Input is immediate. Physical consequence is enormous. Never fake mass with sluggish controls.
4. The Last One/Witness never merely animates; it redistributes load.
5. The Planet has no face and no limbs; it weaponises orbit, rotation, gravity, moons and geology.
6. The arena is occupied space.
7. Fewer, heavier, more meaningful impacts beat hit density.

Priorities:
1. destruction readability and persistence
2. mass, inertia, torque, control feel
3. whole-body motion
4. titan identity
5. impact feel
6. arena presence
7. damage-driven gameplay
8. audio
9. polish
10. content

## Machine limits (WJ's laptop: Ryzen 5 5500U, iGPU, ~6 GB RAM, Windows, PowerShell)

- **Never run the full test suite**, a dev server, or a headed/real-time browser. The Lead does those. Run only the tests for your own files: `npx vitest run <paths>`. `npx tsc --noEmit` is fine. Headless node tools are fine with small sizes (e.g. `npx tsx tools/lead/pacing.ts --n=6`).
- Five specialists share the tree. `tsc` may show transient errors in files you do not own. Ignore those, and mention them in your report if they persist.
- Do not commit (the Lead commits). Do not touch git state.

## Ownership

Strict. You may edit only the paths listed in your brief.

- For a change elsewhere, write `docs/proposals/1NN-<owner>-<title>.md` (problem, exact proposed diff or API, why), keep working around it, and list it in your report.
- Contracts (`src/contracts`) belong to the Lead.

## Contracts already published for Phase 1

All of these compile with neutral defaults:
- `SimEvent` `feel` (accept / respond / settle, with a pixel `channel`).
- `flash` with `x,y`. Flashes are local lights, never full-screen washes.
- `FighterView.angle / spin / z / orbit`. These are hashed.
- `Fighter.resolvePair?` (symmetric contact; called on slot 0 only, after both fighters tick and before `world.tick()`).
- `DamageEvent.hitstop`.
- `CameraState.dolly / kickX / kickY`.
- `LightFx.kind` ('body' | 'impact').
- `MatchConfig.footwork` ('classic' | 'orbit') and `zdepth`, also on `FighterOptions`.
- `SLICE`.

URL flags: `orbit=1`, `zdepth=1`, `tele=1`, `full=1`.

## Quality bar

- **Determinism.** Fixed tick, seeded RNG, no `Math.random` or wall clock in sim modules. Every new sim state is hashed. Existing determinism tests stay green.
- **Purity boundary.** `src/matter`, `src/titans`, `src/combat`, `src/ai`, `src/sim` and `src/contracts` stay pure TypeScript (no DOM or three).
- **Tests.** New systems get tests. Existing tests you break in your area: fix them honestly. If an assertion encoded the old behaviour that the brief now forbids, update it and say so in your report.
- **No placeholders**, TODOs, stub art, or console errors/warnings.
- **Clean code.** Prettier- and ESLint-clean on your files: `npx prettier --write <files>`, then `npx eslint <files>`.
- **Measurements.** Every claim of "better" in your report cites a number from a test, `tools/lead/pacing.ts`, or a headless tool you wrote. The Lead will verify it in real-time footage.

## Report (your final message, ≤ 1000 words)

Include:
- files changed and created;
- what now behaves differently, with numbers;
- tests added and changed;
- proposals filed;
- known gaps;
- what the Lead should look at in footage, given as scenario + seconds, or move + frame.
