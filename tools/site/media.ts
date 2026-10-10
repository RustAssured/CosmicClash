/**
 * The landing page's web media (site/media/): small web encodes of the trailer, the hero loop, the feature and titan loops,
 * pixel-exact screenshots, posters, the social card and the favicons. Needs ffmpeg on PATH.
 *
 *   npx tsx tools/site/media.ts              # everything
 *   npx tsx tools/site/media.ts hero shots   # only some groups (hero, trailer, features, titans, shots, social, icons)
 *
 * SWAPPING IN THE PRESS KIT: every output's source is in SOURCES below. Today they point at the comparison footage
 * (evidence/compare, evidence/uri) and stills (docs/gallery). When S5's press/ assets land, point each entry at the press
 * file (and its in/out points), re-run, and commit site/media. press/ itself is git-ignored, so the page never links into
 * it for media; only the press-kit download list does (see tools/site/build.ts).
 *
 * Pixel art: the footage is the 640×360 game at ×3. Every clip is reduced to the true 640×360 pixels (area filter, exact on
 * ×3 blocks) and, for the large clips, re-enlarged ×2 with nearest neighbour to 1280×720, so 4:2:0 chroma blocks fall on
 * pixel edges and the browser's own `image-rendering: pixelated` upscale stays crisp.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const EV = 'evidence/compare';
const WP = `${EV}/now-witness-planet.mp4`;
const BN = `${EV}/now-engine-blackhole-nexus.mp4`;
const LA = `${EV}/now-engine-lastone-asteroid.mp4`;
const SP = `${EV}/orig-supernova-planet.mp4`;
const UW = 'evidence/uri/uri-vs-witness.mp4';
const SHEET = 'docs/gallery/compare/after-sheet.png'; // 6 columns × 8 rows of native 640×360 frames
const SIZES = 'docs/gallery/compare/sizes.png'; // 2×2 panels at ×2

interface Cut {
  src: string;
  /** in point and length, seconds */
  ss: number;
  t: number;
}

/** Where every output comes from. Replace these with S5's press files when they exist. */
const SOURCES = {
  /** muted background loop in the hero: hard cuts between a few vivid moments */
  hero: [
    { src: BN, ss: 1, t: 4 },
    { src: SP, ss: 6.5, t: 4 },
    { src: WP, ss: 7, t: 4 },
    { src: UW, ss: 17.5, t: 4 },
  ] as Cut[],
  /** the v2 trailer, with sound (lightbox): S5's master; `poster` is the poster frame time (TRAILER.md: shot 2 or 7) */
  trailer: { src: 'press/trailer/trailer-60.mp4', ss: 0, t: 60, poster: 5 } as Cut & { poster?: number },
  features: {
    orbit: { src: WP, ss: 3, t: 6 },
    matter: { src: WP, ss: 9, t: 6 },
    // one nova wash per 5 s loop, and the loop seam joins two similar frames (no flash at the cut)
    impact: { src: SP, ss: 7.5, t: 5 },
    sound: { src: UW, ss: 18, t: 6 },
  } as Record<string, Cut>,
  /** hover loops on the roster cards */
  titans: {
    witness: { src: WP, ss: 0.5, t: 4 },
    planet: { src: WP, ss: 11, t: 4 },
    asteroid: { src: LA, ss: 4, t: 4 },
    nexus: { src: BN, ss: 5, t: 4 },
    blackhole: { src: BN, ss: 10, t: 4 },
    supernova: { src: SP, ss: 1, t: 4 },
    uri: { src: UW, ss: 2, t: 4 },
  } as Record<string, Cut>,
  /** gallery stills, cut from the after-sheet (row, column) or a 1280×720 file at ×2 */
  shots: [
    { name: 'witness-planet-nursery', sheet: [0, 3] },
    { name: 'blackhole-nexus-nursery', sheet: [1, 2] },
    { name: 'supernova-planet-nursery', sheet: [2, 4] },
    { name: 'witness-asteroid-rim', sheet: [3, 2] },
    { name: 'supernova-blackhole-shearfield', sheet: [5, 0] },
    { name: 'nexus-asteroid-redgiant', sheet: [6, 2] },
    { name: 'planet-supernova-quasar', sheet: [7, 3] },
    { name: 'witness-planet-mausoleum', sheet: [4, 4] },
    { name: 'uri-planet', file: SIZES, crop: [1280, 0] },
    { name: 'title', file: 'docs/gallery/ui-title.png', crop: [0, 0] },
  ] as { name: string; sheet?: [number, number]; file?: string; crop?: [number, number] }[],
  /** the Open Graph / Twitter card background (a shot name from above) */
  social: 'supernova-planet-nursery',
};

const OUT = 'site/media';
const PIX720 = 'scale=640:360:flags=area,scale=1280:720:flags=neighbor,setsar=1';
const PIX360 = 'scale=640:360:flags=area,setsar=1';

function ff(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

function out(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function report(path: string): void {
  console.log(`${path}  ${(statSync(path).size / 1024).toFixed(0)} KB`);
}

/** One web pair (MP4/H.264 + WebM/VP9) from a filter graph over the given inputs. */
function encodePair(
  inputs: string[],
  graph: string,
  base: string,
  opts: { audio?: boolean; crf264?: number; crf9?: number; kbps?: number },
): void {
  // `kbps` caps the bitrate (VP9 constrained quality; x264 VBV) so dithered pixel art cannot blow the size budget
  const cap = opts.kbps ?? 0;
  const vp9 = [
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    cap ? `${cap}k` : '0',
    '-crf',
    String(opts.crf9 ?? 36),
    '-row-mt',
    '1',
    '-deadline',
    'good',
  ];
  const h264 = [
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    String(opts.crf264 ?? 25),
    '-pix_fmt',
    'yuv420p',
    ...(cap ? ['-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`] : []),
  ];
  const amap = opts.audio ? ['-map', '[a]'] : ['-an'];
  ff([
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    ...amap,
    ...h264,
    ...(opts.audio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    '-movflags',
    '+faststart',
    out(`${base}.mp4`),
  ]);
  ff([
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    ...amap,
    ...vp9,
    '-pix_fmt',
    'yuv420p',
    ...(opts.audio ? ['-c:a', 'libopus', '-b:a', '96k'] : []),
    out(`${base}.webm`),
  ]);
  report(`${base}.mp4`);
  report(`${base}.webm`);
}

const cutIn = (c: Cut): string[] => ['-ss', String(c.ss), '-t', String(c.t), '-i', c.src];

/** Poster: the first frame of a finished MP4, as JPEG. */
function poster(mp4: string, jpg: string, at = 0): void {
  ff(['-ss', String(at), '-i', mp4, '-frames:v', '1', '-q:v', '3', out(jpg)]);
  report(jpg);
}

const groups = {
  hero(): void {
    const cuts = SOURCES.hero;
    const inputs = cuts.flatMap(cutIn);
    // the hero is a cover-scaled background, so it may zoom: drop the HUD (top 60 and bottom 15 game px)
    const parts = cuts
      .map(
        (_, i) =>
          `[${i}:v]scale=640:360:flags=area,crop=507:285:66:60,scale=1280:720:flags=neighbor,setsar=1,fps=30[v${i}]`,
      )
      .join(';');
    const graph = `${parts};${cuts.map((_, i) => `[v${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0[v]`;
    // budget: about 6 MB per format for the 16 s loop
    encodePair(inputs, graph, `${OUT}/hero/loop`, { crf264: 27, crf9: 38, kbps: 3000 });
    poster(`${OUT}/hero/loop.mp4`, `${OUT}/hero/poster.jpg`, 0.5);
  },
  trailer(): void {
    // the v2 trailer (docs/site/TRAILER.md), web-encoded from S5's master; the page shows its button once this exists
    const c = SOURCES.trailer;
    if (!existsSync(c.src)) {
      console.log(`(no ${c.src} yet: the site keeps its trailer button hidden)`);
      return;
    }
    encodePair(cutIn(c), `[0:v]${PIX720},fps=30[v];[0:a]anull[a]`, `${OUT}/trailer/trailer-60`, {
      audio: true,
      crf264: 24,
      crf9: 35,
      kbps: 1900, // about 14 MB for 60 s
    });
    poster(`${OUT}/trailer/trailer-60.mp4`, `${OUT}/trailer/trailer-60.jpg`, c.poster ?? 3);
  },
  features(): void {
    for (const [name, c] of Object.entries(SOURCES.features)) {
      if (!only('features', name)) continue;
      const audio = name === 'sound';
      const graph = `[0:v]${PIX720},fps=30[v]${audio ? ';[0:a]anull[a]' : ''}`;
      encodePair(cutIn(c), graph, `${OUT}/features/${name}`, { audio, crf264: 27, crf9: 38, kbps: 2400 });
      poster(`${OUT}/features/${name}.mp4`, `${OUT}/features/${name}.jpg`, 0.2);
    }
  },
  titans(): void {
    for (const [name, c] of Object.entries(SOURCES.titans))
      if (only('titans', name))
        encodePair(cutIn(c), `[0:v]${PIX360},fps=30[v]`, `${OUT}/titans/${name}-loop`, {
          crf264: 26,
          crf9: 38,
          kbps: 900,
        });
  },
  shots(): void {
    for (const s of SOURCES.shots) {
      // lossless WebP at the true 640×360: pixel-exact and about half the size of a PNG
      const dst = out(`${OUT}/shots/${s.name}.webp`);
      const webp = ['-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', '-frames:v', '1', dst];
      if (s.sheet) {
        const [row, col] = s.sheet;
        ff(['-i', SHEET, '-vf', `crop=640:360:${col * 640}:${row * 360}`, ...webp]);
      } else {
        const [x, y] = s.crop ?? [0, 0];
        ff(['-i', s.file!, '-vf', `crop=1280:720:${x}:${y},scale=640:360:flags=neighbor`, ...webp]);
      }
      report(dst);
      // the grid's thumbnail: lossy, same pixels (the lightbox loads the lossless one)
      const th = out(`${OUT}/shots/thumb/${s.name}.webp`);
      ff(['-i', dst, '-c:v', 'libwebp', '-quality', '82', '-frames:v', '1', th]);
      report(th);
    }
  },
  social(): void {
    // 1200×630: the shot at ×2, darkened toward the bottom-left, the logotype at ×3 over it
    const shot = `${OUT}/shots/${SOURCES.social}.webp`;
    const logo = `${OUT}/type/logo.png`;
    const graph =
      '[0:v]scale=1280:720:flags=neighbor,crop=1200:630:40:76,' +
      "geq=r='r(X,Y)*(0.45+0.55*Y/H)':g='g(X,Y)*(0.45+0.55*Y/H)':b='b(X,Y)*(0.5+0.5*Y/H)'[bg];" +
      '[1:v]scale=iw*3:ih*3:flags=neighbor[l];[bg][l]overlay=(W-w)/2:40[v]';
    ff([
      '-i',
      shot,
      '-i',
      logo,
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      out(`${OUT}/og.jpg`),
    ]);
    report(`${OUT}/og.jpg`);
  },
  icons(): void {
    const src = `${OUT}/favicon-180.png`;
    for (const s of [32, 16]) {
      ff(['-i', src, '-vf', `scale=${s}:${s}:flags=area`, out(`${OUT}/favicon-${s}.png`)]);
      report(`${OUT}/favicon-${s}.png`);
    }
  },
};

const want = process.argv.slice(2).map((a) => a.split('='));
/** `features=impact,sound` limits a group to some of its items. */
function only(group: string, item: string): boolean {
  const w = want.find(([g]) => g === group);
  return !w || !w[1] || w[1].split(',').includes(item);
}
for (const [name, run] of Object.entries(groups)) {
  if (want.length && !want.some(([g]) => g === name)) continue;
  console.log(`\n== ${name}`);
  run();
}
for (const s of [WP, BN, LA, SP, UW, SHEET, SIZES])
  if (!existsSync(s))
    console.warn(`(missing source ${s}: the placeholders need the local evidence/ footage)`);
