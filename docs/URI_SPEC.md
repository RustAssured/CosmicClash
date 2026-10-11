# 우리 (URI) — character and implementation spec

"We." Two civilisations on a double planet lost both worlds to the Mouth (아귀). They carved everything they could carry into one body and fled. 우리 is all that is left of them: a wandering world, two peoples living on it, crossing the cosmos to find the thing that ate their home. The only titan that was *built*.

Visual references: `docs/concept/uri/` (key art, character sheet, style test, motion, baked damage, live puppet demo).

## 1. Look

- **Build:** hunched and heavy. A huge rounded torso that carries two cities on its shoulders, a large helmeted head set forward, long arms with oversized forearms and stone fists (fingers modelled, not shapes), short pillar legs ending in engine pods. About 2.5x the Planet's diameter.
- **Materials (four large readable areas):** dark basalt plates with irregular cracks and occasional gold in the cracks; old bronze bands; ice from the second world on forearms and legs; glowing cyan coils at every joint.
- **Lights (the silhouette at a glance):** split visor (amber / white / blue), the straight white-gold seam down the chest, the dynamo vent, the gold gothic city (left shoulder), the blue crystal city (right shoulder), engine fire under the pods.
- **Lore details:** a ring of tooth marks on its left flank (the Mouth's bite, never repaired); teeth from the Mouth set into its knuckles.
- **Brightness range:** must match the Witness and the Planet — mostly dark, light reserved for things that glow. This rule matters more than the technique.
- **Wound light:** the cyan lattice under the stone, and white-gold where the seam opens. (Witness: white-gold/cyan halo light. Planet: magma. 아귀: wrong colours.)

## 2. How it is made: baked pixel art (Donkey Kong Country method)

우리 is modelled once as a 3D signed-distance-field sculpture (`tools/uri-bake/`) and **baked** into pixel-art sprites. At runtime it is ordinary 2D pixel art, like the other titans.

Baked per part (`assets/uri/`), each with four images:
- `<part>.png` — colour, one shared 45-colour palette for every part (`palette.json`), no dithering, stray pixels cleaned.
- `<part>_glow.png` — emissive layer (for bloom).
- `<part>_pos.png` — **position map:** RGB = the point on the body this pixel belongs to, in the part's own space (decode: `v/255*16-8`).
- `<part>_part.png` — R = part id, G = material id.

Parts: `torso_m40 … torso_40` (nine twist angles, −0.4 to +0.4 rad), `pelvis`, `uaL uaR` (upper arms), `faL faR` (forearms), `fistL fistR`, `thighL thighR`, `shinL shinR` (shin includes the engine pod). `manifest.json` holds per sprite: `size`, `pivot` (the joint it hangs from), `end` (the next joint), and anchors (`shoulderL/R`, `hip`, `visor`, `cityLe/Re` on the torso; `hipL/R` on the pelvis; `podL/R` on the shins).

Limbs are baked in the direction they hang in the rest pose, so runtime rotation stays small and the lighting stays right. For production, bake 2–3 orientations per limb and pick the nearest, and use a RotSprite-style rotation instead of nearest-neighbour.

## 3. Rig and motion: rigid masses on force fields

Not organic sway, deliberately. 우리 moves like enormous rigid masses held by force fields:
- Parts are placed every frame from joint anchors; **the gap at each joint is bridged by a procedural coil**: a true 3D ring around the limb, projected from the limb's real 3D direction (so its shape and which half is in front always match the perspective). The far half is drawn behind the body, the near half over it. They flare with effort.
- Rest pose floats relaxed: knees drawn up toward the camera, shins hanging, feet pointing toes-down (the foot is an armoured block with thruster slots on the sole).
- Each joint angle follows its target through a **spring** (stiffness ~55, damping ~7.5): it lags, overshoots and settles. Fists lag their forearms slightly; legs barely move.
- **Torso twist** switches between the nine baked angles; the counter-rotation of every heavy punch is read from it.
- The joint gaps stretch a few pixels under effort.
- Secondary life is runtime-procedural: engine flames (scale with effort), waterfalls off the city edges, coil flicker, satellites around the head, shed stone.
- Motion rules: every punch is paid for (wind-up with torso turning away and engines flaring → strike with counter-rotation → overshoot → correction). Input response on frame 1 (visor and engines), body follows.
- Reference keyframes for the heavy punch: `KEYSw` in `docs/concept/uri/uri-puppet-demo.html` (world-space joints, twist, crouch, coil flare, engine power).

## 4. Damage: pixel-level, like the others, stored on the body

Damage is stored **in body space, not image space**: a crater is `{family, point (from the position map), radius, bite, seed}`. Families: `torso` (shared by all nine twist angles — the crater stays when the torso turns) and one per limb part.

When a part is drawn, every pixel's position-map value is tested against that family's craters:
- centre of a crater → the glowing cyan lattice;
- crater wall → darkened stone;
- rim → lit stone with gold glints;
- hits near the silhouette **bite** — the pixels are removed and the runtime outline follows the new edge;
- the pixels inside a fresh crater fly off as shed matter in their own colours.

Integrate with the existing matter/destruction system by treating each part's sprite as a matter map whose cells carry a body-space position. Crater shapes should follow the hit type (punch: broad; beam: long gash; bite: ring of tooth marks).

Damage stages (from the character sheet): armour peels → lattice shows → cities go dark district by district (small ships flee) → the seam opens. Defeat: coils fail, the two halves drift apart.

## 5. Moves (first pass)

Strike: mass-driver jab · Crush: tectonic haymaker (2 s wind-up) · Surge: continental burn · Signature: TEAR (grab, rip a slab, shield or throw) · Special: moon-fist (fist launched down its mass stream and recalled) · Guard: magnetosphere · Ultimate: 우리 (both cities overcharge, the seam opens, joint strike).

## 6. Acceptance

- In a side-by-side with the Witness and the Planet at 640x360, 우리 reads as the same game (brightness range, palette, outline only on the shadow side).
- The heavy punch shows wind-up, counter-rotation, overshoot and settle in real-time footage; input responds on frame 1.
- Damage stays attached to the right point of the body through the whole punch and through torso twist changes.
- Bites change the silhouette; shed pixels carry the stone's colours.
- Performance: assembling 우리 with damage costs ≤ 2 ms per frame on WJ's machine; damaged part sprites are cached and only rebuilt when a new hit lands.
