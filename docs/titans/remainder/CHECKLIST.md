# The Remainder: check it in the real game

Every clip so far was drawn by the software compositor (`tools/titans/clip.ts`): the same layers the game draws, but not
the GPU renderer's lighting, bloom and post. The GPU renderer never starts in the cloud sandbox, so this pass needs a real
machine. About 15 minutes.

**Start it:** `npm run dev`, then open

- `http://localhost:5173/?mode=aivai&a=remainder&b=lastone&stage=tussenruimte&seed=21&ai=4` (AI against AI, its home stage)
- `http://localhost:5173/?mode=training&a=remainder&b=planet` (you play it: Training shows hitboxes and a dummy)

Tick each line, or note what is off and send it back (a screenshot and the time helps).

## Look

- [ ] **Idle:** the vortex swirls violently, spasms closed and tears itself open; the shell stays rigid. Nothing smears
      or ghosts under motion blur, and the eye's rim glows without the bloom washing out the spiral.
- [ ] **Snap (Strike):** the vortex itself stretches out of the rim like rubber to a point, with no seam where it leaves
      the circle and no colour shift between vortex and tongue. It snaps back, the vortex dents and wobbles.
      Try all three aims.
- [ ] **Inhale (Crush):** the tell reads (the vortex darkens, dust rushes in), the foe is yanked, and the bone rim bites.
- [ ] **Fold (Surge):** it drains into its eye; a tear stays where it was and it unfolds from another tear.
- [ ] **Compaction (Signature):** hold it; the slug grows with the charge and fires as real matter (forward and up). Aimed
      down, bone plates grow over the shell.
- [ ] **Loosening (Ultimate):** cracks tear across the body, the core is exposed, everything is dragged in, then the
      slam shut with a shockwave.
- [ ] **Hold Shut (Guard):** the bone iris closes over the wound from the rim inward; blows on it are swallowed.
- [ ] **Cannibal:** below about a third of its mass, it crumbles its own shell inward.
- [ ] **KO:** it reads as the wound finally closing.

## Sound (its own voice, `src/audio/voices/remainder.ts`)

- [ ] A low, beating drone is always under it, audible on laptop speakers; it muffles while Hold Shut is up.
- [ ] Snap: a rising creak, a crack, a slap back. Inhale: a rising suck, then a bone bite. Fold: an implosion, then a pop
      elsewhere. Compaction: a grind while held, a hard crack on release. Loosening: a tearing roar, then the slam.
- [ ] Nothing whistles or hisses (the game's rule: low and epic).

## Feel and speed

- [ ] The frame rate holds with two Remainders on screen (`?mode=aivai&a=remainder&b=remainder`), including during
      Loosening.
- [ ] Snap reads instantly as a different action from Inhale (both pull the foe).

## Left by hand after shipping

- [ ] **Site hover clip:** add a `remainder-card` shot to `tools/press/shots.ts` (4 s, 240 ticks, like `cradle-card`), render
      it with `npx tsx tools/press/clip.ts --only=remainder-card`, then re-run `npm run titan:ship -- remainder`.
- [ ] **Key-art lineup and press card:** `npm run titan:ship -- remainder` where the press/ folder lives (it skipped them
      here: no GPU, no press/ folder).
- [ ] **CLASSIC ladder slot** (WJ decides): it is already an opponent in COSMIC CLASH; CLASSIC needs `LADDER_ORDER` and
      `LADDER_STAGE` in `src/ui/ladder.ts`.
- [ ] **Select screen and site:** `npx tsx tools/ui/select-shots.ts`, and `npm run build:site` +
      `npx tsx tools/site/verify.ts` (desktop, tablet, phone).
