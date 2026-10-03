# GATE C — the Witness and the World (Phase 2)

**Status: waiting for WJ to play.** Both titans are in the game with their new kits and both arenas are built. The Witness is
now the default Last One. Footage, numbers and open items are below.

Every number is either a real-time run on this machine (Vega 7, ANGLE/D3D11, **true 1920×1080, ×3**) or a deterministic headless
run. Sources: `docs/gates/evidence/gate-c/*.json` (the final numbers are `final-mausoleum`, `final-shearfield` and `final-gc`;
latency is `latency-*`). Clips: `evidence/gate-c/`.

## 1. How to play

Double-click **`play.bat`**. It builds the game, starts a local server and opens <http://localhost:4173>. Press **F11** for full
screen; a windowed browser drops the pixel scale to ×2.

| URL | What it is |
|---|---|
| <http://localhost:4173> | The slice through the menus: the **Witness** and the **Planet**, in the **Mausoleum** and the **Shearfield**. Orbital footwork. |
| `?witness=0` | The old Last One, for comparison. |
| `?full=1` | All six titans and all stages. Not part of the slice. |
| `?mode=training&a=lastone&b=planet&stage=mausoleum&p1=human&p2=dummy` | Training straight away, with an idle Planet. |

**Controller** (Switch Pro). Check the mapping in **Controller Check** on the title menu.

| Button | Action |
|---|---|
| Y | Strike |
| X | Crush |
| B | Surge |
| A | Signature (hold) |
| ZR | Ultimate |
| ZL | Guard |
| R | **Gravity** (Planet: Tidal Draw) |
| L | Feint |
| + | Pause |
| − | Training overlay |

On a sideways Joy-Con, Gravity is the stick click. On the keyboard it is U / Numpad 3.

**Aftermath:** one second after the deciding KO the arena freezes.

| Control | Action |
|---|---|
| Stick / mouse drag | Pan |
| Y / X / wheel | Zoom ×1–×4 |
| ZR / ZL | Rotate |
| A | Save a PNG |
| − | Hints on / off |
| B | Continue to results |

## 2. Footage

**Reference clips** (`evidence/gate-c/`) are rendered with `tools/lead/refrender.ts`: one sim tick per frame at exactly 60 fps,
with the full post pipeline at 1080p. Unlike the real-time captures, they cannot drop or double frames, so judge motion on them.
Judge performance by playing.

| Clip | Look for |
|---|---|
| `witness-planet-mausoleum.mp4`, `witness-planet-shearfield.mp4` | 60 s, AI vs AI (level 4), seed 21. Orbit footwork. Look for wounds that crack, hold and then shear; the Witness's arms and halo carrying load; the Planet's spin, moons and well. Shearfield: comets crossing, being captured and slung. |
| `passover.mp4` | Your explosion bug, fixed: the Witness swings over and under an idle Planet in the Mausoleum and turns round cleanly every time, at 100 %. |

**Art:** `docs/gallery/wip/witness-arms-compare.png` (truss is now the default) and `witness-eye-micro-*.png` (the eye's
planet-scale detail at 1× / 3× / 4×).

## 3. Numbers vs §4

| Target | Gate B | Gate C | |
|---|---|---|---|
| Input → response ≤ 1 frame | sim responds on the input tick; key → frame 18–22 ms | Sim responds on the input tick. Key event → accept median 22–28 ms; → first pixel 28–29 ms. | ✓ |
| Crack on impact, shear 80–300 ms, slabs not dust | shear 133–150 ms | **Shear median 150–183 ms** live. Planet crust still sheds slabs after the rebalance (chunk share 0.27–0.57 by move, unchanged). | ✓ |
| FX peak ≤ 100 ms; occluding FX clear ≤ 400 ms | peak 83, clear 300 | **Peak median 14 ms (Mausoleum, 5 wounds), 149 ms (Shearfield, 4 wounds)**; clear 14–150 ms. Offline over 420 s of fights: Witness FRACTURE peak median 75 ms (was 200). | ✓ / ~ |
| Flashes ≤ 20 % Δluminance, ≤ 3/s | ≤ 0.16 | **≤ 0.07 in fights**, 0.15 in the latency scenario; 0–1 per s. | ✓ |
| Audio −23…−18 LUFS, TP ≤ −1, impact ≥ 10 dB over bed, duck 4–8 dB, LRA ≥ 10 | −19.0 | **−22.8 / −21.6 LUFS**, TP −4.6 / −1.7 dBTP, impact +12 dB (short-term) / +13–17 (momentary), duck 4 dB, LRA 13–15. | ✓ |
| Rounds 45–90 s, fewer and heavier contacts | 22–24 s ✗ | Headless, 24 fights per level: **L3 mean 51 s / median 53 s, L4 mean 59 s / median 56 s**. 68–80 % of rounds inside 45–90 s, timeouts 0–3.4 %. About 11 contacts and 3–3.6 heavy hits per round. Live (AI 4): 35 s and 54 s. | ✓ |
| Matchup 45–55 % over ≥ 100 fights | 52 % (classic) | **Witness 47 – Planet 53 matches; rounds 123–125** (100 orbit fights, L3). | ✓ |
| 60 fps at 1080p | 59.4–59.5, 1 % low 24.5–25.6 | **60.0 / 59.9 fps, 1 % low 43–45**, worst frame 51 ms, 15–17 frames > 25 ms in 3 minutes. | ✓ |
| Sim p99 ≤ 5 ms | browser 6.1–7.0 | **Browser p99 3.6–3.7 ms.** It was 10–12 ms mid-phase, before S4's and S3's perf work. | ✓ |
| No GC pause > 4 ms in 3 minutes | 8, max 12.2 | **10 > 4 ms, max 9.2 ms**, 154 pauses. | ✗ |
| Blind readability ≥ 16/20 | — | Phase 3 (Gate D). | — |

## 4. Known issues (not hidden)

1. **Fixed during the gate run.** Three presentation regressions turned up after the rebalance; all are fixed, and the numbers
   in §3 are after the fixes.
   - **Hot mix:** the Planet's ring-capture cue stacked 12 bells a second. Each cue may now sound at most once per 0.3 s.
   - **Late FX peak:** wound spray and chisel dust now draw behind the titans, and the attacker's own overlay clears the wound by
     the end of the hit-stop.
   - **Balance-free presentation:** sound and FX size now ignore the balance knobs.
   - **The "1 s stall":** it was the capture tool's audio unlock being counted as a game frame, not the game.
2. **GC:** 10 pauses over 4 ms in 3 minutes. Matter's typed-array churn is gone; what remains is short-lived garbage (Planet
   spin, comet painting, number boxing). Phase 3.
3. **Rare hit-tick spikes** of up to ~40–50 ms on a heavy blow landing on the Witness. Most hit ticks now stay under 10 ms
   (they were 31–145 ms). What remains is matter's per-body damage cost on its ~24 rotating region bodies. Phase 3.
4. **The Witness loses more matter to debris than the Planet does** (its joints cascade). That is why its balance knobs are
   high (power 3.0, the knob ceiling, durability 2.6). Phase 3: S2/S4 make the Witness's structure resist debris, so the knobs
   can come back down.
5. **Between-round heal skips the Planet's far face** (proposal 137, S4). A Planet that braced in round 1 comes back with
   slightly less than 85 %.
6. **Microdetail is only on the eye** so far; the carapace, halo and spires come next.
7. The 1.3 MB bundle warning (Vite; harmless).

## 5. What changed in Phase 2

- **The Witness:**
  - ~24 region bodies (eye cradle, carapace and three reveal layers, shrine, halo arcs, four truss arms) driven by an XPBD rig.
  - Six moves: Halo Shards, Sweeping Architecture / Structural Shear, Charge and Sidestep, Fracture Gaze, Halo Close, Revelation.
  - Eyes open as it breaks, joints fail into debris, and the KO is a 2–4 s structural failure with the eye going out last.
  - Planet-scale motion (scale spec 36/36) and eye microdetail.
  - **Fixed:** the turn-round mirror that blew the rig apart on every over/under pass (your "explodes" video).
- **The Planet:**
  - Seven moves, including Tidal Draw on R1 and Comet Shepherd → Slingshot.
  - Four geological damage phases, the two-hemisphere shell with a painted far face, and a 3 s failure sequence.
  - Visual work moved out of the sim tick.
- **Arenas:** the **Fractured Orbital Mausoleum** and the **Star-birth Shearfield**, each with reactive depth layers. Comets
  are real matter, and gravity wells pull the scenery.
- **Matter:**
  - rotated region bodies with one shared sampler (what you see is what is hit);
  - a capture/launch API;
  - debris that persists and cools;
  - wounds shed in parallel;
  - large perf work (the Witness's world tick p99 7.5 → 1.2–1.6 ms).
- **D30, debris:** wreckage wounds by its own speed. Walking through it shoves it; flung slabs and comets still wound. A titan's
  own gravity well never wounds it.
- **AI:**
  - patience: regroups after a heavy blow, steps out of heavy wind-ups, probe feints, no stalling;
  - uses the full kits;
  - pacing tuned to 45–90 s rounds.
- **Lead:**
  - Gravity on R1;
  - deterministic comet hazards;
  - the slice roster (two titans, two arenas);
  - the aftermath screen;
  - the 60 fps reference renderer;
  - the Witness as the default;
  - a full-body menu portrait.
- **Tests:** see §7.

## 6. Decisions for you (Gate C)

1. **D30, the debris rule:** keep it? Slow wreckage only shoves; flung debris and comets wound. Without it, debris attrition
   decided rounds in ~20 s.
2. **Controller mapping:** confirm the Switch Pro in Controller Check (still open since Gate B), including R as Gravity and rumble.
3. **Witness art:** truss arms and the eye microdetail are in. Should I extend microdetail to the carapace, halo and spires? And
   do you want the higher-resolution detail map for the aftermath and export (art notes: ~2–3 days, render-only)?
4. **Witness stack exposure:** blows on intact carapace no longer reach the layers behind it; only holes expose them. Keep it?
5. **The old Last One:** keep it hidden behind `witness=0` until Gate D, then remove it?
6. **Phase 3:**
   - the evidence loop to Gate D: the blind readability test (≥ 16/20);
   - §4 items 1–5;
   - polish from your notes.

   Approve?

**Questionnaire** (per titan, 1–5, plus a comment):

- **Both titans:** immediate input? huge mass? readable motion? understandable hits? wound readable after the effects clear?
- **Witness:** does the whole structure move? does load travel through the arms and halo? does the eye lead? does it read as
  planet-sized up close (aftermath zoom)?
- **Planet:** a world, not a ball? is rotation readable? does gravity have authority (Tidal Draw, comets)? do moons and debris
  matter?
- **Arenas:** does the space feel occupied? do the comets and debris change how you fight?

## 7. Checks

- **Full suite: 1039 / 1039 tests in 88 files**; `tsc`, ESLint and Prettier are clean.
- **New in Phase 2:**
  - `passover.test.ts`: over/under passes, no teleports, no matter loss;
  - Witness rig, kit, eye microdetail and sway tests;
  - rotated-sampler parity across all 256 angles;
  - D30 debris rules;
  - AI patience and move coverage.
- **Tests that changed, with the reason:**
  - The D1 bench's shear is now "the first held slab of the blow lets go"; fluid slabs leave as spray, not chunks.
  - Two AI rate thresholds follow the Gate C pacing (8–11 contacts per minute).
  - The Witness sway test applies a blow of the same effective energy whatever the durability knob is.
  - The Witness's front-to-back test now expects intact carapace to shield the layers behind it (stack exposure).
- **Determinism:** match hashes fold the rig state. Every perf change was hash-checked before and after; the D30 debris rule
  and the look-ahead ranking change hashes by design.
