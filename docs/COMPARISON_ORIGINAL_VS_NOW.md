# The original six-titan game vs now (2026-10-09)

- **Original:** commit `6728a3e` (= origin/main, the online version), built from `.scratch/orig`.
- **Now:** HEAD.
- **Clips:** deterministic 60 fps, same seed (21) and AI level (4); `evidence/compare/*.mp4`.
- **Stills:** `docs/gallery/compare/original-vs-now.png`.

## Measured (Gate A measured the original; Gate C and 2D measured now)

| | Original | Now |
|---|---|---|
| Titans | 6, each with its own mechanic (Black Hole well, Nexus lattice, Supernova fuel/flares, Asteroid accretion, Planet moons, Last One tendrils) | 2 in the slice (Witness, Planet) + 우리; the other 4 hidden and untuned for the new engine |
| Titan size on a 640×360 screen | about 90–180 px | Witness about 272, 우리 about 300, Planet 180 |
| Movement | side-on classic footwork | 360° orbit |
| Round length | 23 s mean | 51–74 s |
| Contacts per minute | 24 | 9–13 |
| Wounds | instant craters, 98 % dust | crack → hold → shear into slabs (D1) |
| Flashes | full-screen washes (up to 0.32 luminance change) | local light only, ≤ 0.07 |
| Colour | vivid per-stage palettes, bright emissives | one 128-colour master palette with Bayer dither, a highlight ceiling, darker arenas (Mausoleum) |
| Loudness | −17 LUFS, LRA 3.4 (flat, loud) | −21 to −23 LUFS, LRA 13–21 (dynamic) |
| fps / sim p99 | 59.6 / 4.9 ms | 60 / 3.6 ms (slice); 54 fps with 우리 |

## Read
- **Gained:** 360° movement, weight and momentum, the Witness, wounds that read, comfort (no washes), dynamic sound, stability.
- **Lost:**
  1. **Scale and readability:** the titans now fill the frame, and fine pixel detail becomes a blur at ×3.
  2. **Colour and spectacle:** vivid backdrops, bright emissives, Supernova flares and beams. These were muted by the unified palette, the flash rules, the highlight ceiling and darker arenas.
  3. **Variety:** six strange, broken but characterful titans became one curated pair.
  4. **Pace:** from frantic and arcadey to slow and deliberate.
- **The old titans already run in the new engine** (rows 4–5): at their original sizes, with the original backdrop, plus orbit and weight. They still read well.
