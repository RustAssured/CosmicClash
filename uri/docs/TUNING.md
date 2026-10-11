# 우리 — approved tuning (locked)
Source of truth: `src/20_kinetics.js`. These are the values in the locked demo with all sliders at 1.00.

## Links (mass · limits)
| link | mass | limits |
|---|---|---|
| hx, hy (root translation) | 4.6 | ±40 px |
| ha (root angle) | 4.6 | ±8° |
| ta (torso angle) | 4.0 | ±18° |
| daL/daR (ark angle) | 3.4 | ±30° |
| dxL/dxR (ark slide) | 3.4 | ±22 px |
| sL/sR (shoulder) | 2.3 | ±340° (free) |
| eL/eR (elbow) | 1.5 | ±160° |
| wL/wR (wrist) | 2.8 | ±60° |
| cL/cR (fist spread) | 1.0 | 0.8–1.3 |

Stiffness `k = 58 · km(phase) · damageK`; damping `c = 2·ζ·√(k·m) · damageC`.
Acceleration limit: translations 2600/m (root), 2200/m (ark slide); angles `58·√km / m`; spread 40/m.

## Damping ratio ζ per region (default; phases may override)
root hx/hy/ha 0.98 · torso 0.96 · ark angle 0.74 · ark slide 0.78 · shoulder 0.80 · elbow 0.78 · wrist 0.70 · fist spread 0.52

## Phases (seconds; striking phases end on arrival: joint error < 22, timeout 3.2× duration)
| move | phases |
|---|---|
| punch | load .30 · drive .20 (hit) · follow .18 · taper 1.50 |
| cross | coil .38 · release .26 (hit) · follow .22 · taper 1.70 |
| slam | load .20 · rise .50 · apex .26 · fall .20 (hit) · follow .28 · taper 2.30 |
| upper | compress .30 · launch .22 (hit) · follow .22 · taper 1.50 |

Taper stiffness (layered settling): wrist 1.1 · fist spread .55 · shoulder .62 · elbow .66 · ark .42 · torso .30 · root .28 (slam: ×0.85).
Slam stiffness overrides: rise shoulders .75 / elbows .70 · apex hy 1.1 (stiff hold, ±0.4 px tremor) · fall hy 1.7, hx 1.3, shoulders 2.6, elbows 2.2.
Punch/uppercut drive/launch: lead shoulder 1.2–1.25.

## Authored arm angles (degrees, shoulder/elbow/wrist; written for the RIGHT arm leading, ×−1 when the left leads)
| move | phase | lead | rear |
|---|---|---|---|
| punch | load | 22, 30, 8 | −8, −6, 0 |
| punch | drive | −50, −60, −10 | 10, 8, 0 |
| punch | follow | −55, −63, −12 | 10, 8, 0 |
| cross | coil | −6, −4, 0 | 42, 34, 0 |
| cross | release | 8, 6, 0 | −100, 36, −10 |
| cross | follow | 10, 6, 0 | −106, 40, −12 |
| slam | load | −8, −6, 0 | 8, 6, 0 |
| slam | rise | −112, −102, −18 | 112, 102, 18 |
| slam | apex | −122, −112, −20 | 122, 112, 20 |
| slam | fall | 30, 18, 0 | −30, −18, 0 |
| slam | follow | 33, 20, 0 | −33, −20, 0 |
| upper | compress | 26, 44, 10 | 0, 0, 0 |
| upper | launch | −150, −20, −10 | 10, 6, 0 |
| upper | follow | −155, −24, −12 | 10, 6, 0 |
IK correction weight: `0.14 + 0.14 · clamp((elevation − 20°)/45°, 0, 1)`. Cones: punch ±30° about horizontal, uppercut ±36° about vertical.

## Body goals (d = +1 opponent right, −1 left)
- punch load: hx −6d, hy 2, ha −2°d, ta −5°d, lead ark −7°d / −3d px, rear ark 3°d · drive/follow: hx 11–12d, ha 3°d, ta 7°d, lead ark 12°d / 8d px, rear ark −4°d
- cross coil: hx −7d, hy 1, ha −3°d, ta −10°d, rear ark −11°d / −6d px, lead ark 4°d · release/follow: hx 11d, ha 4°d, ta 13°d, rear ark 15°d / 12d px, lead ark −6°d / −4d px
- slam load hy 6 · rise hy −20, arks ∓14° / ∓4 px · apex hy −23 · fall/follow hy 16/18, hx ±7 toward target, ta ±4°, arks ±7° / ±3 px
- upper compress: hy 9, hx −2d, ta −4°d, lead ark 6°d / −2d px · launch/follow: hy −14/−16, hx 4d, ta 5°d, lead ark −16°d / 5d px, rear ark 4°d / 3d px

## Fist spread
rest 1.14 · load 1.0 · slam rise .98 / apex .92 · commit .80 (slam .78) · impact clamp ≤ .74 · chunk offset factor 1.9 × (spread − 1)

## Reaction (counter-torque, internalized)
arm momentum `Larm = Σ m·ω·r` (r: shoulder 60, elbow 55·0.7, wrist 30·0.4)
torso −0.05·Larm · root angle −0.015·Larm · core jolt −0.0009·Larm·dt·60 · opposite ark −0.012·Larm
fist velocity → root hx −0.3·v · opposite ark −0.1·v · root hy −0.12·v
pylon stabilization: torso −6·ω·eff · root −2.2·v·eff (x), −2·v·eff (y)

## Impact impulses (after arms keep 12% speed, fist spread → ≤ .74)
punch: root hx −16d, loop lobe +2.2, crossing +14d, core +22d · cross: torso +0.35d, crossing +30d, core +28d ·
slam: hy −28, both lobes +3.4, loop brightness +4, core vy +70 (+random x 26) · upper: hy −14, loop vertical +3, core vy −40 · all: brightness +2.5
Shake: slam 10, others 5.

## Loop, cores, moon
loop springs: k 40 / c 6 (active), k 20 / c 3.2 (taper); crossing & vertical k 30 / c 4 (active), 18 / 2.6 (taper)
lobe targets: load .93, slam rise .82, commit 1 + min(.3, load) − min(.14, other·.5)
cores: k 90, c 4 · command moon: pull 34·(1 + min(1.5, d/14)), ζ .82, max trail 12 px, facing 0.8× torso angle, ζ .9
Hitstop: punch .12 · cross .14 · slam .24 · upper .12

## Damage
hit −3·power loop integrity · neck failure < 0.38 · 50% rule for limbs/pylons/moon · arm damageK .7+.3q, damageC .55+.45q · ark damageC .5+.5q · pylon effectiveness = integrity
