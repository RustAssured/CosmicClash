# Shared impact & VFX system (all titans)

The prototypes' impact visuals are placeholders (the Mouth's flash is too flat and cartoonish). Build ONE shared VFX
system on the GPU and use it for every titan, so effects never split the cast into four styles.

## Rules
- Pixel art: every effect pixel snapped to the master palette, stepped (no smooth gradients), at native resolution.
- Additive light is allowed for emissive effects, but the result is palette-snapped.
- Effects are layered and timed in frames at 60 fps.

## Impact recipe (scaled by blow weight: light · medium · heavy · catastrophic)
1. **Anticipation (1–2 frames):** a tight bright pinpoint and a 1-frame inward-pulled ring at the contact point.
2. **Core flash (3–5 frames):** irregular, star-shaped burst with 4–6 palette steps (white → pale yellow → orange → red →
   deep red), dithered edge, angular spikes; shrinks and cools frame by frame. Never a flat disc.
3. **Shockwave (8–20 frames):** a screen-space **distortion ring** that bends the background and bodies behind it
   (refraction offset, palette-safe), with a thin bright leading edge; slightly elliptical toward the camera.
4. **Debris (0.5–2 s):** pixel-art sprites with rotation-free stepped frames:
   rock chunks (dark, lit edge), titan-specific matter (Mouth: slime that stretches along its velocity and droops,
   bone splinters that glow briefly; 우리: torn chunks already handled by its matter system; Witness: cells and gold
   fragments), angular sparks. Drag in space, slow, some persist.
5. **Lingering (1–3 s):** low-contrast dust/vapour puffs in palette colours, drifting.
6. **Hitstop & shake:** light 0.04 s / 3 px · medium 0.08 s / 6 px · heavy 0.11 s / 10 px · catastrophic 0.20–0.25 s / 14 px.
7. **Optional, sparingly:** a 1-frame colour shift or palette inversion only on catastrophic hits and knockouts.

## Titan hooks
- Mouth: bite / crush = heavy; knockout = catastrophic; the jaw-rings' grinding emits small bone sparks during hold.
- 우리: punch / cross / uppercut = heavy; double slam = catastrophic (ground shockwave); break-apart = catastrophic.
- Witness and Planet: map their existing hits to the four weights.

## Acceptance
Side-by-side capture of each weight on a neutral background, reviewed by WJ before titans are wired to it.
