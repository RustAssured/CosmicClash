# PROGRESS

Resume from here.

## Current direction: D34, rebuild from the best of both (2026-10-09)
WJ compared the original six-titan game (6728a3e, the online version; built in `.scratch/orig`) with now
(docs/COMPARISON_ORIGINAL_VS_NOW.md).
- **Keep:** orbit movement, weight, the Witness design, readable wounds.
- **Bring back:**
  - all six titans (the Witness replaces the Last One);
  - original-like sizes;
  - vivid colour, screen-wide effects and flashes (Comfort setting for photosensitivity);
  - a pace in between.
- **Sound:** epic, cosmic, cataclysmic; no thin whistles.
- **Paused:** the 우리 / Mouth integration (MASTER_PROMPT.md). 우리 stays in the game, scaled down; the Mouth is deferred
  (Gate 3A proposal in docs/integration/GATE_3A.md).

## In progress (round R1)
- **S5:** colour and spectacle back (stage palettes, all original stages, screen-wide flashes, bloom; Comfort mode).
- **S2:** the Witness to about 180 px; a plan to scale 우리 to about 200 px (with S4).
- **S3:** the Planet back to 121 px; the returning titans' matchups.
- **S1:** the four returning titans playing properly in the new engine; pace in between; a quick round-robin.
- **S6** (new, audio): the epic sound overhaul.

## Done (S9, D36)
- The colossus is its own titan, `colossus`, shown as The Last One. The original tendril titan is back as `lastone`, shown as The Witness (목격자), with five eyes and an amethyst palette. It plays on the D34 engine at 50 % against the AI (docs/DECISIONS.md D36; stills in docs/gallery/roster/).

## The Mouth (아귀) — S10, D37 (Gate 3A answered: "go with the recommendations")
Playable in Training and vs AI, as the player or the AI; locked out of the normal select until unlocked.
- **Launch:** `?mouth=1` unlocks it in the menus (9th tile of the select). Straight into a fight:
  `?a=mouth&b=lastone&p1=human&p2=ai&stage=mausoleum&mouth=1` (or `mode=training`). Keys (P1): A / D slide the anchor along
  the perimeter (D = clockwise, oracle literal), W / S held at the strike = high / low, J Bite, I Sweep, L Coil & crush.
  Backquote opens its tuning panel (the oracle's five sliders + the Gate 3A numbers).
- **Code:** `src/combat/mouth/` (core = the prototype's crane, deterministic; fighter = the analytic `Fighter`; hurt =
  capsules; geom = the CPU layout; arena = arena B; knobs), `src/render/mouthPass.ts` + `mouthList.ts` (GPU), `src/ai/mouth.ts`,
  `src/ui/mouthHud.ts` (jaw-ring emblem), `src/matter/capsules.ts` (debris vs capsules), `src/titans/mouth/` (def, boss def,
  unlock hook, portrait). Boss for the ladder: `mouthBossDef()` (health ×2, enraged last ring); `setMouthUnlocked(true)`.
- **3B feel:** head path vs the LOCKED oracle frame by frame (tools/mouth/parity.ts --feel=1): bite (all three heights) and coil
  0.000 px apart, sweep ≤ 1.6 px (the approved keep-out band); beats on the oracle's frames (bite +35 / high +36 / low +33,
  sweep +49, crush +64 ticks: src/combat/mouth/mouth.test.ts).
- **3C look:** game (left) vs oracle (right), same script, oracle light rig: docs/gallery/mouth/rest-left / rest-top /
  rest-right / rest-bottom / rest-corner / bite-load / bite-strike / bite-contact / bite-high / bite-low / sweep-mid / coil-mid /
  crush .png. In the game it takes the one titan sky. GPU cost (headless Edge, this Vega 7): +4.0 ms per frame including
  ~2.3 ms of CPU layout, i.e. ≈ 1.8 ms GPU (budget 2 ms); in the real game 6.7 ms per rendered frame vs 7.4 ms with the
  colossus in its place.
- **3D damage and knockouts:** docs/gallery/mouth/damage, ko-drag-convulse / -slack / -dragged, ko-sever-loose / -withdraw .png
  (the oracle's own hits land at random places: compare the kind of damage, not the pixels).
- **3E in the game:** docs/gallery/mouth/ingame-lastone-t150/420/700, ingame-planet-t300/900, ingame-uri-t240/600,
  ingame-colossus-t360 .png (HUD emblem, arena B, the wrap over 우리), select-locked / select-unlocked .png.
  AI vs AI (tools/mouth/duel.ts, L3, every roster titan, both sides, deterministic re-runs): the Mouth wins 20 / 32, the boss
  14 / 16; rounds mostly 20–60 s. No crashes.
- **Open (for WJ):** see the S10 report — the safe strip vs foe width, the light rig, balance, the UtilityAI's play against it.

## Round length and the Mouth's threat (S11)
- **ROUND LENGTH** (Options, under FILL SCREEN): Short / Normal / Long = pace 2.1 / 1.3 / 0.65 and a 90 / 120 / 180 s clock
  (`ROUND_LENGTH_PACE`, `ROUND_LENGTH_SECONDS` in contracts). The app writes the stored choice into the match config
  (`MatchConfig.pace`, `roundSeconds`); each fighter keeps its pace for the match. Short = the D34 feel; the cinema pins it.
  우리's loop and the Mouth's jaw-rings follow the pace at the power 0.7 (`ANALYTIC_PACE_EXP`).
  AI L6 vs L6, seven pairings, median round: Short 43 s, Normal 65 s (×1.5), Long 93 s (×2.2). `tools/lead/roundlen.ts`.
- **The Mouth:** eRef 380, damage taken ×0.9 (at Normal; ×1.4 at Short), power cap 2.5, bite / sweep / crush 760 / 640 / 950,
  coil 90 a tick through Guard (a grab), no wound from its own bite's spray; AI L4–6 space, punish committed foes and grab
  guarding ones. HUD: no ULT strip for a titan without an Ultimate. L6 vs every titan's L6 at Normal: 59 % (0 % vs the Black
  Hole); the boss 85 %.

## Tournament ladder (S12)
Title › TOURNAMENT / 토너먼트: one player climbs eight AI rungs to the boss Mouth (src/ui/ladder.ts order + progress,
src/ui/screens/ladder.ts tower / cards / ending, story lines in src/ui/ladderStory.ts). Beating the Mouth unlocks it
(`setMouthUnlocked(true)`); its own ladder ends at 우리. Progress in localStorage `adeuk.ladder.v1`. Dev flag `?ladder=7`
(`&as=planet`, `&view=card|lose`, `?ladder=end`, `?ladder=select`); stills in docs/gallery/ladder/ (tools/ladder/shots.ts).

## Titan kit (S14)
A new titan is one command: `npm run new:titan -- <id> "<English>" "<한국어>" [--from=blob|planet|…]`, undone with
`--remove <id>`. The roster is one list (src/contracts/roster.ts `ROSTER_IDS`); ids, menus, site cards (generated by
tools/site/roster.ts on every build), press cards / key art and the data-driven checks (src/titans/roster.test.ts: size,
palette clash, AI coverage, replay; balance sweep with `TITAN_BALANCE=1` or `npm run titan:check -- <id>`) read it.
WJ's guide: docs/TITAN_GUIDE.md. Proof (scaffolded, tested, removed): docs/gallery/kit/. The Witness card has its hover clip
(press shot 'witness-card'); the site grid ends on the boss card spanning the free columns.

## The Cradle / 태반체 (S15) — Gate 1 (look and silhouette), waiting for WJ
WJ's brief: docs/titans/cradle/BRIEF.md. The first titan made with the kit (`npm run new:titan -- cradle "The Cradle" "태반체"
--size=large`, blob template), grown into its own painter and rig: src/titans/kit/cradle/paint.ts (`paintCradle`,
`buildCradleRig`; the disc is painted in its own disc space so Gate 2 can billow and tilt it as a sail). Materials:
membrane, vessel, collagen, muscle, bone, sac, lumen (the only cold turquoise, two sacs), core. Accent #9c3048 / #e6c9a8
(nearest other colour: the Nexus red, ΔE 0.12). 243×211 px, class large. Moves, behaviour, voice and HUD resource are still
the blob placeholder's; not in the ladder's opponents.
- **Stills** (docs/gallery/cradle/gate1/, `npx tsx tools/titans/cradle-gate1.ts`): cradle-base-x3 (alone, ×3), cradle-64px
  (the 64 px read, all three variants), cradle-roster-lineup (true relative sizes, ×2), cradle-fight-vs-witness-x3 /
  -vs-planet-x3 (in the game, ×3, `tools/titans/still.ts --w=1920 --h=1080`), cradle-select.
- **Open for WJ:** disc tilt (base "eclipse" vs cradle-sail-x3), tail (hooked, jaw forward, vs cradle-trail-x3, S-curve
  trailing under the body). Also cradle-fight-cord-severed-t240-x3: the blob's blows already cut the cord at its root.
- **WJ, Gate 1 approved:** SAIL disc, TRAIL cord ("weighty, not a string"), the cord severs (deliberately) and regrows wrong,
  surface polish (backlit panels and sacs, knuckled spokes, a heavier knot).

### The Cradle, Gates 2–5 (S15) — waiting for WJ
- **WIP gate (kit-wide):** `kit.wip: true` in a kit titan's JSON keeps it on the roster (every check covers it) but out of
  the menus, the site cards, the press kit / key art and the site's titan count; `?wip=<id>` (or `?wip=all`, `?<id>=1`)
  shows it in the menus. `npm run new:titan` now scaffolds every new titan as WIP (docs/TITAN_GUIDE.md §5). The Cradle is
  WIP; its site art and matter count were taken off the site.
- **Gate 2, motion and rig** (docs/gallery/cradle/gate2/): the knot is the primary body (KO core); the disc and six cord
  links + the jaw-organ are rig regions (src/combat/behaviours/kit/cradle.ts, cradle/rig.ts): the painter cuts them out of
  the composite (joint caps over the seams); the portrait, the size and palette checks read the composite (`rig.portrait`).
  The disc is a sail (slow under-damped drive from its travel); the cord is heavy (×3.2 mass, slow hang drives, a throw
  turns it as one limb, then hands it back slowly). New generic hook `Behaviour.attachHitShape`: the jaw hitboxes ride on
  the real jaw. Moves: Cord Lash, Contraction (crush), Billow (surge), Implant (signature), False Birth (ultimate), Enfold
  (guard). Sheets: lash, contraction, sail-orbit, enfold-guard, sever-regrow; in-game cradle-vs-lastone t150/t420.
- **Severing:** a cord joint parts only after its patch loses most of its matter (<35 %) AND a heavy blow (≥600) has
  landed on that link within 45 ticks, then it strains for 40 ticks (cue `cord-strain`) before it drops with its momentum
  (`cord-sever`); a link gutted to 4 % lets go at once. The cord takes 35 % of a blow's share and does not count toward
  health (a limb and a resource, the HUD's CORD pips). Regrowth: 7 s later, a link every 46 ticks, WRONG (calcified bone
  rings, a solid club for the jaw; blistered with sacs after a second cut); a new round restores it.
- **Gate 3, gestation** (gate3/): every landed blow plants a site in the foe that develops over 1.5 s in the foe's own
  darkest/lightest tones: a capillary web, cartilage ridges across the blow, and after a heavy blow a swollen organ-like
  mass (recoloured only: no mass, no integrity change). Implant: filaments from the spoke tips latch on and keep planting
  for 2.5 s. Its own wounds open developmental chambers (dark walls and a wrong organ: sac with a dark mass, bone
  nodules, a vessel tangle, a core-dark lobe).
- **Gate 4, FALSE BIRTH** (gate4/): the disc spreads as a ribbed translucent membrane over the gap, filaments lock on,
  the membrane closes into an opaque sac that hides the foe and contracts, then tears open (the birth blow) and expels a
  pseudo-organ grown from the foe's own matter (its silhouette malformed, in its colours: pseudo-organs.png), launched
  after it as a matter projectile, then left as an obstacle for 7 s. About 20–40 % of a foe (more on the Nexus).
- **Gate 5** (gate5/): differentiation failure (cradle/wrong.ts): above 75 % nothing; 75–35 % a wrong turn every 1.2–4.5 s
  (membrane → bone, sacs where spokes were, knot muscle → bone, bone → vessel); below 35 % runaway (the knot grows
  tissue on itself, the sail loses its rhythm, the cord's sway quickens); a spoke knocked out regrows 10 s later as a lumpy
  calcified organ with a sac. Voice: src/audio/voices/cradle.ts (whale pulse + wet sail bed, contraction instead of a
  roar, muffled clicks, cartilage crackle, fluid). Balance (`npm run titan:check -- cradle`): 63 % at AI level 4, all
  checks pass; the AI never raises Enfold. Card: WJ's lore line and tagline, mechanic "Gestation."; hover clip rendered
  as a WIP shot (`npx tsx tools/press/clip.ts --wip=1 --only=cradle-card` → gate5/cradle-card-loop.webm, -clip.mp4).
- **SHIPPED (S16)** with `npm run titan:ship -- cradle`: wip off, site portrait + ko-cradle, MATTER 20,975 px (the knot,
  the disc and the cord regions), hover clip site/media/titans/cradle-loop.*, press card + key-art lineup, site cards
  ("Nine colossi"). In every menu. **Not in the ladder's opponents: WJ decides its slot** (TITAN_GUIDE §6).
- Tools: tools/titans/cradle-series.ts (frame sheets with sever / hurt / plant hooks), cradle-jaw.ts (jaw path and cord
  angles), cradle-duel.ts (AI duels, cuts, move use), cradle-organs.ts, author/cradle.ts (the moves).

### The Cradle, WJ playtest round 1 (S15) — docs/gallery/cradle/round1/
- **Cord-cut glitches, two causes, fixed.** (1) A thrown heavy cord could spin a link up past what the XPBD solver holds
  (angles to −1500 rad): a region was dragged 400–900 px off, and with it the fighter's bounds and the camera (6 of 10
  AI fights in tools/titans/cradle-sanity.ts). The behaviour now wraps angles and caps spin (5 rad/s) and speed after every
  rig step, with a rebuild-at-rest fallback (never needed since: 0 recoveries); soft absolute limits on every link,
  regrown ones too. (2) The cut links became ordinary debris, and by their id a third of them took the 2x "near the
  camera" depth class: a cord segment suddenly twice its size, sliding with parallax. `bodyToChunk(…, plane)` and
  `ChunkSpawn.plane` (render-only) keep a severed limb / the pseudo-organ in the fight plane. Severed chunks leave at
  ≤ 380 px/s. Regression test src/combat/cradle.test.ts (sever/regrow cycles + two AI fights that broke before).
- **False Birth rebalanced** (tools/titans/ult-compare.ts; integrity taken from a standing planet / asteroid / Witness /
  Nexus): before 17 / 17 / 16 / 51 (mean 26 %; the earliest build 60–100 %), now 13 / 13 / 14 / 9 (≈13 %; 6 on the
  Supernova, 6 on the Black Hole; the colossus collapses under most ultimates). Roster ultimates for comparison: means
  24–67 %. The birth now lands on the foe's near side; the organ is lighter (a gentle shove) and leaves after 5 s; and an
  ESCAPE WINDOW: a Surge in the sac's first 30 ticks tears out of it (cue `false-birth-torn`): no hold, no birth.
  Balance after: 56 % at AI level 4.
- **The living sail** (cradle/sail.ts, presentation only, tick-driven): contraction waves hub → rim (8 s), panels flap in
  a swell travelling round the disc (13 s), hem ripples (7 s), light travelling with them; half amplitude under attack;
  the disc's rig also breathes (9.5 s + 3.7 s). Clip: round1/sail-idle-9s.webm / .mp4.
- **The pseudo-organ at planetary scale:** 60 px, the foe's silhouette fused with a lobed mass of its own, the foe's colours
  marbled through it with the Cradle's flesh between, broad wet folds with a sheen, a vascular web, calcified nodules, a
  sunk lumen, torn ringed umbilical strands; alive on the field: its veins pulse in slow waves (overlay) and fluid seeps
  from its rim as beads (matter particles). round1/pseudo-organs-before/after.png, false-birth-organ.png.
- **Round 2, the sac** (docs/gallery/cradle/round2/, cradle/falsebirth.ts `drawSac` / `drawRupture`): a translucent
  membrane stretched to bursting round the foe; the foe shows through it in its own colours and presses against it (a
  lit pressure ridge on its outline, a dark crease outside); contraction folds squeezing in pulses with wet lit crests, a
  pulsing vascular web, seven knuckled calcified ribs straining round it like meridians, a wet hem; fluid beads seep at
  the seams. The rupture (birth or escape) peels seven great veined, hemmed, ragged flaps back from the opening, with
  strands stretched between them that snap. The foe reads as trapped inside through the escape window (sac-escape-after).

## S16: the Cradle shipped, select screen, MULJI, titan:ship
- **`npm run titan:ship -- <id>`** (tools/titans/ship.ts, TITAN_GUIDE §5): quick checks → wip off → site art, matter,
  card clip (from a press shot `<id>-card`), press card, key art, site cards → a checklist of what's left. Press shots
  are now one list; a shot with a WIP titan in it is a WIP shot by itself (tools/press/shots.ts); media.ts picks up
  every shipped titan's `<id>-card` clip.
- **Titan select** (src/ui/screens/select.ts `gridOf`): the grid, its names and the prompt are one block centred
  between the panels; ≤9 titans 3×56 px, 10–12 4×42 px, 13–20 5×32 px; a short last row is centred; every tile
  reserves a 14 px name row (우리's Hangeul). select.test.ts checks 1–16 titans. Before / after in every mode:
  docs/gallery/select/ (`npx tsx tools/ui/select-shots.ts --prefix=after`; `&smode=vsai|training` harness flag).
- **MULJI Matter Engine (물질)**: credited in the site's readout, footer, press About, /play/ loading screen, README.

## S17: two tournament modes, difficulty, the COSMIC CLASH wordmark
- **Flow:** Title › TOURNAMENT › join › MODE (CLASSIC / 클래식, COSMIC CLASH / 우주 대결) › DIFFICULTY (EASY / NORMAL /
  TITAN) › a stored run for that pair resumes on the tower, else the titan select (src/ui/screens/tourney.ts).
- **CLASSIC:** 9 rungs, the Cradle at rung 7 ("Then something began to prepare you."), then the Last One and the Mouth.
- **COSMIC CLASH:** every shipped roster titan, no edits: tier-1 openers, a per-run seeded shuffle (the lineup is stored
  with the run), the Last One + Mouth last. NEW tag for `NEW_TITAN_DAYS` (28) after `kit.shippedAt`.
- **Roster data:** `tier`, `shippedAt`, `catalogue` (ADK-001 …, the Cradle ADK-009), stamped by `titan:ship`.
- **Difficulty:** `aiRamp` (EASY ≤ 3, NORMAL the old ramp stretched, TITAN 5 then 6). The boss Mouth on NORMAL / TITAN, the
  normal Mouth on EASY. Beating either mode's Mouth unlocks it.
- **Save:** `adeuk.ladder.v2` (a run per mode + difficulty, best per mode); `adeuk.ladder.v1` migrates once.
- **Wordmark:** src/ui/pixel/cosmicLogo.ts (directions deepfield / nebula / orbit; `COSMIC_STYLE` = nebula). In the mode
  and difficulty screens, on the site under the titan cards (live count from the roster), press/logo/cosmic-clash-logo-x6/12.
- Dev: `?ladder=modes|difficulty|select|N&lmode=cosmic&diff=titan&seed=5`. Stills: docs/gallery/cosmicclash/
  (`npx tsx tools/ladder/shots.ts --set=cosmic`, `npx tsx tools/ui/cosmic-wordmark.ts`).

## S21: a 60 fps floor on WJ's laptop (Ryzen 5 5500U, Vega 7, Edge)
- **Measured for real** (`npm run perf:frames`, tools/perf/frameprof.ts): a production build in a headed Edge window, vsync on,
  ×2 (maximised window) and ×3 (full screen), 4 AI fights + all 9 Ultimates. `--prof=1` = CPU and GPU (timer queries) per
  section (src/render/passProfiler.ts, `?prof=1`). The GPU was never the problem: ≈ 4–5 ms a frame at ×3 (scenery 2.2,
  final 0.5, layers 0.5–1, the rest ≤ 0.3 each). S19's "40 ms GPU-synced" was its own read-back (tools/perf/ultframes.ts).
- **Fixed:** (1) the luminance governor's read-back made the main thread wait for the GPU every frame (6 ms mean, p95 11 ms):
  now off until telemetry / verification asks (`drainLuma`); (2) the 640×360 debris / particle layers and the UI were
  re-uploaded whole every frame (≈ 1.2–1.5 M texels): they hand over dirty rectangles now (`npm run perf:uploads` reads
  every texture back and proves them exact); (3) rarely used passes (the shared VFX, margin, classic bloom) are drawn once at
  load: the first impact's VFX draw stalled 11–21 ms; (4) the titans' big moves are rehearsed on a throwaway match in the
  menus (src/app/rehearsal.ts; ≈ 7 s for the roster, 8 ms a frame), or behind the loading bar if a match starts first
  (≈ 2 s): cold code made each Ultimate's first moments 20–30 ms; (5) the loop snaps vsync jitter (no more 0/2-tick
  judder: 46–113 double-tick frames per 12 s fight → 0–2) and spreads catch-up at 2 ticks a frame (src/engine/loop.ts).
- **Result:** main-thread CPU per frame p95 6–10 ms (was 11–22), every Ultimate and three of four fights with no missed
  vsync at ×2 and ×3 (was 1–3 per Ultimate). Tier stays 1 (auto); tier 2 (opt-in) costs 8.5 ms GPU of scenery.
  `npm run perf:budget` checks it all against tools/perf/budget.json.
- **Left:** one 50 ms frame at the colossus's KO → next round. It's a hard cut, and it's in the budget's known exceptions.
  Diagnosed on 2026-10-14 (tools/perf/budget.json has the numbers): about 20 ms goes to heals of its 19 bodies, and about 13 ms
  to re-creating severed regions from scratch. Part of the cost is cold code (≈ 18 ms in the page's second match).
  Rehearsing round changes doesn't reach those paths. Real fixes, if it's ever worth it:
  - re-use a severed region's Body by restoring it from its snapshot, instead of `createBody`;
  - or regrow severed regions one per tick during the intro.

## S18–S20 (in the commits of 2026-10-14; details in their docs)
- **S18:** cross-engine determinism. The sim uses DMath (src/contracts/dmath.ts), a lint rule bans transcendentals and
  `**` in sim directories, and there is a checksum (docs/netplay/STEP0.md).
- **S19:** Ultimate freezes fixed (effects drawn at render time, overlap memo), an audio dropout fix and guard, SHOW FPS,
  and perf tools.
- **S20:** ONLINE / challenge a friend, with lockstep netplay over WebRTC and a Cloudflare signalling + TURN worker
  (netplay-worker/, docs/netplay/STEP1.md). The worker has been deployed since 2026-10-14
  (`https://adeuk-netplay.wj-games.workers.dev`, set as `NETPLAY_URL`), and both its rooms and TURN answer.
  `?net=local` still gives two-tab local play.

## S22: the new logo (logo D, D38) and the Cradle Child brief
- **Wordmark:** src/ui/pixel/wordmark.ts. ADEUK in cracked gold over TITANS in star-filled chrome (src/ui/pixel/titleType.ts:
  the logotype's letters doubled or tripled before shading), a horizon line of light, the Last One's eye at the centre and
  six beads cut from the original roster's own portraits (Supernova, Nexus, Asteroid | Planet, Black Hole, 우리's moon).
  Sizes: large (press, download), medium (boot and title screens, site hero, /play/ loading page), small (attract
  watermark), inline (one line, the eye as the colon: the site's nav).
- **In the game:** boot, title (아득 under it, then the tagline) and attract. The beads appear once their portraits are warm
  (`UIDeps.portraitsWarm`; the app warms those six titans first), so the first frames never wait on the titan generator.
- **On the site:** hero, nav and the press download (site/media/type/wordmark*.png: `npx tsx tools/site/art.ts --wordmark`).
  Press PNGs: `npx tsx tools/press/wordmark.ts`. Explorations (local, press/ is git-ignored): tools/press/emblem.ts,
  banner.ts, mockup-kit.ts (the kit WJ gave ChatGPT).
- **Kept on the old one-line logotype** (logo.ts): the trailer (src/cinema, tools/press/trailer), the key-art lineup and the
  social card (site/media/og.jpg, tools/site/media.ts). Switch them when those are next re-rendered.
- **Cradle Child / 요람의 아이:** creature brief docs/titans/cradlechild/BRIEF.md (not built). Role (WJ): a secret
  encounter after a tournament won as the Cradle, which unlocks it as a selectable roster titan (the Mouth's unlock,
  generalised). The titan guide's creature
  brief gained two lines: *where its scale lives* and *unfair at / open to*.

## S23: the titan builder (v2) and titan kinds
- **Kinds** (`TITAN_KINDS` in src/contracts/roster.ts; presets in src/titans/kit/kinds.ts): celestial, mineral (rock & metal),
  organic, construct, cosmic (a cosmic being). Authoring only: no gameplay reads it. A kind sets a new blob titan's five
  materials (archetype + ramp around its hue), outline, voice and wake; `npm run new:titan -- … --kind=<kind>` (default
  organic = the old blob, unchanged). Every roster titan is tagged (first guess, for WJ to confirm): Planet, Supernova,
  Black Hole celestial; Asteroid mineral; Cradle, Cradle Child organic; Last One, 우리 construct; Witness, Nexus cosmic.
  Proof: one titan scaffolded per kind passed every roster check (validator, size, AI coverage, replay, painting), then
  removed.
- **Titan builder** (dev/builder/, `npm run dev` → /dev/builder/): live repaint on every slider (×2–4, 1×, 64 px, material
  layers), live size / palette / materials / validator checks, Save (Ctrl+S) through a dev-server bridge
  (tools/builder/plugin.ts: loopback only, header-gated writes, no shell), + New titan, Run titan:check, drafts survive
  reloads. tools/titans/checks.ts gained `checkSizeOf` / `checkPaletteOf` (the same checks on values).
- **Next for the builder:** moves (a frame-data timeline, hitboxes on the sprite), the destruction type (rewrite every
  hitbox's damage type), voice audition, damage states in the page itself.

## S24: key art import (builder Phase 1) and The Remainder / 잔여체
- **Import key art** (BODY › Import key art…; dev/builder/importArt.ts + artImport.ts): mask the creature (auto guess,
  lasso, brush, background samples + cut, core point), then convert: crop and scale to the size class, Kuwahara simplify,
  **region materials** (k-means on colour blended with the surroundings' colour: materials follow the anatomy, because the
  matter world weakens every bond between different materials), up to 3 **vein** materials for colours a region's ramp
  cannot show (glowing, weak seams), hue-shifted ramps from each region's lightness quantiles (dominant hue per step), each
  cell's level within its ramp. Stored as body.json (one byte a cell); painted by src/titans/kit/image.ts through the
  ArtCanvas (stage light on a gentle dome, rim, outline, dither): palette-clean and recolourable. `kit.painter: 'image'`.
- **Brief panel**: docs/titans/<id>/BRIEF.md in the builder, and "Copy packet for Claude".
- **Bridge**: GET/PUT body (body.json + JSON + index.ts + key art), GET/PUT brief. The bridge no longer imports the
  roster contract: vite.config.ts dependencies restart the dev server, and the scaffold edits that file mid-request.
- **The Remainder / 잔여체** (`remainder`, shipped 2026-10-25): the first titan from key art, made entirely in the builder UI (driven by
  Playwright): celestial, large, 163×230 px, materials crust, rubble, membrane, bone, vortex, ichor (vein), spark (vein),
  core. Brief from the user's text with a creature-brief proposal (Compaction signature, Loosening ultimate, Cannibal failure
  mode) in docs/titans/remainder/BRIEF.md; key art beside it; a software-composited fight strip in stills/. All quick
  checks pass. **Open for WJ:** the Korean name (잔여체 proposed), the brief's mechanics. Moves, signature, voice: the blob's.
- Not verified here: the GPU renderer (this sandbox's Chromium never reaches `ready`, for any titan, the Planet included);
  the strip uses the software compositor (tools/titans/strip.ts).
- **The Remainder's living idle** (src/combat/behaviours/kit/remainderIdle.ts, presentation only), reworked on the user's
  note ("a wound in reality that wants to close; it keeps itself open: violent, under stress, sucking in its surroundings"):
  the vortex swirls violently and drains (a flow map: two copies of the motion half a 0.6 s cycle apart, cross-faded per
  cell, so it spins up to 5× faster at the eye and streams inward forever without winding the arms; surges and
  turbulence), closing spasms every ~5.5 s (the eye squeezes, the swirl chokes, then it tears itself open: the eye blown
  wide, a flash through the veins, a burst of speed, the body shaking), the shell round it creeps inward, stress fractures
  crackle along the rim, wreckage orbits decay into the vortex and are consumed, dust streams over the shell into the eye,
  the body twitches (and shakes when hit). Clockwise: the arms wind counter-clockwise outward in the key art (measured), so
  they trail. The body animates on twos (30 Hz; at once on a hit): ≈ 1.2 ms on its frames, 0.05 ms between. Clips
  (tools/titans/clip.ts: the software compositor + ffmpeg, no GPU) in docs/titans/remainder/clips/: idle (gif + mp4), an
  exchange with the Witness, its (placeholder) ultimate on the Planet, and 20 s of AI vs the Nexus.
- **The Remainder's six moves** (the user approved the proposal): Snap, Inhale, Fold, Compaction, Loosening, Hold Shut,
  plus Mass (Hoard) and Cannibal; details, balance and clips in docs/titans/remainder/BRIEF.md. A rigid shell with violence
  inside: no move moves the shell. 8 mechanics tests (src/combat/remainder.test.ts). Balance 65 % at AI level 4 (40 fights).
  Snap reworked twice on the user's notes: a rubber band round the vortex, then the vortex's own pixels warped out of the
  rim (no overlay).
- **The Remainder shipped** (2026-10-25, ADK-010): its AI uses every move (Compaction's slug modelled with
  `extra.aiReach.replace`; `extra.meterGain` stops its TIDAL grabs filling the meter), its own voice
  (src/audio/voices/remainder.ts), `titan:check` counts guard raises. Left: the real-game pass and the hand steps in
  docs/titans/remainder/CHECKLIST.md (hover clip, key art, CLASSIC slot: WJ decides).
- **Builder Phase 2** (2026-10-25): the **motion studio** (▶ Studio, dev/builder/studio.ts) plays any move of the titan
  being edited in the real sim, with a phase-coloured scrub timeline, live hitboxes, a MOVE tab (frame data and hitboxes
  as numbers, re-run on every change), a MOTION tab and NOTES (pinned to a frame, saved with it to
  docs/titans/<id>/NOTES.md as a task list for Claude; tools/builder/notes.ts, bridge `/__builder/notes`). **Animation
  presets** (`kit.motion`, src/combat/behaviours/kit/motion.ts): swirl, pulse, shimmer, stretch, iris, each on one
  material's patches, run by `KitBehaviour.renderLayers` for any kit titan without a hand-written idle; the MOTION panel
  edits them with sliders. Tests: motion.test.ts (6), notes.test.ts (3), the roster checks every kit titan's presets.
- **Next (Phase 3):** a pixel touch-up editor (paint cells and materials), part regions and pivots for motion.

## Next
- **Cradle Child:** WJ answers the brief's open questions, then Gate 1 (body and palette).
- **Netplay:** after WJ pushes and the site redeploys, run a two-machine test (ONLINE › host › send the link to a friend).
- **Gate R1:** WJ plays all six (plus 우리) at the new sizes, look and sound.
- Then a full balance pass.
- Later: "The Observatory / 관측소", the titan-arrival area on the site.

## History
- Slice Gates A–C delivered (docs/gates/).
- Integration Gates 0, 1, 2A–2D delivered (docs/integration/).
- Decisions D23–D37 in docs/DECISIONS.md.
