# The titan guide

*For WJ: how a new titan gets into ADEUK: TITANS, and how you'll know it's ready.*

Adding a titan is now one command. The command makes a plain placeholder creature that already works:

- it compiles;
- you can pick it in VS AI and Training;
- it passes every check;
- it shows up on the website.

After that, the work is creative: you describe the creature, and Claude (or you) turns the placeholder into it, one part at
a time.

---

## 1. What a titan is made of

Every titan has the same seven parts. A new titan keeps all of its parts in two places:

- its **folder**, `src/titans/kit/<id>/`;
- its **behaviour file**, `src/combat/behaviours/kit/<id>.ts`.

| Part | What it is | Where it lives |
|---|---|---|
| **Body** (art) | The pixel creature. Every pixel is matter that can crack, burn or be torn off. It's painted by a *painter*: code that draws the silhouette, the layers under the skin, the eyes and the core. | `art.params` in its JSON (the shapes and sizes), and its painter (the blob painter, or a template's) |
| **Palette** | Its colours. Each *material* (skin, flesh, markings, eye, core…) has a ramp of 6–8 colours, dark to light. Its **accent** colours are its signature on the HUD, the select screen and the website. | `materials[].visual.ramp` and `ui.accent` / `ui.accent2` |
| **Materials** | What its body is *made of*: how tough each layer is, how heavy, how it burns or shatters. The seams between materials are where it breaks. | `materials[]` (`base` = rock, ice, crystal, iron…; `physics`) |
| **Moves** | Six buttons: Strike, Crush (heavy), Surge (dash), Signature, Ultimate and Guard. Each has its timing in ticks (60 ticks = 1 second), hitboxes (where it hurts), energy (how much) and knockback. | `moves[]` |
| **Signature mechanic** | The one idea only this titan has: the Witness's tendril veil, the Black Hole's feeding, the Supernova's fuel. It's code: one *hook* that runs when the signature move fires. | `src/combat/behaviours/kit/<id>.ts` |
| **AI** | How the computer plays it: aggressive or patient, close or at range. The AI reads the moves itself, so most of the time you only set the personality. | `ai.weights` |
| **Voice** | How it sounds: a low, epic body (no whistles). Four numbers tune it. | `kit.voice` |
| **Card** | Its website card and press card: name, Korean name, the one-word essence, lore, the mechanic line, accents, hover clip. | `kit.site` |

> **Who's who** (D36): the id `colossus` is **The Last One** (마지막 하나), and the id `lastone` is **The Witness** (목격자).
> Ids are internal. The names come from the definitions.

**Not every titan fits the kit.** 우리 (a baked rig), the Mouth (an analytic fighter) and the Last One (many body regions)
are hand-built and stay that way. The kit is for the common case: one body, six moves, one signature idea.

### Kinds: what a titan *is*

Every titan has a **kind** (`kit.kind` in its JSON; the titans before the kit carry theirs in `src/titans/roster.ts`):

| Kind | 종류 | What belongs here | Roster |
|---|---|---|---|
| **Celestial body** | 천체 | Stars, planets, holes in space: round, layered, glowing from within | Planet, Supernova, Black Hole |
| **Rock & metal** (`mineral`) | 암석 | Asteroids, ores, crystal masses: hard, faceted, breaking into shards | Asteroid |
| **Organic** | 생물 | Flesh, membrane, tendrils: soft, lobed, wet, tearing rather than shattering | The Cradle, Cradle Child |
| **Construct** | 구조체 | Idols, engines, made things: glazed, banded, clean seams | The Last One, 우리 |
| **Cosmic being** (`cosmic`) | 우주적 존재 | Watchers, possessors, things with too many eyes: luminous, unsettling | The Witness, the Nexus |

A kind is an **authoring preset, not a gameplay type**. Nothing in a fight reads it: matchups still come only from damage
types against each material's `resist`, which keeps balancing in one place. What a kind does is give a new blob titan a
fitting start (src/titans/kit/kinds.ts):

- the physics archetype and colour ramp of its five materials (skin, flesh, marking, eye, core);
- the outline (lobes, wobble, markings, eyes);
- its voice and its movement wake.

Every one of those numbers stays editable afterwards. From a template (`--from=planet`, …) the kind is only a label.

---

## 2. How to describe a new creature to Claude

Copy this **creature brief**, fill it in and paste it into a session. Short answers are fine. A picture or a sketch helps
even more.

```text
CREATURE BRIEF
Name (English / Korean):      e.g. The Gloop / 글룹
One-word essence:             e.g. appetite   (the Planet is "gravity", the Nexus "possession")
Silhouette:                   the shape in one line. What do you recognise at 64 px?
Size class:                   small (~120 px, like the Planet) / medium (~150-180) / large (~240, like the Last One)
Where its scale lives:        what tells you it's bigger than the screen (the Planet: its gravity and moons; the Mouth:
                              its bulk off-screen). Lore size can be absurd; the body stays in its size class.
Unfair at / open to:          the one thing it gets to be unfair at, and the opening it leaves (balance is allowed to be
                              imperfect, D35, but every titan knows where its edge and its gap are)
Materials:                    what it's made of, outside to inside (skin, shell, flesh, crystal, magma, core...)
Palette mood:                 colours and feeling (it must not look like another titan; the checks will say if it does)
How it destroys matter:       crush, burn, shatter, infect, devour, tear... what do its wounds look like?
Signature move:               its one idea, in a sentence (what happens, and why it's scary)
Weakness:                     what happens when it's losing (its failure mode)
Sound:                        e.g. "wet, heavy, a whale's groan", "glass bells under a landslide"
Lore line:                    one or two sentences for its card
Homage notes:                 what it nods to, and how it stays its own (see "Homage" below)
Kind:                         celestial / mineral (rock & metal) / organic / construct / cosmic (a cosmic being)
Template:                     blob (a fresh creature), or start from: planet / asteroid / nexus / blackhole / supernova / lastone
```

Claude then runs the scaffold (section 5) and shapes the placeholder to fit the brief:

1. the palette and the card copy first;
2. then the body;
3. then the moves and the signature hook;
4. then the voice.

It renders a still after each step so you can look.

### Homage, not copies

WJ's newcomers can nod to films and myths. **A nod is fine. A copy is not.** Before something ships:

- **Names:** never a film creature's name, or a near-spelling of it. Invent one, or use a plain word, or Korean.
- **Silhouettes:** never something you would recognise as the original's outline. Take *one* idea (the way it moves, a
  feeling, a material) and give it a body of its own.
- **Signature details:** no famous markings, logos, trademark weapons or catchphrases.
- **Write it down:** the homage notes go in its JSON (`kit.homage`): what it nods to, and what makes it its own. That
  way, anyone reviewing it later can see the line was thought about.

A good test: if someone who has seen the film looks at the card and says "oh, that's X", it's a copy. If they say
"that reminds me of X", it's a nod.

---

## 3. The numbers worth tweaking

### The titan builder (v2)

The easiest way to tweak them is the **titan builder**, a page in the dev server:

```text
npm run dev, then open http://localhost:5173/dev/builder/
```

- **Pick a titan** (any kit titan) or **+ New titan**: the same scaffold as `npm run new:titan`, with the kind picked from
  cards.
- **Every number has a slider**, and the body repaints as you drag: at ×2–4, at game size and as the 64 px read. Its
  panels are KIND, BODY (the blob's shape; other painters get their raw `art.params`), PALETTE & MATERIALS (a hue shift for
  everything, accents, each material's ramp, archetype, glow, toughness and density), ATTRIBUTES & AI, VOICE, CARD and RAW
  JSON.
- **The checks run live** on every change: size class, palette clash with the roster, every material showing, and the
  definition validator (frame data, slots). **Run titan:check** runs the quick checks (AI coverage, replay) on the saved file.
- **Save** (or Ctrl+S) writes the JSON, prettier-formatted, and the open game tabs reload with it. The **Training**, **VS AI**
  and **Damage states** links open the saved titan.
- Unsaved edits are kept as a draft in the tab, so a reload never loses them. **Revert** goes back to the saved file.

### Import key art (Phase 1)

A blob titan's body can come from **key art** instead of the blob: BODY › **Import key art…** opens the import workspace.

1. **Load the art** (png, jpg or webp; or drop it in). The auto mask is a first guess: anything unlike the frame's border.
   On art whose background shares the creature's colours (nebulae!) it will be wrong, and that is expected.
2. **Mark the creature.** Lasso − across everything, then Lasso + around the creature's outline; Brush + / − for details.
   **Background** samples colours that are not the creature, and **Cut background** removes them from inside the mask.
   **Core** puts the KO anchor (the eye, the heart); Undo goes back.
3. **Convert.** The preview on the right is the game's own painter. The knobs:
   - **size**: its longest side in game px (its size class's default);
   - **materials**: how many body regions; **structure** 1 = regions that follow the anatomy (shell, membrane, vortex),
     0 = plain colour groups. Keep it high: the matter world weakens every bond between two different materials, so
     colour-band materials would make the body crumble along random lines;
   - **veins** (0–3): strongly coloured streaks a region's ramp cannot show become their own glowing materials (and weak
     seams: the body cracks along them);
   - **simplify** flattens painterly texture into clean regions; **vibrance** keeps the colours alive at sprite size;
   - **form light** adds the stage's light on a gentle dome; **dither** blends the ramp steps.
4. **Apply to titan**, then rename the materials in PALETTE (they come named by colour) and pick their physics, then
   **Save**: body.json, its JSON, its index.ts (the image painter, src/titans/kit/image.ts) and the key art
   (docs/titans/<id>/keyart.webp) are written together.

An imported body keeps the art's shading in its material ramps, so PALETTE still recolours it and the stage still lights
it. Its moves, signature and voice are the blob's until they are built. The **BRIEF** panel keeps the creature's description
in docs/titans/<id>/BRIEF.md, and **Copy packet for Claude** puts the brief and the titan's state on the clipboard for a
Claude Code session to take further. The Remainder (docs/titans/remainder/) was the first titan made this way.

It only works with `npm run dev` on your own machine: the dev server saves the files (tools/builder/plugin.ts), and only
for requests from the machine itself. The JSON stays the one source of truth, so everything below still works by hand.

### By hand

All of these are in `src/titans/kit/<id>/<id>.json`. Change one, save, and reload the game.

| What | Where | What it does |
|---|---|---|
| **Attributes** | `attributes` (each 1–10) | `mass`: hard to knock back. `cohesion`: tough matter. `heat`: fire resistance. `gravity`: pulls debris and the foe. `reach`: longer hitboxes. `tempo`: faster wind-ups and movement. |
| **Size** | `art.params.body.rx` / `ry` | The body's radii in pixels. Keep it inside its size class (the checks tell you). |
| **Look** | `art.params` | The blob template: `lobes`, `lobeSize`, `wobble` (organic outline), `skin` (thickness), `markings` / `markingSize`, `eyes` / `eyeR`, `core`. |
| **Colours** | `materials[].visual.ramp`, `ui.accent`, `ui.accent2`, `kit.site.accent*` | Ramps go dark to light. `emissive` (0–60) makes a layer glow. |
| **Toughness** | `materials[].physics` | `toughness` and `density` per layer. |
| **Timing** | `moves[].frame` | `startup` (wind-up), `active`, `recovery`, in ticks (60 = 1 s). The feel targets: a Strike lasts 30–48 ticks, a Crush 72–120, an Ultimate 180–300. The checks enforce them. |
| **Damage** | `moves[].variants.*.hitboxes[].damage.energy` | How hard a blow hits. |
| **Knockback** | `…hitboxes[].knockback` | How far it throws the foe. |
| **Overall power** | `balance.power`, `balance.durability` (0.3–3) | The quickest balance knobs: deal more / take less. |
| **AI personality** | `ai.weights` (0–1) | `aggression`, `patience`, `zoning` (keeps distance), `retreat`, `punish`. |
| **What the AI sees** | `moves[].extra.aiReach` | The AI judges a move by its hitboxes. When the real threat is something else (a launched slug, a body that moves), describe it: a box, a tick window and an energy, per aim. Add `"replace": true` to use it even though the move has hitboxes. |
| **Meter earned** | `moves[].extra.meterGain` | A hit earns ultimate meter by its energy. Scale it down for moves with very large energies (TIDAL grabs), or to `0` so an ultimate cannot refill itself. |
| **Voice** | `kit.voice` | `pitch` (Hz: 30 = a mountain, 120 = a boulder), `grit` (smooth to gritty), `ring` (how it rings when hit), `wet` (reverb). |
| **Signature** | `src/combat/behaviours/kit/<id>.ts` | The placeholder swells for 120 ticks with blows ×1.2. Change the numbers, or describe a new idea to Claude. |

---

## 4. How to test it

Start the game with `play.bat`, or `npm run dev` (it opens `http://localhost:5173`).

- **Training** (the titan against a dummy, frame data on screen):
  `http://localhost:5173/?mode=training&a=<id>&b=planet`
- **VS AI** (you against the computer):
  `http://localhost:5173/?a=<id>&b=planet&p1=human&p2=ai`
- **Watch two AIs fight it**: `http://localhost:5173/?mode=aivai&a=<id>&b=nexus&ai=4`
- **The select screen**: `http://localhost:5173/?mode=select`. It's on the menu like any other titan.
- Swap `b=` for any other titan, and add `&stage=rim` (or `nursery`, `redgiant`, `quasar`, `tussenruimte`, `mausoleum`,
  `shearfield`).

And from a terminal:

```text
npm run titan:check -- <id>                the full report: size, palette, AI coverage, replay, balance sweep
npx tsx tools/titans/still.ts <id>         stills of it in a real fight + the select screen (docs/gallery/kit/)
npx tsx tools/titans/clip.ts out.gif --a=<id> --b=planet --script0="20:crush"   a clip of a fight (.gif / .mp4 / .webm; no GPU)
npx vitest run src/titans                  the fast checks for every titan
```

**Online play needs identical maths on every browser:** in a titan's painter and behaviour, write `DMath.sin` / `cos` /
`atan2` / `hypot` / `pow` / `exp` (from `@/contracts/dmath`) and `sq(x)` instead of `Math.sin` … and `x ** 2`; `npm run lint`
flags any slip (docs/netplay/STEP0.md).

---

## 5. The commands

```text
npm run new:titan -- <id> "<English Name>" "<Korean name>"                 a blob creature (default)
npm run new:titan -- <id> "<English Name>" "<Korean name>" --from=planet   start from an existing titan
    options: --size=small|medium|large  --hue=0..359  --stage=rim  --essence=<word>
             --kind=celestial|mineral|organic|construct|cosmic   (§1 "Kinds"; default organic, the plain blob)
npm run new:titan -- --remove <id>                                          take it out again, cleanly
```

- The **id** is internal: short, lowercase, no spaces (`gloop`, `terra`).
- The **names** are what players see.
- **Colours:** the scaffold picks the hue farthest from every other titan's colours, unless you give `--hue`.

The scaffold does all of this:

- It writes the titan's own files: its JSON, its folder's `index.ts`, and its behaviour file.
- It adds the id to **the roster** (`src/contracts/roster.ts`). That's the one list everything else reads: the menus, the
  checks, the website and the press kit.
- It registers the titan's painter and behaviour, next to the roster.
- It draws the titan's website portrait and its Korean name, counts its matter, and regenerates the website's titan cards.

**A new titan starts as work in progress** (`"wip": true` in its JSON's `kit` block). It is on the roster, so every check
covers it, but it stays out of the menus, the website cards, the press kit and the site's titan count, so an unfinished
titan can't go live when the repo is pushed. To see it in the menus, add `?wip=<id>` to the URL (or `?wip=all`, or
`?<id>=1`). Direct fight links (`?a=<id>…`) work as before.

**Shipping it is one command** (when WJ says so):

```text
npm run titan:ship -- <id>                 take a WIP titan public
    options: --no-keyart   skip the key-art lineup (slow: it renders on the GPU)
             --render-clip render its hover-clip shot first if it isn't rendered yet (a few minutes)
             --force       ship even if a check fails
```

It does, in order:

1. runs its quick checks (`titan:check -- <id> --quick`: size, palette, AI coverage, replay) and stops if one fails;
2. deletes `"wip": true` from its JSON: from now on it's in the menus, the website, the press kit and the titan count;
3. regenerates everything made from the roster:
   - its website portrait and Korean name, and its MATTER count;
   - its website hover clip, if it has a press shot named `<id>-card` in `tools/press/shots.ts` (the shot moves into the
     press list by itself once the titan ships) and that shot is rendered: the web loop is encoded and `kit.site.clip`
     switched on;
   - its press card and the key-art lineup (only where the local `press/` folder exists);
   - the website's titan cards and the "Nine colossi…" count;
   It also stamps its ship date and catalogue number into its JSON (`kit.shippedAt`, `kit.catalogue`: §6);
4. prints what's left by hand: usually a CLASSIC ladder slot (§6, WJ's call; COSMIC CLASH takes it by itself), a
   hover-clip shot if there is none, a look at the select screen and the website, and the commit.

Running it again on a shipped titan just regenerates its outputs. The Cradle was the first titan shipped this way.

---

## 6. Adding it to the tournament

The tournament is `src/ui/ladder.ts`. It has two modes (and three difficulties, EASY / NORMAL / TITAN, for both):

**COSMIC CLASH / 우주 대결 (no edit needed).** Every shipped titan is in it automatically. Shipping does it:

- `titan:ship` stamps `kit.shippedAt` (today) and `kit.catalogue` (the next number: ADK-010, ADK-011, …).
- For its first four weeks (`NEW_TITAN_DAYS`) it wears a **NEW** tag in the COSMIC CLASH lineup.
- Where it lands in the order depends on its **tier** (`kit.tier`, 1–5; the scaffold sets it from the size class):
  - tier 1 titans open the ladder;
  - everyone else is shuffled into the middle (a new order every run);
  - the Last One and the Mouth always come last.
- Set `kit.tier` in its JSON to move it: 1 = an opener, 2–3 = the middle, 4 = heavy.
- The "N TITANS · GROWING" badge in the game and on the site counts it too.

**CLASSIC / 클래식 (WJ's curated ladder, a hand edit).** The story ladder, nine rungs in a set order. A new titan can
already *climb* it (pick it under CLASSIC), but it is not one of its *opponents* until WJ gives it a slot:

1. Add its id to `LADDER_ORDER`, in the place you want it (the order is easiest first; the Last One stays last).
2. Give it a stage in `LADDER_STAGE` (without one it fights on its own home stage, `kit.stage`).
3. Optionally, give it a story line in `src/ui/ladderStory.ts` (`RUNG_LINES`), e.g. *"Then something crawled out of the
   dark."* Without one, it gets "Then another came."

> Adding a CLASSIC regular makes that ladder one rung longer. The AI ramp stretches to fit by itself (`aiRamp`), and the
> tower shrinks its rows to fit. Players' runs in progress keep going; a stored run is rebuilt from the new order.

---

## 7. What "ready to ship" means

A titan ships when all of these are true.

1. **The checks pass**: `npx vitest run` is green. Every roster titan is checked automatically:
   - it fits the arena and its size class;
   - its colours don't clash with another titan's signature;
   - the AI can use every move;
   - a replayed fight gives the same result twice.
2. **It's balanced**: `npm run titan:check -- <id>` puts its win rate against the roster between **25 % and 75 %**, and
   the AI uses every attack.
3. **It looks like itself**:
   - its own painter or real art, not the placeholder blob;
   - it reads at 64 px;
   - its wounds look like *its* matter breaking.
4. **It plays like itself**: its signature hook does its idea, not the placeholder swell.
5. **It sounds like itself**: its voice is tuned, or it has its own voice file. It's low and epic.
6. **Its card is written**:
   - essence, lore and mechanic line;
   - its website portrait (`npm run site:art -- --only=<id>`);
   - optionally a hover clip (`kit.site.clip`, recorded with `tools/press/clip.ts` and `npm run site:media titans`).
7. **The homage is clean**: section 2, with the notes filled in.
8. **WJ has played it**: in Training and VS AI, against at least three titans.

---

## Appendix: where everything is

| Thing | File |
|---|---|
| The roster (the one list) | `src/contracts/roster.ts` |
| Card copy and size class of the titans before the kit | `src/titans/roster.ts` |
| Kit titans | `src/titans/kit/<id>/` (+ the registry `src/titans/kit/index.ts`) |
| The blob painter | `src/titans/kit/blob.ts` |
| Behaviours | `src/combat/behaviours/kit/<id>.ts` (base: `kit/base.ts`) |
| The kit voice | `src/audio/voices/kitVoice.ts` |
| The checks | `src/titans/roster.test.ts`, `tools/titans/checks.ts`, `tools/titans/check.ts` |
| The scaffold | `tools/titans/new.ts` |
| Kinds (presets) | `src/titans/kit/kinds.ts` (the list: `TITAN_KINDS` in `src/contracts/roster.ts`) |
| The titan builder | `dev/builder/` (page), `tools/builder/plugin.ts` (the dev server's file bridge) |
| Key art import | `dev/builder/artImport.ts` (art → cells and materials), `src/titans/kit/image.ts` (the image painter) |
| The ship step | `tools/titans/ship.ts` (`npm run titan:ship -- <id>`) |
| The site cards | `tools/site/roster.ts` (run on every `npm run build:site`) |
