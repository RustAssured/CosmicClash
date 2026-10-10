# ADEUK: story teaser (film renderer)

A 61-second story teaser rendered **frame by frame from the site's own story scenes** (`story.js`):
- native 640×360, nearest-neighbour ×3 to 1920×1080, 30 fps;
- 우리's genesis uses the real game matter (`media/story/uri-*.png`).

## Files
- `trailer.html`: the shot list (`shots[]`, durations and text cards) and the frame renderer `window.film.frame(n)`.
- `render.mjs`: drives headless Chromium and pipes raw frames to ffmpeg.
  - `node render.mjs stills 5 11 26` writes stills.
  - `node render.mjs video` writes `video.mp4`.
- `score.py`: synthesizes `score.wav` from `cues.json` (shot starts plus every weld's timestamp). Every clank in the genesis lands on the frame where its chunk welds.
- Mux:
  ```
  ffmpeg -i video.mp4 -i score.wav -c:v copy -c:a aac -b:a 256k -shortest adeuk-story-teaser.mp4
  ```

## Setup
```
npm i @fontsource/jersey-10 @fontsource/silkscreen @fontsource/dotgothic16
```
Link or copy `story.js` and `media/` from the site, serve the folder over http, then run `render.mjs`.

## Editing
- **Change a line:** edit `cards` in the shot.
- **Retime:** change `dur`, rerun `render.mjs` (it rewrites `cues.json`), then rerun `score.py`.
- **Use in the full trailer:** the teaser's cut points (shot starts) are in `cues.json`. Cut gameplay in between **ruin → genesis**, or after **brace**.
