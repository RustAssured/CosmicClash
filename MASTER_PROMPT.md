# MASTER PROMPT — integrate 우리 (URI) and the MOUTH into ADEUK: TITANS

You are working in the existing ADEUK: TITANS codebase (a cosmic pixel-art fighting game; the Witness and the Planet are
already playable). Your job: integrate two new titans — **우리 (URI)** and **the MOUTH** — faithfully, then align all four
titans into one visual universe. This is a port of locked designs, **not a redesign**.

This bundle contains everything:
- `uri/` — 우리's pack: `README.md`, `docs/URI_SPEC.md`, `docs/TUNING.md`, the oracle `reference/demos/uri-LOCKED-kinetic-pass.html`, the asset `data/uri_rig.json`, source modules in `src/`.
- `mouth/` — the Mouth's pack: `README.md`, `docs/MOUTH_SPEC.md`, `docs/MOUTH_TUNING.md`, the oracles `reference/demos/mouth-LOCKED-full.html` (look/motion/damage) and `reference/demos/mouth-feel-greybox.html` (feel at 60 fps), source modules in `src/`.
- `shared/` — `RENDERING.md` (GPU requirement and budgets), `UNIFICATION.md` (one universe), `VFX_SPEC.md` (one effects system).
- `mouth/reference/demos/three-titans-scene.html` — the Mouth, the Witness and 우리 together at fighting scale.

## Ground rules
1. **The oracles win.** Open them in a browser. If a document and an oracle disagree, the oracle wins unless WJ says
   otherwise. If you think something in an oracle is wrong, stop and ask.
2. **Do not redesign.** No new looks, moves, or numbers unless a gate below asks for a decision. All approved numbers are in
   the TUNING files; expose them as config.
3. **GPU rendering is mandatory** (`shared/RENDERING.md`). The prototypes are CPU references only. Render at native 640×360,
   integer nearest-neighbour upscale, palette-snapped, no smooth gradients.
4. **Authored gesture, physics consequence.** Both titans' motion is authored per beat and enriched by springs; never let
   simulation take over the silhouette.
5. **No mirroring of 우리.** Arm roles come from the opponent's position (`uri/docs/URI_SPEC.md` §5). The Mouth may face any
   direction because its anchor is on the arena perimeter.
6. **Keep the debug/tuning panels** as an in-game overlay toggle for both titans (WJ tunes during real matches).
7. **Work in phases, stop at every gate**, and report with side-by-side captures (game vs oracle) before continuing.
8. **Keep `PROGRESS.md` at the repo root**: what is done, what gate is next, open questions. If the session ends, the next
   session resumes from it. This prompt is designed to be run once and resumed as often as needed.

## Phase 0 — audit (no code changes)
Read the codebase. Report: engine/runtime, how titans are structured (interfaces for input, update, render, hitboxes,
health, effects), how the Witness and the Planet are implemented, the camera and arena model, the current rendering
path, performance on the target machine. Propose where 우리 and the Mouth plug in and what shared systems you will add.
**Gate 0:** WJ approves the plan.

## Phase 1 — shared foundations
- GPU pixel-art render path for titans (native 640×360 target, nearest upscale, depth where needed).
- Master palette + Bayer dither + final palette-snap pass (`shared/UNIFICATION.md`).
- One global light (direction, rim, ambient) passed to every titan's shading.
- Shared bloom for emissives; shared outline rule.
- The shared VFX system (`shared/VFX_SPEC.md`): anticipation, stepped star flash, distortion shockwave, debris sprites,
  lingering dust, hitstop/shake table by blow weight.
- A debug overlay framework (sliders + diagnostics) any titan can register into.
**Gate 1:** capture of the four VFX weights on a neutral background; the existing Witness and Planet still render correctly
through the new path (or are untouched if they don't need it yet — say which).

## Phase 2 — 우리 (follow `uri/docs/URI_SPEC.md` and its gates A–D in `uri/docs/CLAUDE_CODE_PROMPT.md`)
- **2A Render parity:** load `uri/data/uri_rig.json`; rig hierarchy (hips → torso → domes → arms); 4-sample majority
  rotation in a shader; form-light/live-light blend; cores, loop, command moon. Gate: rest silhouette = 100% vs
  `uri/data/uri_silhouette_rest.png`; side-by-side with the oracle at rest indistinguishable.
- **2B Kinetic system:** links with mass/stiffness/damping/limits at 120 Hz; authored move grammar with 14–28% IK
  correction; five beats; arrival-based impacts; internalized counter-torque; pylons; loop deformation; fist compression;
  command-moon gravity tether. Gate: per move and per opponent side (left/right/above/below), 3-s captures match the
  oracle's timing (±1 frame) and keyframe silhouettes; double slam first.
- **2C Damage and break-apart:** chunk tearing, glowing wounds, load-bearing necks, 50% rule, loop integrity = health
  (wired to the game's health model), break-apart around fixed cores. Gate: 20 random hits + a severed wrist neck + a
  knockout, captured.
- **2D In the game:** input → move intent with buffering and cancel windows (visuals grow out of the current state);
  hitboxes/hurtboxes per part; VFX hooks at the right weights. Gate: WJ plays 우리 vs the Witness.

## Phase 3 — the Mouth (follow `mouth/docs/MOUTH_SPEC.md`)
- **3A Decisions first (spec §9):** propose and get WJ's approval for (1) arena-edge anchoring and the camera rule that
  keeps the anchored edge in view, (2) neck/head/coil hurtboxes and bite/crush hitboxes, (3) the coil & crush grab rules,
  (4) corner handling. **Gate 3A:** written proposal approved.
- **3B Feel parity:** port the crane (perimeter anchor with inertia, auto-aim arc, height choice, no homing), the beats of
  bite / sweep / coil & crush, the authored neck + spring lag, the head speed cap, the head behaviour layer — first with
  simple shapes. Gate: side-by-side with `mouth-feel-greybox.html` at 60 fps: same timings, inertia and height choices.
- **3C Look parity:** GPU flesh shading for braided coils (4×4 strands), the eight-strand neck (volume preservation,
  spines, slime, swallow bulge, tendrils), the funnel head, throat clipped to the opening, lips, the four jaw-rings with
  their claws, wounds. Gate: stills from every edge side-by-side with `mouth-LOCKED-full.html` and
  `mouth-lookdev-stills.html`.
- **3D Damage and knockouts:** teeth, rings (chip/break), strand tears and severing, coil gashes, ×1.6 stretched-neck
  damage, control degradation, both knockouts (dragged back, severed). Gate: captures of both knockouts.
- **3E In the game:** controls (keyboard + gamepad), hitboxes live, VFX hooks (bite/crush heavy, knockout catastrophic),
  the true wrap for coil & crush. Gate: WJ plays the Mouth vs 우리 and vs the Witness.

## Phase 4 — unification and balance
- Apply `shared/UNIFICATION.md` to all four titans (one sky, master palette, highlight ceiling, outline, bloom,
  brightness balance) — align the Witness and the Planet without redesigning them.
- Performance: 60 fps with two titans + effects + background within the budgets in `shared/RENDERING.md`.
- Balance pass with the debug overlay: report hit/whiff/punish data per matchup (Mouth reach, tell, recovery, migration;
  우리 commitment and taper).
**Gate 4:** a four-titan screenshot and a short capture of each matchup, reviewed by WJ.

## Phase 5 — report
Summarise what shipped, deviations from the oracles (with reasons), open issues, and recommended next steps (for example
the new, vaster background, which WJ wants to design after integration).

## Do not
- Do not paint over, regenerate, or "improve" 우리's part matter or the Mouth's look.
- Do not mirror 우리's sprite. Do not let the cores leave their cradles.
- Do not use rifts or teleporting for the Mouth; it moves along the perimeter.
- Do not ship CPU per-pixel renderers in the game loop.
- Do not invent numbers; if a value is missing, ask.
