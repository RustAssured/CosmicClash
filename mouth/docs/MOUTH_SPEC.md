# THE MOUTH (아귀) — canonical spec v1

> Only the feeding end of it fits on the screen. The rest lies coiled along the edge of the arena and beyond.

Status: look, control scheme, motion character, damage and knockouts are **approved in prototype**.
Open game-design questions are listed in §9 and are gates, not details.

## 1. Identity
- **Role in the cast:** Witness = perception · Planet = nature · 우리 = refusal · **Mouth = hunger / encroachment**.
- **The fantasy:** you never walk it. You slide a colossal body along the edge of the arena and launch its head. The player
  commands a predator's feeding vector, not a character's feet.
- **Scale is sold by what is not shown:** the coils are always partly off-screen; the visible head and neck are only the
  front of something unimaginably large.
- **No rifts, no teleporting.** It moves along the perimeter, visibly, turning corners slowly.

## 2. Anatomy (three parts, always present)
1. **The coils (the reservoir):** four rope-strands, each braided from four thinner strands; wet black with raw red and pale
   marbled sinew; mucus threads between coils. Nearest to the camera, darkest in the hierarchy, partly beyond the edge.
   They slide along the perimeter with the anchor and tighten as the neck pays out (and swell as it returns).
2. **The neck (the conduit):** eight strands braided round a spine, thick and muscular, black-red, dense curved spines raking
   back along the outside; slime between strands; a swallowing bulge travelling toward the head; hooked tendrils.
   Volume is preserved: stretched → thinner, bunched → thicker.
3. **The head (the feeding structure):** a long ribbed funnel of flesh flaring into the mouth; a throat of six rings of curved
   claws in wet gums descending to a red glow; thick lips with a rim of claws; four heavy bone **jaw-rings** (oval,
   wobbling, ribbed, saw-clawed inside) each turning on its own tilted axis round the front (an armillary of jaws);
   saliva across the throat; drool. Brightest element in the hierarchy.

## 3. Look and rendering
- Same family as 우리 and the Witness: pixel art, drawn per pixel, palette-stepped (Bayer-dithered ramps), lit per pixel.
- **Ramps:** wet black, raw red, pale sinew, old bone, glowing throat (see `src/10_mouth_render_lib.js`).
- **Light:** in the prototype the sun is behind-right (strong pink-red rim through flesh edges), key upper-right, cold violet
  fill in shadows, sharp wet speculars. **In the game, use the shared global light** (`../shared/UNIFICATION.md`); keep the
  rim-through-flesh and wet speculars as the Mouth's material signature.
- Structure: strands are round tubes in a depth buffer (crossings get a dark contour seam); rings, teeth and slime are
  depth-sorted; the throat is seen through the mouth opening (clip to the opening ellipse).
- **Hierarchy (readability):** coils darkest/most muted → neck mid → head brightest, strongest silhouette.

## 4. Controls — the crane
- **Slide** (stick/A–D/◀▶): moves the anchor along the arena perimeter (all four edges). Heavy: accelerates and stops
  with inertia, slower at corners, almost stops during a strike.
- **Auto-aim:** at rest the head always tracks the opponent inside a ±1.35 rad arc around the edge normal.
- **Height** (up/down held at the moment of striking; neutral = straight): high = wide arc over the top, longest reach,
  slowest; low = comes in from below, fastest, shortest; straight = between. During the wind-up a dashed line shows
  the path (readable for both players).
- **Strikes:** Bite (J / A), Sweep (K / X), Coil & crush (L / B).
- **No homing:** a strike locks the target position at the moment it is commanded.
- Gamepad supported in the prototype (left stick slide, up/down height, A/X/B strikes).

## 5. Motion — authored gesture, physics consequence
- The head follows an **authored intent per beat** with a heavy spring; a velocity cap means it can never outrun the neck
  (low at rest, high in strikes).
- The neck is an **authored curve per beat** (gentle S at rest, folded waves in the wind-up, an arc in the strike) plus
  per-sample spring lag (stiff at the base and near the head, loosest mid-neck → bends without kinks).
- The anchor carries the neck when sliding; the coils follow round corners.
- **Head behaviour layer (per beat):** breathing and slow roll at rest with rare small twitches; in the wind-up the jaw-rings
  open like an iris and the mouth gapes, the head wrenches about its axis, the pulse quickens; in the strike the rings snap
  forward and tighten; at the bite the mouth snaps shut (slight overshoot) and alternate rings grind against each other.
- **Moves (beats):** Bite = load · strike · bite · hold · recover. Sweep = load · sweep · bite · recover.
  Coil & crush = reach · coil · crush · release. Durations in `MOUTH_TUNING.md`.
- **Impact:** hitstop, shake, shockwaves, flash, debris (rock, slime, bone) — to be realised with the shared VFX system
  (`../shared/VFX_SPEC.md`); the prototype's flat flash is a placeholder.

## 6. Damage
- **Head:** teeth snap (stay broken as stumps); jaw-rings chip (arcs missing) and break after 5 hp; bone splinters.
- **Neck:** strands tear into irregular raw gashes; a strand severs past a threshold (beyond the cut it is gone; the stump
  drips). **A stretched neck after a strike takes ×1.6 damage** (the punish window).
- **Coils:** gashes where hit, travelling with the strand.
- **Control degrades with damage:** slower slide, weaker tracking, heavier neck, more twitch.

## 7. Knockouts
- **Dragged back** (default): convulse (rings stop and collapse inward one by one, mouth gapes and snaps), the neck goes
  slack and sinks, the coils drag everything back over the edge until gone.
- **Severed** (if ≥ 3 neck strands are cut): the head comes loose and drifts away slowly, rotating, its rings falling off one
  by one; the bleeding stump retracts and the coils withdraw.

## 8. Scale
Head (lip ring) ≈ 116 px across at native 640×360; jaw-rings to ≈ 180 px; neck ≈ 40–55 px thick; coils' strands ≈ 55 px
thick, with only part of the body on screen. Next to the Witness: head ≈ the Witness's carapace. See
`reference/demos/three-titans-scene.html`.

## 9. Open game-design questions (gates — decide before or during integration)
1. **Arena edge vs camera:** the anchor lives on the **arena** boundary, not the screen. When the Mouth is in a match the
   camera must keep its anchored edge in view (fixed arena framing, or a camera rule that never crops the anchor edge).
2. **Hitboxes on a moving neck:** neck hurtboxes follow the neck samples (capsules along the authored curve), head hurtbox,
   coil hurtboxes along the visible coils; hitboxes only on the mouth during bite/crush beats.
3. **Coil & crush:** in the prototype the head circles the target but the neck does not truly wrap; define the grab
   (grab box, escape rules, damage over time) and make the last third of the neck wrap visibly.
4. **Corners:** head and coils can crowd each other near corners; keep a minimum head distance from the coils and
   resolve draw order so the head is always in front.
5. **Balance:** reach (0.9), tell (~0.42 s + visible path), recovery (~0.7–0.9 s with ×1.6 neck damage), migration speed,
   damage per bite. Tune by playing against the other titans with the debug panel.
6. **Performance:** the prototype renders on the CPU (≈ 30–45 ms/frame for the Mouth alone). The game must render on the
   GPU at native 640×360 and scale with nearest-neighbour; budget ≤ 2 ms/frame for the Mouth.

## 10. Acceptance
- Look side-by-side with the oracle at rest and in each beat: indistinguishable in silhouette, hierarchy and materials.
- Feel side-by-side with the greybox: same timings (±1 frame at 60 fps), same inertia, same height choices.
- Damage and both knockouts behave as in the oracle; the stretched-neck punish window works.
- 60 fps with two titans and effects on the target machine.
