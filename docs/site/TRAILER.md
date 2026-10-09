# ADEUK: TITANS: trailer plan (v2)

The site now tells a story: distance → the old titans → 우리 → the blow → *something felt it* → scale → the Edge.
The trailer should tell **the same story in the same order**, so the site and the trailer echo each other.

## Why the current trailer feels wrong
- It is 30 s of the **old** URI and the **old** Witness, and they were captured too large (cropped or upscaled).
- The current footage (e.g. ADEUK_FIGHTING.mp4) is a 1262×716 screen recording. That is not a whole-number multiple of 640×360, so pixels get resampled and smeared, and the training overlay and frame data are visible.

## Capture rules (do these first, or every shot will look soft)
1. **Native and clean.** Run the game at 640×360 and record at exactly **1920×1080 (×3)** or **2560×1440 (×4)**, with nearest-neighbour scaling only.
   - Ideally capture straight from the canvas (a `?capture` flag that hides the HUD and writes frames, or OBS window capture of a 1920×1080 borderless window).
2. **Trailer mode in the game** (worth a small dev task):
   - HUD off, training overlay off, frame data off;
   - a fixed or scripted camera;
   - slow motion ×0.25 on demand;
   - an "AI vs AI" seed so a fight can be replayed and re-shot.
3. **Correct scale.** Never crop into a titan. If a titan feels too big on screen, that is the camera's zoom, not the edit. Keep both fighters and the empty space between them in frame; the emptiness *is* the scale.
4. **Encoding.** Use `ffmpeg -sws_flags neighbor`, x264 with `-crf 14 -tune animation`, 60 fps. Also export WebM (VP9) for the site.
5. **Music and sound** come from the game's own synthesized score. Record the audio bus separately so cuts can land on impacts.

## Shot list (≈ 60 s; a 15 s cut-down is listed below)

| # | Time | Picture | Text card | Sound |
|---|------|---------|-----------|-------|
| 1 | 0:00–0:04 | Black. One pixel of light. A second one far away. They touch: a tiny flash. | — | Sub drone; the flash arrives **late** (light-travel delay) |
| 2 | 0:04–0:08 | Hard cut: the same flash, close up. Planet vs Supernova at full arena scale, crust shearing off in slow motion. | `아득` | First impact, huge |
| 3 | 0:08–0:20 | **Roster, one beat per titan (≈1.5 s each)**, each at native scale and each showing its own way of destroying matter: Witness eyes opening in cracks → Planet gravity repacking debris → Asteroid shrapnel → Nexus chain going dark → Black Hole tidal stream → Supernova final nova. | One word each: PERCEPTION · GRAVITY · MOMENTUM · POSSESSION · ABSENCE · SACRIFICE | Score builds; cut on hits |
| 4 | 0:20–0:30 | **우리 / URI.** Load-up, the hips → torso → shoulder chain, a fist landing, the loop flaring as it holds the blow, the command moon swinging on its tether. End on the loop **snapping** and everything flying apart. | `TWO WORLDS. ONE BODY.` then `우리` | Drop the music for the snap. Silence, then debris |
| 5 | 0:30–0:42 | Escalation montage: ultimates, beams across the screen, a titan visibly carved down to its core, the arena littered. Cuts get faster. | `NO HEALTH BARS.` / `YOUR BODY IS THE BAR.` | Full score |
| 6 | 0:42–0:50 | **The turn.** Mid-fight, everything slows. The stars start sliding toward the screen edges. A coil slides along the bottom edge of the frame. Neither fighter notices. | `SOMETHING FELT IT.` | Score cuts out; a low wet sound |
| 7 | 0:50–0:54 | The Mouth's feeding end lunges over the edge in silhouette and then cuts to black **before** it lands. Show the coil and the rings of teeth, never the whole thing. | — | One impact into silence |
| 8 | 0:54–1:00 | Logo, crisp at a whole-number scale. | `ADEUK: TITANS · 아득` / `FREE IN YOUR BROWSER` / `FINAL BOSS: COMING` | Tail of the drone |

### If the Mouth is not in the game yet
For shots 6–7, use the locked **mouth_full.html** prototype (it is the visual oracle) at the same 640×360 scale and composite it over a real fight. Alternatively, record the site's own Edge section, which is pixel art made in code in the same palette. It is a teaser: silhouette and darkness are better than detail.

## 15 s cut (socials)
1 (2 s) → 2 (2 s) → 3, but only URI, Witness and Planet (4.5 s) → 6 (3 s) → 7 (1.5 s) → logo (2 s).

For vertical 9:16, letterbox the 16:9 frame at a whole-number scale inside a 1080×1920 frame, with text above and below. **Do not crop** into the arena.

## On the site
- Until the new trailer exists, consider pointing "Watch the trailer" at the 16 s gameplay loop, or hiding the button. A wrong-scale trailer undercuts the "every pixel is matter" promise more than having no trailer.
- Trailer poster: frame 7 (the coil at the edge) or frame 2 (the first impact). Either beats a title card.
