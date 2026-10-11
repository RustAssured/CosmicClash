# Claude Code — implement 우리 (URI), locked v2

You are integrating the titan 우리 into the ADEUK: TITANS fighting game. Everything about its look and
motion is **locked**. Your job is a faithful port, not a redesign.

**Oracle:** `reference/demos/uri-LOCKED-kinetic-pass.html` (open it; it is the spec in executable form).
**Read first:** `docs/URI_SPEC.md`, `docs/TUNING.md`. **Source:** `src/` (rebuild the oracle with `python3 src/assemble.py`).
**Asset:** `data/uri_rig.json`.

Rules:
- Do not regenerate or repaint the parts; load `uri_rig.json` as is.
- Do not mirror the sprite, ever. Arm roles come from the opponent's position (spec §5).
- Keep the 4-sample majority rotation, the form-light/live-light blend, outlines, cast shadows.
- Keep authored motion in charge (IK correction 14–28%), the five beats, arrival-based impacts, layered taper.
- Keep every number from `TUNING.md` unless a gate below says otherwise; expose them as config.
- If the game engine differs (canvas/WebGL/other), match the oracle visually, not the code line by line.

## Phase A — render parity (gate A)
Load `uri_rig.json`, build the rig hierarchy (spec §4), draw the rest pose with the full shading pipeline,
cores, loop, command moon.
**Gate A:** rest silhouette overlap with `data/uri_silhouette_rest.png` = 100%; a side-by-side screenshot
with the oracle at rest is indistinguishable; rotated parts show no smear or sparkle (test 30°, 90°, 150°).

## Phase B — kinetic system (gate B)
Port the link system (120 Hz), authored move grammar, constrained IK, counter-torque, pylons, loop
deformation, cores, command-moon tether, fist compression. Opponent position from game state = target.
**Gate B:** for each move and each opponent side (left, right, above, below) record a 3-second capture and
compare with the oracle (same target positions; use its diagnostics overlay): phase timing ±1 frame at
30 fps, same impact frame rule, same silhouette at load/impact/taper keyframes, no springy bounce.
Double slam first — if it is right, the rest usually is.

## Phase C — damage and breaking (gate C)
Chunk tearing, wounds, neck integrity, 50% rule, loop integrity as health (wire it to the game's health
model), break-apart with slow-mo around fixed cores, debris persistence.
**Gate C:** 20 random hits produce torn chunks and glowing wounds in place on moving parts; a severed wrist
neck makes the fist drift away whole; loop integrity 0 triggers the break-apart; cores never move sides.

## Phase D — game integration (gate D)
Input → move intent (with buffering and cancel windows; visuals must grow out of the current motion state,
never reset to neutral). Camera shake and hitstop through the game's systems. Diagnostics + tuning sliders
behind a debug toggle. Performance budget: ≤ 4 ms per frame for 우리 on the target machine (if the CPU path
is too slow, port the part rasterizer to the GPU — same sampling rule).
**Gate D:** WJ plays it against the Witness at fighting scale; it reads as the same game and feels heavy.

Report at each gate with screenshots/captures next to the oracle's. Stop and ask if anything in the oracle
seems to contradict the spec — the oracle wins unless WJ says otherwise.
