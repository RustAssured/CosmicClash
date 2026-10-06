# GATE 3A — the Mouth (아귀): decisions before code

**Status:** proposal for WJ. Written by S3 (the Mouth's builder). No code was changed.

**Read for this:**
- `MASTER_PROMPT.md` Phase 3;
- `mouth/README.md`, `MOUTH_SPEC.md` (§4–9) and `MOUTH_TUNING.md`;
- `shared/*.md`; `docs/integration/GATE_0.md`; D31–D33.

**Played:** both oracles, headless (`.scratch/mouth/play.ts`): rest, Bite, Coil & crush, a high Sweep and a corner slide. Stills are in `.scratch/mouth/shots/`.

**Numbers:** every number below is from `MOUTH_TUNING.md`, from the prototype source (`mouth/src/30_mouth_core_motion_damage.js`, cited as *proto*) or from our engine. Anything else is marked **to tune**.

**Two facts set the frame for everything below:**
1. **The prototype's arena is its screen** (proto `W=640, H=360`; the perimeter is the canvas rectangle). Ours is a 1600×560 `ArenaInfo` seen through a 640×360 camera that never zooms out (D5).
2. **The Mouth is not matter.** Every other titan is hit as pixel matter (`DamageEvent` → craters, slabs). The Mouth is analytic: hp 100 and capsules.

---

## 1. Arena edge vs camera (spec §9.1)

**The problem.** The anchor lives on the arena boundary, and the anchored edge must always be in view.
- Our arenas (the Mausoleum and the Shearfield both use `DEFAULT_ARENA`): x 0–1600, y 0–560, rest altitude 290, soft walls 120.
- The view is 640×360. The top and bottom edges are 560 px apart, so they can never be on screen together.
- The perimeter is 2·(1600+560) = 4320 px. At the slide speed of 243 px/s, a full lap takes about 18 s.

| Option | What it is | For | Against |
|---|---|---|---|
| **A. Screen arena** | When the Mouth plays, the arena is 640×360 and the camera is fixed: the prototype exactly | 1:1 with the oracle; the coils always half off-screen | Three titans 180–300 px tall in a 640×360 box; no travel; Shearfield comets cross it in about 3 s |
| **B. Rim arena + edge-keeping camera** (recommended) | The arena keeps its width (1600) but is 360 tall when the Mouth plays (y = restY ± 180, i.e. 110–470). The camera's y is locked; its x follows the fight with one extra rule: the anchor must stay in view | Top and bottom edges are both always on screen, so coils bleed off the top or bottom exactly as in the oracle; horizontal travel and scrolling stay; perimeter 3920 px, about 16 s a lap | A Mouth match is shorter in height for the foe (the Witness is about 272 px, 우리 about 300) |
| **C. Full arena + framing rule only** | 1600×560 kept; the camera adds the anchor as a third framing target | No arena change | On the top or bottom edge, the other edge and the foe can't both be framed; the camera would have to scroll vertically away from the anchor, or crop the foe |

**Recommendation: B.**
- **Arena:** a `StageInfo` keeps its scenery. A Mouth match takes `arenaFor(stage, 'mouth')`: same x range, y = restY ± 180, soft walls unchanged.
- **Camera rule, in the order applied:**
  1. Frame both fighters' live bounds as now (S1's frame tether). The Mouth's bounds are its head + neck + the visible part of its coils, clipped to the arena.
  2. Keep the anchor in view:
     - side edge (left/right): the view's x0 (or x1) is clamped to that wall;
     - top/bottom edge: the anchor's x stays inside [x0 + 70, x1 − 70], our existing `safeMarginX`.
  3. The foe is tethered to the anchor's view. With a side anchor that means foe x ≤ wall + 640 − margin (this replaces `MAX_FIGHTER_DX` for this pair).
     - The anchor slides at 243 px/s, ×0.2 during a strike. A foe can push the view along only as fast as the Mouth follows. That is the Mouth's pressure: "encroachment".
- **Overflowing coils (WJ loves titans that overflow the screen):**
  - The coils' depths are −130…+8 px, i.e. beyond the edge, so on a side or top/bottom anchor they always run off-screen.
  - Recommendation: draw them past the arena edge at no cost. They are cosmetic beyond the edge (no hurtbox there, see §2).

**Diagram (option B, anchor on the left wall):**

```
 x0=0                                     x1=640   (view, y locked 110..470)
  ┌────────────────────────────────────────┐
  │▓▓coils▓▓╲                               │  ▓ = coils beyond/at the edge (draw past the frame)
  │▓▓▓▓▓▓▓▓▓ ═══neck════╗                   │
  │▓▓▓▓anchor           ╚═〇 head      ●foe │  foe x ≤ 640 − margin (anchor tether)
  │▓▓▓▓▓▓▓▓▓                                │
  └────────────────────────────────────────┘
       exit point = edge + 48 px inward;  Bite reach ≤ 520 × 0.9 = 468 px (high ×1.12, low ×0.88)
```

## 2. Hurtboxes and hitboxes (spec §9.2)

**The prototype** (proto `hitAt`): the nearest of three:
- head: distance < Rh·1.35 = 78 px (Rh 58);
- neck: within 22 px of a strand sample;
- coil: within 40 px of a coil sample.

**Proposal: an additive contract for an analytic fighter.** (This is the Lead's contract, Gate 0 §2 "capsule hurtboxes".)

```ts
interface Capsule { x0: number; y0: number; x1: number; y1: number; r: number; part: 'head' | 'neck' | 'coil'; index: number }
// FighterImpl / Behaviour:
hurtCapsules?(out: Capsule[]): number;   // this tick's capsules, world space
```

**The capsules:**
- **Head:** one capsule along the funnel axis, from lips to funnel base. r = Rh = 58, so the reach to its far edge ≈ the prototype's 1.35·Rh; **exact length to tune**, funnel length 1.9 Rh = 110 px.
- **Neck:** 23 capsules between the 24 neck samples. r = braid radius at that sample (25 − 7f)·vol, plus about one strand radius. That gives about 20–28 px, and the spec's neck is 40–55 px thick.
  - Each capsule's `stretched` flag is the beat (strike / bite / hold / recover / sweep / release, per the prototype).
- **Coils:** capsules along the visible coil polyline, **only inside the arena**. r = 40, the prototype's coil hit radius. The parts beyond the edge are not hittable.

**How our attacks resolve against capsules:**
- **Probing:** `fighter.probe(shape)` on the Mouth returns a synthetic `OverlapResult`:
  - analytic overlap of the `DamageShape` (point, line, cone, ring, field) with each capsule;
  - "cells" = overlapped area in px², so `strike()`, `deepestBite` and graze rules keep working unchanged.
- **Receiving:** `receive(ev)` maps the event to the prototype's damage model.
  - The part is the capsule with the deepest overlap.
  - `power = ev.energy / E_REF`, with **E_REF to tune**. The prototype's power is 1–2 per blow.
  - Damage: head −4·power (teeth snap, ring chip; ring hp 5), neck −5·power (×1.6 stretched), coil −2·power. Strands sever at 2.5 accumulated; ≥ 3 severed at KO gives the severed knockout.
  - CONTINUOUS beams (the Witness's gaze, the Planet's Magma Vent) apply per tick with `power × duration share`, **to tune**.
  - Damage type: no resist table on flesh at first; one multiplier per type, all 1.0, **to tune** in Phase 4.
- **Knockback and hitstop:**
  - The Mouth's anchor never moves from a blow.
  - The head and neck take the impulse as a velocity kick into their springs. The head spring is k 28 in moves and 7·track at rest (ζ 0.9); the neck springs are k 150·…. A blow visibly shoves the head and the neck absorbs it.
  - The weight ladder from proposal 171 applies.

**The Mouth's hitboxes** ("only on the mouth during bite/crush beats"):
- **Bite beat and the Sweep's bite beat:** a `point` CRUSH at the mouth centre, r = lip ring ≈ 58 px (head ≈ 116 px across). Energy **to tune**. Heavy weight (VFX_SPEC: bite = heavy).
- **Crush beat:** see §3.
- Nothing during load, strike, reach or recover. The strike's travel does not hurt; only the snap does.

**Debris and comets (D30) against the Mouth:**
- **Recommendation:** an additive matter API, `setCapsules(slot, capsules)`. The world tests chunks against those capsules with the same D30 rules:
  - wound only by the chunk's own speed > 120 px/s and mass > 1.2;
  - fresh slabs bounce;
  - the impact goes to the fighter as `receive()`, at coil −2·power if it hits a coil.
- The alternative is for the behaviour to query `chunksInShape` per capsule every tick (an API that exists). It works, but it can't make chunks bounce, so debris would pass through the Mouth.
- **Risk:** Shearfield comets enter from the side edges (`hazards.ts`, one every 5–7 s), right where a side-anchored Mouth's coils lie. **To tune:** coil damage from comets, or coils on the comet's own path only.

## 3. Coil & crush (spec §9.3)

**Beats:** reach .36 · coil .70 · crush .40 · release .80 s (`MOUTH_TUNING`).
- In the prototype the head circles the target, radius 75 → 40 during coil and 40 during crush. The target is locked at command time. The neck does not wrap (seen in the greybox still).

**Proposal:**
- **Grab check, at the end of the reach beat:**
  - the grab box is a circle at the locked target, r = 75 (the prototype's coil radius at its start);
  - the grab succeeds if it overlaps the foe's live bounds;
  - otherwise the move continues as a whiff, with release as its recovery and the ×1.6 stretched-neck punish window.
- **Held, during coil + crush (1.1 s):**
  - The foe is held. Its footwork input is ignored and its root is pulled toward the coil centre by a critically damped spring. **Stiffness to tune**, inside the scale spec (≤ 4 Hz).
  - It can still turn, guard and act. Guard halves crush damage, **to tune**.
- **Escape (recommended):** two ways out, both diegetic.
  1. During the **coil** beat, a **Surge** in the first half (0.35 s) breaks free. The foe dashes out and the Mouth recoils into a long release.
  2. At any time, neck damage on the wrapped third that reaches a threshold (**to tune**, e.g. 1.5 strand-sever units) breaks the grip. Every hit there counts ×1.6 (stretched).
  - The crush beat itself can't be escaped by input.
- **Damage:**
  - **Coil:** a light CRUSH `ring` around the foe every N ticks (**to tune**). Our `ring` shape is an annulus, so on matter titans it scars the whole rim. On the Planet it knocks out moons and strips the ring.
  - **Crush:** one heavy CRUSH ring (VFX heavy), r0/r1 = foe radius ∓ the strand thickness. Energy **to tune**.
  - On the Witness, the ring hits whichever of its 24 regions it overlaps (the existing multi-body routing).
  - On 우리, the ring tears chunks through its chunk ids (Phase 2's damage model).
- **The visible wrap (the last third of the neck):**
  - Neck samples 16–23 are re-targeted onto a helix around the foe's live-bounds circle: radius = foe radius + about 26 px (strand radius 14.5 − 4.5f at the tip).
  - It takes 1.7 turns, matching the prototype's 1.7·π sweep of the head.
  - Each sample alternates depth: front half over the foe, back half behind it. The neck is drawn in two passes around the foe's layer.
  - The authored curve of samples 0–15 stays as it is; only the tail third wraps.
- **Per titan:**

| Foe | Ring radius | Notes |
|---|---|---|
| Planet (180 px) | about 90 + 26 px | Moons in the ring are struck too; the Planet's Brace can't turn while held (**to decide**) |
| Witness | 272 px tall | The ring can't fit the whole body. Wrap the carapace: centre on the eye, radius = carapace half-size. The arms stay outside |
| 우리 | about 300 px tall | Same: wrap the torso and core. The arms and command moon stay outside |

## 4. Corners (spec §9.4)

**The prototype:** corners rounded with a normal blend over 110 px; slide ×0.55 near a corner; the neck exits 48 px inward along the blended normal.

**Proposal:**
- **Minimum head distance:**
  - The head's intent is projected out of a keep-out band along the perimeter: distance from the coil polyline ≥ coil radius 40 + Rh 58 = 98 px. That rule follows from the prototype's sizes; **to tune**.
  - At a corner the band is the union of both edges' bands. The head is pushed out along the corner's blended normal, so it never tucks behind its own coils.
  - The neck's base samples stay pinned (as in the prototype). The neck curve bends round the band rather than through it.
- **Draw order, fixed:**
  - coils (darkest, nearest the edge) → neck → head (always last; brightest, strongest silhouette, spec §3);
  - the foe is between the coils and the neck, except for the wrap's back half (§3);
  - depth seams where neck strands cross the coils (the RENDERING spec's tube depth buffer).
  - In our layer bands: coils z 1, neck z 2, head z 3 inside the titan body band (0 ≤ z < 10).

## 5. WJ's health readout (D31-3: not a health bar)

| Option | Readout | For | Against |
|---|---|---|---|
| **A. The four jaw-rings** (recommended) | HUD emblem: the four rings seen face-on. Each ring is 25 % of health; it loses arc as health falls and breaks when its quarter is gone. On the body, the rings chip and break in step with the emblem | Iconic, anatomy-true; readable at a glance (4 big parts, then arcs); the prototype already chips and breaks rings | In the prototype only head hits chip rings. Making the rings the readout means every hit (neck, coil) chips the ring of the current quarter. A small departure, flagged |
| B. Neck cross-section | Eight strand dots in a ring; strands tear (dim) and sever (gone); health = strand integrity | Matches the severed-knockout rule (≥ 3 strands) | Abstract; 8 small dots are hard to read; head hits don't show |
| C. Teeth count | Throat rows of teeth snap | Grim, diegetic | Too fine at 640×360; teeth are inside the throat, often hidden |

**Recommendation: A.**
- **HUD:** the Mouth's slot shows the ring emblem where the others have a bar, in the same frame. `integrityPct` stays the number the round logic reads (KO at 0, best of three).
- The neck's severed strands are shown as small marks under the emblem, because they decide the knockout type.
- This needs the per-titan health model the Lead planned in Phase 1 (Gate 0 §2): the fighter view's integrity comes from the behaviour.

## 6. Input mapping (D31-2: unbound if nothing maps)

| Mouth action | Our input | Keyboard P1 | Pad (Nintendo positions) | Oracle |
|---|---|---|---|---|
| Slide | stick X | A / D | left stick | A/D, stick |
| Height (held at the strike) | stick Y up / neutral / down | W / – / S | stick up/down | W/S |
| **Bite** | Strike | J | Y (west) | J / A |
| **Sweep** | Crush | I | X (north) | K / X |
| **Coil & crush** | Signature | L | A (east) | L / B |
| Surge, Guard, Ultimate, Gravity, Feint | unbound | – | – | – |

- **Slide direction: two options.**
  - **(a)** The oracle literal: A/D move the anchor along the perimeter clockwise/counter-clockwise. That is needed for 3B parity with the greybox.
  - **(b)** Screen-relative: the stick projected on the edge tangent, so on a side wall up/down slides. That conflicts with up/down for height.
  - **Recommendation:** (a) for Gates 3B–3E; offer (b) only if WJ finds sliding on side walls confusing.
- **Keyboard:** the oracle's K (Sweep) is our Surge key. Our layout puts Crush on I, so Sweep is I.

## 7. Feel and balance risks against the other three

| Risk | Why | Mitigation (to tune in 3E / Phase 4 with the debug overlay) |
|---|---|---|
| **Reach** | 520 × 0.9 = 468 px straight; high ×1.12 = 524, low ×0.88 = 412. From a side wall it covers most of a 640 px view | The foe tether (§1) keeps the foe on screen, but the foe must be able to stand out of range. Mitigation: allow a 640 − 468 ≈ 170 px safe strip at the far side, or cap the reach to the view |
| **Tell vs dodge** | Bite load .42 s + strike .18/1.18 = .15 s ≈ .57 s from command to bite, with the path drawn. No homing | Measure each titan's lateral escape distance in .57 s; the slowest is the risk (the Witness colossus: its sidestep carries 70 % of the Last One's) |
| **Punish window** | Recover .70 s with ×1.6 neck damage; the neck is the long, hittable part | Most foes' heavy moves have 0.3–0.6 s anticipation (SLICE_PLAN §6), so a heavy only lands if started early. Check that each titan has one punish that fits .70 s at 470 px from its own body |
| **Health scale** | The Mouth has hp 100; matter titans lose mass. One blow's energy → power needs one E_REF | Tune E_REF so a heavy blow ≈ power 2, the prototype's top click |
| **Damage per bite** | Not in the pack | To tune: set it so a bite removes about one heavy blow's matter (D30 parity) |
| **Grab lock** | 1.1 s held on a 24-region Witness or a 300 px 우리 | The escape window (§3); the crush can be guarded |
| **Comets and debris** | Side-wall coils sit where comets enter (Shearfield); the Planet's well pulls debris | D30 speed rule plus coil −2·power; watch attrition per round |
| **Performance** | The prototype draws in 30–45 ms on the CPU; the budget is ≤ 2 ms on the GPU (spec §9.6) | 3C on the GPU from the start; the sim side is about 50 capsules per tick (cheap) |

## Decisions asked of WJ

1. **Arena (§1):** B, a 1600×360 rim arena with an edge-keeping camera? (Or A or C.)
2. **Hurtboxes (§2):** the capsule set and the analytic-fighter contract. And debris: matter-side `setCapsules` (bounces), or behaviour-side queries (no bounce)?
3. **Coil & crush (§3):** the grab circle r 75, the two escapes (Surge in the first 0.35 s of coil, or neck damage on the wrap), the wrap on the carapace or torso for the big titans.
4. **Corners (§4):** the 98 px keep-out band and the fixed draw order.
5. **Health (§5):** the jaw-ring emblem, with every hit chipping the current ring?
6. **Input (§6):** Bite/Sweep/Coil on Strike/Crush/Signature, the oracle-literal slide, the rest unbound?
7. **Risks (§7):** keep a safe strip at the far side of the view, or let the reach cover the whole view?
