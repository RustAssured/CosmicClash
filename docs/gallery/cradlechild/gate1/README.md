# Cradle Child: Gate 1 (look and silhouette)

For WJ, 2026-10-15. Brief: [docs/titans/cradlechild/BRIEF.md](../../../titans/cradlechild/BRIEF.md), refined by your
paint-over and short brief of the same day ([paintover-gate1.webp](../../../titans/cradlechild/paintover-gate1.webp)). It is
**WIP**: off the menus, the site and the press until you ship it. To see it in the game, add `?wip=cradlechild` to the URL.

## What to look at
| File | What it shows |
|---|---|
| `cradlechild-x1.png` / `cradlechild-x3.png` | the titan alone, as the matter world draws it (1× = true game size, 166×245 px) |
| `cradlechild-64px.png` | the 64 px read, the Child next to the Cradle |
| `cradlechild-vs-cradle.png` | the two side by side at true size |
| `cradlechild-roster-lineup.png` | the whole roster at true relative sizes, the Child right after the Cradle |
| `cradlechild-vs-cradle-nursery-t240.png` | a real fight frame against the Cradle on the nursery stage |
| `cradlechild-select.png` | the titan select screen (with `?wip=cradlechild`) |

## What's built (revision 2, after your paint-over)
- **The crown is a containment apparatus**, not a halo: two bone rings behind the head. The outer ring is broken open at the
  upper right and hooked at the break. Knobbed nodes sit on both rings, a cross spire runs through them, and web strands
  (some red) are strung between the rings.
- **A sealed hood:** a tall mitre with bone ribs down it and no face.
- **The open cavity** under the brow holds the great galaxy-organ: two pearl arms wound into a spiral round a white-gold
  core, with raw red grooves between them. A few soft drips hang from the brow.
- **Gestational membrane lobes,** not wings. Each is stretched on four bone struts with knobs at every node (the leading
  strut is the heaviest). Holes lace the free edges, leaving pale web strands. A spiral galaxy sits in a lilac window in
  each lobe, raw red vessels fan out from the root, and drips with bead tips hang from the lower edges.
- **The torso:** sickly pearl over rose flesh, red vessels running down it, two red vessel loops hanging off its flanks,
  two almond galaxy-pods set into it, and the healed cord scar low on the belly.
- **The lower body is unfinished incarnation:** two bony scaffold limbs with knuckles and knob ends, and between them a
  hanging chain of galaxy-pods and bone beads, two shorter side chains, and laced webs. There are no tentacles.
- **Palette check passes:** accent `#fbe0f6` / `#f2c26a`. The nearest other colour is the Cradle's bone at ΔE 0.111 (the
  limit is 0.09).
- **Size check passes:** 166×245 px, large class (150–250).
- **Still the inverse of the Cradle:** its mean lightness is **0.58** against the Cradle's **0.24**, and 57 % of its pixels
  are light against the Cradle's 5 %.

## Where I went my own way from the paint-over (your call)
1. **The cavity is taller than wide** and narrows to a point under the brow, and the organ fills it with two arms. A round
   cavity with a single swirl and a gold centre read as an eyeball at game size.
2. **Few, soft drips from the brow,** so the cavity never reads as a mouth with teeth.
3. **It's simpler than the paint-over** at 1×: fewer beads, threads and lace cells. At 166 px wide, more detail turned to
   noise.

## Not done yet (later gates)
Motion (Gate 2), the six moves, Reassignment and the Fold (Gate 3), incarnation reversal (Gate 4), card/voice/balance
(Gate 5) and the secret unlock. Its moves and AI are still the scaffold's placeholder blob moves. The paint-over's motion
ideas (chains and pods swaying, drips stretching) belong in Gate 2.

## Open questions
- Korean name: 요람의 아이 (now) or 화신체? It is two fields in `src/titans/kit/cradlechild/cradlechild.json`: `nameKo` and
  `kit.site.ko`.
- Is the lower body unfinished enough, or should the limbs be broken or partly scaffold (bare bone, no tissue)?

Regenerate these stills: `npx tsx tools/titans/cradlechild-gate1.ts`, and
`npx tsx tools/titans/still.ts cradlechild --b=cradle --stage=nursery --ticks=240 --out=docs/gallery/cradlechild/gate1`.
