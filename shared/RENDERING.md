# Rendering requirement (all titans)

All prototypes are CPU look-development renderers (per-pixel JavaScript). They are the **visual oracles**, not the
runtime. In the game:
- Render titans on the **GPU** (WebGL2/WebGPU or the engine's shader pipeline) into a **native 640×360** target, then
  upscale with integer nearest-neighbour.
- 우리: parts as textures (matter, normals, form light, chunk ids) drawn with the 4-sample majority rotation rule in a
  fragment shader; chunk tearing writes into the part textures.
- Mouth: strands as instanced round-tube segments (capsule impostors) with the flesh shading in a shader; rings, teeth,
  claws instanced; noise as textures; depth buffer for crossings; throat clipped to the mouth opening.
- Palette snapping + Bayer dithering as a final pass (shared master palette).
- **Budget:** ≤ 2 ms per titan, ≤ 6 ms for two titans + effects + background at 60 fps on the target machine.
- Keep the prototype tuning panels as an in-game debug overlay (toggle), so feel can be tuned during real matches.
