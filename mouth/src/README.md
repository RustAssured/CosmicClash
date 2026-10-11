# Mouth source (prototype)
The locked oracle `reference/demos/mouth-LOCKED-full.html` is these files concatenated after the shared helpers (`00_shared_helpers.js` = the same `part2.js` as in 우리's pack) and inside one block:
`10_mouth_render_lib.js` (opens the block: flesh shading, tubes, braids, slime, head/funnel/throat/jaw-rings, wounds),
`20_mouth_compose.js` (depth contours, outline, bloom, cached background),
`30_mouth_core_motion_damage.js` (perimeter anchor, crane controls, auto-aim, moves as beats, authored neck + spring lag, head behaviour layer, impacts, damage, knockouts, page UI; closes the block).
The feel was authored first in `reference/demos/mouth-feel-greybox.html` (60 fps, flat shapes) — use it to judge motion.
These are CPU look-development renderers: the game must render on the GPU (see the master prompt).