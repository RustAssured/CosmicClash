# CREATURE BRIEF: THE REMAINDER / 잔여체

From the user, 2026-10-24: key art and a short summary. Imported into the titan builder as the first titan made from key art
(Phase 1: art and brief intake). Its living idle, its six moves and its own voice are built, and it shipped on 2026-10-25 (ADK-010). The real-game pass
is [CHECKLIST.md](CHECKLIST.md).

**Clips:** [clips/](clips/) (idle, an exchange, the ultimate, an AI fight). **Key art:** [keyart.webp](keyart.webp) (the original is 1122×1402). Imported with the lasso around the creature, the core in
the vortex's eye, 5 regions + 2 veins.

**Name:** THE REMAINDER / 잔여체 (*janyeoche*, "residual body", rhyming with the Cradle's 태반체). The Korean is a proposal:
WJ's call.

**Essence:** survival

**Signature idea:** *A wound in reality that learned to fear closing.*

## Description (as given)

**Lore.** Born when spacetime tore open and an unstable wormhole failed to close, The Remainder spent eons gathering planets,
dust, and wreckage to keep itself from collapsing. Over time, that survival process became awareness — and awareness became
fear. It does not conquer or hate; it simply understands death now, and will do anything to continue existing.

**Attack style.** It fights through gravitational desperation rather than brute force: dragging debris into orbit, ripping
matter from the arena, compacting stolen mass into projectiles or armor, and briefly loosening control of its wormhole core to
pull enemies inward. At low health it becomes more defensive and frantic, cannibalizing surroundings and even its own outer
shell to reinforce the core.

## Creature brief (docs/TITAN_GUIDE.md §2)
- **Silhouette:** a ragged shield of pale bone and dark wreckage around a violet-and-green spiral with a black eye; bone
  horns at the top, dripping wreckage below. At 64 px: **pale jagged rim + spiral + black centre.**
- **Size class:** large (163×230 px imported).
- **Where its scale lives:** the captured planets embedded in its shell (each one a world) and the debris it drags into orbit.
- **Unfair at / open to:** unfair at turning the arena's debris (and the foe's lost matter) into armour and projectiles; open
  when it loosens the core to pull: the eye is exposed for that moment.
- **Materials (outside to inside):** crust (dark wreckage), bone (pale webbed shell), membrane (mauve tissue), vortex (the
  violet disk), ichor and spark veins (green and magenta glow), core (the black eye).
- **Palette mood:** bone white and soot over violet and acid green; cosmic, sick, desperate. Not the Witness's amethyst: the
  green veins and the bone are its own.
- **How it destroys matter:** TIDAL: it rips matter loose and compacts it. Wounds should look like torn wreckage and leaking
  ichor.
- **Signature move:** *Compaction*: stolen mass is compressed into armour plates on its shell or thrown as a dense projectile.
- **Ultimate idea:** *Loosening*: it lets the wormhole open for a moment and pulls the foe inward, exposing its own core.
- **Weakness (failure mode):** *Cannibal*: below about a third of its mass it eats its own shell to reinforce the core:
  harder to kill, but slower, smaller and frantic.
- **Sound:** a low gravitational hum with grinding wreckage and a sucking inhale when it pulls.
- **Lore line:** "A wound in reality that learned to fear closing."
- **Homage notes:** none known: an original creature. Watch the overlap with the roster instead: the Black Hole already
  swallows streams of matter and the Planet already gathers debris into orbit. The Remainder's own idea is **compaction and
  self-cannibalism**; keep that at the centre.
- **Kind:** celestial (a wormhole plus captured worlds; its awareness is lore).
- **Template:** blob behaviour for now; its body is imported art (src/titans/kit/image.ts).

## The moves (built 2026-10-25, the user's go-ahead on the proposal)

**The idea: a rigid shell with violence inside.** The body never swings, leans or lunges: every attack erupts out of the
vortex. Data: tools/titans/author/remainder.ts → remainder.json; mechanics: src/combat/behaviours/kit/remainder.ts; drawing:
remainderFx.ts and remainderIdle.ts. Clips: [clips/moves/](clips/moves/) and [the reel](clips/remainder-moves-reel.mp4).

| Button | Move | What you see | What it does |
|---|---|---|---|
| Strike | **Snap** / 낚아채기 | a rubber band round the whole vortex: the eye cocks, the vortex itself is warped out of the rim like a rubber sheet into a taut tongue (its own live pixels: the rim becomes the band and runs tangent off the circle, the arms and the eye drag out into streaks), cracks at the aim, then snaps back so the vortex dents and wobbles, dragging the foe's own colours home | 9 / 4 / 26 ticks, 166 px reach; TIDAL along the whip and a grab at the tip, a KINETIC crack; yanks the foe a little |
| Crush | **Inhale** / 들이킴 | the tell (vortex spins up and darkens, the eye widens, a cone of dust rushes in), then the yank and two toothed bone mandibles slamming shut at the rim | 28 / 12 / 50; the foe is pulled toward the eye for 8 ticks (and loose debris with it), then a CRUSH bite |
| Surge | **Fold** / 접힘 | the body twists down into its own eye, a tear of light closes where it was, it unfolds out of a second tear | 4 / 14 / 16; intangible ticks 2–16 |
| Signature | **Compaction** / 압축 | hold: compression rings close on the eye, matter spirals into a slug growing there; forward / up it fires (a muzzle ring, a comet trail), down it grinds bone plates onto the shell | hold up to 1 s; 1–3 Mass pips by charge; the slug is real matter (a launched chunk: one KINETIC blow); plates are grown bone cells |
| Ultimate | **Loosening** / 풀림 | the wound tears open over the whole shell, light cracks run outward, debris streams in from all round; then it slams shut (an iris of bone, a ring of light, a shockwave) | 40 / 150 / 50; a gravity well drags the foe and debris in, the eye shreds what reaches it; **while open its core is exposed: a blow that reaches the eye lands twice** |
| Guard | **Hold Shut** / 닫힘 | an iris of bone petals closes over the vortex (seams of light, a slit at the centre), plates grind round the rim | strong vs KINETIC / CRUSH, weak vs TIDAL / ASSIMILATION; each swallowed blow is +0.3 Mass |

- **Mass / 질량** (5 pips, starts at 2): Hoard: what Snap, Inhale and Loosening tear off the foe (4 % of a foe ≈ 1 pip), and
  blows swallowed while holding shut. Compaction spends it.
- **Cannibal** (failure mode, below 34 % mass): every 0.75 s it tears a mouthful of its own shell loose toward the eye and
  grows a little core from it (a quarter at most: starving, not healing); tempo ×1.18, speed ×1.1, Hold Shut ×0.55, the
  vortex frantic. (The first version grew more than it ate: caught by its test, fixed.)
- **Stats:** mass 7, cohesion 6, heat 6, gravity 9, reach 7, tempo 4; `balance` power 0.72, durability 0.75.
- **Balance** (`npm run titan:check -- remainder --fights=2`, AI level 4, 40 fights): **65 %**, in the 25–75 % band. Pacing
  (share of an idle foe): Snap 0.4–3 %, Inhale 3–9 %, Compaction 6–10 %, Loosening 12–38 % (the Nexus resists it most, the
  Planet least).
- **AI** (2026-10-25): it does raise Hold Shut (about 3 times a fight, ~5 blocks each); the check report said "never used"
  only because raising a guard is a state, not a move event (`checks.ts` now counts it). Compaction was starved (0.3 a
  minute): its JSON describes only the muzzle blast, so the AI never saw the slug. `extra.aiReach` with `replace` now
  models the slug's flight (1.5 a minute). Loosening came round every 30 s: its TIDAL energies are large, and meter is
  earned per unit of energy, so one grab filled half the meter; `extra.meterGain` scales it (Snap 0.15, Inhale 0.2,
  Loosening 0), now about 0.8 a minute like the others. Balance after: 65 % (20 fights).
- **Voice** (`src/audio/voices/remainder.ts`): a beating drone (two sines a hair apart) and a wavering breath that strain
  as it is hurt and muffle while held shut; a sound for each move, cue and the KO (the wound finally closing). Nothing
  above 2 kHz in a real fight render ([clips/remainder-voice-fight.m4a](clips/remainder-voice-fight.m4a)). Its fights
  measure −17.5 LUFS against the −20 target, from the matter they tear loose more than from the voice (the Cradle's
  measures −22).
