/**
 * Netplay Step 0 (docs/netplay/STEP0.md): do the same inputs give the same sim state on every JS engine?
 *
 * Replays recorded input streams (tools/netplay/record.ts) on several engines and compares the state hash of EVERY tick
 * against Node's, plus a probe of each engine's own Math library:
 *   - node      this repo's Node (V8), a child process
 *   - jitless   the same with `--jitless` (V8's interpreter only: no optimising compiler), a proxy for engine variation
 *   - edge      the installed Microsoft Edge (Chromium / V8), headless via Playwright
 *   - firefox   the installed Firefox (SpiderMonkey), headless, launched directly (no Playwright build needed)
 *   - webkit / pw-firefox / chromium   Playwright's own builds, once installed (`npx playwright install webkit firefox`)
 *   - serve     serve the page and wait: open the printed URL in any browser (Safari on a Mac, a phone…) by hand
 *
 *   npx tsx tools/netplay/crossengine.ts [--recs=.scratch/netplay/recordings.json] [--engines=node,jitless,edge,firefox]
 *        [--limit=55] [--jitless-limit=3] [--label=before] [--port=8765] [--host=127.0.0.1] [--root=<source tree>]
 *
 * `--engines=serve --host=0.0.0.0` lets a phone or a Mac on the same network open http://<this-pc>:8765/?engine=safari.
 * Writes .scratch/netplay/crossengine-<label>.json; exit 1 when any engine diverges from Node.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from '@playwright/test';
import { firstDiff, type Recording } from './replay-core';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, '.scratch/netplay');
const recsPath = arg('recs', join(OUT, 'recordings.json'));
const engines = arg('engines', 'node,jitless,edge,firefox').split(',');
const limit = +arg('limit', '1000');
const jitlessLimit = +arg('jitless-limit', '3');
/** --jitless is ~50× slower: it replays only this many ticks of each recording (compared on that prefix). */
const jitlessTicks = +arg('jitless-ticks', '1000');
/** `--reuse=node,edge`: load these engines' saved runs from an earlier run with the same label instead of re-running. */
const reuse = arg('reuse', '').split(',');
const label = arg('label', 'run');
const WEB = join(OUT, `web-${label}`);
/**
 * `--root=<dir>`: bundle the sim from another source tree (e.g. `git archive HEAD` unpacked into the scratch folder, to
 * measure the code before a change). The replay tool itself always comes from this repo's tools/netplay.
 */
const SRC = resolve(arg('root', ROOT));
const port = +arg('port', '8765');
const host = arg('host', '127.0.0.1');
const FIREFOX = process.env.FIREFOX_PATH ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

interface Result {
  i: number;
  a: string;
  b: string;
  ticks: number;
  hashes: number[];
  checksums: number[] | null;
  digest: string;
  final: unknown;
  ms: number;
}
interface EngineRun {
  ua: string;
  probe: Record<string, number[]>;
  results: Result[];
  error?: string;
}

const recs = (JSON.parse(readFileSync(recsPath, 'utf8')) as Recording[]).slice(0, limit);
mkdirSync(WEB, { recursive: true });
const limitedRecs = join(WEB, 'recordings.json');
writeFileSync(limitedRecs, JSON.stringify(recs));

// ---- the page and the Node runner: esbuild bundles of the sim + replay core (tsconfig paths resolve '@/…' in SRC)
for (const [entry, out, platform] of [
  ['browser-entry.ts', 'replay.js', 'browser'],
  ['replay-node.ts', 'replay-node.mjs', 'node'],
] as const)
  await build({
    entryPoints: [join(ROOT, 'tools/netplay', entry)],
    bundle: true,
    format: 'esm',
    platform,
    target: 'es2022',
    outfile: join(WEB, out),
    tsconfig: join(SRC, 'tsconfig.json'),
    logLevel: 'warning',
  });
writeFileSync(
  join(WEB, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>ADEUK netplay replay</title>' +
    '<body style="font:16px monospace;background:#111;color:#eee"><p id="status">loading…</p>' +
    '<script type="module" src="replay.js"></script></body>',
);

// ---- the server: static files + result posts, per engine
const runs = new Map<string, EngineRun>();
const waiters = new Map<string, () => void>();
const run = (e: string): EngineRun => {
  let r = runs.get(e);
  if (!r) runs.set(e, (r = { ua: '', probe: {}, results: [] }));
  return r;
};
const FILES: Record<string, [string, string]> = {
  '/': [join(WEB, 'index.html'), 'text/html'],
  '/index.html': [join(WEB, 'index.html'), 'text/html'],
  '/replay.js': [join(WEB, 'replay.js'), 'text/javascript'],
  '/recordings.json': [limitedRecs, 'application/json'],
  '/uri_rig.bin': [join(SRC, 'src/titans/uri/uri_rig.bin'), 'application/octet-stream'],
};
const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const engine = u.searchParams.get('engine') ?? 'browser';
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const r = run(engine);
      if (u.pathname === '/probe') {
        r.ua = String(body.ua);
        r.probe = body.probe as Record<string, number[]>;
      } else if (u.pathname === '/result') {
        r.results.push(body as unknown as Result);
        const x = body as unknown as Result;
        console.log(
          `  ${engine} ${x.i + 1}/${recs.length} ${x.a} v ${x.b} ${x.digest} ${(x.ms / x.ticks).toFixed(2)} ms/tick`,
        );
      } else if (u.pathname === '/error') {
        r.error = String(body.error);
        console.log(`  ${engine} ERROR ${r.error}`);
        waiters.get(engine)?.();
        waiters.get('*')?.();
      } else if (u.pathname === '/done') {
        waiters.get(engine)?.();
        waiters.get('*')?.();
      }
      res.writeHead(204).end();
    });
    return;
  }
  const f = FILES[u.pathname];
  if (!f) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }).end(readFileSync(f[0]));
});
await new Promise<void>((r) => server.listen(port, host, r));
const url = (e: string): string => `http://127.0.0.1:${port}/?engine=${e}`;
const finished = (e: string): Promise<void> => new Promise((r) => waiters.set(e, r));

/** `n` recordings: all of them (n ≥ count) or n spread evenly through the file. */
function nodeRun(e: string, flags: string[], n: number, ticks = 1e9): EngineRun {
  const pick =
    n >= recs.length
      ? []
      : [
          `--pick=${Array.from({ length: n }, (_, k) => Math.round((k * (recs.length - 1)) / Math.max(1, n - 1))).join(',')}`,
        ];
  const out = join(WEB, `node-${e}.json`);
  const t0 = Date.now();
  // cwd = the source tree: Node reads 우리's asset from <cwd>/src/titans/uri/uri_rig.bin
  const p = spawnSync(
    process.execPath,
    [
      ...flags,
      join(WEB, 'replay-node.mjs'),
      `--recs=${limitedRecs}`,
      `--out=${out}`,
      `--limit=${n}`,
      `--ticks=${ticks}`,
      ...pick,
    ],
    { cwd: SRC, stdio: 'inherit' },
  );
  if (p.status !== 0) throw new Error(`${e}: node exited ${p.status}`);
  console.log(`  ${e}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return JSON.parse(readFileSync(out, 'utf8')) as EngineRun;
}

const t0 = Date.now();
try {
  for (const e of engines) {
    console.log(`\n== ${e}`);
    const saved = join(WEB, `engine-${e}.json`);
    if (reuse.includes(e) && existsSync(saved)) {
      runs.set(e, JSON.parse(readFileSync(saved, 'utf8')) as EngineRun);
      console.log(`  reused ${saved}`);
      continue;
    }
    if (e === 'node') runs.set(e, nodeRun(e, [], recs.length));
    else if (e === 'jitless')
      runs.set(e, nodeRun(e, ['--jitless'], Math.min(jitlessLimit, recs.length), jitlessTicks));
    else if (e === 'edge' || e === 'chromium' || e === 'pw-firefox' || e === 'webkit') {
      // edge: the installed Edge; chromium / pw-firefox / webkit: Playwright's own builds (`npx playwright install …`)
      const browser =
        e === 'edge'
          ? await chromium.launch({ channel: 'msedge' })
          : e === 'chromium'
            ? await chromium.launch()
            : e === 'webkit'
              ? await webkit.launch()
              : await firefox.launch();
      try {
        const page = await browser.newPage();
        page.on('pageerror', (err) => console.log(`  ${e} pageerror ${err.message}`));
        const done = finished(e);
        await page.goto(url(e));
        await done;
        run(e).ua = `${run(e).ua} (Playwright ${e} ${browser.version()})`;
      } finally {
        await browser.close();
      }
    } else if (e === 'firefox') {
      if (!existsSync(FIREFOX)) {
        console.log(`  no Firefox at ${FIREFOX} (set FIREFOX_PATH)`);
        continue;
      }
      // a throwaway profile: no first-run pages, no telemetry, no hung-script dialog, no background throttling
      const profile = join(tmpdir(), `adeuk-netplay-ff-${process.pid}`);
      mkdirSync(profile, { recursive: true });
      writeFileSync(
        join(profile, 'user.js'),
        [
          'user_pref("browser.shell.checkDefaultBrowser", false);',
          'user_pref("browser.startup.homepage_override.mstone", "ignore");',
          'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
          'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
          'user_pref("app.update.enabled", false);',
          'user_pref("dom.max_script_run_time", 0);',
          'user_pref("dom.timeout.enable_budget_timer_throttling", false);',
        ].join('\n'),
      );
      const done = finished(e);
      const ff = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, url(e)], {
        stdio: 'ignore',
      });
      try {
        await done;
      } finally {
        spawnSync('taskkill', ['/PID', String(ff.pid), '/T', '/F'], { stdio: 'ignore' });
        // Firefox lets go of its profile a moment after it exits: best effort, never fatal
        for (let k = 0; k < 10; k++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            rmSync(profile, { recursive: true, force: true });
            break;
          } catch {
            /* still locked */
          }
        }
      }
    } else if (e === 'serve') {
      console.log(
        `  open http://<this machine's address>:${port}/?engine=<name> in any browser (--host=0.0.0.0 for another\n` +
          `  device); the comparison prints when that page reports done`,
      );
      await finished('*');
    }
    // every engine's raw run is kept, so a later failure loses nothing (`--reuse=<engine>` loads it back)
    if (runs.has(e)) writeFileSync(saved, JSON.stringify(runs.get(e)));
  }
} finally {
  server.close();
}

// ---- compare every engine with Node
const ref = runs.get('node') ?? [...runs.values()][0];
const report: Record<string, unknown> = { label, recs: recs.length, ticks: recs[0]?.ticks, engines: {} };
let bad = 0;
console.log(`\n== results (reference: ${ref?.ua})`);
for (const [e, r] of runs) {
  const probeDiff: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.probe)) {
    const w = ref?.probe[k];
    probeDiff[k] = w ? v.filter((x, i) => !Object.is(x, w[i])).length : -1;
  }
  const per = r.results.map((x) => {
    const y = ref?.results.find((q) => q.i === x.i);
    // compared on the common prefix (a --jitless run replays fewer ticks)
    const n = y ? Math.min(x.hashes.length, y.hashes.length) : 0;
    const first = y ? firstDiff(x.hashes.slice(0, n), y.hashes.slice(0, n)) + 1 : 0;
    const firstCs =
      y?.checksums && x.checksums ? firstDiff(x.checksums.slice(0, n), y.checksums.slice(0, n)) + 1 : 0;
    return {
      pair: `${x.a} v ${x.b}`,
      digest: x.digest,
      firstDiffTick: first,
      firstChecksumDiffTick: firstCs,
      msPerTick: x.ms / x.ticks,
    };
  });
  const diverged = per.filter((p) => p.firstDiffTick > 0);
  if (diverged.length) bad++;
  const probeBad = Object.entries(probeDiff).filter(([, n]) => n > 0);
  console.log(
    `${e.padEnd(8)} ${r.ua}\n         ${per.length} replays: ${
      diverged.length
        ? `${diverged.length} DIVERGE (${diverged
            .slice(0, 6)
            .map((p) => `${p.pair} @${p.firstDiffTick}`)
            .join(', ')}${diverged.length > 6 ? ', …' : ''})`
        : 'all identical to Node, every tick'
    }${r.error ? `; ERROR ${r.error}` : ''}\n         Math probe vs Node: ${
      probeBad.length ? probeBad.map(([k, n]) => `${k} ${n}/2000`).join(', ') : 'identical'
    }`,
  );
  (report.engines as Record<string, unknown>)[e] = { ua: r.ua, error: r.error, probeDiff, per };
}
writeFileSync(join(OUT, `crossengine-${label}.json`), JSON.stringify(report, null, 1));
console.log(
  `\n${bad ? `${bad} engine(s) diverge` : 'no divergence'}; ${((Date.now() - t0) / 1000).toFixed(0)} s; → .scratch/netplay/crossengine-${label}.json`,
);
process.exit(bad ? 1 : 0);
