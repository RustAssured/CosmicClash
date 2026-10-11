/**
 * Bake the LOCKED Mouth's crane strike on World B (TRAILER_V3 0:20–0:24, P3) from the oracle
 * (mouth/reference/demos/mouth-LOCKED-full.html), headless and deterministic like tools/cinema/mouth-bake.ts: a seeded
 * Math.random, no real-time loop, the oracle's own renderer at its native 640×360, frame by frame. Then pack it:
 *   npx tsx tools/cinema/mouth-strike.ts && npx tsx tools/cinema/mouth-pack.ts strike
 * → press/cinema/work/mouth/strike/NNNN.png (figure | emissive, 1280×360) → strike.cfp
 *
 * The take (frames at 60 fps, 0 = 0:20): the body slides in along the bottom edge from the right corner (0–2 s) and
 * slows to a stop below World B; the crane neck rises and the head tracks the world; at frame BEGIN it starts its real
 * bite (the oracle's MOVES.bite: load, strike, bite, hold, recover), whose bite lands on World B at frame ~175, the tick
 * of the matter blow in src/cinema/gates/p3.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const W = 640;
const H = 360;
const FRAMES = 240;
/** Frame the bite begins (load 0.42 s + strike 0.18 s / 1.18 → contact ≈ 34 frames later). */
const BEGIN = 141;
/** World B on the screen (the shot's camera is locked (100, 70) px from it, so it sits high on the left and the head can hang clear of it until the strike), and where the bite lands. */
const TARGET: [number, number] = [238, 134];
const OUT = 'press/cinema/work/mouth/strike';
const SRC = 'mouth/reference/demos/mouth-LOCKED-full.html';

function patch(html: string): string {
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
  // no predicted-path dashes (readability UI drawn straight on the canvas)
  rep("if(move&&move.path&&lab==='load'){", "if(window.__noTell!==true&&move&&move.path&&lab==='load'){");
  rep(
    "const cv=document.getElementById('cv'),gx=cv.getContext('2d');",
    "window.__fig=fig;window.__emc=emc;const cv=document.getElementById('cv'),gx=cv.getContext('2d');",
  );
  rep(
    'window.__F={DMG,',
    'window.__F={setFight:v=>{fightBack=v;},setOppMoves:v=>{oppMoves=v;},setVariant:v=>{variant=v;},setSlide:v=>{slideIn=v;sv=0;},DMG,',
  );
  return html;
}

mkdirSync(OUT, { recursive: true });
const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.error(`[oracle pageerror] ${e.message}`));
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    let s = 0x5a17c0de;
    Math.random = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Object.assign(window, { __noOpp: true, __noRocks: true, __noShake: true, __noTell: true });
  });
  const html = patch(readFileSync(SRC, 'utf8'));
  await page.route('**/mouth-oracle.html', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(`${url}/mouth-oracle.html`);
  await page.waitForFunction('window.__F !== undefined');
  await page.evaluate(
    `(() => { const F = window.__F; F.setFight(false); F.setOppMoves(false); F.setVariant(0); F.setSlide(0);
      Object.assign(F.opp, { x: ${TARGET[0]}, y: ${TARGET[1]}, vx: 0, vy: 0 }); })()`,
  );
  for (let f = 0; f < FRAMES; f++) {
    const u = Math.min(1, f / 125);
    const sst = u * u * (3 - 2 * u);
    // the bottom edge runs right to left from s = W + H: in from beyond the right corner, to a stop below World B
    const s = W + H - 90 + 250 * sst;
    const b64 = (await page.evaluate(`(() => {
      const F = window.__F; F.s = ${s};
      if (${f === BEGIN}) F.begin('bite');
      F.step(1 / 60); F.draw();
      const a = window.__fig.getContext('2d').getImageData(0, 0, 640, 360).data;
      const e = window.__emc.getContext('2d').getImageData(0, 0, 640, 360).data;
      const both = new Uint8Array(a.length * 2); both.set(a, 0); both.set(e, a.length);
      let out = ''; for (let i = 0; i < both.length; i += 0x8000) out += String.fromCharCode(...both.subarray(i, i + 0x8000));
      return btoa(out); })()`)) as string;
    const buf = Buffer.from(b64, 'base64');
    const png = new PNG({ width: W * 2, height: H });
    const n = W * H * 4;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        for (let c = 0; c < 4; c++) {
          png.data[(y * W * 2 + x) * 4 + c] = buf[i + c]!;
          png.data[(y * W * 2 + W + x) * 4 + c] = buf[n + i + c]!;
        }
      }
    writeFileSync(`${OUT}/${String(f).padStart(4, '0')}.png`, PNG.sync.write(png));
  }
  console.log(`strike: ${FRAMES} frames → ${OUT} (bite begins at frame ${BEGIN})`);
} finally {
  await browser.close();
  await server.close();
}
