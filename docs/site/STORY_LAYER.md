# Story layer: what changed (handover for Claude Code)

Drop-in on top of the existing site. Plain JS, no dependencies. Nothing in `media/` is needed for the new parts: every new visual is drawn in code as pixel art on small canvases.

## New and changed

### Files
- **`story.js` (new module, loaded after main.js).** It contains:
  - a pixel buffer with palette ramps and 4×4 Bayer dither, matching the game's look;
  - `prologue()`: five scroll-pinned beats, one procedural scene per beat:
    1. distance;
    2. the old titans;
    3. 우리 (two cores in the infinity loop, rubble, command moon on its tether);
    4. the blow (shock ring, debris);
    5. "something felt it" (the sky dragged to the edges, coils over the rim, the maw rising);
  - `scaleReveal()`: a scroll-pinned exponential zoom-out: Earth → the Planet titan → the 640×360 arena (dotted frame) → the Mouth's coil heap, which dwarfs the arena;
  - `edge()`: a full-bleed final-boss teaser (writhing coils on both edges, slime threads, bone thorns, a maw opening from the bottom). The words HUNGER / DEVOURS / ENDS / REPEATS land one at a time;
  - `readout()`: the under-the-hood readout types in.
- **`index.html`:**
  - a "Story" nav link;
  - hero: an 아득 definition line and a sub that sets up the threat;
  - the scroll cue now goes to `#prologue`;
  - new sections `#prologue` and `#scale` (between the hero and `#features`), `.readout` (end of `#features`) and `#edge` (after `#titans`);
  - titan cards gain `.titan-essence` (one word) and `.titan-lore` (one line);
  - the mystery card is now a link to `#edge`.
- **`main.js`:** the background starfield is pulled outward and dims as `#edge` comes into view.
- **`style.css`:** all new rules are appended under `STORY LAYER`.

### Behaviour
- **Reduced motion:** `html.story-static` removes the pinning, shows every beat and caption statically, and holds each canvas on one frame.
- **Performance:**
  - each canvas only animates while on screen (IntersectionObserver);
  - render resolution is about 1/3 to 1/4 of CSS pixels;
  - measured ~56 fps on the scale section and ~53 fps on the Edge (headless, software rendering).

## Copy

All lore lines are **drafts**: the beats, the captions, the essence words and the titan lore. Edit freely. The scene order in `PRO[]` must match the `<li data-beat>` order.

## Ideas not built (yet)
- **Swap the procedural Planet and Supernova in the scale reveal for the real sprites** (`media/titans/planet.png`, `supernova.png`). Draw them with `drawImage` at whole-number scales up to the arena key.
- **A per-titan "matter" stat** on each card, e.g. `MATTER 41,203 px`, read from the game's sprite data. It is a real number, and the best spec you have.
- **Ambient sound on the prologue,** opt-in like the sound feature: a drone plus one late flash, generated with WebAudio in the same style as the game.
- **Replace the trailer** (see TRAILER.md).
