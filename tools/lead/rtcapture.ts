/**
 * REAL-TIME evidence capture on the real GPU (WJ's machine): a headed, full-screen Edge window plays a scenario at the
 * display's refresh rate while `canvas.captureStream(60)` + the game's own audio output are recorded by MediaRecorder,
 * the in-game telemetry measures latency / wound sequence / flashes / loudness, and motion strips are grabbed at exact
 * sim ticks. Nothing is stepped: what is recorded is what a player sees and hears.
 *
 *   npx tsx tools/lead/rtcapture.ts <scenario> [--name=x] [--seconds=60] [--overlay=0|1] [--record=0|1] [--trace=0|1]
 *                                   [--base=http://localhost:4173] [--build=1] [--out=evidence/gate-a] [--strips-out=docs/gates/evidence/gate-a]
 *
 * Scenarios: see SCENARIOS below (`aivai`, `aivai-mirror-lastone`, `aivai-mirror-planet`, `moves-lastone`, `moves-planet`, `play`).
 * Without --base a production build is served with `vite preview` on :4173 (built first with --build=1).
 * Writes: <out>/<name>.webm (video+audio), <stripsOut>/<name>.json (telemetry, perf, GC, GPU), <stripsOut>/<name>-<strip>.png.
 * Long jobs are resumable at scenario granularity: an existing <name>.json is skipped unless --force=1.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { LOGICAL_H, LOGICAL_W, rgba } from '@/contracts';
import { PixelCanvas, drawText } from '@/ui';
import type { StripRequest } from '@/telemetry/strips';
import { launchRealtime, openGame } from './browser';
import { writeContactSheet } from './png';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const scenarioId = args.find((a) => !a.startsWith('--')) ?? 'aivai';

interface Scenario {
  params: string;
  seconds: number;
  strips: StripRequest[];
  /** Stop early once the match has ended and this many seconds passed. */
  untilMatchEnd?: boolean;
  /** Real key presses through the browser's input pipeline (P1 keyboard layout kb1): [ms after start, code, hold ms]. */
  keys?: [number, string, number][];
}

/** P1 kb1: J strike · I crush · K surge · L signature · A/D move. A press every ~1.5 s, each after the last recovered. */
const LATENCY_KEYS: [number, string, number][] = [];
for (let rep = 0; rep < 3; rep++) {
  const t = 1000 + rep * 13000;
  LATENCY_KEYS.push(
    [t, 'KeyJ', 60],
    [t + 1500, 'KeyK', 60],
    [t + 3000, 'KeyI', 60],
    [t + 5000, 'KeyD', 300],
    [t + 6200, 'KeyA', 300],
    [t + 7600, 'KeyL', 500],
    [t + 9800, 'KeyJ', 60],
    [t + 11400, 'KeyD', 250],
  );
}

const crushStrip = (slot: 0 | 1, name: string, skip = 0): StripRequest => ({
  name,
  trigger: { event: 'move', slot, moveSlot: 'crush' },
  every: 6,
  count: 10,
  lead: 2,
  skip,
});
const heavyHitStrip = (name: string, skip = 0): StripRequest => ({
  name,
  trigger: { event: 'hit', minEnergy: 400 },
  every: 4,
  count: 11,
  lead: 1,
  skip,
});

const SCENARIOS: Record<string, Scenario> = {
  /** The matchup as the AI plays it: 60 s of real fighting (the gate clip). */
  aivai: {
    params: 'mode=aivai&a=lastone&b=planet&stage=nursery&seed=21&ai=4',
    seconds: 60,
    strips: [
      crushStrip(0, 'lastone-crush'),
      crushStrip(1, 'planet-crush'),
      heavyHitStrip('heavy-hit-1'),
      heavyHitStrip('heavy-hit-2', 2),
      { name: 'ko', trigger: { event: 'ko' }, every: 6, count: 10, lead: 2 },
    ],
  },
  'aivai-mirror-lastone': {
    params: 'mode=aivai&a=lastone&b=lastone&stage=nursery&seed=33&ai=4',
    seconds: 45,
    strips: [heavyHitStrip('heavy-hit')],
  },
  'aivai-mirror-planet': {
    params: 'mode=aivai&a=planet&b=planet&stage=nursery&seed=34&ai=4',
    seconds: 45,
    strips: [heavyHitStrip('heavy-hit')],
  },
  /** Scripted, isolated moves on a still foe: commitment (D2), tendrils (D3), wound sequence (D1), camera (D4). */
  'moves-lastone': {
    params:
      'mode=fight&a=lastone&b=planet&stage=nursery&seed=5&gap=230&meter=1&p2=dummy&script0=' +
      encodeURIComponent('30:crush,210:sig*45,390:surge,470:strike,600:right*20,640:left*20,720:ult'),
    seconds: 18,
    strips: [
      crushStrip(0, 'shatter'),
      {
        name: 'gaze',
        trigger: { event: 'move', slot: 0, moveSlot: 'signature' },
        every: 6,
        count: 10,
        lead: 2,
      },
      {
        name: 'sidestep',
        trigger: { event: 'move', slot: 0, moveSlot: 'surge' },
        every: 3,
        count: 10,
        lead: 2,
      },
      { name: 'turn', trigger: { event: 'move', slot: 0, moveSlot: 'strike' }, every: 4, count: 10, lead: 1 },
      { name: 'lastlight', trigger: { event: 'ultimate', slot: 0 }, every: 14, count: 10, lead: 1 },
    ],
  },
  'moves-planet': {
    params:
      'mode=fight&a=planet&b=lastone&stage=nursery&seed=5&gap=230&meter=1&p2=dummy&script0=' +
      encodeURIComponent('30:crush,230:sig*45,420:surge,500:strike,640:right*20,680:left*20,760:ult'),
    seconds: 19,
    strips: [
      crushStrip(0, 'impact'),
      {
        name: 'moonslam',
        trigger: { event: 'move', slot: 0, moveSlot: 'signature' },
        every: 6,
        count: 10,
        lead: 2,
      },
      { name: 'shift', trigger: { event: 'move', slot: 0, moveSlot: 'surge' }, every: 3, count: 10, lead: 2 },
      { name: 'cataclysm', trigger: { event: 'ultimate', slot: 0 }, every: 14, count: 10, lead: 1 },
    ],
  },
  /** Input latency with REAL key events (keyboard → sim → first visible pixel), P1 vs an idle foe. */
  'latency-lastone': {
    params: 'mode=fight&a=lastone&b=planet&stage=nursery&seed=9&gap=300&p1=human&p2=dummy',
    seconds: 40,
    strips: [],
    keys: LATENCY_KEYS,
  },
  'latency-planet': {
    params: 'mode=fight&a=planet&b=lastone&stage=nursery&seed=9&gap=300&p1=human&p2=dummy',
    seconds: 40,
    strips: [],
    keys: LATENCY_KEYS,
  },
  /** WJ plays P1 (controller or keyboard) against the AI; the run lasts until the match ends (or --seconds). */
  play: {
    params: 'mode=fight&a=lastone&b=planet&stage=nursery&seed=7&p1=human&p2=ai&ai=3',
    seconds: 240,
    untilMatchEnd: true,
    strips: [heavyHitStrip('heavy-hit-1'), heavyHitStrip('heavy-hit-2', 3)],
  },
};

const sc = SCENARIOS[scenarioId];
if (!sc) {
  console.error(`unknown scenario ${scenarioId}; one of ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}
const name = opt('name', scenarioId);
const seconds = +opt('seconds', String(sc.seconds));
const overlay = opt('overlay', '1') === '1';
const record = opt('record', '1') === '1';
// V8 GC tracing costs ~8 fps on this machine: it gets its own run (--trace=1), never rides along with a feel clip
const trace = opt('trace', '0') === '1';
const outDir = opt('out', 'evidence/gate-a');
const stripsOut = opt('strips-out', 'docs/gates/evidence/gate-a');
// strip PNGs are ~6 MB each (dithered pixel art compresses poorly): they stay next to the footage, not in git
const pngOut = opt('png-out', `${outDir}/strips`);
mkdirSync(outDir, { recursive: true });
mkdirSync(stripsOut, { recursive: true });
mkdirSync(pngOut, { recursive: true });
if (existsSync(`${stripsOut}/${name}.json`) && opt('force', '0') !== '1') {
  console.log(`${name}: already captured (${stripsOut}/${name}.json); --force=1 to redo`);
  process.exit(0);
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

const VITE = 'node_modules/vite/bin/vite.js';
let server: ChildProcess | null = null;
let base = opt('base', '');
if (!base) {
  base = 'http://localhost:4173';
  if (opt('build', '0') === '1' || !existsSync('dist/index.html')) {
    console.log('building production bundle…');
    await new Promise<void>((res, rej) => {
      const b = spawn(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { stdio: 'inherit' });
      b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
    });
  }
  if (!(await reachable(base))) {
    // vite itself, no shell/npx wrapper: its pid is the server's, so kill() really stops it on every OS
    server = spawn(process.execPath, [VITE, 'preview', '--port', '4173', '--strictPort'], {
      stdio: 'ignore',
    });
    for (let i = 0; i < 60 && !(await reachable(base)); i++) await new Promise((r) => setTimeout(r, 500));
  }
}

const tele = overlay ? 1 : 2;
const lum = opt('lum', '1') === '1';
const quality = opt('q', 'auto');
// --flags=orbit=1,zdepth=1,push=1 → extra URL params for prototype A/B runs
const extra = opt('flags', '')
  .split(',')
  .filter(Boolean)
  .map((f) => `&${f}`)
  .join('');
// --stage=mausoleum swaps the scenario's arena (the slice's arenas; scenarios default to the nursery)
const stage = opt('stage', '');
const params = stage ? sc.params.replace(/stage=[a-z]+/, `stage=${stage}`) : sc.params;
const url = `${base}/?${params}&freeze=1&aftermath=0&tele=${tele}&q=${quality}${lum ? '' : '&lum=0'}${extra}`;
console.log(`${name}: ${url}`);
const browser = await launchRealtime();
const { page, errors } = await openGame(browser, url, null);
const gpu = await page.evaluate(() => window.__ADEUK__!.gpu());
console.log(`GPU: ${gpu}`);

// Launch flags do not make Playwright's window full-screen; the DevTools protocol does. A windowed canvas on a 1080p
// panel (with Windows display scaling) lands at the ×2 integer scale (1280×720) instead of ×3 — Phase 0 learned this.
const cdp = await page.context().newCDPSession(page);
const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
await page.waitForTimeout(1200);
const display = await page.evaluate(() => {
  const c = document.getElementById('game') as HTMLCanvasElement;
  const scale = Math.max(1, Math.floor(Math.min(c.width / 640, c.height / 360)));
  return { canvas: [c.width, c.height], dpr: devicePixelRatio, css: [innerWidth, innerHeight], scale };
});
console.log(
  `display: canvas ${display.canvas.join('×')} (dpr ${display.dpr}) → ×${display.scale} integer scale`,
);
if (display.scale < 3) console.warn('WARNING: not at ×3 — numbers are not 1080p numbers');

// recording sink: chunks arrive as base64 through an exposed binding
const webmPath = `${outDir}/${name}.webm`;
const sink = record ? createWriteStream(webmPath) : null;
await page.exposeFunction('__saveChunk', (b64: string) => {
  sink?.write(Buffer.from(b64, 'base64'));
});

let tracing = false;
if (trace) {
  try {
    await browser.startTracing(page, { categories: ['disabled-by-default-v8.gc'] });
    tracing = true;
  } catch (e) {
    console.warn(`tracing unavailable: ${String(e)}`);
  }
}

const audioOk = await page.evaluate(async () => window.__ADEUK__!.unlockAudio());
for (const s of sc.strips) await page.evaluate((r) => window.__ADEUK__!.armStrip(r), s);

const mime = await page.evaluate(async (rec) => {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const api = window.__ADEUK__!;
  if (!rec) {
    api.run(true);
    return 'none';
  }
  const tracks: MediaStreamTrack[] = [...canvas.captureStream(60).getVideoTracks()];
  const audio = api.recordingStream();
  if (audio) tracks.push(...audio.getAudioTracks());
  const types = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=avc1,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const r = new MediaRecorder(new MediaStream(tracks), {
    mimeType,
    videoBitsPerSecond: 16_000_000,
    audioBitsPerSecond: 192_000,
  });
  // Blobs are kept as they arrive (no main-thread work during the run); they are transferred after the recorder stops.
  const w = window as unknown as {
    __rec: MediaRecorder;
    __recDone: Promise<void>;
    __recBlobs: Blob[];
  };
  w.__recBlobs = [];
  r.ondataavailable = (e: BlobEvent): void => {
    if (e.data.size) w.__recBlobs.push(e.data);
  };
  w.__recDone = new Promise<void>((res) => {
    r.onstop = (): void => res();
  });
  w.__rec = r;
  r.start(2000);
  api.run(true);
  return mimeType;
}, record);
console.log(`recording: ${mime}; audio ${audioOk ? 'on' : 'OFF'}; running ${seconds} s…`);

const t0 = Date.now();
const keyRun = (async (): Promise<void> => {
  if (!sc.keys) return;
  await page.locator('#game').focus();
  for (const [at, code, hold] of sc.keys) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    if (Date.now() - t0 > seconds * 1000) break;
    await page.keyboard.down(code);
    await page.waitForTimeout(hold);
    await page.keyboard.up(code);
  }
})();
while (Date.now() - t0 < seconds * 1000) {
  await page.waitForTimeout(1000);
  if (sc.untilMatchEnd) {
    const ph = await page.evaluate(() => window.__ADEUK__!.matchPhase());
    if (ph === 'matchend') {
      await page.waitForTimeout(2500);
      break;
    }
  }
}

await keyRun;
// read the numbers BEFORE tearing anything down (stopping the recorder hitches frames)
const report = (await page.evaluate(() => window.__ADEUK__!.telemetry())) as Record<string, unknown>;
await page.evaluate(() => window.__ADEUK__!.run(false));
if (record)
  await page.evaluate(async () => {
    const w = window as unknown as { __rec: MediaRecorder; __recDone: Promise<void> };
    w.__rec.stop();
    await w.__recDone;
  });
if (record) {
  // transfer the recording in 4 MB slices
  await page.evaluate(async () => {
    const w = window as unknown as { __recBlobs: Blob[]; __saveChunk(b: string): Promise<void> };
    const all = new Uint8Array(await new Blob(w.__recBlobs).arrayBuffer());
    for (let off = 0; off < all.length; off += 4 << 20) {
      const part = all.subarray(off, Math.min(all.length, off + (4 << 20)));
      let s = '';
      for (let i = 0; i < part.length; i += 0x8000)
        s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000) as unknown as number[]);
      await w.__saveChunk(btoa(s));
    }
    w.__recBlobs = [];
  });
}
await new Promise<void>((res) => (sink ? sink.end(res) : res()));

const summary = await page.evaluate(() => window.__ADEUK__!.summary());
const renderStats = await page.evaluate(() => window.__ADEUK__!.renderStats());
const strips = await page.evaluate(() => window.__ADEUK__!.takeStrips());

let gc: { count: number; over4ms: number; maxMs: number; totalMs: number } | null = null;
if (tracing) {
  gc = analyseGc(await browser.stopTracing());
}
await browser.close();
server?.kill();

// strips → labelled contact sheets at logical resolution
const stripIndex: { name: string; file: string; frames: number; armedTick: number }[] = [];
for (const s of strips) {
  if (!s.frames.length) {
    console.log(`strip ${s.name}: trigger never fired`);
    continue;
  }
  const items = s.frames.map((f) => {
    const px = new Uint32Array(new Uint8Array(Buffer.from(f.b64, 'base64')).buffer);
    const cv = new PixelCanvas(LOGICAL_W, LOGICAL_H, px);
    const dt = Math.round(((f.tick - s.armedTick) * 1000) / 60);
    drawText(cv, `${dt >= 0 ? '+' : ''}${dt} MS`, 4, 4, {
      color: rgba(240, 236, 200),
      outline: rgba(0, 0, 0),
    });
    return { pixels: px, w: LOGICAL_W, h: LOGICAL_H };
  });
  const file = `${pngOut}/${name}-${s.name}.png`;
  writeContactSheet(file, items, 4, 1, 4);
  stripIndex.push({ name: s.name, file, frames: s.frames.length, armedTick: s.armedTick });
}

const out = {
  scenario: scenarioId,
  name,
  url,
  when: new Date().toISOString(),
  gpu,
  display,
  recording: record ? { file: webmPath, mime } : null,
  audioUnlocked: audioOk,
  seconds,
  summary,
  renderStats,
  telemetry: report,
  gc,
  strips: stripIndex,
  consoleErrors: errors,
};
writeFileSync(`${stripsOut}/${name}.json`, JSON.stringify(out, null, 1));
printSummary(out);
if (record) toMp4(webmPath);

/**
 * MediaRecorder WebM has no duration/cues (players can't seek it) and Windows' default player is picky: remux the
 * H.264 + Opus streams into an MP4 next to it (no re-encode, so frames stay exact). Skipped when ffmpeg is absent.
 */
function toMp4(webm: string): void {
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', mp4],
    {
      stdio: 'inherit',
    },
  );
  if (r.error) console.log('ffmpeg not found: keeping the .webm only');
  else if (r.status === 0) console.log(`mp4: ${mp4}`);
}

/**
 * Main-thread GC pauses from a Chrome trace. The trace of a 3-minute fight exceeds V8's maximum string length, so the
 * buffer is scanned in overlapping chunks for the atomic pause events (scavenger, mark-compact finalisation) and the
 * `"dur"` of each (µs), instead of being parsed as one JSON document.
 */
function analyseGc(buf: Buffer): { count: number; over4ms: number; maxMs: number; totalMs: number } {
  const NAMES = /"name":"(V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCFinalizeMCReduceMemory|MinorGC|MajorGC)"/g;
  const CHUNK = 32 << 20;
  const OVERLAP = 2048;
  const durs: number[] = [];
  for (let off = 0; off < buf.length; off += CHUNK) {
    const end = Math.min(buf.length, off + CHUNK + OVERLAP);
    const s = buf.toString('latin1', off, end);
    NAMES.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAMES.exec(s))) {
      // count a match once: only when it starts inside this chunk's own (non-overlap) range
      if (m.index >= CHUNK) break;
      const lo = s.lastIndexOf('{', m.index);
      const hi = s.indexOf('}', m.index);
      const ev = s.slice(Math.max(0, lo), hi < 0 ? m.index + 600 : hi + 1);
      if (!ev.includes('"ph":"X"')) continue;
      const d = /"dur":(\d+)/.exec(ev);
      if (d) durs.push(+d[1]! / 1000);
    }
  }
  return {
    count: durs.length,
    over4ms: durs.filter((d) => d > 4).length,
    maxMs: +Math.max(0, ...durs).toFixed(2),
    totalMs: +durs.reduce((a, b) => a + b, 0).toFixed(1),
  };
}

function printSummary(o: typeof out): void {
  const t = o.telemetry as {
    fps: { mean: number; p1Low: number; longFrames: number; worstMs: number };
    simMs: { mean: number; p99: number; max: number };
    inputLatencyMs: number[];
    pixelLatencyMs: number[];
    wounds: { fxPeakMs: number; fxClearMs: number; shearMs: number; instantMass: number }[];
    rounds: { seconds: number; hits: number; contacts: number }[];
    flash: { maxDelta100ms: number; maxRelDelta100ms: number; maxFlashesPerSec: number };
    audio: {
      integrated: number;
      truePeak: number;
      range: number;
      impactOverBedDb: number[];
      impactOverBedShortDb: number[];
      duckDb: number[];
    } | null;
  } | null;
  if (!t) return;
  const med = (a: number[]): string => {
    const s = a.filter((x) => x >= 0).sort((x, y) => x - y);
    return s.length ? String(Math.round(s[s.length >> 1]!)) : '-';
  };
  console.log(`\n== ${o.name} (${o.gpu}) ==`);
  console.log(
    `fps mean ${t.fps.mean} / 1% low ${t.fps.p1Low}, frames >25 ms: ${t.fps.longFrames}, worst ${t.fps.worstMs} ms`,
  );
  console.log(`sim ms/tick mean ${t.simMs.mean} p99 ${t.simMs.p99} max ${t.simMs.max}`);
  if (o.gc) console.log(`GC pauses ${o.gc.count}, >4 ms: ${o.gc.over4ms}, max ${o.gc.maxMs} ms`);
  console.log(
    `wounds ${t.wounds.length}: FX peak med ${med(t.wounds.map((w) => w.fxPeakMs))} ms, clear med ${med(t.wounds.map((w) => w.fxClearMs))} ms, shear med ${med(t.wounds.map((w) => w.shearMs))} ms`,
  );
  console.log(
    `rounds: ${t.rounds.map((r) => `${r.seconds.toFixed(1)}s/${r.hits}h/${r.contacts}c`).join('  ') || '-'}`,
  );
  console.log(
    `flash: max Δlum(100 ms) ${t.flash.maxDelta100ms} (rel ${t.flash.maxRelDelta100ms}), max flashes/s ${t.flash.maxFlashesPerSec}`,
  );
  if (t.audio)
    console.log(
      `audio: I ${t.audio.integrated} LUFS, TP ${t.audio.truePeak} dBTP, LRA ${t.audio.range} LU, impact over bed (M) med ${med(t.audio.impactOverBedDb)} dB, (S) med ${med(t.audio.impactOverBedShortDb)} dB, duck med ${med(t.audio.duckDb)} dB`,
    );
  if (t.inputLatencyMs.length)
    console.log(
      `input→accept med ${med(t.inputLatencyMs)} ms, input→first pixel med ${med(t.pixelLatencyMs)} ms`,
    );
  if (o.consoleErrors.length) console.log(`console: ${o.consoleErrors.length} errors/warnings — see JSON`);
}
