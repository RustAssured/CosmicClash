/**
 * The Mouth, game vs oracle (Gates 3B feel and 3C look), headless on the real GPU:
 *   npx tsx tools/mouth/parity.ts [--out=docs/gallery/mouth] [--only=rest,bite-strike] [--feel=1] [--perf=1]
 * - LOOK: each scene is run from the oracle's own start (s = left wall, head (300, 180), 30 warm-up steps, opp (470, 170)) in
 *   both, then drawn: left = the game's GPU pass (dev/render/mouth.html, the oracle's light rig, black backdrop), right = the
 *   oracle's own canvas (mouth/reference/demos/mouth-LOCKED-full.html, seeded Math.random, demo opponent / rocks / shake /
 *   tell off, black backdrop). Written as `<scene>.png` (1280 × 360).
 * - FEEL (--feel=1): the head's path per frame for each strike and height in both; prints the largest gap (px) and the frame
 *   each beat starts (the gate: same timings ±1 frame).
 * - PERF (--perf=1): the Mouth pass's cost per frame on this GPU.
 * LOOK at every image.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const outDir = arg('out', 'docs/gallery/mouth');
const only = arg('only', '')
  .split(',')
  .filter((s) => s);
mkdirSync(outDir, { recursive: true });
const W = 640;
const H = 360;
const PER = 2 * (W + H);
const png = (u: string): PNG => PNG.sync.read(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));

type Move = 'bite' | 'sweep' | 'coil';
interface Scene {
  name: string;
  s?: number;
  opp?: [number, number];
  frames: number;
  begin?: [number, Move, number][];
  slide?: [number, number, number][];
  ko?: number;
  hits?: [number, 'head' | 'neck' | 'coil', number][];
  /** Cut three strands before the knockout (the severed end). */
  sever?: boolean;
}
const SCENES: Scene[] = [
  { name: 'rest-left', frames: 60 },
  { name: 'bite-load', frames: 30, begin: [[10, 'bite', 0]] },
  { name: 'bite-strike', frames: 40, begin: [[10, 'bite', 0]] },
  { name: 'bite-contact', frames: 46, begin: [[10, 'bite', 0]] },
  { name: 'bite-high', frames: 50, begin: [[10, 'bite', -1]] },
  { name: 'bite-low', frames: 43, begin: [[10, 'bite', 1]] },
  { name: 'sweep-mid', frames: 50, begin: [[10, 'sweep', 0]] },
  { name: 'coil-mid', frames: 70, begin: [[10, 'coil', 0]] },
  { name: 'crush', frames: 100, begin: [[10, 'coil', 0]] },
  { name: 'rest-top', s: W * 0.45, opp: [330, 230], frames: 60 },
  { name: 'rest-right', s: W + H * 0.5, opp: [200, 200], frames: 60 },
  { name: 'rest-bottom', s: W + H + W * 0.5, opp: [300, 140], frames: 60 },
  { name: 'rest-corner', s: W - 30, opp: [380, 200], frames: 60 },
  // 3D: damage and the two knockouts (the oracle's own hits land at random places: compare the kind, not the pixels)
  {
    name: 'damage',
    frames: 90,
    hits: [
      [10, 'head', 2],
      [20, 'head', 2],
      [30, 'neck', 2],
      [40, 'neck', 2],
      [50, 'neck', 2],
      [60, 'coil', 2],
      [70, 'head', 2],
    ],
  },
  { name: 'ko-drag-convulse', frames: 40, ko: 10 },
  { name: 'ko-drag-slack', frames: 110, ko: 10 },
  { name: 'ko-drag-dragged', frames: 240, ko: 10 },
  { name: 'ko-sever-loose', frames: 90, ko: 10, sever: true },
  { name: 'ko-sever-withdraw', frames: 220, ko: 10, sever: true },
];

function patchOracle(html: string): string {
  const rep = (from: string, to: string): void => {
    if (!html.includes(from)) throw new Error(`oracle patch point missing: ${from}`);
    html = html.replace(from, to);
  };
  rep('for(let y=Math.floor(opp.y-58);', 'if(window.__noOpp!==true)for(let y=Math.floor(opp.y-58);');
  rep(
    'for(let k=0;k<6;k++){const r=rng(k*13+5);rock(',
    'if(window.__noRocks!==true)for(let k=0;k<6;k++){const r=rng(k*13+5);rock(',
  );
  rep('if(shake>.4){', 'if(shake>.4&&window.__noShake!==true){');
  rep(
    "if(move&&(lab==='load'||lab==='reach'))ringPx(",
    "if(window.__noTell!==true&&move&&(lab==='load'||lab==='reach'))ringPx(",
  );
  rep(
    'for(const q of trail)if(q.a>.3)ringPx(',
    'for(const q of trail)if(window.__noTell!==true&&q.a>.3)ringPx(',
  );
  rep("if(move&&move.path&&lab==='load'){", "if(window.__noTell!==true&&move&&move.path&&lab==='load'){");
  rep(
    '  compose(gx,t);',
    "  if(window.__black){gx.fillStyle='#05040a';gx.fillRect(0,0,W,H);compose(gx,t,false);}else compose(gx,t);",
  );
  rep('for(let k=0;k<30;k++)step(1/60);draw();requestAnimationFrame(loop);', 'requestAnimationFrame(loop);');
  rep(
    'window.__F={DMG,',
    'window.__F={setFight:v=>{fightBack=v;},setOppMoves:v=>{oppMoves=v;},setVariant:v=>{variant=v;},setSlide:v=>{slideIn=v;},get t(){return t;},DMG,',
  );
  return html;
}

const { server, url } = await startRenderServer();
const browser = await launch();
let bad = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const game = await ctx.newPage();
  const watch = (p: typeof game, tag: string): void => {
    p.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource/.test(m.text())) {
        console.log(`[${tag} console.${m.type()}] ${m.text()}`);
        bad++;
      }
    });
    p.on('pageerror', (e) => {
      console.log(`[${tag} pageerror] ${e.message}`);
      bad++;
    });
  };
  watch(game, 'game');
  await game.goto(`${url}/dev/render/mouth.html`, { waitUntil: 'commit' });
  await game.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180_000 });

  const oracle = await ctx.newPage();
  watch(oracle, 'oracle');
  await oracle.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    let s = 0x5a17c0de;
    Math.random = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Object.assign(window, { __noOpp: true, __noRocks: true, __noShake: true, __noTell: true, __black: true });
  });
  const html = patchOracle(readFileSync('mouth/reference/demos/mouth-LOCKED-full.html', 'utf8'));
  await oracle.route('**/mouth-oracle.html', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );

  /** Load a fresh oracle and run a scene in it; returns the canvas PNG (or, with `trace`, the head per frame). */
  const runOracle = async (sc: Scene, trace = false): Promise<string | number[][]> => {
    await oracle.goto(`${url}/mouth-oracle.html`);
    await oracle.waitForFunction('window.__F !== undefined');
    return (await oracle.evaluate(
      `(() => { const F = window.__F; F.setFight(false); F.setOppMoves(false);
        F.s = ${sc.s ?? PER - H * 0.5};
        Object.assign(F.opp, { x: ${(sc.opp ?? [470, 170])[0]}, y: ${(sc.opp ?? [470, 170])[1]}, vx: 0, vy: 0 });
        for (let k = 0; k < 30; k++) F.step(1 / 60);
        const begins = ${JSON.stringify(sc.begin ?? [])};
        const slides = ${JSON.stringify(sc.slide ?? [])};
        const rows = [];
        for (let f = 0; f < ${sc.frames}; f++) {
          let sl = 0; for (const [a, b, v] of slides) if (f >= a && f < b) sl = v; F.setSlide(sl);
          for (const [fr, mv, v] of begins) if (fr === f) { F.setVariant(v); F.begin(mv); }
          ${sc.ko !== undefined ? `if (f === ${sc.ko}) { ${sc.sever ? 'F.DMG.severF[0] = 0.5; F.DMG.severF[1] = 0.6; F.DMG.severF[2] = 0.45;' : ''} F.DMG.hp = 0; F.knockout(); }` : ''}
          for (const [fr, part, p] of ${JSON.stringify(sc.hits ?? [])}) if (fr === f) {
            if (part === 'head') F.hitAt(F.head.x, F.head.y, p);
            else if (part === 'neck') { const q = F.HITN[Math.floor(F.HITN.length * 0.5)]; if (q) F.hitAt(q.x, q.y, p); }
          }
          F.step(1 / 60);
          if (${trace}) rows.push([f + 1, F.head.x, F.head.y, F.lab()]);
        }
        if (${trace}) return rows;
        F.draw();
        return document.getElementById('cv').toDataURL('image/png'); })()`,
    )) as string | number[][];
  };

  if (arg('feel', '1') === '1') {
    // ---- feel parity: the head's path and the beats, per frame ----
    const feel: Scene[] = [
      { name: 'bite', frames: 110, begin: [[10, 'bite', 0]] },
      { name: 'bite-high', frames: 110, begin: [[10, 'bite', -1]] },
      { name: 'bite-low', frames: 110, begin: [[10, 'bite', 1]] },
      { name: 'sweep', frames: 120, begin: [[10, 'sweep', 0]] },
      { name: 'coil', frames: 160, begin: [[10, 'coil', 0]] },
      { name: 'slide', frames: 150, slide: [[0, 90, 1]] },
    ];
    for (const sc of feel) {
      const o = (await runOracle(sc, true)) as [number, number, number, string][];
      const g = (await game.evaluate(
        `window.__MOUTH__.trace(${JSON.stringify({ ...sc, grab: 14, every: 1 })})`,
      )) as number[][];
      let gap = 0;
      let at = 0;
      for (let i = 0; i < Math.min(o.length, g.length); i++) {
        const d = Math.hypot(o[i]![1] - g[i]![1]!, o[i]![2] - g[i]![2]!);
        if (d > gap) {
          gap = d;
          at = i + 1;
        }
      }
      const beats: string[] = [];
      let prev = '';
      for (const r of o) {
        const lab = String(r[3]).split(':')[0]!;
        if (lab !== prev) beats.push(`${lab}@${r[0]}`);
        prev = lab;
      }
      console.log(
        `feel ${sc.name}: max head gap ${gap.toFixed(3)} px (frame ${at}); oracle beats ${beats.join(' ')}`,
      );
    }
  }

  for (const sc of SCENES) {
    if (only.length && !only.includes(sc.name)) continue;
    const gUrl = (await game.evaluate(
      `window.__MOUTH__.shot(${JSON.stringify({ ...sc, sky: 0, tell: false, backdrop: 'black', grab: 14 })})`,
    )) as string;
    const oUrl = (await runOracle(sc)) as string;
    const a = png(gUrl);
    const b = png(oUrl);
    const sbs = new PNG({ width: W * 2, height: H });
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let c = 0; c < 4; c++) {
          sbs.data[(y * W * 2 + x) * 4 + c] = a.data[(y * W + x) * 4 + c]!;
          sbs.data[(y * W * 2 + W + x) * 4 + c] = b.data[(y * W + x) * 4 + c]!;
        }
    writeFileSync(`${outDir}/${sc.name}.png`, PNG.sync.write(sbs));
    console.log(`look ${sc.name} → ${outDir}/${sc.name}.png`);
  }

  if (arg('perf', '1') === '1') {
    const r = await game.evaluate(
      `window.__MOUTH__.perf(${JSON.stringify({ frames: 40, begin: [[10, 'bite', 0]] })}, 180)`,
    );
    console.log('perf', JSON.stringify(r));
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(bad ? `${bad} console problems` : 'no console problems');
