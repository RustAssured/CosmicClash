/**
 * P6 gate (docs/cinema/TRAILER_V3.md Act IV, 1:17–1:35): a minimal stand-in for the Director that drives S7's P6 actors
 * (edgepull, jawwipe, title, and a nameslam on the stills sheet) and renders
 *  - press/cinema/edge/edge-0117-0135.mp4: the ×1 frames, 60 fps, delivered ×2 nearest (1280×720);
 *  - press/cinema/edge/stills.png: a contact sheet of key moments (×2), plus a nameslam frame strip;
 *  - press/cinema/edge/edge-cues.json: the four words' cue times (one per coil pass).
 *
 *   npx tsx tools/cinema/mouth-bake.ts && npx tsx tools/cinema/mouth-pack.ts   # the LOCKED Mouth, baked once
 *   npx tsx tools/cinema/p6-edge.ts [stills]
 *
 * Stand-ins: the arena is a still native game frame (docs/gallery/compare/after-witness-planet-mausoleum.png, HUD and all)
 * where the Director will hand in the real fight (`setArenaSource`); the words are drawn here as cards (the Director's
 * cards will do it from the cue times); compose, bloom and the palette snap are tools/cinema/standin.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { nativeBuffer, type Actor, type CineContext } from '../../src/cinema/types';
import { actorFactory } from '../../src/cinema/actors/index';
import '../../src/cinema/actors/parallax';
import '../../src/cinema/actors/nameslam';
import '../../src/cinema/actors/title';
import '../../src/cinema/actors/jawwipe';
import { setArenaSource, edgeWordCues, EDGE_WORDS } from '../../src/cinema/actors/edgepull';
import { EDGE } from '../../src/cinema/p6/edge';
import { providePack, readPack } from '../../src/cinema/p6/pack';
import { blit, textSprite } from '../../src/cinema/p6/text';
import { masterRamp } from '../../src/cinema/p4/palette';
import { Frame, finish, videoWriter } from './standin';

const OUT = 'press/cinema/edge';
const T0 = 77;
const T1 = 95;
const FPS = 60;
mkdirSync(OUT, { recursive: true });

for (const n of ['edge', 'heap', 'jaw'])
  providePack(n, readPack(readFileSync(`press/cinema/work/mouth/${n}.cfp`)));

// the arena stand-in: one native game frame (the 5th column of a 6-frame strip)
const strip = PNG.sync.read(readFileSync('docs/gallery/compare/after-witness-planet-mausoleum.png'));
const arena = new Uint32Array(640 * 360);
for (let y = 0; y < 360; y++)
  for (let x = 0; x < 640; x++) {
    const i = (y * strip.width + 4 * 640 + x) * 4;
    arena[y * 640 + x] =
      (0xff000000 | (strip.data[i + 2]! << 16) | (strip.data[i + 1]! << 8) | strip.data[i]!) >>> 0;
  }
setArenaSource(() => ({ w: 640, h: 360, pixels: arena }));

const words = edgeWordCues();
writeFileSync(
  `${OUT}/edge-cues.json`,
  JSON.stringify(
    {
      comment: 'Act IV: one word per coil pass (timeline s), from src/cinema/p6/edge.ts',
      edge: EDGE,
      words: EDGE_WORDS.map((w, i) => ({ word: w, t: words[i] })),
    },
    null,
    1,
  ),
);
console.log(`words: ${EDGE_WORDS.map((w, i) => `${w} ${words[i]!.toFixed(2)} s`).join(', ')}`);

const make = (type: string, depth: number, params: Record<string, unknown> = {}): Actor =>
  actorFactory(type)(type, depth, params);
const debris = make('parallax', 10, { layer: 'debris', seed: 7, drift: 3 });
const edgepull = make('edgepull', 30);
const jaw = make('jawwipe', 40, { holdUntil: EDGE.wipeEnd + 0.25 });
const title = make('title', 50, { at: 0 });
await edgepull.init?.({} as CineContext);
await jaw.init?.({} as CineContext);
title.init?.({} as CineContext);

const SHOTS = [
  { id: 'arena', start: 77, end: 80 },
  { id: 'edge', start: 80, end: 89 },
  { id: 'wipe', start: 89, end: 91 },
  { id: 'title', start: 91, end: 94 },
  { id: 'sting', start: 94, end: 95 },
];
const wordSprites = EDGE_WORDS.map((w, i) => textSprite(w, i === 3 ? '#d45e50' : '#fbe8d6', 4, 1));
const black = masterRamp('mouth.black')[0]!;
const frame = new Frame();
const buf = nativeBuffer();

function ctxAt(t: number, shot: { id: string; start: number }): CineContext {
  let r = 0x9e3779b9 ^ Math.round(t * FPS);
  return {
    frame: Math.round(t * FPS),
    t,
    shot: shot.id,
    shotT: t - shot.start,
    sceneT: t - shot.start,
    camera: { x: 320, y: 180, zoom: 1, dutch: 0, shakeX: 0, shakeY: 0 },
    view: { x0: Math.round((t - T0) * 6), y0: 0 },
    rng: () => (r = Math.imul(r ^ (r >>> 15), 0x2c1b3c6d) >>> 0) / 4294967296,
    params: {},
  };
}
const layer = (a: Actor, ctx: CineContext): void => {
  buf.pixels.fill(0);
  buf.emissive.fill(0);
  a.draw(buf, ctx);
  frame.over(buf);
};

function render(n: number): Uint32Array {
  const t = n / FPS;
  const shot = SHOTS.find((s) => t >= s.start && t < s.end) ?? SHOTS[SHOTS.length - 1]!;
  const ctx = ctxAt(t, shot);
  frame.clear(black);
  if (shot.id === 'arena' || (shot.id === 'edge' && t < EDGE.pullStart)) {
    frame.pixels.set(arena);
    layer(debris, ctx);
  }
  if (shot.id === 'edge') {
    layer(edgepull, ctx);
    // the words, one per coil pass (each held ~1 s), at ×4 in the game's font
    for (let i = 0; i < words.length; i++)
      if (t >= words[i]! && t < words[i]! + 1.0) {
        const s = wordSprites[i]!;
        buf.pixels.fill(0);
        buf.emissive.fill(0);
        blit(buf, s, Math.round(320 - (s.w * 1) / 2), 150, 0, 1);
        frame.over(buf);
      }
  }
  if (shot.id === 'wipe') {
    // the scene behind the closing jaws: the end of the pull-back, held
    layer(edgepull, ctxAt(EDGE.pullEnd - 1 / FPS, { id: 'edge', start: 80 }));
    layer(jaw, ctx);
  }
  if (shot.id === 'title') layer(title, ctx);
  return finish(frame);
}

const STILLS = [
  78,
  80.6,
  82.4,
  83.6,
  words[0]! + 0.2,
  words[1]! + 0.2,
  words[2]! + 0.2,
  words[3]! + 0.2,
  88.9,
  89.4,
  90.2,
  90.75,
  91.1,
  91.5,
  92.3,
  94.5,
];
{
  const S = 2;
  const cols = 4;
  const rows = Math.ceil(STILLS.length / cols) + 1;
  const sheet = new PNG({ width: 640 * S * cols, height: 360 * S * rows });
  const put = (f: Uint32Array, k: number): void => {
    const cx = (k % cols) * 640 * S;
    const cy = Math.floor(k / cols) * 360 * S;
    for (let y = 0; y < 360 * S; y++)
      for (let x = 0; x < 640 * S; x++) {
        const c = f[Math.floor(y / S) * 640 + Math.floor(x / S)]!;
        const o = ((cy + y) * sheet.width + cx + x) * 4;
        sheet.data[o] = c & 255;
        sheet.data[o + 1] = (c >>> 8) & 255;
        sheet.data[o + 2] = (c >>> 16) & 255;
        sheet.data[o + 3] = 255;
      }
  };
  STILLS.forEach((s, k) => put(render(Math.round(s * FPS)), k));
  // the last row: a nameslam's 6 frames over the arena (`행성 PLANET`), frames 0, 1, 2, 5
  const slam = make('nameslam', 60, { titan: 'planet', at: 0 });
  [0, 1, 2, 5].forEach((fr, j) => {
    frame.clear(black);
    frame.pixels.set(arena);
    layer(slam, { ...ctxAt(0, { id: 'slam', start: 0 }), shotT: fr / FPS });
    put(finish(frame), STILLS.length + j);
  });
  writeFileSync(`${OUT}/stills.png`, PNG.sync.write(sheet));
  console.log(`${OUT}/stills.png`);
}

if (process.argv[2] !== 'stills') {
  const file = `${OUT}/edge-0117-0135.mp4`;
  const v = videoWriter(file, FPS);
  const t0 = Date.now();
  const N = Math.round((T1 - T0) * FPS);
  for (let k = 0; k < N; k++) {
    await v.write(render(Math.round(T0 * FPS) + k));
    if (k % 300 === 0) console.log(`frame ${k}/${N} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await v.end();
  console.log(`${file} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
