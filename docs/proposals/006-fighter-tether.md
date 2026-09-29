# 006 — MAX_FIGHTER_DX is too loose for a 640-px view (B1 → Builder 3 / Lead)

The camera (`src/engine/camera.ts`) now guarantees, in calm play and under a launch of 20 px/tick, that both fighters stay fully in view
(hard margin 10 px; a soft 70 px inner margin with a catch-up spring that strengthens toward the edge; velocity-predicted 0.12 s ahead).
Unit tests simulate 20 px/tick launches in three directions.

**Geometry limit.** Both fighters fit in the 640-px view with an inner margin `m` only if `dx + 2·hw + 2·m ≤ 640` (hw ≈ 90 px for the
asteroid / last one including tendrils): hard margin 10 px allows dx ≤ 440; the comfortable 70 px margin allows only dx ≤ 320.

`MAX_FIGHTER_DX = 430` sits just under the hard limit: with the tether fully stretched the camera keeps both bodies in view with ≈ 15 px to spare, and the
70 px comfort margin cannot exist (the camera then centres the union and skips the soft pull rather than fight it). `MAX_FIGHTER_DY = 190` vs view height 360 with hh ≈ 75 leaves 30 px: same story.

**Proposal.** Keep 430 as the hard tether, but have `fighter.ts` start a progressively stronger pull-back (or reduce launch impulse) from `dx ≈ 330`
(today the soft zone starts at 0.88 × max and only when moving apart), so a launched body decelerates inside the range the camera can frame comfortably.
Vertical: soft zone from `dy ≈ 140`. No contract change; Builder 3 owns the enforcement.
