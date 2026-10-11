# 우리 (URI) — The Refusal · integration pack v2 (locked)

This pack replaces v1 entirely. Everything here describes the **locked** version of 우리:
the reference silhouette, rebuilt as a rig of pixel-matter parts, driven by an authored
kinetic chain with physically believable consequences, and destructible pixel by pixel.

**The oracle is `reference/demos/uri-LOCKED-kinetic-pass.html`.** Open it in a browser.
Whatever the game build does, it must look and move like that page.

## Read in this order
1. `docs/URI_SPEC.md` — what 우리 is, how it is built, how it moves, how it breaks
2. `docs/TUNING.md` — every approved number (masses, damping, phases, impulses, poses)
3. `docs/CLAUDE_CODE_PROMPT.md` — the implementation prompt, phased with gates
4. `tools/pipeline/README.md` — how the rig data was made from the reference art

## Contents
| Path | What |
|---|---|
| `reference/uri_front_reference.png` | canonical front view — the rest pose and silhouette |
| `reference/sheets/` | concept board and the two pose sheets (see the side-convention note in the spec) |
| `reference/demos/uri-LOCKED-kinetic-pass.html` | **the locked prototype** — rendering, motion, damage, break-apart, diagnostics, tuning sliders |
| `reference/demos/uri-rig-anatomy.html` | the rig: parts colour-coded, exploded view, posable joints, silhouette check |
| `reference/demos/uri-at-scale.html` | 우리 next to the Witness and the Planet at fighting scale |
| `reference/demos/*.gif, *.png` | captures of the above |
| `data/uri_rig.json` | **the asset**: 13 parts, each a grid of pixel matter + normals, form light, chunks, pivots, joints |
| `data/uri_rig_primitives.json` | the fitted anatomical primitives the parts were conformed from |
| `data/uri_silhouette_rest.png` | the rest silhouette (reference coordinates, 403×368) |
| `src/` | the locked prototype as modules; `python3 src/assemble.py` rebuilds it byte-identical |
| `tools/pipeline/` | the five scripts that turn the reference art into `uri_rig.json` |
| `archive/` | the v1 spec and prompt, superseded — for history only |
