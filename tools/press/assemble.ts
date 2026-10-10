import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { logoSprite } from '../../src/ui/pixel/logo';
import { PixelCanvas } from '../../src/ui/pixel/canvas';
import { drawText } from '../../src/ui/pixel/text';
import { PRESS, WORK, arg } from './common';
import type { Shot } from './shots';

/**
 * Cut the press kit from the rendered shots (press/work/clips, tools/press/clip.ts). Nothing is smoothed: the trailer is the
 * 1920×1080 game frame (640×360 at ×3) as rendered; the vertical cut crops a 540×360 game window and re-scales it ×3 → ×2
 * with nearest neighbour on the 3-px grid; GIFs are the true 640×360 pixels (area reduction is exact on ×3 blocks); stills
 * are ×2 nearest (game ×6). Sound is each shot's own (the game's engine, rendered for exactly those ticks).
 *   npx tsx tools/press/assemble.ts [trailer] [vertical] [loops] [stills]
 */
const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const on = (k: string): boolean => want.length === 0 || want.includes(k);
const CLIPS = `${WORK}/clips`;
const TMP = `${WORK}/tmp`;
mkdirSync(TMP, { recursive: true });

function ff(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}
const size = (p: string): string => `${(statSync(p).size / 1048576).toFixed(1)} MB`;
const out = (p: string): string => (mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }), p);

interface ClipInfo {
  shot: Shot;
  seconds: number;
  times: number[];
  showOf: number[];
}
const clips = new Map<string, ClipInfo>();
const clip = (name: string): ClipInfo => {
  let c = clips.get(name);
  if (!c) {
    c = JSON.parse(readFileSync(`${CLIPS}/${name}.json`, 'utf8')) as ClipInfo;
    clips.set(name, c);
  }
  return c;
};
/** Seconds into the clip at which `tick` is first shown. */
const timeOf = (name: string, tick: number): number => {
  const c = clip(name);
  const j = c.showOf.findIndex((i) => c.shot.t0 + i >= tick);
  return (j < 0 ? c.showOf.length : j) / 60;
};

interface Seg {
  clip: string;
  /** anchor tick, and seconds of the clip before / after it */
  at: number;
  pre: number;
  post: number;
  caption?: [string, string];
  /** vertical cut: the crop window's left edge in game px (0..100), default centred */
  cx?: number;
}
const span = (s: Seg): { ss: number; d: number } => {
  const t = timeOf(s.clip, s.at);
  const ss = Math.max(0, t - s.pre);
  const d = Math.min(clip(s.clip).seconds - 0.05, t + s.post) - ss;
  return { ss: +ss.toFixed(3), d: +d.toFixed(3) };
};

/* ---------- overlays drawn in the game's pixel font ---------- */
function writeRgba(path: string, cv: { pixels: Uint32Array; w: number; h: number }, k: number): void {
  const png = new PNG({ width: cv.w * k, height: cv.h * k });
  for (let y = 0; y < cv.h * k; y++)
    for (let x = 0; x < cv.w * k; x++) {
      const c = cv.pixels[Math.floor(y / k) * cv.w + Math.floor(x / k)]!;
      const o = (y * cv.w * k + x) * 4;
      png.data[o] = c & 255;
      png.data[o + 1] = (c >>> 8) & 255;
      png.data[o + 2] = (c >>> 16) & 255;
      png.data[o + 3] = c >>> 24;
    }
  writeFileSync(path, PNG.sync.write(png));
}
/** A 1920×1080 transparent caption (640×360 game px at ×3): titan name, Korean name, bottom left. */
function caption(en: string, ko: string): string {
  const path = `${TMP}/cap-${en.replace(/\W+/g, '_')}.png`;
  const cv = new PixelCanvas(640, 360);
  drawText(cv, en, 16, 318, { color: 0xffffffff, outline: 0xff100808, scale: 2, tracking: 1 });
  drawText(cv, ko, 16, 302, { color: 0xffe8dcc8, outline: 0xff100808 });
  writeRgba(path, cv, 3);
  return path;
}
/** The logotype ×6 on the game's near-black, 1920×1080. */
function logoCard(): string {
  const path = `${TMP}/logo-card.png`;
  const logo = logoSprite();
  const cv = new PixelCanvas(320, 180);
  cv.clear(0xff0d0807);
  const x0 = (320 - logo.w) >> 1;
  const y0 = (180 - logo.h) >> 1;
  for (let y = 0; y < logo.h; y++)
    for (let x = 0; x < logo.w; x++) {
      const c = logo.pixels[y * logo.w + x]!;
      if (c >>> 24 === 255) cv.pixels[(y0 + y) * 320 + x0 + x] = c;
      else if (c >>> 24) {
        const t = (c >>> 24) / 255;
        const d = 0xff0d0807;
        const m = (s: number): number => Math.round(((c >>> s) & 255) * t + ((d >>> s) & 255) * (1 - t)) << s;
        cv.pixels[(y0 + y) * 320 + x0 + x] = (0xff000000 | m(16) | m(8) | m(0)) >>> 0;
      }
    }
  writeRgba(path, cv, 6);
  return path;
}

/* ---------- a cut: segments (+ cards) → one file ---------- */
interface Card {
  image: string;
  d: number;
  /** the sound under it: this clip continuing from `from` seconds */
  audio: { clip: string; from: number };
  fadeIn?: number;
}
type Part = Seg | Card;
const isCard = (p: Part): p is Card => 'image' in p;

function cut(
  parts: Part[],
  file: string,
  vf: (label: string, i: number, p: Part) => string,
  enc: string[],
): void {
  const inputs: string[] = [];
  const idx = new Map<string, number>();
  const input = (path: string, img = false): number => {
    const key = `${img ? 'img:' : ''}${path}`;
    if (!idx.has(key)) {
      idx.set(key, idx.size);
      inputs.push(...(img ? ['-loop', '1', '-framerate', '60', '-i', path] : ['-i', path]));
    }
    return idx.get(key)!;
  };
  const g: string[] = [];
  const labels: string[] = [];
  parts.forEach((p, i) => {
    if (isCard(p)) {
      const k = input(p.image, true);
      const a = input(`${CLIPS}/${p.audio.clip}.mov`);
      g.push(
        `[${k}:v]trim=duration=${p.d},setpts=PTS-STARTPTS,format=yuv444p${p.fadeIn ? `,fade=in:st=0:d=${p.fadeIn}` : ''}[c${i}]`,
      );
      g.push(`[c${i}]${vf(`c${i}`, i, p)}[v${i}]`);
      g.push(
        `[${a}:a]atrim=start=${p.audio.from}:duration=${p.d},asetpts=PTS-STARTPTS,afade=out:st=${Math.max(0, p.d - 2.5)}:d=2.5,apad=whole_dur=${p.d}[a${i}]`,
      );
    } else {
      const { ss, d } = span(p);
      const k = input(`${CLIPS}/${p.clip}.mov`);
      let v = `[${k}:v]trim=start=${ss}:duration=${d},setpts=PTS-STARTPTS[s${i}]`;
      if (p.caption) {
        const c = input(caption(p.caption[0], p.caption[1]), true);
        v += `;[${c}:v]trim=duration=${d},setpts=PTS-STARTPTS,fade=in:st=0.25:d=0.2:alpha=1,fade=out:st=${Math.max(0.5, d - 0.6)}:d=0.2:alpha=1[cap${i}];[s${i}][cap${i}]overlay=0:0:format=auto[t${i}]`;
      } else v += `;[s${i}]null[t${i}]`;
      g.push(v);
      g.push(`[t${i}]${vf(`t${i}`, i, p)}[v${i}]`);
      g.push(
        `[${k}:a]atrim=start=${ss}:duration=${d},asetpts=PTS-STARTPTS,afade=in:st=0:d=0.01,afade=out:st=${Math.max(0, d - 0.04)}:d=0.04[a${i}]`,
      );
    }
    labels.push(`[v${i}][a${i}]`);
  });
  g.push(`${labels.join('')}concat=n=${parts.length}:v=1:a=1[v][a]`);
  writeFileSync(`${TMP}/graph.txt`, g.join(';\n'));
  ff([
    ...inputs,
    '-filter_complex_script',
    `${TMP}/graph.txt`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-r',
    '60',
    ...enc,
    file,
  ]);
  const d = parts.reduce((a, p) => a + (isCard(p) ? p.d : span(p).d), 0);
  console.log(`${file}: ${d.toFixed(1)} s, ${size(file)}`);
}

const H264 = (crf: number): string[] => [
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  String(crf),
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '256k',
  '-movflags',
  '+faststart',
];
const VP9 = (crf: number): string[] => [
  '-c:v',
  'libvpx-vp9',
  '-b:v',
  '0',
  '-crf',
  String(crf),
  '-row-mt',
  '1',
  '-deadline',
  'good',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'libopus',
  '-b:a',
  '160k',
];

const TITLE = `${PRESS}/keyart/title-screen-1080p.png`;
const NAMES: Record<string, [string, string]> = {
  witness: ['THE WITNESS', '마지막 하나'],
  uri: ['URI', '우리'],
  supernova: ['SUPERNOVA', '초신성'],
  blackhole: ['BLACK HOLE', '블랙홀'],
  planet: ['PLANET', '행성'],
  nexus: ['THE NEXUS', '넥서스'],
  asteroid: ['THE ASTEROID', '소행성'],
};

/* ---------- 1. the sizzle trailer, 1920×1080 60 fps ---------- */
if (on('trailer')) {
  const hook: Seg = { clip: 'supernova-nova-ko', at: 4724, pre: 0.75, post: 1.3 };
  const hs = span(hook);
  const lastAt = 3781;
  const parts: Part[] = [
    hook,
    { image: logoCard(), d: 1.7, audio: { clip: 'supernova-nova-ko', from: hs.ss + hs.d }, fadeIn: 0.15 },
    { clip: 'witness-gaze', at: 2973, pre: 1.1, post: 2.0, caption: NAMES.witness },
    { clip: 'planet-slab', at: 2447, pre: 1.0, post: 1.9, caption: NAMES.planet },
    { clip: 'supernova-flare', at: 1203, pre: 1.3, post: 2.0, caption: NAMES.supernova },
    { clip: 'blackhole-well', at: 7974, pre: 1.1, post: 2.3, caption: NAMES.blackhole },
    { clip: 'asteroid-impact', at: 9692, pre: 1.2, post: 1.6, caption: NAMES.asteroid },
    { clip: 'blackhole-ultimate', at: 2980, pre: 1.0, post: 2.0 },
    { clip: 'nexus-ko', at: 9032, pre: 1.3, post: 2.6, caption: NAMES.nexus },
    { clip: 'supernova-collapse', at: 5344, pre: 0.9, post: 2.4 },
    { clip: 'witness-planet', at: 5221, pre: 1.2, post: 2.0 },
    { clip: 'planet-ko', at: 8151, pre: 1.2, post: 3.0 },
    { clip: 'uri-break-apart', at: lastAt, pre: 2.0, post: 3.2, caption: NAMES.uri },
  ];
  const last = span(parts[parts.length - 1] as Seg);
  parts.push({ image: TITLE, d: 5, audio: { clip: 'uri-break-apart', from: last.ss + last.d }, fadeIn: 0.5 });
  const file = out(`${PRESS}/video/adeuk-titans-trailer-1080p60.mp4`);
  cut(parts, file, () => 'setsar=1', H264(14));
  ff(['-i', file, ...VP9(24), file.replace('.mp4', '.webm')]);
  console.log(`${file.replace('.mp4', '.webm')}: ${size(file.replace('.mp4', '.webm'))}`);
}

/* ---------- 2. the vertical cut, 1080×1920 ---------- */
if (on('vertical')) {
  const logo = logoSprite();
  // the logotype ×3 over the frame (the area above the gameplay), on the vertical's background
  const lc = new PixelCanvas(360, 640);
  lc.clear(0);
  const lx = (360 - logo.w) >> 1;
  for (let y = 0; y < logo.h; y++)
    for (let x = 0; x < logo.w; x++) lc.pixels[(118 + y) * 360 + lx + x] = logo.pixels[y * logo.w + x]!;
  const top = `${TMP}/vertical-top.png`;
  writeRgba(top, lc, 3);
  const BG = '0x0d0807';
  // crop a 540×360 game window (1620×1080 on the ×3 grid), ×3 → ×2 nearest = 1080×720, centred at y 600
  const vf = (_l: string, _i: number, p: Part): string => {
    const cx = isCard(p) ? 50 : (p.cx ?? 50);
    const crop = `crop=1620:1080:${cx * 3}:0,scale=1080:720:flags=neighbor`;
    return `${crop},pad=1080:1920:0:(1920-ih)/2:color=${BG},setsar=1`;
  };
  const hook: Seg = { clip: 'supernova-nova-ko', at: 4724, pre: 0.6, post: 1.6, cx: 0 };
  const parts: Part[] = [
    hook,
    { clip: 'witness-gaze', at: 2973, pre: 1.0, post: 2.0, cx: 0 },
    { clip: 'supernova-flare', at: 1203, pre: 1.0, post: 1.8 },
    { clip: 'blackhole-well', at: 7974, pre: 1.0, post: 2.0 },
    { clip: 'planet-ko', at: 8151, pre: 1.0, post: 2.6, cx: 80 },
    { clip: 'uri-break-apart', at: 3781, pre: 1.6, post: 3.0 },
  ];
  const last = span(parts[parts.length - 1] as Seg);
  parts.push({
    image: TITLE,
    d: 3.5,
    audio: { clip: 'uri-break-apart', from: last.ss + last.d },
    fadeIn: 0.4,
  });
  const raw = `${TMP}/vertical-raw.mp4`;
  cut(parts, raw, vf, [
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '8',
    '-pix_fmt',
    'yuv444p',
    '-c:a',
    'pcm_s16le',
    '-f',
    'mov',
  ]);
  const file = out(`${PRESS}/video/adeuk-titans-vertical-1080x1920.mp4`);
  ff([
    '-i',
    raw,
    '-loop',
    '1',
    '-i',
    top,
    '-filter_complex',
    '[0:v][1:v]overlay=0:0:shortest=1[v]',
    '-map',
    '[v]',
    '-map',
    '0:a',
    ...H264(16),
    file,
  ]);
  console.log(`${file}: ${size(file)}`);
}

/* ---------- 3. the loops: MP4 + WebM + GIF ≤ 8 MB ---------- */
interface Loop {
  name: string;
  seg: Seg;
}
const LOOPS: Loop[] = [
  { name: 'witness-gaze', seg: { clip: 'witness-gaze', at: 2973, pre: 1.6, post: 3.4 } },
  { name: 'uri-break-apart', seg: { clip: 'uri-break-apart', at: 3781, pre: 2.4, post: 4.0 } },
  { name: 'supernova-nova', seg: { clip: 'supernova-nova-ko', at: 4724, pre: 1.6, post: 4.4 } },
  { name: 'supernova-flare', seg: { clip: 'supernova-flare', at: 1203, pre: 2.0, post: 3.0 } },
  { name: 'blackhole-well', seg: { clip: 'blackhole-well', at: 7974, pre: 2.0, post: 3.0 } },
  { name: 'blackhole-ultimate', seg: { clip: 'blackhole-ultimate', at: 2980, pre: 1.6, post: 3.0 } },
  { name: 'planet-slab', seg: { clip: 'planet-slab', at: 2447, pre: 2.0, post: 3.0 } },
  { name: 'planet-ko', seg: { clip: 'planet-ko', at: 8151, pre: 1.6, post: 4.4 } },
  { name: 'supernova-collapse', seg: { clip: 'supernova-collapse', at: 5344, pre: 1.6, post: 3.4 } },
  { name: 'nexus-ko', seg: { clip: 'nexus-ko', at: 9032, pre: 1.8, post: 4.2 } },
  { name: 'asteroid-impact', seg: { clip: 'asteroid-impact', at: 9692, pre: 2.0, post: 2.6 } },
  { name: 'witness-vs-planet', seg: { clip: 'witness-planet', at: 5221, pre: 2.0, post: 3.0 } },
];
if (on('loops')) {
  const only = arg('only', '');
  for (const l of LOOPS) {
    if (only && !only.split(',').includes(l.name)) continue;
    const { ss, d } = span(l.seg);
    const src = `${CLIPS}/${l.seg.clip}.mov`;
    const base = out(`${PRESS}/loops/${l.name}`);
    if (arg('gifonly', '0') !== '1') {
      ff(['-ss', String(ss), '-t', String(d), '-i', src, ...H264(18), `${base}.mp4`]);
      ff(['-ss', String(ss), '-t', String(d), '-i', src, ...VP9(30), `${base}.webm`]);
    }
    // GIF: the true 640×360 game pixels, a palette per loop; fewer frames, then a shorter window round the anchor, until ≤ 8 MB
    const anchor = timeOf(l.seg.clip, l.seg.at);
    const tries: [number, number][] = [
      [20, d],
      [15, d],
      [15, Math.min(d, 4.5)],
      [12, Math.min(d, 4)],
      [12, Math.min(d, 3.4)],
      [10, Math.min(d, 3)],
    ];
    let used: [number, number] = tries[0]!;
    for (const [fps, gd] of tries) {
      used = [fps, gd];
      const gs = Math.max(ss, Math.min(anchor - gd * 0.35, ss + d - gd));
      ff([
        '-ss',
        String(gs.toFixed(3)),
        '-t',
        String(gd.toFixed(3)),
        '-i',
        src,
        '-filter_complex',
        `fps=${fps},scale=640:360:flags=area,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
        `${base}.gif`,
      ]);
      if (statSync(`${base}.gif`).size <= 8 * 1048576) break;
    }
    console.log(
      `${l.name}: ${d.toFixed(1)} s  mp4 ${size(`${base}.mp4`)}  webm ${size(`${base}.webm`)}  gif ${size(`${base}.gif`)} (${used[1].toFixed(1)} s @ ${used[0]} fps)`,
    );
  }
}

/* ---------- 4. hero stills: lossless 1080p frames ×2 nearest → 3840×2160 ---------- */
if (on('stills')) {
  const picks = arg('picks', '').split(',').filter(Boolean);
  const list = picks.length ? picks : (JSON.parse(readFileSync(`${WORK}/stills.json`, 'utf8')) as string[]);
  let n = 0;
  for (const name of list) {
    const src = `${WORK}/stills/${name}.png`;
    if (!existsSync(src)) throw new Error(`no still ${src}`);
    const png = PNG.sync.read(readFileSync(src));
    const o = new PNG({ width: png.width * 2, height: png.height * 2 });
    for (let y = 0; y < o.height; y++)
      for (let x = 0; x < o.width; x++) {
        const s = ((y >> 1) * png.width + (x >> 1)) * 4;
        const d = (y * o.width + x) * 4;
        o.data[d] = png.data[s]!;
        o.data[d + 1] = png.data[s + 1]!;
        o.data[d + 2] = png.data[s + 2]!;
        o.data[d + 3] = 255;
      }
    const file = out(`${PRESS}/stills/${String(++n).padStart(2, '0')}-${name.replace(/-\d+$/, '')}-4k.png`);
    writeFileSync(file, PNG.sync.write(o));
    console.log(`${file}: ${size(file)}`);
  }
}
