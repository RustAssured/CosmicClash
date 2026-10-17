/**
 * Phase 0 PERF GATE (idle-animation port): the worst moments of a match on WJ's laptop, judged against the floor
 * (tools/perf/gate.json: mean >= 58 fps, 1 % low >= 30 fps, at most one frame a run worse than 30 fps). Every titan port
 * must pass it. A production build in a headed Edge window on the real GPU, forced full screen through CDP (1920×1080 →
 * ×3: a windowed canvas on the 125 % panel lands at ×2 and is NOT the 1080p number), quality tier `auto`, vsync on, the
 * game's own rAF loop (nothing stepped by hand).
 *
 *   npx tsx tools/perf/gate.ts [--set=gate|storm|idle|all] [--reps=2] [--seconds=20] [--only=cradle,uri] [--prof=1]
 *       [--gc=1] [--build=1] [--out=.scratch/perf/gate] [--json=file] [--q=auto] [--scale=3]
 *
 * Sets: `storm` = the worst-case runs (below), judged; `idle` = the per-titan idle cost line (each titan mirrored, both
 * fighters idling: CPU ms and GPU ms per frame); `gate` (default) = both; `all` = both plus GC-traced storm runs.
 * Per storm run (bare, `?prof=lite`: the loop's own CPU timing only): mean fps, 1 % low (1000 / mean of the worst 1 % of
 * rAF intervals, as src/telemetry), frames > 25 ms (a missed vsync) and > 34 ms (under 30 fps), tick ms p99 / max
 * (`app.tick`: sim + fx + camera), the frame's own CPU (layers + draw + UI) p50 / p95 / max, GCs seen as a heap drop
 * inside a frame interval, and the quality tier timeline. `--prof=1` adds one profiled run per storm (`?prof=1`, timer
 * queries: GPU ms per pass, the slowest frames whole with their texture uploads / GC). `--gc=1` adds one V8-GC-traced run
 * per storm (tracing costs frames: never mixed into the judged numbers). Before anything runs the machine's CPU load is
 * sampled: GPU timer readings and frame pacing include every other app.
 */
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build, preview } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import { openGame } from '../lead/browser';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const ROOT = resolve(opt('root', '.'));
// the build's own folder: vite empties it, so logs and --json files go elsewhere
const OUT = resolve(opt('out', '.scratch/perf/gate-dist'));
const SET = opt('set', 'gate');
const REPS = Math.max(1, +opt('reps', '2'));
const SECONDS = +opt('seconds', '20');
const Q = opt('q', 'auto');
const SCALE = +opt('scale', '3');
const PROFILE = opt('prof', SET === 'all' ? '1' : '0') === '1';
const GC = opt('gc', SET === 'all' ? '1' : '0') === '1';
const only = opt('only', '').split(',').filter(Boolean);
const LIMITS = JSON.parse(readFileSync(resolve(ROOT, 'tools/perf/gate.json'), 'utf8')) as {
  meanFpsMin: number;
  p1LowMin: number;
  under30PerRunMax: number;
  under30Ms: number;
};

/** Every playable titan (the Mouth is a boss: add it with --only=mouth). */
const IDLE_TITANS = [
  'colossus',
  'lastone',
  'asteroid',
  'nexus',
  'blackhole',
  'supernova',
  'planet',
  'uri',
  'cradle',
  'cradlechild',
];
/** After the Ultimate, a barrage so debris piles up (crush / strike / signature on the foe in front). */
const BARRAGE = '10:ult,330:crush,390:strike,450:crush,510:sig*40,600:crush,660:strike,720:crush,780:sig*40';

interface Scenario {
  name: string;
  kind: 'storm' | 'idle';
  params: string;
  seconds: number;
}
const storms: Scenario[] = [];
/**
 * The worst case: the heaviest titans (The Last One = `colossus`, the Cradle, the Planet, the Black Hole, 우리) in mirror and
 * mixed AI fights at level 5 with both meters full (Ultimates early, then a real fight's debris), and Ultimate clashes (both
 * fire on the same tick at close range, then the barrage).
 */
const STORM_PAIRS: [string, string][] = [
  ['colossus', 'colossus'],
  ['cradle', 'cradle'],
  ['planet', 'blackhole'],
  ['uri', 'colossus'],
  ['cradle', 'blackhole'],
];
const CLASH_PAIRS: [string, string][] = [
  ['blackhole', 'cradle'],
  ['colossus', 'planet'],
  ['uri', 'cradle'],
];
const pick = (p: [string, string]): boolean => !only.length || p.some((t) => only.includes(t));
// a titan being ported that no pairing covers yet gets its own mirror storm (the worst case of its idle: two of it)
for (const t of only) if (!STORM_PAIRS.some((p) => p.includes(t)) && t !== 'mouth') STORM_PAIRS.push([t, t]);
for (const [a, b] of STORM_PAIRS.filter(pick))
  storms.push({
    name: `storm ${a} v ${b}`,
    kind: 'storm',
    params: `mode=aivai&a=${a}&b=${b}&stage=nursery&seed=21&ai=5&meter=1`,
    seconds: SECONDS,
  });
for (const [a, b] of CLASH_PAIRS.filter(pick))
  storms.push({
    name: `clash ${a} v ${b}`,
    kind: 'storm',
    params: `mode=fight&a=${a}&b=${b}&stage=nursery&seed=7&meter=1&gap=210&script0=${encodeURIComponent(BARRAGE)}&script1=${encodeURIComponent(BARRAGE)}`,
    seconds: Math.min(SECONDS, 15),
  });
const idles: Scenario[] = (only.length ? only : IDLE_TITANS).map((t) => ({
  name: `idle ${t}`,
  kind: 'idle',
  params: `mode=fight&a=${t}&b=${t}&stage=nursery&seed=7&p1=dummy&p2=dummy`,
  seconds: 6,
}));

/* ---------------------------------------------------------------------------------------------- *
 *  machine check: everything else on the box shows up in frame pacing and GPU timer readings
 * ---------------------------------------------------------------------------------------------- */
function cpuBusy(ms: number): Promise<number> {
  const snap = (): [number, number] => {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    }
    return [idle, total];
  };
  const a = snap();
  return new Promise((res) =>
    setTimeout(() => {
      const b = snap();
      res(100 * (1 - (b[0] - a[0]) / Math.max(1, b[1] - a[1])));
    }, ms),
  );
}
const busy = await cpuBusy(3000);
console.log(`machine: CPU ${busy.toFixed(0)} % busy over 3 s before the runs (${cpus().length} threads)`);
if (busy > 20) console.warn('WARNING: the machine is not quiet; numbers are pessimistic');

if (opt('build', '1') === '1') {
  await build({
    root: ROOT,
    configFile: resolve(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: OUT, emptyOutDir: true, sourcemap: false },
  });
}
const server = await preview({
  root: ROOT,
  configFile: resolve(ROOT, 'vite.config.ts'),
  build: { outDir: OUT },
  preview: { port: 4319, strictPort: false, host: '127.0.0.1' },
  logLevel: 'error',
});
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4319/';

const pct = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function launchHeaded(): Promise<Browser> {
  return chromium.launch({
    channel: process.env.CHROMIUM_PATH ? undefined : 'msedge',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: false,
    args: [
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      // a GC shows as the JS heap shrinking inside a frame interval (needs the precise heap size)
      '--enable-precise-memory-info',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
}

interface ProfReport {
  sections: {
    name: string;
    n: number;
    cpuMean: number;
    cpuP95: number;
    gpuN: number;
    gpuMean: number;
    gpuP95: number;
  }[];
  frame: { n: number; mean: number; p95: number };
  gpu: boolean;
  spikes: { at: number; ms: number; sections: [string, number][]; counts: Record<string, number> }[];
}
interface Raw {
  /** Page time (ms) the measured run started. */
  t0: number;
  deltas: number[];
  /** Page time of each rAF interval's end (ms). */
  at: number[];
  ticks: number[];
  frameCpu: number[];
  loopCpu: number[];
  tickCounts: number[];
  /** [page ms, MB freed] for every rAF interval in which the JS heap shrank by > 0.25 MB (a GC ran in it). */
  gcs: [number, number][];
  tiers: [number, number][];
  canvas: number[];
  tierChanges: number;
  prof: ProfReport | null;
}
interface Run {
  name: string;
  kind: string;
  mode: 'bare' | 'prof' | 'gc';
  rep: number;
  scale: number;
  canvas: number[];
  frames: number;
  meanFps: number;
  p1Low: number;
  over25: number;
  under30: number;
  worstMs: number;
  tickMs: { mean: number; p99: number; max: number; over8: number };
  frameCpuMs: { p50: number; p95: number; max: number };
  loopCpuMs: { mean: number; p95: number; max: number };
  heapGcs: number;
  heapGcMaxMB: number;
  tier: number;
  tierChanges: number;
  tierTimeline: [number, number][];
  /** rAF intervals over 25 ms: [s into the run, ms, what else happened around it]. */
  long: [number, number, string][];
  gpuMs?: number;
  gpuBySection?: Record<string, number>;
  cpuBySection?: Record<string, number>;
  spikes?: ProfReport['spikes'];
  v8gc?: { count: number; over4ms: number; maxMs: number; totalMs: number };
  errors: string[];
}

async function measure(browser: Browser, sc: Scenario, mode: Run['mode'], rep: number): Promise<Run> {
  const prof = mode === 'prof' || sc.kind === 'idle' ? '1' : 'lite';
  const url = `${base}?${sc.params}&freeze=1&hud=1&aftermath=0&tele=0&q=${Q}&prof=${prof}`;
  const { page, errors } = await openGame(browser, url, null);
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  if (SCALE === 3)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  else {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: 0, width: 1536, height: 864 },
    });
  }
  await page.waitForTimeout(1500);
  await page.evaluate('window.__name = (f) => f');
  if (mode === 'gc') await browser.startTracing(page, { categories: ['disabled-by-default-v8.gc'] });
  const raw = (await page.evaluate(async (seconds: number) => {
    const api = window.__ADEUK__!;
    const P = (
      window as unknown as {
        __ADEUK_PROF__?: {
          on: boolean;
          reset(): void;
          report(): unknown;
          loopReport(): number[];
          loopTicksReport(): number[];
          tickReport?(): number[];
          frameReport?(): number[];
        };
      }
    ).__ADEUK_PROF__;
    const mem = performance as unknown as { memory?: { usedJSHeapSize: number } };
    const c = document.getElementById('game') as HTMLCanvasElement;
    const stats = (): { tier: number; tierChanges: number } =>
      api.renderStats() as { tier: number; tierChanges: number };
    // the first frames upload everything and the tier controller sees a few frames (as frameprof)
    api.run(true);
    await new Promise((r) => setTimeout(r, 300));
    api.run(false);
    P?.reset();
    const deltas: number[] = [];
    const at: number[] = [];
    const gcs: [number, number][] = [];
    const tiers: [number, number][] = [];
    let last = -1;
    let heap = mem.memory?.usedJSHeapSize ?? 0;
    let tier = -1;
    let n = 0;
    let done = false;
    const t0 = performance.now();
    const tick = (t: number): void => {
      if (last >= 0) {
        deltas.push(t - last);
        at.push(t - t0);
      }
      last = t;
      const h = mem.memory?.usedJSHeapSize ?? 0;
      if (heap - h > 256 * 1024) gcs.push([+(t - t0).toFixed(1), +((heap - h) / 1048576).toFixed(2)]);
      heap = h;
      if (n++ % 30 === 0) {
        const s = stats().tier;
        if (s !== tier) tiers.push([+((t - t0) / 1000).toFixed(2), (tier = s)]);
      }
      if (!done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    api.run(true);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    done = true;
    api.run(false);
    const st = stats();
    return {
      t0,
      deltas,
      at,
      ticks: P?.tickReport?.() ?? [],
      frameCpu: P?.frameReport?.() ?? [],
      loopCpu: P?.loopReport() ?? [],
      tickCounts: P?.loopTicksReport() ?? [],
      gcs,
      tiers,
      canvas: [c.width, c.height],
      tierChanges: st.tierChanges,
      prof: P?.on ? P.report() : null,
    };
  }, sc.seconds)) as Raw;
  let v8gc: Run['v8gc'];
  if (mode === 'gc') v8gc = analyseGc(await browser.stopTracing());
  await page.close();

  const d = raw.deltas;
  const worst = d
    .slice()
    .sort((a, b) => b - a)
    .slice(0, Math.max(1, Math.floor(d.length / 100)));
  const long: Run['long'] = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i]! <= 25) continue;
    const t = raw.at[i]!;
    const near: string[] = [];
    for (const g of raw.gcs) if (g[0] > t - d[i]! - 2 && g[0] <= t + 2) near.push(`gc ${g[1]}MB`);
    for (const tt of raw.tiers) if (Math.abs(tt[0] * 1000 - t) < 1100) near.push(`tier→${tt[1]}`);
    // the profiler's slow frame that started inside this interval
    const sp = raw.prof?.spikes.find((s) => s.at - raw.t0 > t - d[i]! - 5 && s.at - raw.t0 < t + 5);
    if (sp)
      near.push(
        `spike ${sp.ms.toFixed(1)}ms ${sp.sections.map((x) => `${x[0]} ${x[1]}`).join(' ')} ${JSON.stringify(sp.counts)}`,
      );
    long.push([+(t / 1000).toFixed(2), +d[i]!.toFixed(1), near.join('; ')]);
  }
  const run: Run = {
    name: sc.name,
    kind: sc.kind,
    mode,
    rep,
    scale: Math.floor(Math.min(raw.canvas[0]! / 640, raw.canvas[1]! / 360)),
    canvas: raw.canvas,
    frames: d.length,
    meanFps: +(1000 / Math.max(1e-6, mean(d))).toFixed(1),
    p1Low: +(1000 / Math.max(1e-6, mean(worst))).toFixed(1),
    over25: d.filter((x) => x > 25).length,
    under30: d.filter((x) => x > LIMITS.under30Ms).length,
    worstMs: +Math.max(0, ...d).toFixed(1),
    tickMs: {
      mean: +mean(raw.ticks).toFixed(2),
      p99: +pct(raw.ticks, 0.99).toFixed(2),
      max: +Math.max(0, ...raw.ticks).toFixed(2),
      over8: raw.ticks.filter((x) => x > 8).length,
    },
    frameCpuMs: {
      p50: +pct(raw.frameCpu, 0.5).toFixed(2),
      p95: +pct(raw.frameCpu, 0.95).toFixed(2),
      max: +Math.max(0, ...raw.frameCpu).toFixed(2),
    },
    loopCpuMs: {
      mean: +mean(raw.loopCpu).toFixed(2),
      p95: +pct(raw.loopCpu, 0.95).toFixed(2),
      max: +Math.max(0, ...raw.loopCpu).toFixed(2),
    },
    heapGcs: raw.gcs.length,
    heapGcMaxMB: Math.max(0, ...raw.gcs.map((g) => g[1])),
    tier: raw.tiers.length ? raw.tiers[raw.tiers.length - 1]![1] : -1,
    tierChanges: raw.tierChanges,
    tierTimeline: raw.tiers,
    long,
    v8gc,
    errors: errors.slice(0, 5),
  };
  if (raw.prof) {
    const p = raw.prof;
    // a section's mean per measured sample, spread over every frame (sections that run on some frames only)
    const per = (v: number, k: number): number => (v * k) / Math.max(1, p.frame.n);
    run.gpuMs = +p.sections.reduce((a, s) => a + per(s.gpuMean, s.gpuN), 0).toFixed(2);
    run.gpuBySection = Object.fromEntries(
      p.sections.map((s) => [s.name, +per(s.gpuMean, s.gpuN).toFixed(2)]),
    );
    run.cpuBySection = Object.fromEntries(p.sections.map((s) => [s.name, +per(s.cpuMean, s.n).toFixed(2)]));
    run.spikes = p.spikes
      .slice()
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
  }
  return run;
}

/** Main-thread V8 GC pauses from a trace (as tools/lead/rtcapture.ts). */
function analyseGc(buf: Buffer): { count: number; over4ms: number; maxMs: number; totalMs: number } {
  const NAMES = /"name":"(V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCFinalizeMCReduceMemory|MinorGC|MajorGC)"/g;
  const s = buf.toString('latin1');
  const durs: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = NAMES.exec(s))) {
    const lo = s.lastIndexOf('{', m.index);
    const hi = s.indexOf('}', m.index);
    const ev = s.slice(Math.max(0, lo), hi < 0 ? m.index + 600 : hi + 1);
    if (!ev.includes('"ph":"X"')) continue;
    const dm = /"dur":(\d+)/.exec(ev);
    if (dm) durs.push(+dm[1]! / 1000);
  }
  return {
    count: durs.length,
    over4ms: durs.filter((x) => x > 4).length,
    maxMs: +Math.max(0, ...durs).toFixed(2),
    totalMs: +durs.reduce((a, b) => a + b, 0).toFixed(1),
  };
}

const f1 = (v: number, w = 5): string => v.toFixed(1).padStart(w);
function printRun(r: Run): void {
  const tag = r.mode === 'bare' ? `#${r.rep + 1}` : r.mode;
  console.log(
    `×${r.scale} ${r.name.padEnd(30)} ${tag.padEnd(4)} fps ${f1(r.meanFps)} 1%low ${f1(r.p1Low)}  >25ms ${String(r.over25).padStart(3)}  <30fps ${String(r.under30).padStart(2)}  worst ${f1(r.worstMs)}` +
      ` | tick p99 ${f1(r.tickMs.p99)} max ${f1(r.tickMs.max)} | frame cpu p50 ${f1(r.frameCpuMs.p50)} p95 ${f1(r.frameCpuMs.p95)} max ${f1(r.frameCpuMs.max)}` +
      ` | gc ${r.heapGcs} (max ${r.heapGcMaxMB} MB) | tier ${r.tier}${r.tierChanges ? ` (${r.tierChanges} changes)` : ''}` +
      (r.gpuMs !== undefined ? ` | gpu ${r.gpuMs.toFixed(2)} ms` : '') +
      (r.v8gc ? ` | v8 gc ${r.v8gc.count} pauses, >4 ms ${r.v8gc.over4ms}, max ${r.v8gc.maxMs} ms` : '') +
      (r.errors.length ? `  (${r.errors.length} console msgs)` : ''),
  );
  for (const l of r.long.filter((x) => x[1] > LIMITS.under30Ms))
    console.log(`      under 30 fps @${l[0]} s: ${l[1]} ms${l[2] ? `  [${l[2]}]` : ''}`);
}

const runs: Run[] = [];
const browser = await launchHeaded();
const doStorm = SET === 'gate' || SET === 'storm' || SET === 'all';
const doIdle = SET === 'gate' || SET === 'idle' || SET === 'all';
if (doStorm) {
  console.log(
    `\n== worst case: ${storms.length} scenarios × ${REPS} bare runs${PROFILE ? ' + 1 profiled' : ''}${GC ? ' + 1 GC-traced' : ''} ==`,
  );
  for (const sc of storms) {
    for (let rep = 0; rep < REPS; rep++) {
      const r = await measure(browser, sc, 'bare', rep);
      runs.push(r);
      printRun(r);
    }
    if (PROFILE) {
      const r = await measure(browser, sc, 'prof', 0);
      runs.push(r);
      printRun(r);
    }
    if (GC) {
      const r = await measure(browser, sc, 'gc', 0);
      runs.push(r);
      printRun(r);
    }
  }
}
const idleLines: {
  titan: string;
  cpuMs: number;
  tickMs: number;
  drawMs: number;
  gpuMs: number;
  fps: number;
}[] = [];
if (doIdle) {
  console.log('\n== idle cost per titan (mirror, both fighters idling, profiled) ==');
  for (const sc of idles) {
    const r = await measure(browser, sc, 'prof', 0);
    runs.push(r);
    const titan = sc.name.slice(5);
    const line = {
      titan,
      cpuMs: r.loopCpuMs.mean,
      tickMs: r.tickMs.mean,
      drawMs: +(r.loopCpuMs.mean - r.tickMs.mean).toFixed(2),
      gpuMs: r.gpuMs ?? 0,
      fps: r.meanFps,
    };
    idleLines.push(line);
    console.log(
      `idle ${titan.padEnd(12)} CPU ${line.cpuMs.toFixed(2)} ms/frame (tick ${line.tickMs.toFixed(2)} + draw ${line.drawMs.toFixed(2)})  GPU ${line.gpuMs.toFixed(2)} ms/frame  fps ${line.fps}` +
        (r.errors.length ? `  (${r.errors.length} console msgs: ${r.errors[0]})` : ''),
    );
  }
}
await browser.close();
server.httpServer.close();

/* ---------------------------------------------------------------------------------------------- *
 *  verdict: every bare worst-case run, and the bare runs pooled. A scenario fails when its problem REPEATS (at least
 *  two of its runs over a limit; with --reps=1 the one run). A one-off is printed as a warning: Windows' compositor or the
 *  driver now and then holds two vsyncs with the game idle (Phase 0: one cradle-mirror run in 12, no GC, tick or frame
 *  CPU anywhere near it), and the sim and renderer are deterministic enough that a real cost shows in every rep.
 * ---------------------------------------------------------------------------------------------- */
const judged = runs.filter((r) => r.kind === 'storm' && r.mode === 'bare');
const fails: string[] = [];
const warns: string[] = [];
const overOf = (r: Run): string[] => {
  const at = `${r.name} #${r.rep + 1}`;
  const o: string[] = [];
  if (r.scale !== SCALE) o.push(`${at}: ran at ×${r.scale}, not ×${SCALE} (${r.canvas.join('×')})`);
  if (r.meanFps < LIMITS.meanFpsMin) o.push(`${at}: mean ${r.meanFps} fps < ${LIMITS.meanFpsMin}`);
  if (r.p1Low < LIMITS.p1LowMin) o.push(`${at}: 1% low ${r.p1Low} fps < ${LIMITS.p1LowMin}`);
  if (r.under30 > LIMITS.under30PerRunMax)
    o.push(`${at}: ${r.under30} frames under 30 fps (> ${LIMITS.under30Ms} ms) > ${LIMITS.under30PerRunMax}`);
  return o;
};
for (const name of new Set(judged.map((r) => r.name))) {
  const reps = judged.filter((r) => r.name === name);
  const over = reps.map(overOf);
  const bad = over.filter((o) => o.length).length;
  const lines = over.flat();
  if (bad >= Math.min(2, reps.length)) fails.push(...lines);
  else warns.push(...lines.map((l) => `${l} (did not repeat in ${reps.length - 1} other runs)`));
}
if (judged.length) {
  const fr = judged.reduce((a, r) => a + r.frames, 0);
  const u30 = judged.reduce((a, r) => a + r.under30, 0);
  const p1 = Math.min(...judged.map((r) => r.p1Low));
  const mf = judged.reduce((a, r) => a + r.meanFps * r.frames, 0) / Math.max(1, fr);
  console.log(
    `\npooled ${judged.length} bare runs, ${fr} frames: mean ${mf.toFixed(1)} fps, worst 1% low ${p1}, under 30 fps ${u30}, worst tick ${Math.max(...judged.map((r) => r.tickMs.max)).toFixed(1)} ms`,
  );
  if (warns.length) console.log(`\nwarnings (one-off, not judged):\n  ${warns.join('\n  ')}`);
  console.log(
    fails.length
      ? `\nGATE: FAIL (${fails.length})\n  ${fails.join('\n  ')}`
      : `\nGATE: PASS (${judged.length} runs within tools/perf/gate.json)`,
  );
}
const json = opt('json', '');
if (json) {
  mkdirSync(dirname(resolve(json)), { recursive: true });
  writeFileSync(
    json,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        machineBusyPct: +busy.toFixed(1),
        q: Q,
        limits: LIMITS,
        runs,
        idle: idleLines,
      },
      null,
      1,
    ),
  );
}
process.exit(judged.length && fails.length ? 1 : 0);
