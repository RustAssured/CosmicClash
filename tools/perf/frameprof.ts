/**
 * S21: real-time frame pacing + per-pass profile of the REAL game on this machine (a production build in a headed Edge
 * window on the real GPU, vsync on, nothing stepped by hand: the game's own rAF loop runs).
 *
 *   npx tsx tools/perf/frameprof.ts [--scale=2|3|both] [--set=fight|ult|all] [--only=planet,uri] [--seconds=12]
 *       [--prof=0|1] [--build=1] [--out=.scratch/perf/fp] [--json=file] [--q=auto|0|1|2] [--root=.]
 *
 * Scale: ×2 = a 1536×864 CSS window (WJ's maximised Edge on the 1080p panel at 125 %: a 1920×~1000 canvas → ×2 with a
 * margin); ×3 = full screen through CDP (1920×1080 → ×3, no margin).
 * Sets: `fight` = AI vs AI (level 5) pairings, measured over `--seconds`; `ult` = every titan's Ultimate on a still foe
 * (script `10:ult`), measured from the start for ~8 s (the whole Ultimate).
 * Per run: rAF frame deltas (p50 / p95 / p99 / max, frames > 20 ms = missed vsyncs), the loop's CPU per frame, the tier the
 * adaptive controller settled on. With `--prof=1` the page also loads `?prof=1` (src/render/passProfiler.ts): CPU and GPU
 * (timer-query) ms per section, app and renderer passes, and the slowest frames whole (sections, texture uploads, GC).
 * Profiling costs a little: pacing numbers come from `--prof=0` (which still records the loop's CPU via `?prof=lite`).
 * `--budget=tools/perf/budget.json` (npm run perf:budget) fails (exit 1) when any run is over the frame budget.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build, preview } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import { openGame } from '../lead/browser';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const ROOT = resolve(opt('root', '.'));
const OUT = resolve(opt('out', '.scratch/perf/fp'));
const SECONDS = +opt('seconds', '12');
const PROFILE = opt('prof', '0') === '1';
const Q = opt('q', 'auto');
const SET = opt('set', 'all');
const scaleOpt = opt('scale', 'both');
const SCALES: (2 | 3)[] = scaleOpt === 'both' ? [2, 3] : [+scaleOpt as 2 | 3];
const only = opt('only', '');
const ALL = ['colossus', 'lastone', 'asteroid', 'nexus', 'blackhole', 'supernova', 'planet', 'uri', 'cradle'];

interface Scenario {
  name: string;
  params: string;
  seconds: number;
}
const scenarios: Scenario[] = [];
if (SET === 'fight' || SET === 'all') {
  // --only=a,b: each titan against the Planet; --pairs=colossus:nexus,uri:cradle: exact pairings
  const pairsOpt = opt('pairs', '');
  const pairs: [string, string][] = pairsOpt
    ? pairsOpt.split(',').map((p) => p.split(':') as [string, string])
    : only
      ? only.split(',').map((t) => [t, t === 'planet' ? 'lastone' : 'planet'])
      : [
          ['lastone', 'planet'],
          ['uri', 'supernova'],
          ['cradle', 'blackhole'],
          ['colossus', 'nexus'],
        ];
  for (const [a, b] of pairs)
    scenarios.push({
      name: `fight ${a} v ${b}`,
      params: `mode=aivai&a=${a}&b=${b}&stage=nursery&seed=21&ai=5`,
      seconds: SECONDS,
    });
}
if (SET === 'ult' || SET === 'all') {
  for (const a of only ? only.split(',') : ALL) {
    const foe = a === 'planet' ? 'cradle' : 'planet';
    scenarios.push({
      name: `ult ${a}`,
      params: `a=${a}&b=${foe}&seed=7&stage=nursery&p1=dummy&p2=dummy&script0=10:ult&meter=1&gap=210`,
      seconds: 8,
    });
  }
}

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
  preview: { port: 4318, strictPort: false, host: '127.0.0.1' },
  logLevel: 'error',
});
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4318/';

const pct = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};

async function launchHeaded(): Promise<Browser> {
  return chromium.launch({
    channel: process.env.CHROMIUM_PATH ? undefined : 'msedge',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: false,
    args: [
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      // the profiler spots garbage collections by the heap shrinking inside a frame (prof=1 only reads it)
      '--enable-precise-memory-info',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
}

interface Result {
  name: string;
  scale: number;
  canvas: number[];
  dpr: number;
  frames: number;
  delta: { p50: number; p95: number; p99: number; max: number; over20: number; over25: number };
  cpuFrame: { p50: number; p95: number; p99: number; max: number };
  /** Rendered frames that ran 2+ sim ticks (uneven motion at a steady 60 Hz; 0-tick frames are the sim's own slow motion). */
  judder: number;
  tier: number;
  tierChanges: number;
  drawCalls: number;
  prof?: unknown;
  /** rAF intervals > 20 ms: [start (page ms), length]. */
  hitches: [number, number][];
  errors: string[];
}

const results: Result[] = [];
const browser = await launchHeaded();
for (const scale of SCALES) {
  for (const sc of scenarios) {
    const url = `${base}?${sc.params}&freeze=1&hud=1&aftermath=0&tele=0&q=${Q}${PROFILE ? '&prof=1' : '&prof=lite'}`;
    const { page, errors } = await openGame(browser, url, null);
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    if (scale === 3) {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    } else {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 0, top: 0, width: 1536, height: 864 },
      });
    }
    await page.waitForTimeout(1500);
    // tsx (esbuild keepNames) wraps named closures in __name(): give the page one
    await page.evaluate('window.__name = (f) => f');
    const res = await page.evaluate(async (seconds: number) => {
      const api = window.__ADEUK__!;
      const prof = (
        window as unknown as {
          __ADEUK_PROF__?: {
            on: boolean;
            reset(): void;
            report(): unknown;
            loopReport(): number[];
            loopTicksReport?(): number[];
          };
        }
      ).__ADEUK_PROF__;
      const c = document.getElementById('game') as HTMLCanvasElement;
      // warm: let the first frames upload everything, the tier controller see a few frames
      api.run(true);
      await new Promise((r) => setTimeout(r, 300));
      api.run(false);
      prof?.reset();
      const deltas: number[] = [];
      let last = -1;
      let done = false;
      const hitches: [number, number][] = [];
      const tick = (t: number): void => {
        if (last >= 0) deltas.push(t - last);
        if (last >= 0 && t - last > 20) hitches.push([+last.toFixed(1), +(t - last).toFixed(1)]);
        last = t;
        if (!done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      api.run(true);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      done = true;
      api.run(false);
      const st = api.renderStats() as { tier: number; tierChanges: number; drawCalls: number };
      return {
        deltas,
        cpu: prof?.loopReport() ?? [],
        hitches,
        ticks: prof?.loopTicksReport?.() ?? [],
        canvas: [c.width, c.height],
        dpr: devicePixelRatio,
        tier: st.tier,
        tierChanges: st.tierChanges,
        drawCalls: st.drawCalls,
        prof: prof?.on ? prof.report() : null,
      };
    }, sc.seconds);
    await page.close();
    const d = res.deltas;
    const r: Result = {
      name: sc.name,
      scale: Math.floor(Math.min(res.canvas[0]! / 640, res.canvas[1]! / 360)),
      canvas: res.canvas,
      dpr: res.dpr,
      frames: d.length,
      delta: {
        p50: pct(d, 0.5),
        p95: pct(d, 0.95),
        p99: pct(d, 0.99),
        max: pct(d, 1),
        over20: d.filter((x) => x > 20).length,
        over25: d.filter((x) => x > 25).length,
      },
      cpuFrame: {
        p50: pct(res.cpu, 0.5),
        p95: pct(res.cpu, 0.95),
        p99: pct(res.cpu, 0.99),
        max: pct(res.cpu, 1),
      },
      judder: res.ticks.filter((t) => t >= 2).length,
      tier: res.tier,
      tierChanges: res.tierChanges,
      drawCalls: res.drawCalls,
      prof: res.prof ?? undefined,
      hitches: res.hitches,
      errors: errors.slice(0, 5),
    };
    results.push(r);
    const f = (v: number): string => v.toFixed(1).padStart(5);
    console.log(
      `×${r.scale} ${r.canvas.join('×').padEnd(9)} ${sc.name.padEnd(30)} frame p50 ${f(r.delta.p50)} p95 ${f(r.delta.p95)} p99 ${f(r.delta.p99)} max ${f(r.delta.max)}  >20ms ${String(r.delta.over20).padStart(3)}/${r.frames}` +
        `  | cpu p50 ${f(r.cpuFrame.p50)} p95 ${f(r.cpuFrame.p95)} max ${f(r.cpuFrame.max)}  judder ${r.judder}  tier ${r.tier}${r.tierChanges ? ` (${r.tierChanges} changes)` : ''}` +
        (errors.length ? `  (${errors.length} console msgs)` : ''),
    );
    if (r.prof) printProf(r.prof as ProfReport, r.hitches);
  }
}
await browser.close();
server.httpServer.close();
const json = opt('json', '');
if (json) {
  mkdirSync(dirname(resolve(json)), { recursive: true });
  writeFileSync(
    json,
    JSON.stringify({ when: new Date().toISOString(), profile: PROFILE, q: Q, results }, null, 1),
  );
}
const budgetFile = opt('budget', '');
if (budgetFile) process.exit(checkBudget(JSON.parse(readFileSync(budgetFile, 'utf8')) as Budget) ? 0 : 1);
process.exit(0);

interface Budget {
  maxFrameMs: number;
  missedPerRun: number;
  p99FrameMs: number;
  cpuP95Ms: number;
  cpuMaxMs: number;
  judderPerRun: number;
  gpuMeanMs: number;
  /** Known exceptions: a run whose name matches `run` gets these limits instead (with the reason, printed). */
  known?: ({ run: string; reason: string } & Partial<Omit<Budget, 'known'>>)[];
}
/** `--budget=tools/perf/budget.json`: every run within the budget, or a list of what is over (exit code 1). */
function checkBudget(b: Budget): boolean {
  const over: string[] = [];
  const notes = new Set<string>();
  for (const r of results) {
    const at = `×${r.scale} ${r.name}`;
    const k = b.known?.find((x) => r.name.includes(x.run));
    if (k) notes.add(`${k.run}: ${k.reason}`);
    const lim = { ...b, ...(k ?? {}) };
    const chk = (what: string, v: number, l: number): void => {
      if (v > l) over.push(`${at}: ${what} ${v.toFixed(1)} > ${l}`);
    };
    // a long rAF interval our own frame did not cause (the loop's CPU stayed under budget) is the OS / compositor: it still
    // counts as a missed vsync, but not against the max-frame limit
    if (r.cpuFrame.max === 0 || r.cpuFrame.max > lim.maxFrameMs)
      chk('max frame ms', r.delta.max, lim.maxFrameMs);
    chk('missed vsyncs', r.delta.over20, lim.missedPerRun);
    chk('p99 frame ms', r.delta.p99, lim.p99FrameMs);
    if (r.cpuFrame.max > 0) {
      chk('cpu p95 ms', r.cpuFrame.p95, lim.cpuP95Ms);
      chk('cpu max ms', r.cpuFrame.max, lim.cpuMaxMs);
    }
    chk('judder frames', r.judder, lim.judderPerRun);
    if (r.prof) chk('gpu mean ms', gpuSum(r.prof as ProfReport), lim.gpuMeanMs);
  }
  for (const n of notes) console.log(`known exception: ${n}`);
  console.log(
    over.length
      ? `\nBUDGET: ${over.length} over\n  ${over.join('\n  ')}`
      : `\nBUDGET: all ${results.length} runs within ${budgetFile}`,
  );
  return over.length === 0;
}

function gpuSum(p: ProfReport): number {
  let g = 0;
  for (const s of p.sections) g += s.gpuMean * (s.gpuN / Math.max(1, p.frame.n));
  return g;
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
function printProf(p: ProfReport, hitches: [number, number][]): void {
  const f = (v: number): string => v.toFixed(2).padStart(6);
  let cpu = 0;
  let gpu = 0;
  for (const s of p.sections) {
    console.log(
      `      ${s.name.padEnd(14)} cpu ${f(s.cpuMean)} p95 ${f(s.cpuP95)}   gpu ${p.gpu ? `${f(s.gpuMean)} p95 ${f(s.gpuP95)}` : '   -'}  (n ${s.n})`,
    );
    cpu += s.cpuMean * (s.n / Math.max(1, p.frame.n));
    gpu += s.gpuMean * (s.gpuN / Math.max(1, p.frame.n));
  }
  console.log(
    `      frame cpu mean ${f(p.frame.mean)} p95 ${f(p.frame.p95)}; sum of sections cpu ${f(cpu)} gpu ${f(gpu)}`,
  );
  if (hitches.length)
    console.log(
      `      hitches (rAF > 20 ms): ${hitches.map((h) => `@${h[0].toFixed(0)} ${h[1]}ms`).join('  ')}`,
    );
  const top = p.spikes
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6);
  for (const sp of top)
    console.log(
      `      spike @${sp.at.toFixed(0)} ${sp.ms.toFixed(1)} ms: ${sp.sections.map((x) => `${x[0]} ${x[1]}`).join(', ')}  ${JSON.stringify(sp.counts)}`,
    );
}
