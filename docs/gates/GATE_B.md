# GATE B â€” feel graybox (current art)

**Status: waiting for WJ to play.** Phase 1 is integrated: the feel, D1â€“D7 and the camera are done on the *current* Last One
and Planet art. The Witness rebuild is Phase 2; see Â§5 for its sheets.

Every number below is a real-time run on this machine (Vega 7, ANGLE/D3D11, **true 1920Ã—1080, Ã—3**) or a deterministic headless
run. Sources are in `docs/gates/evidence/gate-b/*.json`. The tests pass; see Â§6.

## 1. How to play

```bash
npm run build
npx vite preview --port 4173
```

Open the game in Edge/Chrome and press **F11**. A windowed browser drops the pixel scale to Ã—2. The cursor hides itself after 1.5 s.

| URL | What it is |
|---|---|
| <http://localhost:4173> | The game, through the menus. Only the Last One and the Planet are offered; `?full=1` shows all six. |
| <http://localhost:4173/?orbit=1> | **Orbital footwork**: the stick thrusts mostly around the foe, momentum carries. Menus as usual. |
| <http://localhost:4173/?orbit=1&zdepth=1> | Orbit plus the **depth offset**: Surge can carry a titan in front of or behind the other. |
| <http://localhost:4173/?orbit=1&push=1> | Orbit plus the **sprite push**: a â‰¤10 % sharp-bilinear zoom of the sprites on heavy windups. Without it, only the scenery pushes in. |
| `â€¦&tele=1` (on a direct-match URL, e.g. <http://localhost:4173/?mode=fight&a=lastone&b=planet&p1=human&p2=ai&tele=1&orbit=1>) | A two-line telemetry strip at the bottom: latency, wound timing, loudness, fps. |

**Controller**: pair the Switch Pro over Bluetooth, then open **Controller Check** from the title menu and confirm that every
button and both sticks map as labelled. Default layout:

| Button | Action |
|---|---|
| Y | Strike |
| X | Crush |
| B | Surge |
| A | Signature (hold) |
| ZR | Ultimate |
| ZL | Guard |
| L / R | Feint |
| + | Pause |
| âˆ’ | Training overlay |

(R1 becomes Gravity for the Planet in Phase 2.)

## 2. Footage

The clips are in `evidence/gate-b/` (MP4 next to each WebM). The strips are in `evidence/gate-b/strips/`.

> **The recorder costs 12â€“20 fps on this iGPU at 1080p.** Clips run at about 39â€“47 fps, so they show hitches the game does not
> have: the game itself runs at 59.4â€“59.8 fps (Â§3). Judge smoothness by playing, not from the clips. Phase 2 adds a deterministic
> 60 fps reference render for the clips.

| Clip | Look for |
|---|---|
| `moves-lastone.mp4` | **Shatter Blow at ~0.5 s.** 0â€“370 ms the body loads and twists back; 370â€“500 ms it commits about 125 px; contact at ~500 ms with an 8-tick stop; blue slabs peel off the Planet over the next ~250 ms. **Gaze at ~3.5 s.** **Sidestep at ~6.5 s.** The **tendrils** are curved and tapered now, not rods (D3). |
| `moves-planet.mp4` | **Impact at ~0.5 s.** It now connects from 230 px (it missed at Gate A). The world spins up, the Last One is shoved and tilted, and dark slabs tumble off. Input-frame telegraphs on every press: aurora flare, ring tightening, moon swinging ahead. **Cataclysm**: the quake is a local light, never a white frame. |
| `aivai-classic.mp4` | Classic footwork, AI vs AI, 60 s: camera push-in on windups, a lagged pull-back, a parallax kick, wounds left on the bodies. |
| `aivai-orbit.mp4` | Orbital footwork: circling, closing, slingshot passes. |
| `aivai-orbit-z.mp4` | Plus the depth offset. |
| `aivai-orbit-push.mp4` | Plus the sprite push (A/B against `aivai-orbit.mp4`; the fights are identical, only the rendering differs). |

What I saw in the strips: Shatter (`moves-lastone-shatter.png`) and Impact (`moves-planet-impact.png`) now read as
load â†’ commit â†’ recover, with momentum. The wounds are bites with flying slabs, not vanishing hemispheres. The scenery dolly
is strong (see `aivai-orbit-z-lastone-crush.png`). **At contact the attacker covers about half of its target for ~250 ms**;
I'd like your eye on that (it is the "bodies overlap in the centre" part of D4).

## 3. Numbers vs Â§4

| Target | Gate A | Gate B | |
|---|---|---|---|
| Input â†’ first visible response â‰¤ 1 frame | first pixel 18â€“36 ms median, tails 86â€“158 ms | **The sim responds on the input's own tick: 45 of 45 commands, both titans** (`feel` events). Wall clock from key event to frame submit: median 18 ms (Last One) and 22 ms (Planet). That is the floor here: the wait for the next frame plus the draw. | âœ“ |
| Settle 0.35â€“1.2 s, with overshoot | 0.38â€“1.85 s | Strike 0.80â€“1.07 s; Surge 0.65â€“0.97 s; heavies settle 0.1â€“0.4 s after their own 1.4â€“1.8 s move ends; steering 1.47 s from the press (key held 300 ms). The Planet's light commands never "settle": its spin and orbit keep it moving. | ~ |
| Heavy anticipation 0.3â€“0.6 s, total 1.0â€“2.0 s, feint window | Impact anticipation 0.67 s | Shatter 0.50 / 1.37 s; Impact 0.57 / 1.63 s; feint in the first 40 % | âœ“ |
| Crack on the impact frame; shear 80â€“300 ms; slabs not dust | half the 1.5 s loss in one tick, 98 % dust | Hairline crack on the impact frame. **Shear median 133â€“150 ms in live fights.** The largest one-tick loss is 5â€“12 % of the 1.5 s loss (headless, 20 fights). Slabs carry 99â€“101 % of the wound's momentum, spinning by lever arm (S4 bench). | âœ“ |
| Impact FX peak â‰¤ 100 ms; occluding FX clear â‰¤ 400 ms | clear ~1.7 s | Live AI fight: **peak median 83 ms, clear median 300 ms** (17/19 â‰¤ 400, max 414). Scripted Shatter/Impact clear in 213â€“219 ms. | âœ“ |
| Off-axis hits rotate by lever arm; centre/edge/glancing/low differ | no angular state | Real impulse at the contact point. Centre = shove (spin âˆ’0.01 rad/s), edge = 0.51 rad/s, low = âˆ’0.90 rad/s plus lift (S1 measurements). Hit-stop is capped at 8 ticks, so momentum carries the weight. | âœ“ |
| Flashes: Î” full-frame luminance â‰¤ 20 %, â‰¤ 3/s | 0.32 | **â‰¤ 0.16 in every run, 0 flashes/s.** The KO is a local light plus a thin refraction ripple. | âœ“ |
| Audio: âˆ’23â€¦âˆ’18 LUFS, TP â‰¤ âˆ’1 dBTP, impact â‰¥ 10 dB over bed, duck 4â€“8 dB, LRA â‰¥ 10 | âˆ’17 / âˆ’3.7 / 13â€“15 / 1 dB / 3.4 | 3-min fight: **âˆ’19.0 LUFS, âˆ’1.2 dBTP, impact +15 dB (short-term), duck 7 dB, LRA 20.4.** 60 s classic fights âˆ’17.5 to âˆ’18.6, LRA 9.3â€“9.8. **Orbit fights run hot: âˆ’15.5 to âˆ’17.6** (denser contact). | ~ |
| Round 45â€“90 s, fewer and heavier contacts | 23.4 s, 9.2 contacts | Headless, 20 fights: **22.4 s classic, 24.4 s orbit; 9.4â€“10 contacts per round.** Not fixed. See Â§4. | âœ— |
| Matchup 45â€“55 % (equal level) | Last One 43 % | **Classic: Last One 24 â€“ Planet 22 rounds (52 %).** Orbit: 62 % Last One. | âœ“ / ~ |
| 60 fps at 1080p | 59.6 at Ã—2 (not 1080p) | **59.4â€“59.5 fps mean, 1 % low 24.5â€“25.6, 22â€“31 frames > 25 ms per 60 s** | ~ |
| Sim p99 â‰¤ 5 ms per tick | 4.9 ms | **Headless (pure sim): p99 3.6 ms** âœ“. In the browser, where GC pauses and main-thread contention count: p99 6.1â€“7.0 ms. | ~ |
| No GC pause > 4 ms in a 3-min fight | 6 > 4 ms, max 14 ms | 460 pauses, **8 > 4 ms, max 12.2 ms** | âœ— |

## 4. Known issues (not hidden)

1. **Rounds are still ~22â€“24 s.**
   - Making bodies tougher only adds contacts (tried: 28 s rounds with 11.7 contacts), which goes against "fewer, heavier".
   - The real lever is how often the AI commits: about 25 contacts per minute now, against roughly 8â€“10 needed. That means patience, spacing and feints, not damage numbers.
   - This is Phase 2 work for S1. The damage knobs only fixed the balance: Last One durability 1.1, Planet power 0.95.
2. **Performance headroom is thin.**
   - Browser sim p99 is 6â€“7 ms. Its biggest costs are the behaviours' pixel drawing inside the sim tick: the Last One's tendrils 0.56 ms mean, the Planet's cloud redraw p99 2 ms.
   - GC pauses (8 over 4 ms) come from per-event allocations.
   - Phase 3 work: move the drawing to render time, and pool allocations.
3. **Recording costs 12â€“20 fps.** That is why the clips are choppier than the game; see Â§2.
4. **Overlapping wounds shed one after another.** Five simultaneous blows on one body take ~2 s to separate fully; one blow takes ~250 ms. To revisit with S4.
5. **The Planet's spin is hard to read in stills.** Judge it in motion.
6. **The Brace prototype mirrors the baked sunlight** at the turn's midpoint. A cloud sheet hides it, but watch for a light pop.
7. **The orbit-mode balance (62 %) and loudness (âˆ’15.5 LUFS)** are tuned for classic. Once you choose the footwork model, they get tuned for it.
8. **The 1341 KB bundle warning** (from Vite; harmless).

## 5. The Witness, so far (offline; not in the game yet)

The sheets are in `docs/gallery/wip/`. My notes are in `docs/briefs/witness-art-notes.md`.

- `witness-nursery-3x.png`, `witness-nursery-vs-planet.png` (true scale), `witness-nursery-1x-thumb.png` (the 64 px test),
  `witness-nursery-cutaways.png` (the four reveal layers).
- `witness-motion-turn.png`: the rig turning. The eye leads in 0â€“1 ticks, then the carapace, shrine and halo; the arms lag; it settles at 0.95 s.

**My read:**
- **Right:**
  - the vertical silhouette, at 1.49Ã— the Planet;
  - the eye as the event;
  - the hanging spire chandelier;
  - the broken halo;
  - no red anywhere.
- **Not yet:**
  - the arms are short claws that read a little like spider legs (the concept's scythes sweep far out);
  - the top halo arc reads as a flat bar;
  - the spires are short.

## 6. What changed in Phase 1

- **S1 (feel).**
  - Every command moves a drawn pixel on its own tick, with feel accept/respond/settle events.
  - Impacts are momentum plus torque at the contact point, and hit-stop is capped at 8 ticks.
  - Shatter and Impact are re-choreographed.
  - Orbital footwork and the depth-offset prototype.
  - Camera: push-in on windups, lagged pull-back, Ï‰-roll â‰¤ 1.5Â°, impact parallax kick, wound framing.
  - The AI handles orbit and cancels into Surge.
- **S4 (matter).** D1 wound sequencing: held slabs, a crack on the impact frame, shear 80â€“300 ms after impact carrying the blow's momentum, the chisel after the shear, big islands split, fight-plane debris on its own layer. Rotation spike, matter side.
- **S3 (Planet).**
  - Shell resist calibrated (4 â†’ 1.4).
  - No lean.
  - Spin state: clouds, aurora and moons lag and overshoot.
  - Input-frame telegraphs.
  - Brace prototype.
  - Local quake light.
- **S5 (light and sound).**
  - **D5 local light.** No whitening pass anywhere: impact lights with an onset gate, a thin refraction ripple, glow cap, intensity slew, a GPU luminance governor, comfort on every path.
  - **D6 audio.**
    - Impact, bed and UI buses; 50 Hz high-pass; a lookahead true-peak limiter at âˆ’1 dBTP.
    - A bed duck of 6â€“10 dB on heavy hits, and a score that breathes.
    - Calibrated on real fights (`tools/ui/audio-verify.ts --fight`).
  - **Also:**
    - the D3D11 shader warning is fixed;
    - the renderer side of the rotation spike;
    - the `push=1` sprite push.
- **S2 (Witness).**
  - Spline tendrils (D3).
  - Witness painter v1 (offline).
  - Deterministic XPBD rig with joint failure.
  - Membrane, fibre and arm pens.
- **Lead.**
  - The contracts, the slice flag and the cursor hide (D7).
  - Telemetry corrections, all three in my own measurement (Â§3 shows the corrected numbers):
    - impact lights were being counted as occluders;
    - the wound box now follows the body;
    - "clear" is now the first time a blow's own effects leave the wound.
  - A true-1080p capture (Phase 0 had run at Ã—2).
  - Balance knobs.
  - Gate B evidence and this document.
- **Tests:** the full suite passes **929/929**; typecheck, lint and format are clean. Three tests now expect the new physics:
  - the Nexus chain test waits for the delayed shear;
  - the presence and shove bounds follow the momentum model;
  - the audio e2e pre-limiter bound follows the limiter re-stage.

## 7. Decisions for you (Gate B)

1. **Footwork model**: orbit (`?orbit=1`) becomes the slice's combat space, as the brief describes, or does classic stay? I recommend
   **orbit**, once you've played it with the controller.
2. **Depth offset** (`&zdepth=1`): keep it or drop it?
3. **Sprite push** (`&push=1`): the scenery-only push-in (default), or add the â‰¤10 % sharp-bilinear sprite zoom?
4. **Controller mapping**: confirm in Controller Check that the Switch Pro maps correctly (and that rumble works).
5. **Overlap at contact**: acceptable, or should attacks stop at the target's surface?
6. **Witness direction** (sheets in Â§5): longer, sweeping scythes instead of claws? Anything else before the Phase 2 rebuild?
7. **Rounds**: confirm the approach. Fix pacing through AI patience and spacing (fewer, heavier contacts), not toughness.

**Questionnaire** (per titan, 1â€“5, plus a comment):

- **Both titans:** immediate input? huge mass? readable motion? understandable hits? wound readable after the effects clear?
- **Last One / Witness:** does the whole body move? does torque travel? does the eye lead?
- **Planet:** a world, not a ball? is rotation readable? does gravity have authority? do moons and debris matter?
