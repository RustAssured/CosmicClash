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

## 2b. The full pixel-art version: normal-mapped, lit in real time (recommended)

The highest-quality version, and the one to implement. Reference: `docs/concept/uri/uri-normalmapped-demo.html` (buttons: Move the light, Show normals).

Every part also carries a **G-buffer** (`assets/uri/<part>_gb.png`, `_nrm.png`, `_emc.png`):
- `_gb`: R = material (1 stone, 2 crack, 3 moss, 4 ice, 5 bronze, 6 gold city, 7 crystal city, 9 helmet, 10 foot, 11 emissive), G = tone (per-plate variation), B = baked ambient occlusion.
- `_nrm`: view-space normal per pixel (x right, y up, z toward camera; decode `v/127.5-1`).
- `_emc`: exact emissive colour for material 11 (seam, vent, visor, windows, scar).
- `_part` B channel: sprite index (`si` in the manifest), used to find each pixel's rotation.

At runtime, each part writes its G-buffer into screen-space layers with its rotation; a lighting pass (a fragment shader in the game) then:
1. rotates each pixel's normal by its part's screen rotation, so light stays fixed in the world while limbs swing (this is what kills the paper-cut-out look);
2. lights it with a key light, a cool fill, a blue rim light, and **coloured point lights**: cyan from every coil, orange from the engines under the feet, warm from the dynamo vent, white from the fist when a punch lands, and a flash at every hit;
3. maps the result onto **hand-picked, hue-shifted ramps per material** (cool violet shadows to warm highlights for stone, etc.), with ordered dither only at band edges, crisp single-pixel speculars on helmet, bronze, ice and crystal;
4. snaps every pixel to one palette made of those ramps plus the glows — the output is true pixel art, never off-palette;
5. applies damage per pixel from the position map, then the shadow-side outline, then the 3D coils and bloom.

On a GPU this pass is trivial at 640x360. (The browser demo does it on the CPU, which is why it is slower.)

## 2c. Native pixel-art version (like the Witness): a 2.5D shape renderer

Reference: `docs/concept/uri/uri-native-demo.html` and `uri_keyart_v2.png`. No 3D model and no baking: 우리 is drawn pixel by pixel every frame from simple 2.5D shapes, the same way the Witness is drawn in code.

- **Shapes:** *drums* (tapered cylinders: torso barrel, limb segments, head, fingers, spires as drums tapering to a point), *flanges* (wide thin drums with glowing rims and ringed undersides at every joint: orange on its left side, cyan on its right), *discs* (the shoulder plateaus) carrying *cities* (64 spires each on a plinth: gold gothic left, violet-blue crystal right).
- **Every shape knows how it curves.** For each pixel the renderer knows the surface normal, the height along the shape and the angle around it. That gives shading, and it gives texture that wraps: stone blocks sit at fixed positions around each drum, so when 우리 twists they slide around the barrel; the sun core and blue emblem slide with them; the cities turn on their discs; the far shoulder passes behind.
- **A depth buffer** sorts overlapping shapes per pixel, so arms pass in front of and behind the body correctly.
- **Look:** hue-shifted ramps per material snapped to one palette; irregular, chipped stone blocks; warm light from the left and cold violet light from the right (the two peoples); every flange, the core and the thrusters act as coloured point lights; shadow-side outline plus contour lines where a nearer shape covers a farther one; bloom from emissive pixels.
- **Damage:** a crater is stored as (shape, height, angle, radius), so it stays on the surface through any twist or turn; centre shows the lattice, rim glints gold, hits near the silhouette bite pixels out.
- **Motion:** model-space joint keyframes with springs, torso twist against the hips, whole-body turn.
- **Cost:** the demo draws everything on the CPU. In the game, each shape becomes one shader-drawn quad writing colour and depth — standard, cheap work for a GPU.

- **Every piece is a separate celestial body, and nothing is fused.** Torso: the remains of a world (oceans, continents, cloud, city lights, carved bands). Pelvis, shoulders, hips and head: moons. Limbs: carved moons with craters, strata, ice and tiny city lights on their night side (scale cues), warm ochre moons on the left, lavender and icy moons on the right, energy veins seeping through the cracks. Each piece floats a small gap from the next and is held by a gravity ring (the glowing flanges) — they are the joints.
- **Hips are ball-and-socket:** a moon-ball tops each thigh, held in a ring under the pelvis, never intersecting it.
- **No hands: a ram and a blade.** Left: the ram, a dense moon held in front of the wrist by gravity. Right: the blade, a long faceted crystal shard from the second world with two side shards. Moves change accordingly: the haymaker becomes the ram, the TEAR signature becomes a carve with the blade, the jab becomes a blade thrust.
- **Proportions:** gorilla-like — a tapered world-torso (broad chest, narrow waist), long arms, short legs.
- **Palette:** subdued and realistic for an epic battle — desaturated moons and world, muted gravity-ring glows, restrained bloom; colour reserved for the core, the emblem, the veins and the two cities.

This is the version that most closely matches the Witness's construction. Choose it or §2b (normal-mapped bake) at Gate A.

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
