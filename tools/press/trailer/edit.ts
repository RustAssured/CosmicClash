import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { logoSprite } from '../../../src/ui/pixel/logo';
import { PixelCanvas } from '../../../src/ui/pixel/canvas';
import { drawText } from '../../../src/ui/pixel/text';
import type { PressCfg } from '../../../dev/press/press';
import { arg } from '../common';
import { OPEN_TOUCH, TRAILER, TWORK } from './paths';
import type { GameShot } from './shots';
import { CUT_15, CUT_60, CUT_FINAL, CUT_FINAL_15, type Cut } from './timeline';

/** WJ's story teaser as S7 renders it (tools/teaser → press/trailer/story-teaser.mp4). */
const TEASER = `${TRAILER}/story-teaser.mp4`;

/**
 * Cut the trailer (docs/site/TRAILER.md) from the shot renders: every cut is the game's 640×360 at ×3 (nearest only:
 * `-sws_flags neighbor`), 60 fps; cards and the Mouth are 640×360 overlays scaled ×3 nearest. Each cut is rendered to a
 * near-lossless 4:4:4 segment, the segments are joined, then encoded once: x264 `-crf 14 -tune animation` (+ VP9 WebM).
 * The vertical letterboxes the 15 s cut at ×1 (the only whole-number scale of 640 that fits 1080) with text above and below.
 * Sound: S6's mixes (press/trailer/mix-60.wav, mix-15.wav) are muxed when present; otherwise the files are a silent picture
 * lock. Writes press/trailer/cuesheet.json (per cut: edit in/out, source, slow motion, sound notes) for S6.
 *   npx tsx tools/press/trailer/edit.ts [60] [15] [vertical] [posters] [--redo=1]
 */
const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const on = (k: string): boolean => want.length === 0 || want.includes(k);
const redo = arg('redo', '0') === '1';
/** --sheet=1: only the cue sheets (no rendering or encoding). */
const sheetOnly = arg('sheet', '0') === '1';
const SEG = `${TWORK}/edit`;
mkdirSync(SEG, { recursive: true });

function ff(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-sws_flags', 'neighbor', ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}
const mb = (p: string): string => `${(statSync(p).size / 1048576).toFixed(1)} MB`;

interface ShotLog {
  shot: GameShot;
  frames: { tick: number; alpha: number; rate: number }[];
}
const logs = new Map<string, ShotLog>();
const shotLog = (id: string): ShotLog => {
  let l = logs.get(id);
  if (!l) {
    l = JSON.parse(readFileSync(`${TWORK}/${id}.json`, 'utf8')) as ShotLog;
    logs.set(id, l);
  }
  return l;
};
/** First frame of a shot render that shows `tick` (alpha 0 or later). */
const frameOf = (id: string, tick: number): number => {
  const f = shotLog(id).frames.findIndex((x) => x.tick >= tick);
  if (f < 0) throw new Error(`${id}: tick ${tick} is not in the render`);
  return f;
};
const startFrame = (c: Cut): number => {
  const s = c.src;
  if ('shot' in s)
    return s.frame !== undefined ? s.frame : Math.max(0, frameOf(s.shot, s.at) - Math.round(s.pre * 60));
  if ('seq' in s) return s.from;
  return 0;
};

/** One cut → a 1920×1080 60 fps 4:4:4 segment (silent). */
function renderCut(c: Cut, file: string): void {
  if (sheetOnly || (!redo && existsSync(file))) return;
  const n = Math.round(c.dur * 60);
  const inputs: string[] = [];
  const g: string[] = [];
  const s = c.src;
  if ('shot' in s) {
    const f0 = startFrame(c);
    const total = shotLog(s.shot).frames.length;
    if (f0 + n > total)
      throw new Error(`${c.name}: needs frames ${f0}–${f0 + n} of ${s.shot} (has ${total})`);
    inputs.push('-i', `${TWORK}/${s.shot}.mov`);
    g.push(`[0:v]trim=start_frame=${f0}:end_frame=${f0 + n},setpts=PTS-STARTPTS,format=yuv444p[b]`);
  } else if ('seq' in s) {
    inputs.push('-framerate', '60', '-start_number', String(s.from), '-i', `${TWORK}/${s.seq}/%04d.png`);
    g.push(`[0:v]trim=end_frame=${n},setpts=PTS-STARTPTS,scale=1920:1080:flags=neighbor,format=yuv444p[b]`);
  } else if ('teaser' in s) {
    // WJ's teaser: already the 640×360 frame ×3; its 30 fps frames are held for two 60 fps frames (no blending)
    if (!existsSync(TEASER)) throw new Error(`${TEASER} is not rendered yet (S7)`);
    inputs.push('-ss', String(s.from), '-t', String(c.dur + 0.1), '-i', TEASER);
    g.push(
      `[0:v]fps=60,scale=1920:1080:flags=neighbor,trim=end_frame=${n},setpts=PTS-STARTPTS,format=yuv444p[b]`,
    );
  } else if ('card' in s) {
    inputs.push('-loop', '1', '-framerate', '60', '-i', `${TWORK}/cards/${s.card}.png`);
    g.push(`[0:v]trim=end_frame=${n},setpts=PTS-STARTPTS,scale=1920:1080:flags=neighbor,format=yuv444p[b]`);
  } else {
    inputs.push('-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=60:d=${c.dur}`);
    g.push(`[0:v]format=yuv444p[b]`);
  }
  let last = 'b';
  let k = 1;
  if (c.mouth) {
    inputs.push(
      '-framerate',
      '60',
      '-start_number',
      String(c.mouth.from),
      '-i',
      `${TWORK}/${c.mouth.seq}/%04d.png`,
    );
    g.push(
      `[${k}:v]setpts=PTS-STARTPTS+${c.mouth.at}/TB,scale=1920:1080:flags=neighbor[m];[${last}][m]overlay=0:${(c.mouth.dy ?? 0) * 3}:eof_action=pass:format=auto[o${k}]`,
    );
    last = `o${k}`;
    k++;
  }
  for (const o of c.over ?? []) {
    inputs.push('-loop', '1', '-framerate', '60', '-i', `${TWORK}/cards/${o.card}.png`);
    g.push(
      `[${k}:v]trim=end_frame=${n},setpts=PTS-STARTPTS,scale=1920:1080:flags=neighbor,format=rgba[c${k}];[${last}][c${k}]overlay=0:0:enable='between(t,${o.from},${o.to})':format=auto[o${k}]`,
    );
    last = `o${k}`;
    k++;
  }
  g.push(`[${last}]trim=end_frame=${n},format=yuv444p[v]`);
  ff([
    ...inputs,
    '-filter_complex',
    g.join(';'),
    '-map',
    '[v]',
    '-r',
    '60',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '6',
    '-pix_fmt',
    'yuv444p',
    file,
  ]);
}

interface CueRow {
  id: string;
  n: number;
  name: string;
  in: number;
  out: number;
  source: Record<string, unknown>;
  sound: string;
}
/** Render a cut list, join it (4:4:4 master), and return the cue sheet rows. */
function build(cuts: Cut[], tag: string): { master: string; rows: CueRow[]; dur: number } {
  const rows: CueRow[] = [];
  const list: string[] = [];
  let t = 0;
  cuts.forEach((c, i) => {
    const file = `${SEG}/${tag}-${String(i).padStart(2, '0')}-${c.name}.mov`;
    renderCut(c, file);
    list.push(`file '${file.split('/').pop()}'`);
    const n = Math.round(c.dur * 60);
    const s = c.src;
    let source: Record<string, unknown>;
    if ('shot' in s) {
      const L = shotLog(s.shot);
      const f0 = startFrame(c);
      const fr = L.frames.slice(f0, f0 + n);
      const cfg: PressCfg = L.shot.cfg;
      // rate segments: from this edit time the picture advances `rate` sim ticks per frame (1 = real time)
      const rates: { at: number; tick: number; alpha: number; rate: number }[] = [];
      fr.forEach((x, j) => {
        if (!rates.length || rates[rates.length - 1]!.rate !== x.rate)
          rates.push({ at: +(t + j / 60).toFixed(3), tick: x.tick, alpha: x.alpha, rate: x.rate });
      });
      // S6's format: the render's start tick, each tick's first frame time in the render (s), and where this cut starts in it
      const times: number[] = [];
      L.frames.forEach((x, j) => {
        while (L.shot.t0 + times.length <= x.tick) times.push(+(j / 60).toFixed(4));
      });
      source = {
        cfg,
        t0: L.shot.t0,
        times,
        offset: +(f0 / 60).toFixed(4),
        kind: 'game',
        pair: [cfg.a, cfg.b],
        stage: cfg.stage,
        seed: cfg.seed,
        ai: cfg.ai,
        harness: `?mode=aivai&a=${cfg.a}&b=${cfg.b}&stage=${cfg.stage}&seed=${cfg.seed}&ai=${cfg.ai}&trailer=1`,
        startTick: fr[0]!.tick,
        startAlpha: fr[0]!.alpha,
        endTick: fr[fr.length - 1]!.tick,
        slowMotion: rates,
        events: (s.events ?? []).map((e) => ({
          ...e,
          at: +(t + (frameOf(s.shot, e.tick) - f0) / 60).toFixed(3),
        })),
        shot: L.shot.what,
      };
    } else if ('seq' in s)
      source = { kind: 'black', made: s.kind ?? 'made-in-code', frames: s.seq, from: s.from, note: s.note };
    else if ('teaser' in s)
      source = {
        kind: 'teaser',
        file: TEASER,
        from: s.from,
        to: +(s.from + n / 60).toFixed(3),
        score: { file: 'press/teaser/score.wav', from: s.from, to: +(s.from + n / 60).toFixed(3) },
      };
    else if ('card' in s) source = { kind: s.card === 'logo-card' ? 'logo' : 'black', card: s.card };
    else source = { kind: 'black' };
    if (c.mouth)
      source.mouth = {
        kind: 'oracle',
        file: 'mouth/reference/demos/mouth-LOCKED-full.html',
        frames: c.mouth.seq,
        from: c.mouth.from,
        at: +(t + c.mouth.at).toFixed(3),
        note: c.mouth.note,
      };
    if (c.over?.length)
      source.cards = c.over.map((o) => ({
        card: o.card,
        in: +(t + o.from).toFixed(3),
        out: +(t + o.to).toFixed(3),
      }));
    rows.push({
      id: c.name,
      n: c.shotNo,
      name: c.name,
      in: +t.toFixed(3),
      out: +(t + n / 60).toFixed(3),
      source,
      sound: c.sound,
    });
    t += n / 60;
  });
  writeFileSync(`${SEG}/${tag}.txt`, list.join('\n'));
  const master = `${SEG}/${tag}-master.mov`;
  if (!sheetOnly) ff(['-f', 'concat', '-safe', '0', '-i', `${SEG}/${tag}.txt`, '-c', 'copy', master]);
  return { master, rows, dur: t };
}

const X264 = [
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '14',
  '-tune',
  'animation',
  '-pix_fmt',
  'yuv420p',
  '-r',
  '60',
];
const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-b:v',
  '0',
  '-crf',
  '22',
  '-row-mt',
  '1',
  '-deadline',
  'good',
  '-pix_fmt',
  'yuv420p',
];
function encode(master: string, mix: string, mp4: string, webm?: string): void {
  const hasMix = existsSync(mix);
  const a = hasMix ? ['-i', mix, '-map', '0:v', '-map', '1:a', '-shortest'] : ['-map', '0:v'];
  ff([
    '-i',
    master,
    ...a,
    ...X264,
    ...(hasMix ? ['-c:a', 'aac', '-b:a', '256k'] : []),
    '-movflags',
    '+faststart',
    mp4,
  ]);
  console.log(`${mp4}: ${mb(mp4)}${hasMix ? '' : ' (picture lock, no sound yet)'}`);
  if (webm) {
    ff(['-i', master, ...a, ...VP9, ...(hasMix ? ['-c:a', 'libopus', '-b:a', '160k'] : []), webm]);
    console.log(`${webm}: ${mb(webm)}`);
  }
}

const ABOUT =
  'ADEUK: TITANS trailer cue sheet (docs/site/TRAILER.md), 60 fps, times in seconds of the edit. Game shots: source.cfg + t0 (the render starts at that tick, harness ?mode=aivai&…&trailer=1), times[i] = when tick t0+i is first shown in the render, offset = where this cut starts in the render (so edit time = in + times[i] - offset). slowMotion lists the picture rate (sim ticks per frame; game KO slow motion included). events = the key blows/cues at their edit time. kind black/logo = no game sound (made-in-code pictures, cards).';
/** S6's sheet: { shots: [{ id, in, out, source, sound }], beats } (+ my extras inside each source). */
function writeSheet(path: string, rows: CueRow[], dur: number, beats: Record<string, number>): void {
  writeFileSync(
    path,
    JSON.stringify({ about: ABOUT, duration: +dur.toFixed(3), shots: rows, beats }, null, 1),
  );
  console.log(path);
}
const at = (rows: CueRow[], id: string, k: 'in' | 'out'): number => rows.find((r) => r.id === id)![k];
const eventAt = (rows: CueRow[], id: string): number =>
  ((rows.find((r) => r.id === id)!.source.events as { at: number }[] | undefined) ?? [])[0]?.at ??
  at(rows, id, 'in');
if (on('60')) {
  const r = build(CUT_60, 't60');
  if (!sheetOnly)
    encode(r.master, `${TRAILER}/mix-60.wav`, `${TRAILER}/trailer-60.mp4`, `${TRAILER}/trailer-60.webm`);
  writeSheet(`${TRAILER}/cuesheet.json`, r.rows, r.dur, {
    flash: +(OPEN_TOUCH / 60).toFixed(3),
    firstImpact: eventAt(r.rows, 'first-impact'),
    snap: eventAt(r.rows, 'uri-snap'),
    wet: +(at(r.rows, 'turn', 'in') + 1.2).toFixed(3),
    lunge: at(r.rows, 'lunge', 'out'),
    logo: at(r.rows, 'logo', 'in'),
  });
}
if (on('15') || on('vertical')) {
  const r = build(CUT_15, 't15');
  writeSheet(`${TRAILER}/cuesheet-15.json`, r.rows, r.dur, {
    flash: +((OPEN_TOUCH - 120) / 60).toFixed(3),
    firstImpact: eventAt(r.rows, 'first-impact'),
    wet: at(r.rows, 'turn', 'in'),
    lunge: at(r.rows, 'lunge', 'out'),
    logo: at(r.rows, 'logo', 'in'),
  });
  if (on('15') && !sheetOnly) encode(r.master, `${TRAILER}/mix-15.wav`, `${TRAILER}/trailer-15.mp4`);
  if (on('vertical') && !sheetOnly)
    vertical(r.master, `${TRAILER}/mix-15.wav`, 't15', `${TRAILER}/trailer-vertical.mp4`);
}

/** 1080×1920: the 640×360 frame at ×1 (area reduction is exact on the ×3 blocks), the logo above, a line below. */
function vertical(master: string, mix: string, tag: string, file: string): void {
  const top = new PixelCanvas(360, 640);
  const logo = logoSprite();
  const lx = (360 - logo.w) >> 1;
  for (let y = 0; y < logo.h; y++)
    for (let x = 0; x < logo.w; x++) top.pixels[(150 + y) * 360 + lx + x] = logo.pixels[y * logo.w + x]!;
  drawText(top, '아득', 180, 196, { color: 0xffc8dce8, align: 'center' });
  drawText(top, 'FREE IN YOUR BROWSER', 180, 446, { color: 0xffe8ecf0, align: 'center', tracking: 1 });
  drawText(top, 'FINAL BOSS: COMING', 180, 466, { color: 0xff3a3ac8, align: 'center', tracking: 1 });
  const png = new PNG({ width: 1080, height: 1920 });
  for (let y = 0; y < 1920; y++)
    for (let x = 0; x < 1080; x++) {
      const c = top.pixels[Math.floor(y / 3) * 360 + Math.floor(x / 3)]!;
      const o = (y * 1080 + x) * 4;
      png.data[o] = c & 255;
      png.data[o + 1] = (c >>> 8) & 255;
      png.data[o + 2] = (c >>> 16) & 255;
      png.data[o + 3] = c >>> 24;
    }
  writeFileSync(`${SEG}/vertical-frame.png`, PNG.sync.write(png));
  const vmaster = `${SEG}/${tag}-vertical-master.mov`;
  ff([
    '-i',
    master,
    '-loop',
    '1',
    '-i',
    `${SEG}/vertical-frame.png`,
    '-filter_complex',
    '[0:v]scale=640:360:flags=area,pad=1080:1920:220:780:color=black[g];[g][1:v]overlay=0:0:shortest=1,format=yuv444p[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '6',
    '-pix_fmt',
    'yuv444p',
    vmaster,
  ]);
  encode(vmaster, mix, file);
}

/* ---------- the converged trailer: WJ's teaser 0–40, the gameplay montage, the teaser 40–61.2 ---------- */
if (on('final')) {
  const r = build(CUT_FINAL, 'final');
  const mIn = at(r.rows, 'teaser-cold-to-brace', 'out');
  const mOut = at(r.rows, 'teaser-hunt-to-logo', 'in');
  writeSheet(`${TRAILER}/cuesheet-final.json`, r.rows, r.dur, {
    montageIn: mIn,
    montageOut: mOut,
    uriFist: eventAt(r.rows, 'uri-fist'),
    snap: eventAt(r.rows, 'uri-snap'),
    lastFlash: eventAt(r.rows, 'first-impact'),
    teaserHunt: mOut,
  });
  if (!sheetOnly)
    encode(
      r.master,
      `${TRAILER}/mix-final.wav`,
      `${TRAILER}/trailer-final.mp4`,
      `${TRAILER}/trailer-final.webm`,
    );
}
if (on('final15') || on('finalvertical')) {
  const r = build(CUT_FINAL_15, 'final15');
  writeSheet(`${TRAILER}/cuesheet-final-15.json`, r.rows, r.dur, {
    montageIn: at(r.rows, 'uri-fist', 'in'),
    montageOut: at(r.rows, 'teaser-edge', 'in'),
    logo: at(r.rows, 'teaser-logo', 'in'),
  });
  if (on('final15') && !sheetOnly)
    encode(r.master, `${TRAILER}/mix-final-15.wav`, `${TRAILER}/trailer-final-15.mp4`);
  if (on('finalvertical') && !sheetOnly)
    vertical(r.master, `${TRAILER}/mix-final-15.wav`, 'final15', `${TRAILER}/trailer-final-vertical.mp4`);
}

if (on('posters')) {
  // TRAILER.md: the poster is frame 7 (the coil at the edge) or frame 2 (the first impact), from the near-lossless segments
  for (const [name, cut, sec] of [
    ['poster-shot2-first-impact', 'first-impact', 0.45],
    ['poster-shot7-mouth', 'lunge', 1.45],
  ] as const) {
    const i = CUT_60.findIndex((c) => c.name === cut);
    const file = `${SEG}/t60-${String(i).padStart(2, '0')}-${cut}.mov`;
    ff(['-ss', String(sec), '-i', file, '-frames:v', '1', `${TRAILER}/${name}.png`]);
    console.log(`${TRAILER}/${name}.png`);
  }
}
/* ---------- the site's web copies of the converged trailer (site/media/trailer): ≤ 15 MB each, 1080p or 720p (×2) ---------- */
if (on('web') && !sheetOnly) {
  const master = `${SEG}/final-master.mov`;
  const mix = `${TRAILER}/mix-final.wav`;
  if (!existsSync(master) || !existsSync(mix))
    throw new Error('web copies need the final master and S6 mix-final.wav');
  const OUT = 'site/media/trailer';
  mkdirSync(OUT, { recursive: true });
  const LIMIT = 15 * 1048576;
  // 1080p as rendered, or the true 640×360 pixels ×2 nearest (720p) when 1080p cannot fit
  const scales = [
    ['1080p', 'null'],
    ['720p', 'scale=640:360:flags=area,scale=1280:720:flags=neighbor'],
  ] as const;
  const fit = (ext: 'mp4' | 'webm'): void => {
    const file = `${OUT}/trailer.${ext}`;
    for (const [res, vf] of scales)
      for (const crf of ext === 'mp4' ? [28, 30, 32, 34, 36] : [36, 40, 44, 48]) {
        const v =
          ext === 'mp4'
            ? [
                '-c:v',
                'libx264',
                '-preset',
                'slow',
                '-crf',
                String(crf),
                '-tune',
                'animation',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-movflags',
                '+faststart',
              ]
            : [
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
                '-cpu-used',
                '2',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'libopus',
                '-b:a',
                '96k',
              ];
        ff([
          '-i',
          master,
          '-i',
          mix,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-shortest',
          '-vf',
          vf,
          '-r',
          '60',
          ...v,
          file,
        ]);
        const ok = statSync(file).size <= LIMIT;
        console.log(`${file}: ${res} crf ${crf} → ${mb(file)}${ok ? '' : ' (over 15 MB)'}`);
        if (ok) return;
      }
    throw new Error(`${file} does not fit 15 MB`);
  };
  fit('mp4');
  fit('webm');
  // the poster: the montage's biggest flash (TRAILER.md: shot 2, the first impact), 1080p JPEG
  ff([
    '-ss',
    '0.5',
    '-i',
    `${SEG}/t60-01-first-impact.mov`,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    `${OUT}/poster.jpg`,
  ]);
  console.log(`${OUT}/poster.jpg: ${mb(`${OUT}/poster.jpg`)}`);
}
