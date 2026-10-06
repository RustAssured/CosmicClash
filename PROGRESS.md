# PROGRESS — integrating 우리 (URI) and the Mouth (MASTER_PROMPT.md)

Resume from here. The rules and phases are in `MASTER_PROMPT.md`; the packs are in `uri/`, `mouth/`, `shared/`.

## Done
- **Before this program (the two-titan slice):** the Witness (v3, WJ's concept) and the Planet are playable. Gate C was
  delivered (`docs/gates/GATE_C.md`), and D30 was confirmed. The other Gate C decisions are open.
- **Phase 0 audit:** `docs/integration/GATE_0.md` (2026-10-06). No code changes.

- **Gate 0 approved** (D31 in docs/DECISIONS.md).

- **Phase 1 delivered and Gate 1 approved** (D32). The Planet is 180 px.

- **Phase 2A + 2B committed** (a42c5ff).
  - **2A:** 우리 at rest is pixel-identical to the oracle's rest frame (77,396 / 77,396 pixels), with a 100 % rest silhouette; the
    oracle's shading, cores, loop, moon and rubble fists.
  - **2B:** the kinetics port matches the oracle in 16 move × side runs (13 exact, 3 within one oracle frame), frozen as a
    regression fixture.
- **Open for WJ:** the highlight ceiling for 우리 (oracle top step vs the unification rule; switch `URI_CEILING_EXEMPT`).

## In progress
- **S5:** a quiet perf re-measure; checking 우리 in the real game; pylon plumes.
- **S1:** the Tidal Draw AI at 180 px; fighter hooks (mirrors(), body-layer planes). Then Gate 2D.
- **Next:** 2C, 우리's damage (S2 + S4), after S5's perf run.

## Earlier: Phase 2A (우리 render parity), plus the Gate 1 follow-ups
- **S4:** the uri_rig.json loader into matter region bodies, the 4-sample majority sampler (contract + GLSL), the rest
  silhouette overlap test.
- **S2:** 우리's titan definition, behaviour and rig hierarchy; never mirrored. 2B (kinetics) follows.
- **S5:**
  - the Planet's atmosphere glow back;
  - the one sky live in play;
  - a quiet perf re-measure;
  - then 우리's shading, cores, loop and moon.
- **S3:** the Brace test at 180 px.
- **Gate 2A:** rest silhouette 100 %; a side-by-side with the oracle at rest; no smear at 30° / 90° / 150°.

## Phase 1 assignments (historical)
- **S5:** master palette with Bayer palette snap, one global light for titans, shared bloom and outline, the lit part pass
  foundation, the shared VFX module (four weights).
- **S1:** the debug overlay framework (toggle, sliders, diagnostics registry), and the hitstop/shake table by weight with
  the cap raised for heavy and catastrophic.
- **S3:** the Planet enlarged to read as an equal, with size options for WJ.

## Next gate
- **Gate 1:**
  - captures of the four VFX weights on a neutral background;
  - a before/after of the Witness, the Planet and the arenas through the master palette and one sky;
  - the Planet size options.

## Open questions
- **The Mouth's health readout:** not a bar; propose at Gate 3A.
- **Backdrops:** new, vaster ones after the integration (WJ).
