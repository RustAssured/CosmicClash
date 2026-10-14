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
Materials:                    what it's made of, outside to inside (skin, shell, flesh, crystal, magma, core...)
Palette mood:                 colours and feeling (it must not look like another titan; the checks will say if it does)
How it destroys matter:       crush, burn, shatter, infect, devour, tear... what do its wounds look like?
Signature move:               its one idea, in a sentence (what happens, and why it's scary)
Weakness:                     what happens when it's losing (its failure mode)
Sound:                        e.g. "wet, heavy, a whale's groan", "glass bells under a landslide"
Lore line:                    one or two sentences for its card
Homage notes:                 what it nods to, and how it stays its own (see "Homage" below)
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
| The ship step | `tools/titans/ship.ts` (`npm run titan:ship -- <id>`) |
| The site cards | `tools/site/roster.ts` (run on every `npm run build:site`) |
