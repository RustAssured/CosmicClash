import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { LOGICAL_H, LOGICAL_W, type TitanId, type ViewRect } from '../../../src/contracts';
import { PixelCanvas } from '../../../src/ui/pixel/canvas';
import { drawText } from '../../../src/ui/pixel/text';
import { ROSTER } from '../../../src/titans/roster';
import { blitLayers, makeFrame, paintBackdrop } from '../../../dev/titans/blit';
import { arg } from '../common';
import { MARK } from './cue';
import { EDL, type Card, type Clip } from './edl';
import { buildMatch } from './scan';
import { TAKES_DIR, cfgOf, schedule } from './takes';
import { BONE, DIM, EDGE, EMBER, INK, RED, VOID, blitCentred, counter, logo, scrim, slamWord, whisper } from './type';

/**
 * "WHAT'S LEFT": cut the animatic. Every output frame (60 fps, 60 s) is the edit's footage at native 640×360 (the take shot
 * in the real game when it exists, else the software compositor's stand-in), the type and the matter counters drawn over
 * it in the game's own pixel type, ×3 nearest → 1920×1080, with the score.
 *   npx tsx tools/press/sixty/edit.ts [--out=press/sixty/whats-left.mp4] [--from=0] [--to=60] [--scale=3]
 */
const OUT = arg('out', 'press/sixty/whats-left.mp4');
const FROM = Number(arg('from', '0'));
const TO = Number(arg('to', '60'));
const SCALE = Number(arg('scale', '3'));
const FPS = 60;
const W = LOGICAL_W;
const H = LOGICAL_H;

const nameOf = (id: TitanId): { name: string; ko: string } => {
  const r = ROSTER.find((x) => x.id === id);
  if (r) return { name: r.site.name.replace(/^THE /i, '').toUpperCase(), ko: r.site.ko };
  return id === 'mouth' ? { name: 'MOUTH', ko: '입' } : { name: id.toUpperCase(), ko: '' };
};

/** A titan's whole body (cells) at the bell: the counter's 100 %. */
const startCells = new Map<string, number>();
function fullBody(key: string, slot: 0 | 1): number {
  const k = `${key}:${slot}`;
  if (!startCells.has(k)) {
    const m = buildMatch(cfgOf(key));
    startCells.set(k, (m.fighters[slot]!.view.bodyStats as { cells: number }).cells);
  }
  return startCells.get(k)!;
}

interface Frame {
  px: Uint32Array;
  cells: number[];
}

/** A clip's frames, one at a time: the real take (FFV1 decoded) or the software stand-in. */
function* clipFrames(c: Clip): Generator<Frame> {
  const n = Math.round(c.dur * FPS);
  const id = c.take.id;
  if (existsSync(`${TAKES_DIR}/${id}.mkv`) && existsSync(`${TAKES_DIR}/${id}.json`)) {
    const meta = JSON.parse(readFileSync(`${TAKES_DIR}/${id}.json`, 'utf8')) as { frames: { cells: number[] }[] };
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', `${TAKES_DIR}/${id}.mkv`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
      maxBuffer: 1024 * 1024 * 1024,
    }).stdout;
    const per = W * H * 4;
    for (let f = 0; f < n; f++) {
      const k = Math.min(f, meta.frames.length - 1);
      const px = new Uint32Array(raw.buffer, raw.byteOffset + k * per, W * H).slice();
      yield { px, cells: meta.frames[k]!.cells };
    }
    return;
  }
  // stand-in: the same match in Node, the game's own layers through the software compositor, the pair's midpoint
  const m = buildMatch(cfgOf(c.take.key));
  for (const s of schedule(c.take, n)) {
    while (m.tick < s.tick) m.step();
    const v = m.fighters.map((f) => f.view);
    const fol = c.take.cam?.follow;
    const cx = fol === 0 || fol === 1 ? v[fol]!.x : (v[0]!.x + v[1]!.x) / 2;
    const cy = fol === 0 || fol === 1 ? v[fol]!.y : (v[0]!.y + v[1]!.y) / 2;
    const view: ViewRect = { x0: Math.round(cx - W / 2), y0: Math.round(cy - H / 2), w: W, h: H };
    const fr = makeFrame();
    paintBackdrop(fr);
    blitLayers(fr, [...m.fighters[0]!.renderLayers(view, 1), ...m.fighters[1]!.renderLayers(view, 1), ...m.world.renderLayers(view, 1)], view, 1);
    yield { px: fr, cells: v.map((x) => (x.bodyStats as { cells: number }).cells) };
  }
}

const STYLE = { bone: BONE, ember: EMBER, void: VOID } as const;

function drawCard(cv: PixelCanvas, k: Card, t: number, frame: number): void {
  const u = t - k.at;
  const f = Math.round(u * FPS);
  switch (k.k) {
    case 'whisper': {
      const scale = k.scale ?? 1;
      const lh = 14 * scale;
      const y = k.y ?? 150;
      scrim(cv, y - 6, y + lh * k.lines.length + 2, 0.55);
      // earlier lines stand whole (a previous card typed them); the last one types in
      const typed = u * (k.typeCps ?? 24);
      for (const [i, line] of k.lines.entries())
        whisper(cv, line, y + i * lh, i < k.lines.length - 1 ? line.length : typed, scale);
      break;
    }
    case 'slam': {
      const size = k.size ?? 5;
      const s = slamWord(k.word, STYLE[k.style], size);
      const y = k.y ?? Math.round(H / 2 - s.h / 2 - (k.sub ? 8 : 0));
      // the slam: two white frames, then the metal; a short shake that dies away
      const shake = f < 8 ? Math.round((8 - f) / 3) * (f % 2 ? 1 : -1) : 0;
      scrim(cv, y - 4, y + s.h + (k.sub ? 18 : 2), 0.6);
      blitCentred(cv, s, W / 2 + shake, y + (f < 8 ? -shake : 0), f < 2);
      if (k.sub && f >= 3) drawText(cv, k.sub, W / 2, y + s.h + 4, { color: DIM, outline: EDGE, align: 'center', tracking: 2 });
      break;
    }
    case 'ah': {
      cv.clear(0xff000000);
      const big = f < 2 ? 0xffffffff : INK;
      drawText(cv, '아득', W / 2, 120, { color: big, outline: EDGE, align: 'center', scale: 6 });
      if (f > 30) drawText(cv, 'ADEUK', W / 2, 214, { color: DIM, align: 'center', tracking: 6 });
      break;
    }
    case 'title': {
      cv.clear(0xff000000);
      if (f < 3) {
        cv.clear(f === 0 ? 0xffffffff : 0xff302830);
        break;
      }
      logo(cv, u);
      drawText(cv, '아득', W / 2, 196, { color: INK, outline: EDGE, align: 'center', scale: 2 });
      if (u > 0.9) drawText(cv, 'FREE IN YOUR BROWSER', W / 2, 238, { color: INK, outline: EDGE, align: 'center', tracking: 3 });
      break;
    }
    case 'sting': {
      // the counter types in once more, for something it cannot count
      const shown = Math.floor(u * 14);
      const label = '??? · ???,??? PX'.slice(0, shown);
      drawText(cv, label, W - 14, 330, { color: RED, outline: EDGE, align: 'right', tracking: 1, scale: 2 });
      break;
    }
    case 'countIn':
      break;
  }
  void frame;
}

const cards = EDL.cards;
const clips = [...EDL.clips].sort((a, b) => a.at - b.at);
const ff = spawn(
  'ffmpeg',
  [
    '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    ...(existsSync('press/sixty/score.wav') ? ['-ss', String(FROM), '-t', String(TO - FROM), '-i', 'press/sixty/score.wav'] : []),
    '-sws_flags', 'neighbor', '-vf', `scale=${W * SCALE}:${H * SCALE}:flags=neighbor`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-tune', 'animation', '-pix_fmt', 'yuv420p',
    ...(existsSync('press/sixty/score.wav') ? ['-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
    '-movflags', '+faststart', OUT,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
const write = async (b: Uint8Array): Promise<void> => {
  if (!ff.stdin.write(b)) await new Promise((r) => ff.stdin.once('drain', r));
};

const total = Math.round((TO - FROM) * FPS);
const shownCells: Record<'left' | 'right', number | null> = { left: null, right: null };
const counterClip: Record<'left' | 'right', Clip | null> = { left: null, right: null };
let ci = 0;
let gen: Generator<Frame> | null = null;
let genClip: Clip | null = null;
const t0 = Date.now();
let real = 0;
for (let i = 0; i < total; i++) {
  const t = FROM + i / FPS;
  const cv = new PixelCanvas(W, H);
  cv.clear(0xff000000);
  while (ci < clips.length && t >= clips[ci]!.at + clips[ci]!.dur - 1e-6) ci++;
  const c = clips[ci];
  let cells: number[] | null = null;
  if (c && t >= c.at - 1e-6) {
    if (genClip !== c) {
      gen = clipFrames(c);
      genClip = c;
      // skip into the clip when the cut starts mid-clip (--from)
      for (let k = 0; k < Math.round((t - c.at) * FPS); k++) gen.next();
      if (existsSync(`${TAKES_DIR}/${c.take.id}.mkv`)) real++;
    }
    const fr = gen!.next();
    if (!fr.done) {
      cv.pixels.set(fr.value.px);
      // the game's capture is RGBA bytes; PixelCanvas packs ABGR: the same little-endian word
      cells = fr.value.cells;
    }
  }
  // counters
  if (c && cells && c.counters && t >= c.at) {
    const cfg = cfgOf(c.take.key);
    const ids = [cfg.a, cfg.b] as TitanId[];
    const intro = cards.find((k) => k.k === 'countIn' && t >= k.at - 0.4 && t < k.at + k.dur && t < MARK.ah);
    for (const side of ['left', 'right'] as const) {
      const slot = c.counters[side];
      if (slot === undefined) continue;
      const n = nameOf(ids[slot]!);
      let shown = cells[slot]!;
      if (intro && intro.k === 'countIn') {
        if (t < intro.at) continue;
        shown = Math.round(shown * Math.min(1, (t - intro.at) / intro.dur) ** 0.6);
      } else if (c.at < MARK.ah && t < 2.4) continue;
      // the number chases the truth (a refill or a big loss reads as motion, never a jump); a new clip starts on it
      const prev = shownCells[side];
      if (prev === null || counterClip[side] !== c || (intro && intro.k === 'countIn')) shownCells[side] = shown;
      else shownCells[side] = prev + (shown - prev) * 0.12;
      counterClip[side] = c;
      counter(cv, { name: n.name, ko: n.ko, cells: shownCells[side]!, start: fullBody(c.take.key, slot) }, side);
    }
  }
  for (const k of cards) if (t >= k.at - 1e-6 && t < k.at + k.dur) drawCard(cv, k, t, i);
  await write(new Uint8Array(cv.pixels.buffer));
  if (i % 300 === 0) console.log(`${t.toFixed(1)} s (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
ff.stdin.end();
await new Promise((r) => ff.on('exit', r));
console.log(`${OUT}: ${(total / FPS).toFixed(1)} s, ${real} clips from the real game, the rest stand-ins`);
