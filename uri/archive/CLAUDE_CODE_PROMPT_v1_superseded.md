# Prompt: add 우리 (URI) as a playable titan

You are adding a new titan, 우리 (URI), to the existing ADEUK: TITANS project. Read `docs/URI_SPEC.md` first, then look at everything in `docs/concept/uri/` (open the HTML demos in a browser; `uri-puppet-demo.html` is the working reference for the rig, the springs and the damage).

The art is already baked: `assets/uri/` contains every part sprite, its glow layer, its position map, its part map, `manifest.json`, `palette.json` and `view.json`. The baking tools are in `tools/uri-bake/` — use them only if a part must be re-baked (e.g. extra limb orientations); do not redraw the art.

Work in phases, and stop at each gate for WJ to play the build and answer.

**Phase 1 — puppet in the game.** Implement the normal-mapped version (`URI_SPEC.md` §2b; reference `uri-normalmapped-demo.html`): load each part's G-buffer, assemble 우리 from the manifest anchors into screen-space layers, and light it in a fragment shader with the material ramps, rotated normals and the coloured point lights. Add the 3D coils, the shadow-side outline pass and the bloom. Port the spring rig and the heavy-punch keyframes from the demo. Put it in the training stage against the Witness.
→ GATE A: WJ plays it. Does it read as the same game as the Witness and the Planet? Does it feel massive?

**Phase 2 — damage.** Connect 우리 to the existing destruction system: each part sprite is a matter map whose cells carry a body-space position (from the position map). Craters are stored in body space per family (`torso` shared across all twist sprites). Centre → lattice, wall → dark stone, rim → lit stone; near-silhouette hits bite and the outline follows; shed pixels in the stone's colours. Crater shape follows the hit type. Add the damage stages (cities go dark, seam opens) and the defeat (coils fail, halves drift apart).
→ GATE B: WJ plays it. Does damage stay on the body through punches and twists? Can he read who is winning without the health bar?

**Phase 3 — the kit.** Implement the moves in `URI_SPEC.md` §5 with the motion rules in §3 (input on frame 1, wind-up / counter-rotation / overshoot / correction). Wire the AI. Balance against the existing titans.
→ GATE C: WJ plays every move with a controller.

Rules: keep determinism and the tests green; cache damaged sprites and rebuild only on new hits; ≤ 2 ms per frame for 우리; every feel claim in a gate doc cites a clip or a number.
