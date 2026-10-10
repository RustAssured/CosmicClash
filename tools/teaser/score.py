# ADEUK story teaser: the soundtrack, synthesised from the film's own cue sheet (cues.json).
import json
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt
from scipy.io import wavfile

SR = 48000
cues = json.load(open('cues.json'))
T = cues['total'] + 1.0
N = int(T * SR)
S = {s['name']: s['start'] for s in cues['shots']}
D = {s['name']: s['dur'] for s in cues['shots']}
rng = np.random.default_rng(7)
t = np.arange(N) / SR
L = np.zeros(N)
Rr = np.zeros(N)
wet = np.zeros((2, N))  # send to reverb


def lp(x, f, order=2):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)


def env_at(points):
    """piecewise-linear envelope over the whole film from (time, value) points"""
    xs, ys = zip(*points)
    return np.interp(t, xs, ys)


def add(sig, at, gain=1.0, pan=0.0, send=0.3):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    L[i : i + len(sig)] += sig * gain * l
    Rr[i : i + len(sig)] += sig * gain * r
    wet[0, i : i + len(sig)] += sig * gain * send * l
    wet[1, i : i + len(sig)] += sig * gain * send * r


def tt(dur):
    return np.arange(int(dur * SR)) / SR


# ---------------------------------------------------------------- the bed: a drone that breathes with the story
lvl = env_at([
    (0, 0), (2, 0.25), (S['worlds'], 0.3), (S['eye'], 0.35), (S['eye'] + 4, 0.7), (S['mouth'], 0.8), (S['mouth'] + 4, 1.0),
    (S['ruin'], 0.12), (S['genesis'], 0.2), (S['genesis'] + 9, 0.85), (S['brace'] + 3, 1.0), (S['brace'] + 4, 0.5),
    (S['hunt'], 0.3), (S['scale'], 0.35), (S['scale'] + 5.5, 0.9), (S['edge'], 0.7), (S['edge'] + 4, 0.9), (S['logo'], 0.0),
    (S['logo'] + 0.5, 0.0), (S['logo'] + 1.0, 0.35), (T - 1.2, 0.2), (T, 0),
])
ph = 2 * np.pi
drone = (np.sin(ph * 36.71 * t) * 0.5 + np.sin(ph * 36.9 * t + 1) * 0.4 + np.sin(ph * 55.0 * t) * 0.35 + np.sin(ph * 73.42 * t + 2) * 0.18)
drone *= 0.75 + 0.25 * np.sin(ph * 0.07 * t)
wind = lp(hp(rng.standard_normal(N), 120), 900) * (0.5 + 0.5 * np.sin(ph * 0.05 * t + 1))
bed = (drone * 0.22 + wind * 0.05) * lvl
L += bed
Rr += bed * 0.97 + np.roll(wind, 900) * 0.05 * lvl
wet += np.vstack([bed, bed]) * 0.15

# ---------------------------------------------------------------- cold open: one far ping, and the flash that arrives late
ping = np.sin(ph * 1760 * tt(3)) * np.exp(-tt(3) * 2.2) * 0.12
add(ping, 0.6, pan=-0.2, send=0.8)
add(ping * 0.8, 0.62, pan=0.3, send=0.8)
th = lp(rng.standard_normal(int(1.5 * SR)), 180) * np.exp(-tt(1.5) * 3) * 0.6
add(th, 2.15, send=0.6)

# ---------------------------------------------------------------- two worlds: a warm, slow chord
def pad(freqs, dur, att=1.5, rel=1.5):
    x = tt(dur)
    e = np.minimum(1, np.minimum(x / att, (dur - x) / rel))
    s = sum(np.sin(ph * f * x + i) + 0.3 * np.sin(ph * f * 2.003 * x) for i, f in enumerate(freqs))
    return lp(s, 1800) * e / len(freqs)

add(pad([146.8, 174.6, 220.0, 329.6], D['worlds'] + 0.8), S['worlds'] - 0.2, gain=0.22, send=0.6)
for k in range(9):
    add(np.sin(ph * (1318 + 220 * (k % 3)) * tt(1.2)) * np.exp(-tt(1.2) * 4) * 0.04, S['worlds'] + 0.6 + k * 0.48, pan=np.sin(k), send=0.9)

# ---------------------------------------------------------------- the eye: a cluster that rises as it opens, then the gaze burns
x = tt(D['eye'])
gl = np.cumsum(55 + 50 * np.clip(x / 2.4, 0, 1)) / SR
cluster = (np.sin(ph * gl) + np.sin(ph * gl * 1.059) + np.sin(ph * gl * 1.498)) / 3
cluster *= np.clip(x / 1.5, 0, 1) * np.clip((D['eye'] - x) / 0.6, 0, 1)
add(lp(cluster, 1200), S['eye'], gain=0.32, send=0.4)
g0 = 0.42 * D['eye']
xb = tt(D['eye'] - g0)
beam = bp(rng.standard_normal(len(xb)), 2500, 6000) * 0.35 + np.sin(ph * 880 * xb) * 0.15 * (1 + np.sin(ph * 31 * xb))
beam *= np.clip(xb / 0.15, 0, 1) * np.clip((len(xb) / SR - xb) / 0.4, 0, 1)
add(beam, S['eye'] + g0, gain=0.22, pan=0.15, send=0.35)
for k in range(40):  # the crust cracking
    c = hp(rng.standard_normal(int(0.03 * SR)), 1500) * np.exp(-tt(0.03) * 120)
    add(c, S['eye'] + g0 + 0.3 + rng.random() * (D['eye'] - g0 - 0.6), gain=0.2 + 0.25 * rng.random(), pan=rng.uniform(-0.6, 0.6), send=0.4)

# ---------------------------------------------------------------- the mouth: something wet and enormous, and the bite
x = tt(D['mouth'])
cut = 200 + 260 * (0.5 + 0.5 * np.sin(ph * 2.3 * x)) * (0.5 + 0.5 * np.sin(ph * 0.7 * x))
growl = rng.standard_normal(len(x))
# a cheap time-varying lowpass: blend of fixed lowpasses weighted by the cutoff curve
lo1, lo2 = lp(growl, 160, 4), lp(growl, 520, 4)
w = (cut - 200) / 260
growl = lo1 * (1 - w) + lo2 * w
growl += np.sin(ph * np.cumsum(48 - 14 * x / D['mouth']) / SR) * 0.6
growl *= np.clip(x / 1.2, 0, 1) * np.clip((D['mouth'] - x) / 0.5, 0, 1)
add(growl, S['mouth'], gain=0.42, pan=0.35, send=0.3)
bite_t = S['mouth'] + 0.35 * D['mouth'] + 0.4
crunch = lp(rng.standard_normal(int(1.2 * SR)), 2400) * np.exp(-tt(1.2) * 5)
crunch *= 1 + 0.6 * (rng.random(len(crunch)) > 0.995)
boom = np.sin(ph * np.cumsum(70 * np.exp(-tt(2.5) * 1.4) + 22) / SR) * np.exp(-tt(2.5) * 1.6)
add(crunch, bite_t, gain=0.5, pan=0.3, send=0.5)
add(boom, bite_t, gain=0.9, send=0.5)

# ---------------------------------------------------------------- ruin: almost nothing; metal creaking far away
for k in range(5):
    x = tt(1.6)
    f = 140 + 90 * rng.random()
    cr = np.sin(ph * np.cumsum(f + 25 * np.sin(ph * 3 * x)) / SR) * np.exp(-x * 2) * (1 + np.sin(ph * 13 * x)) * 0.5
    add(bp(cr, 90, 900), S['ruin'] + 0.4 + k * 0.7, gain=0.08, pan=rng.uniform(-0.7, 0.7), send=0.9)

# ---------------------------------------------------------------- genesis: every weld rings; heavy parts land with a thud
welds = sorted(cues['welds'])
times = np.array([w[0] for w in welds])
for (at, code, n) in welds:
    dens = np.sum(np.abs(times - at) < 0.12)
    size = min(1.0, (n / 120) ** 0.5)
    f0 = 900 - 650 * size + rng.uniform(-60, 60)
    dur = 0.18 + 0.5 * size
    x = tt(dur)
    partials = [(1, 1), (2.76, 0.5), (5.40, 0.28), (8.93, 0.15)]
    s = sum(a * np.sin(ph * f0 * r * x + rng.random() * 6) * np.exp(-x * (6 + r * 3) / (0.5 + size)) for r, a in partials)
    s[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
    gain = (0.06 + 0.12 * size) / np.sqrt(max(1, dens) / 2)
    add(s, at, gain=gain, pan=rng.uniform(-0.5, 0.5), send=0.35)
# phase thuds as each part group starts landing (chamber, hips, domes, arms, fists, moon)
for frac in [0.2, 0.3, 0.44, 0.54, 0.68, 0.86]:
    at = S['genesis'] + (frac + 0.1 + 0.02) / 1.08 / 0.97 * D['genesis']
    add(boom * 0.7, at, gain=0.5, send=0.4)
    add(lp(rng.standard_normal(int(0.4 * SR)), 900) * np.exp(-tt(0.4) * 9), at, gain=0.35, send=0.3)
# the loop ignites: a rising, ringing whoosh
x = tt(1.6)
ign = bp(rng.standard_normal(len(x)), 600, 5000) * (x / 1.6) ** 2 + np.sin(ph * np.cumsum(220 + 440 * (x / 1.6) ** 2) / SR) * 0.4 * (x / 1.6)
ign *= np.clip((1.6 - x) / 0.1, 0, 1)
add(ign, S['genesis'] + (0.15 + 0.02) / 1.08 / 0.97 * D['genesis'], gain=0.3, send=0.6)
# a pulse under the build that quickens
x = tt(D['genesis'])
rate = 1.2 + 2.8 * (x / D['genesis']) ** 1.5
pulse = np.sin(ph * 41 * x) * (0.5 + 0.5 * np.sin(ph * np.cumsum(rate) / SR)) ** 6 * np.clip(x / 2, 0, 1)
add(pulse, S['genesis'], gain=0.45, send=0.2)

# ---------------------------------------------------------------- 우리 braces: tension, then the clench
x = tt(3.0)
rise = bp(rng.standard_normal(len(x)), 200, 3000) * (x / 3) ** 3 + np.sin(ph * np.cumsum(60 + 120 * (x / 3) ** 2) / SR) * 0.5 * (x / 3)
add(rise, S['brace'], gain=0.35, send=0.4)
clench_t = S['brace'] + 0.55 * D['brace']
x = tt(5)
sub = np.sin(ph * np.cumsum(62 * np.exp(-x * 0.9) + 26) / SR) * np.exp(-x * 0.7)
hit = lp(rng.standard_normal(len(x)), 3000) * np.exp(-x * 7)
metal = sum(np.sin(ph * f * x) * np.exp(-x * d) for f, d in [(196, 1.2), (311, 1.6), (467, 2.0), (741, 2.6)]) * 0.3
add(sub, clench_t, gain=1.1, send=0.5)
add(hit, clench_t, gain=0.7, send=0.7)
add(metal, clench_t, gain=0.4, send=0.8)

# ---------------------------------------------------------------- the hunt: alone, one high tone
x = tt(D['hunt'])
lone = np.sin(ph * 587.3 * x) * 0.5 + np.sin(ph * 880 * x) * 0.2
lone *= np.clip(x / 1.5, 0, 1) * np.clip((D['hunt'] - x) / 1.0, 0, 1) * (0.7 + 0.3 * np.sin(ph * 0.6 * x))
add(lone, S['hunt'], gain=0.07, send=0.9)

# ---------------------------------------------------------------- scale: the floor drops away
x = tt(D['scale'])
rum = lp(rng.standard_normal(len(x)), 90, 4) * (x / D['scale']) ** 2 * 3
add(rum, S['scale'], gain=0.5, send=0.2)
add(boom, S['scale'] + 4.4, gain=0.8, send=0.6)

# ---------------------------------------------------------------- the edge: four words, four blows
for i in range(4):
    at = S['edge'] + 0.5 + i * 0.85
    g = 1.25 if i == 3 else 0.9
    add(boom, at, gain=g, send=0.5)
    add(lp(rng.standard_normal(int(0.8 * SR)), 1800) * np.exp(-tt(0.8) * 6), at, gain=0.5 * g, send=0.6)
    add(lo1[: int(0.9 * SR)] * np.exp(-tt(0.9) * 2), at, gain=0.5, pan=-0.4 + i * 0.25, send=0.4)

# ---------------------------------------------------------------- logo: one last blow, a long tail
add(boom, S['logo'] + 0.3, gain=1.1, send=0.9)
add(metal, S['logo'] + 0.3, gain=0.35, send=1.0)

# ---------------------------------------------------------------- reverb (a long dark space) and master
ir_t = tt(3.2)
ir = rng.standard_normal((2, len(ir_t))) * np.exp(-ir_t * 2.1)
ir = np.vstack([lp(ir[0], 3500), lp(ir[1], 3200)])
ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
revL = fftconvolve(wet[0], ir[0])[:N]
revR = fftconvolve(wet[1], ir[1])[:N]
out = np.vstack([L + revL * 0.55, Rr + revR * 0.55])
out = hp(out, 25)
peak = np.max(np.abs(out))
out = np.tanh(out / peak * 1.6) / np.tanh(1.6) * 0.89
wavfile.write('score.wav', SR, (out.T * 32767).astype(np.int16))
print('score.wav', T, 's peak', peak)
