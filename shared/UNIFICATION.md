# Unification rules — one universe for all titans (Witness, Planet, 우리, Mouth)

The four titans were developed separately. In the game they must read as one world. Apply these to all four
(including the existing Witness and Planet — no redesign, only alignment).

1. **One sky.** A single global key light direction for every titan (recommend: upper-left-front, as 우리 and the
   Witness), one rim/back light colour, one ambient. The Mouth keeps its material signature (light bleeding red-pink
   through flesh edges, sharp wet speculars) but takes its direction from the shared light.
2. **One master palette.** Build a master palette (≈ 96–128 colours) as the union of the approved ramps; each titan
   uses a subset. Every final pixel of every titan and every effect is snapped to it, with the same ordered (Bayer)
   dithering. No smooth gradients anywhere.
3. **Highlight ceiling.** Specular highlights may reach the palette's top step only on wet/emissive materials (Mouth
   flesh, cores, loop, eye). Stone, bone and metal stop one step below. This keeps the glossy Mouth and the flat
   Witness in the same world.
4. **Same edges.** One dark outline pixel around every titan's silhouette (shadow-side emphasis allowed), and internal
   depth seams where parts overlap.
5. **Same light from within.** Emissives (windows, cores, loop, throat glow, Witness lights) go through the same bloom
   (two blurred additive passes, ≈ 3 px and ≈ 10 px, same strengths).
6. **Same pixel density.** Native 640×360, integer nearest-neighbour upscaling, no sub-pixel rendering of sprites.
7. **Same physics of consequence.** Hitstop, shake and debris persistence follow one table (in `VFX_SPEC.md`) scaled
   by blow weight, for every titan.
8. **Brightness balance.** Average luminance of each titan at rest within ±15% of each other; 우리's lights may need
   one step down; the Mouth's coils stay darkest on screen.
9. **Test:** a four-titan screenshot reviewed by WJ is the acceptance for this file.
