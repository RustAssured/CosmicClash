/**
 * P4 gate (docs/cinema/TRAILER_V3.md Act II, 0:24–0:46): a minimal stand-in for the Director that drives S7's actors
 * (ruin, ark, parallax ×4, genesis) on the timeline and renders
 *  - press/cinema/genesis/genesis-0024-0046.mp4: the ×1 (640×360) frames as drawn, 60 fps, delivered at ×2 nearest\n *    (1280×720, so the 4:2:0 chroma lands on whole pixels);
 *  - press/cinema/genesis/stills.png: a contact sheet of key moments (×2);
 *  - press/cinema/genesis/genesis-cues.json: every weld and the drum cue of every part (timeline seconds).
 *
 *   npx tsx tools/cinema/p4-genesis.ts [stills]
 *
 * Stand-ins for what S5's Director owns: layers are composited by depth (alpha 0 = see-through), the emissive channel gets
 * a two-pass additive bloom (≈3 px and ≈10 px, UNIFICATION §5) and the result is snapped back to the master palette with
 * the Bayer dither (the renderer's final pass). The montage's zoom cuts are whole-number crops (×2 on alternate drum
 * cues, 0:30–0:38), never a resample.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { nativeBuffer, NATIVE_H, NATIVE_W, type Actor, type CineContext } from '../../src/cinema/types';
import { actorFactory } from '../../src/cinema/actors/index';
import '../../src/cinema/actors/genesis';
import '../../src/cinema/actors/ruin';
import '../../src/cinema/actors/ark';
import '../../src/cinema/actors/parallax';
import { provideUriBake } from '../../src/cinema/p4/assets';
import { bakeUri, genesisCues } from '../../src/cinema/p4/uri';
import { BAYER4, masterRamp, nearestMaster } from '../../src/cinema/p4/palette';

const OUT = 'press/cinema/genesis';
const T0 = 24;
const T1 = 46;
const FPS = 60;
const GEN = { start: 27, dur: 14, braceAt: 41, launchAt: 44 };

const png = (f: string): PNG => PNG.sync.read(readFileSync(`src/cinema/assets/${f}.png`));
const bake = bakeUri(png('uri-a'), png('uri-a-id'), png('uri-g'), png('uri-g-id'));
provideUriBake(bake);
const cues = genesisCues(bake, GEN.start, GEN.dur);
mkdirSync(OUT, { recursive: true });
writeFileSync(
  `${OUT}/genesis-cues.json`,
  JSON.stringify(
    {
      comment:
        'Genesis weld events (timeline s): drums = one per part as it completes (two per fist), welds = every chunk. Made by tools/cinema/p4-genesis.ts from src/cinema/p4/uri.ts WIN.',
      genesis: GEN,
      drums: cues.drums.map((d) => ({ ...d, t: +d.t.toFixed(4) })),
      welds: cues.welds.map((w) => [+w.t.toFixed(4), w.code, w.size]),
    },
    null,
    1,
  ),
);
console.log(`cues: ${cues.welds.length} welds, ${cues.drums.length} drum cues`);
for (const d of cues.drums)
  console.log(`  ${d.t.toFixed(2)} s  ${d.part}${d.clench ? ` (clench ${d.clench})` : ''}`);

// ---------------------------------------------------------------- the shots (what timeline.json would say)
interface Layer {
  type: string;
  depth: number;
  params: Record<string, unknown>;
}
const sky: Layer[] = [
  { type: 'parallax', depth: -95, params: { layer: 'nebula', seed: 3 } },
  { type: 'parallax', depth: -60, params: { layer: 'dust', seed: 5 } },
];
const near: Layer[] = [
  { type: 'parallax', depth: 10, params: { layer: 'debris', seed: 7 } },
  { type: 'parallax', depth: 35, params: { layer: 'fore', seed: 9 } },
];
const shots = [
  {
    id: 'ruin',
    start: 24,
    end: 27,
    layers: [
      ...sky,
      { type: 'ruin', depth: -20, params: {} },
      { type: 'ark', depth: -10, params: {} },
      ...near,
    ],
  },
  {
    id: 'genesis',
    start: 27,
    end: 46,
    layers: [
      ...sky,
      { type: 'ark', depth: -10, params: { gather: 0.03 } },
      { type: 'genesis', depth: 0, params: GEN },
      ...near,
    ],
  },
];
const actors = new Map<string, Actor>();
for (const s of shots)
  for (const [i, l] of s.layers.entries()) {
    const id = `${s.id}.${l.type}.${i}`;
    actors.set(id, actorFactory(l.type)(id, l.depth, l.params));
  }

// ---------------------------------------------------------------- camera: a slow dolly; montage zoom cuts on the drums
const drumsInMontage = cues.drums.filter((d) => d.t >= 30 && d.t < 38.5);
function camera(t: number): { x: number; y: number; zoom: number; fx: number; fy: number } {
  const x = -30 + ((t - T0) / (T1 - T0)) * 60;
  const y = 6 - ((t - T0) / (T1 - T0)) * 10;
  let zoom = 1;
  let fx = 320;
  let fy = 180;
  // cut on every landing, alternating wide ↔ ×2 on the part that just landed
  let n = -1;
  for (let i = 0; i < drumsInMontage.length; i++) if (t >= drumsInMontage[i]!.t) n = i;
  // (the montage ends with the fists' first clench; the second clench, the moon and the brace play wide)
  if (n >= 0 && n % 2 === 0 && t < 38.5) {
    zoom = 2;
    const part = bake.A.list.filter((g) => g.code === drumsInMontage[n]!.code);
    const cx = part.reduce((s, g) => s + g.cx, 0) / Math.max(1, part.length);
    const cy = part.reduce((s, g) => s + g.cy, 0) / Math.max(1, part.length);
    fx = Math.round(cx - bake.A.w / 2 - (x - 320));
    fy = Math.round(cy - bake.A.h / 2 - (y - 180));
    fx = Math.max(160, Math.min(480, fx));
    fy = Math.max(90, Math.min(270, fy));
  }
  return { x, y, zoom, fx, fy };
}

// ---------------------------------------------------------------- compose one frame
const W = NATIVE_W;
const H = NATIVE_H;
const buf = nativeBuffer();
const frame = new Uint32Array(W * H);
const emis = new Uint8Array(W * H);
const BG = masterRamp('uri.s2')[0]!;
const fr = new Float32Array(W * H * 3);
const tmp = new Float32Array(W * H * 3);

function blur(src: Float32Array, dst: Float32Array, r: number): void {
  // separable box blur (twice ≈ a soft kernel)
  const pass = (a: Float32Array, b: Float32Array, horiz: boolean): void => {
    const L = horiz ? W : H;
    const N = horiz ? H : W;
    for (let j = 0; j < N; j++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      const idx = (i: number): number => (horiz ? j * W + i : i * W + j) * 3;
      for (let i = -r; i <= r; i++) {
        const k = idx(Math.min(L - 1, Math.max(0, i)));
        s0 += a[k]!;
        s1 += a[k + 1]!;
        s2 += a[k + 2]!;
      }
      for (let i = 0; i < L; i++) {
        const o = idx(i);
        b[o] = s0 / (2 * r + 1);
        b[o + 1] = s1 / (2 * r + 1);
        b[o + 2] = s2 / (2 * r + 1);
        const ka = idx(Math.max(0, i - r));
        const kb = idx(Math.min(L - 1, i + r + 1));
        s0 += a[kb]! - a[ka]!;
        s1 += a[kb + 1]! - a[ka + 1]!;
        s2 += a[kb + 2]! - a[ka + 2]!;
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, dst, false);
}
const glowSrc = new Float32Array(W * H * 3);
const glowA = new Float32Array(W * H * 3);
const glowB = new Float32Array(W * H * 3);
const out = new Uint32Array(W * H);

async function render(n: number): Promise<Uint32Array> {
  const t = n / FPS;
  const shot = shots.find((s) => t >= s.start && t < s.end) ?? shots[shots.length - 1]!;
  const cam = camera(t);
  const view = { x0: Math.round(cam.x - W / 2), y0: Math.round(cam.y - H / 2) };
  frame.fill(BG);
  emis.fill(0);
  const ordered = shot.layers
    .map((l, i) => ({ l, a: actors.get(`${shot.id}.${l.type}.${i}`)! }))
    .sort((p, q) => p.l.depth - q.l.depth);
  let r = 0x2545f491 + n;
  const ctx: CineContext = {
    frame: n,
    t,
    shot: shot.id,
    shotT: t - shot.start,
    sceneT: t - shot.start,
    camera: { x: cam.x, y: cam.y, zoom: cam.zoom, dutch: 0, shakeX: 0, shakeY: 0 },
    view,
    rng: () => (r = Math.imul(r ^ (r >>> 15), 0x2c1b3c6d) >>> 0) / 4294967296,
    params: {},
  };
  for (const { a } of ordered) {
    buf.pixels.fill(0);
    buf.emissive.fill(0);
    if (a.init && !inited.has(a)) {
      await a.init({ ...ctx });
      inited.add(a);
    }
    a.draw(buf, ctx);
    for (let i = 0; i < W * H; i++) {
      const c = buf.pixels[i]!;
      if (!(c >>> 24)) continue;
      frame[i] = c;
      emis[i] = buf.emissive[i]!;
    }
  }
  // bloom: the glowing pixels spill light (≈3 px and ≈10 px passes), then the frame is snapped back into the palette
  for (let i = 0; i < W * H; i++) {
    const c = frame[i]!;
    const e = emis[i]! / 255;
    fr[i * 3] = c & 255;
    fr[i * 3 + 1] = (c >>> 8) & 255;
    fr[i * 3 + 2] = (c >>> 16) & 255;
    glowSrc[i * 3] = fr[i * 3]! * e;
    glowSrc[i * 3 + 1] = fr[i * 3 + 1]! * e;
    glowSrc[i * 3 + 2] = fr[i * 3 + 2]! * e;
  }
  blur(glowSrc, glowA, 2);
  blur(glowSrc, glowB, 7);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const add0 = glowA[i * 3]! * 0.32 + glowB[i * 3]! * 0.22;
      const add1 = glowA[i * 3 + 1]! * 0.32 + glowB[i * 3 + 1]! * 0.22;
      const add2 = glowA[i * 3 + 2]! * 0.32 + glowB[i * 3 + 2]! * 0.22;
      if (add0 + add1 + add2 < 6) {
        out[i] = frame[i]!;
        continue;
      }
      const d = (BAYER4[((y & 3) << 2) | (x & 3)]! - 0.5) * 14;
      const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v + d)));
      out[i] = nearestMaster(q(fr[i * 3]! + add0), q(fr[i * 3 + 1]! + add1), q(fr[i * 3 + 2]! + add2));
    }
  // the montage's zoom: a whole-number crop about the focus (never a resample)
  if (cam.zoom === 2) {
    const z = new Uint32Array(W * H);
    const x0 = cam.fx - W / 4;
    const y0 = cam.fy - H / 4;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) z[y * W + x] = out[(y0 + (y >> 1)) * W + x0 + (x >> 1)]!;
    return z;
  }
  return out;
}
const inited = new Set<Actor>();

const toRgba = (u: Uint32Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

// contact sheet of key moments (×2 each, 4 columns)
const STILLS = [
  24.5, 27.6, 28.8, 30.2, 31.6, 33.2, 34.6, 36.2, 37.5, 38.6, 40.2, 41.6, 42.8, 43.6, 44.9, 45.6,
];
{
  const S = 2;
  const cols = 4;
  const rows = Math.ceil(STILLS.length / cols);
  const sheet = new PNG({ width: W * S * cols, height: H * S * rows });
  for (const [k, s] of STILLS.entries()) {
    const f = await render(Math.round(s * FPS));
    const cx = (k % cols) * W * S;
    const cy = Math.floor(k / cols) * H * S;
    for (let y = 0; y < H * S; y++)
      for (let x = 0; x < W * S; x++) {
        const c = f[Math.floor(y / S) * W + Math.floor(x / S)]!;
        const o = ((cy + y) * sheet.width + cx + x) * 4;
        sheet.data[o] = c & 255;
        sheet.data[o + 1] = (c >>> 8) & 255;
        sheet.data[o + 2] = (c >>> 16) & 255;
        sheet.data[o + 3] = 255;
      }
  }
  writeFileSync(`${OUT}/stills.png`, PNG.sync.write(sheet));
  console.log(`${OUT}/stills.png (${STILLS.join(', ')} s)`);
}

if (process.argv[2] !== 'stills') {
  const file = `${OUT}/genesis-0024-0046.mp4`;
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${W}x${H}`,
      '-r',
      String(FPS),
      '-i',
      '-',
      '-vf',
      'scale=iw*2:ih*2:flags=neighbor',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '12',
      '-tune',
      'animation',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const t0 = Date.now();
  const N = Math.round((T1 - T0) * FPS);
  for (let k = 0; k < N; k++) {
    const f = await render(Math.round(T0 * FPS) + k);
    if (!ff.stdin.write(toRgba(f.slice()))) await new Promise((r) => ff.stdin.once('drain', r));
    if (k % 300 === 0) console.log(`frame ${k}/${N} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log(`${file} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
