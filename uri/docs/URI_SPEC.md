# 우리 (URI) — The Refusal · canonical spec v2 (LOCKED)

> Two dismantled worlds and their surviving civilizations, forcibly held in a combat anatomy by an
> infinity-shaped containment system, continuously fighting both cosmic horrors and its own collapse.

Status: **locked** — look, anatomy, motion character and damage behaviour are approved.
The oracle for every question this document doesn't answer: `reference/demos/uri-LOCKED-kinetic-pass.html`.

---

## 1. Identity (canon, condensed)

- **Role in the cast:** Witness = perception · Planet = nature · Mouth = hunger · **우리 = refusal**.
- **Emotional read:** "That could kill a god" — and immediately — "that thing should not survive another ten seconds."
- **What it is:** a war-body, an ark and a coffin. Two inhabited worlds, doomed to be eaten, dismantled
  themselves and forced their matter, moons, megastructures, populations and world-cores into one body.
  It should not physically work; it keeps existing because entire civilizations refuse to let it fall apart.
- **Silhouette archetype:** a floating fortress-boxer. Broad, upper-body heavy, huge fists, no legs.
  Compact and dense, even though made of separate masses held by fields. A crab-like read is accepted.
- **Avoid:** mech/Gundam/knight tropes, faces, cockpits, clean symmetry, chest-paired orbs, skyline
  shoulders, human legs, polished armour, anything that makes it look stable by nature.

## 2. Visual canon

### 2.1 Silhouette and rest pose
- The rest pose **is** `reference/uri_front_reference.png`. At rest the rig covers the reference
  silhouette with **100% overlap** (`data/uri_silhouette_rest.png`; dark recesses inside the masses
  count as body; real gaps between arms and body and between the pylons stay open).
- Always seen from the front. It never turns its back and is **never mirrored** (see §5).

### 2.2 Anatomy (13 parts)
| # | Part | Notes |
|---|---|---|
| 1–2 | propulsion pylons L/R | stabilization engines, not legs; independently thrusting |
| 3 | pelvis / hip mass | the root; centre-of-mass repositioning, not human hips |
| 4–5 | upper arms L/R | hang from inside the shoulder domes; mostly hidden at rest |
| 6–7 | shoulder domes (arks) L/R | civilization habitats: buried lights, trenches, antenna forests |
| 8 | barycentric chamber | open containment chamber; cradles the two world-cores |
| 9–10 | forearms L/R | heavier than the upper arms |
| 11–12 | fists L/R | weaponized rubble: clusters of separate blocks that compress when striking |
| 13 | command moon | small, off-centre, sensor slit; a head that is not a face |

Plus, drawn live: **hot core** (large, molten, lower right), **cold core** (small, spectral, upper left),
the **infinity loop** (one continuous load-balancing path around and between them, white-hot crossing)
and an orbit ring around the hot core. **The cores never leave their cradles.**

### 2.3 Materials and light
- Per pixel, from the reference where the reference shows it: crevices (dark), lit edges, warm civilization
  lights (emissive), blue glows (emissive), warm-lit vs cool-lit faces, large-scale form light.
- Where a part was hidden at rest (upper arms, undersides): procedural matter in the same language —
  plates split along break lines, darker crevices, sparse lights.
- Two stone ramps (warm umber `s1`, cool lavender `s2`, 11 steps each), emissive sets for civilization
  light, field blue, hot core, cold core. Palette discipline: no colours outside these ramps.
- Lighting: one sky, upper-left-front. At rest the reference's own form light dominates; the further a
  part rotates, the more live normal-based lighting takes over (`wForm = 0.82·max(0,cos θ)³`).
- Every part outlined in its own darker colour; a 1-px dark outer outline; cast shadows from front
  parts onto parts behind (offset 3 px right, 4 px down, ×0.68); bloom on emissives only.

## 3. Technique: pixel matter on a rig

- **Pixel art is bound to the parts.** Each part is a grid of pixel matter in its own local space
  (`data/uri_rig.json`). Craters, cracks and torn-out chunks live in that grid and travel with the part.
- **The rig carries only position and rotation.** It draws nothing itself.
- **Rotation without smear:** each screen pixel samples the part at 4 sub-positions and keeps the
  majority (≥2 of 4), else stays empty. Unrotated parts are copied 1:1.
- **Per-part data fields** (all base64, row-major, `w×h`):
  `mat` (material code), `surf` (1 warm / 2 cool), `tone`, `form` (reference form light), `nx/ny/nz`
  (normals; `(v-128)/120`, `nz/250`), `edge` (distance to the part edge), `chunk` (uint16 chunk id),
  plus `pivX/pivY` (local pivot), `pg` (pivot in reference coords), `joints.a/.b` (bone ends), `nchunk`.
- **Material codes:** 1 rock · 2 field glow · 3 civilization light · 7 exposed habitat (wound) ·
  8 crack · 9 sensor slit · 10 crevice.
- **Coordinates:** reference space is 403×368; the body origin is (200,170), drawn at screen (320,186)
  on a 640×360 game screen. 우리 is ~300 px tall, ~400 px wide at native scale.

## 4. The rig

Hierarchy (2D transforms composed parent→child):
```
hips (pelvis centre)  ── pylons L/R (+ their own vectoring angle)
 └─ torso (chamber, pivot just above the pelvis) ── cores, loop, command-moon anchor
     ├─ dome L (pivot at its inner-lower edge, + slide dx) ── upper arm L (shoulder) ── forearm L (elbow) ── fist L (wrist)
     └─ dome R (same)                                     ── upper arm R            ── forearm R          ── fist R
```
- Draw order (back→front): pylons, pelvis, upper arms, domes, chamber (+ loop back half, cores, loop front
  half), forearms, fists, command moon. **During the cross-body smash the crossing arm is drawn after
  everything else** so it passes in front of the chamber.
- The command moon is **not** a rigid child: it is tethered by gravity (§6.6).

## 5. Side convention (important — the pose sheets get this wrong)

- 우리 is always seen from the front. Which arm acts is decided by **where the opponent is**, never by a label.
- Opponent on the right → the screen-right arm leads (straight punch, uppercut); the screen-left arm is
  the rear arm (cross-body smash). Opponent on the left → exactly the reverse. Above → the arm on the
  opponent's side uppercuts. Below → double slam.
- **No mirroring of the sprite.** Each arm keeps its identity and its damage; the cores keep their places
  (hot lower-right, cold upper-left) in every situation. The pose sheets' "mirrored example" flips the
  cores — that is wrong.
- The pose sheets label arms by screen side and mix perspectives; use them for gesture only.

## 6. Motion

**Design rule: authored motion defines the gesture; physics defines the consequence.**
우리 is a civilization-scale war-body suppressing physics while barely surviving its own momentum.

### 6.1 Links
Every degree of freedom is a link with mass, stiffness, damping, an acceleration limit and joint limits:
root (hx, hy, ha), torso (ta), dome L/R (angle da, slide dx), shoulder/elbow/wrist per arm (s, e, w),
fist compression per fist (c). Mass classes: very high (root, torso, arks, fists) · high (upper arms,
pylons) · medium (forearms) · low (command moon). Values in `TUNING.md`.
Integrated at 120 Hz (semi-implicit), drawn at 30 fps.

### 6.2 Damping character
Root and torso near-critically damped; arks slightly under; arms restrained; fists the most kinetic but
settle in one or two heavy cycles. **Never springy.** Moves accelerate heavily and decelerate gradually.

### 6.3 Moves are intent
A move = phases, each with authored body goals (root, torso, arks), **authored arm angles**, fist
compression, regional stiffness, and (for striking phases) an aim point. The solver corrects the authored
arm pose toward the target by only **14%** (level targets) up to **28%** (steep targets).
Targets outside a move's cone are clamped; the arm never hyperextends.

Every move has five beats: **load → commitment → impact → follow-through → taper**.
- **Impact happens when the striking arms actually arrive** at their pose (joint-space error < 22),
  or after a timeout — never on a clock alone.
- **Impact redistributes, it doesn't invent:** striking arms keep only 12% of their speed, fists jump to
  maximum compression, hitstop, shockwave, debris. Root/torso kicks are small; most of the energy goes
  into the loop, the cores, the pylons.
- **Taper is a featured phase:** layered settling — fist first, then arm, then ark, then torso/root,
  with loop, cores and command moon last and slowest.
- A new move started during a taper grows out of the current motion state (no reset to neutral).

### 6.4 The four locked moves
| Move | Arm | Personality | Hitstop |
|---|---|---|---|
| Straight punch | lead | linear mass delivery: load → drive → hard stop → long taper | 0.12 s |
| Cross-body smash | rear | rotational torque barely contained: coil away → release across the chamber | 0.14 s |
| Double slam (flagship) | both | load down → rise (body first, arms later) → stiff apex hold → body drops first, arms come over → geological impact → 2.3 s layered taper | 0.24 s |
| Uppercut | lead | pylon-loaded launch: sink → launch up → keeps drifting up after impact | 0.12 s |
"Best move for the target": elevation > 40° → uppercut, < −38° → slam, else punch/cross.

### 6.5 Counter-torque, internalized
The arms' angular momentum and the fists' velocity react back into the body, but **mostly inside it**:
only a small fraction turns the torso/root; the rest shows as pylon thrust, loop strain, core jolt in the
cradles and a small answer from the opposite ark. The spectacle is "look how much force it suppresses",
not "look how much it spins".

### 6.6 Systems that carry the physics story
- **Pylons:** each fires independently from a correction vector (drift, spin, commitment, suppressed
  torque), harder on the side that must suppress the torque, sustained through the taper; smooth, never
  flickering. A damaged pylon compensates less → the body turns longer.
- **Infinity loop = inertial nervous system:** tightens during load, the load-side lobe stretches and the
  other tightens during commitment, the crossing shears with rotation, vertical breathing with vertical
  acceleration; impact flare and kick; rings down slowly during the taper (longer than the arm).
  It is also the **health readout** (§7).
- **Cores:** jolt and shake in their cradles on impact; never leave them.
- **Fists:** pieces visibly draw together when committing (spread 1.14 rest → 0.78–0.8 commit → 0.74 at
  impact); the field between pieces lights blue when tight; they open slowly afterwards. No scaling.
- **Command moon:** pulled along by the torso's gravity, not carried: lags, swings a little, settles;
  the pull grows with distance; never trails more than 12 px; turns with the torso a beat late. A head,
  not a ball.

## 7. Damage and breaking

- **Health is the loop:** loop integrity starts at 100 and drops 3 × power per hit. With damage the loop
  thins, flickers and turbulates, the cores drift further, the debris thickens, settling gets worse.
- **Hits tear real chunks** (each part is pre-split into irregular chunks, ~8–11 px): the struck chunk
  tears out as a tumbling piece with its own colours; heavy hits take neighbours too; the wound left
  behind glows (exposed habitat / cracks).
- **Load-bearing connections:** shoulder, elbow, wrist and pylon root each have a neck. If a neck's
  integrity drops below 0.38, everything hanging from it drifts away whole.
- **50% rule:** a limb/pylon/moon that loses half of itself is let go in pieces. Domes and chamber stay.
- **Damage degrades control:** damaged arms get less stiffness (×0.7–1) and damping (×0.55–1);
  damaged arks overshoot more; damaged pylons compensate less.
- **Break apart** (loop at 0): the loop snaps (white flash, ring), time slows to 0.3×, every part flies
  apart into its chunks slowly, around the two cores, which stay in place, dimmed and flickering.

## 8. Scale
At native scale 우리 is ~300 px tall. Next to it: the Witness at about the same height but spread wide and
light; the Planet ~124 px across (우리 ≈ 2.5× its diameter — consider enlarging the Planet if it must read
as an equal). See `reference/demos/uri-at-scale.html`.

## 9. Diagnostics and tuning (keep in the game build as a debug toggle)
Overlay: centre of mass, barycentre, target vector + attack cone, pylon thrust vectors, angular
velocities, torque, loop stress, fist spread, neck-integrity bars.
Sliders: stiffness, damping, mass, counter-torque, pylon compensation, loop deformation, hitstop.

## 10. Open items (not locked)
- Cancel windows / input buffering (gameplay layer; visual must still grow out of the current state).
- Automatic retargeting when a target leaves the move's cone mid-attack.
- Motion smears on fists/forearms at peak speed only (stepped echoes in field blue, debris streaks;
  never on torso/arks, never in idle or taper).
- Slam arms pass in front of the chamber when coming over (no depth in the front view) — accepted for now.
- Optional: true pose-sheet moves (grapple/crush, diving plunge, anti-air) using the same grammar.
- Bring the Witness and the Planet in line (technique, palette discipline, weight).

## 11. Acceptance
- At rest: silhouette overlap with `data/uri_silhouette_rest.png` = 100%; side-by-side with the locked
  demo is indistinguishable.
- Each move: same phases, timing within ±1 frame at 30 fps, same impact moment rule, same taper layering.
- Side convention correct for opponent left/right/above/below; cores never move sides.
- Damage: chunks tear, necks fail, loop health drives the visuals, break-apart around fixed cores.
- Never: springy bounce, the body thrown around by its own limbs, mirrored sprite, smeared rotation.
