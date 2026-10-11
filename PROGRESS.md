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

## Next
- **Gate R1:** WJ plays all six (plus 우리) at the new sizes, look and sound.
- Then a full balance pass.

## History
- Slice Gates A–C delivered (docs/gates/).
- Integration Gates 0, 1, 2A–2D delivered (docs/integration/).
- Decisions D23–D37 in docs/DECISIONS.md.
