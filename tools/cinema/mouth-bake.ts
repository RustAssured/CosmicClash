/**
 * Bake the LOCKED Mouth (mouth/reference/demos/mouth-LOCKED-full.html, the oracle) for Act IV's actors (edgepull, jawwipe),
 * the way S5's tools/press/trailer/mouth.ts drives it: headless, a seeded Math.random, no real-time loop, the oracle's own
 * renderer (flesh shading, braids, jaw-rings, teeth, slime, outline) at its native 640×360, frame by frame.
 *
 *   npx tsx tools/cinema/mouth-bake.ts [probe]
 *
 * Writes press/cinema/work/mouth/<seq>/NNNN.png (not in git): each PNG is 1280×360, the oracle's figure (left, alpha =
 * coverage) beside its emissive layer (right). Sequences, on the timeline clock of src/cinema/p6/edge.ts:
 *  - edge   (EDGE.slideStart → pullEnd): the full Mouth with its coils sliding along the bottom edge, the head low and
 *            watching: what sits at the arena's edge (inside the shrinking arena during the pull-back);
 *  - heap   (pullStart → pullEnd): the rest of its body, the coil heap outside the arena, braided by the oracle's own
 *            braidPaths/drawPath at the camera's scale every frame (rendered natively, never magnified);
 *  - jaw    (wipeStart → wipeEnd): the head seen down its axis: the jaw-rings and teeth rows closing over the lens.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { EDGE, HEAP_THICK, arenaZoom, heapSpine, jawOpen, toScreen } from '../../src/cinema/p6/edge';

const W = 640;
const H = 360;
const OUT = 'press/cinema/work/mouth';
const probe = process.argv[2] === 'probe';

const SRC = 'mouth/reference/demos/mouth-LOCKED-full.html';
function patch(html: string): string {
  const rep = (from: string, to: string): void => {
    if (!html.includes(from)) throw new Error(`oracle patch point missing: ${from}`);
    html = html.replace(from, to);
  };
  // S5's patches: no opponent stand-in, no floating rocks, no screen shake, no readability UI
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
  rep(
    "const cv=document.getElementById('cv'),gx=cv.getContext('2d');",
    "window.__fig=fig;window.__emc=emc;const cv=document.getElementById('cv'),gx=cv.getContext('2d');",
  );
  // ours: the renderer's own building blocks, to braid the heap and turn the head toward the lens
  rep(
    'window.__F={DMG,',
    'window.__M={clr,braidPaths,drawPath,asSpine,slime,head,compose,zb:()=>ZB,setT:v=>{t=v;}};' +
      'window.__F={setFight:v=>{fightBack=v;},setOppMoves:v=>{oppMoves=v;},setVariant:v=>{variant=v;},setSlide:v=>{slideIn=v;sv=0;},DMG,',
  );
  return html;
}

const { server, url } = await startRenderServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.error(`[oracle pageerror] ${e.message}`));
await page.addInitScript(() => {
  window.requestAnimationFrame = () => 0;
  let s = 0x2f6b9a1d;
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
await page.waitForFunction('window.__F !== undefined && window.__M !== undefined');
await page.evaluate(`(() => { const F = window.__F; F.setFight(false); F.setOppMoves(false); F.setVariant(0); F.setSlide(0);
  Object.assign(F.opp, { x: 330, y: 200, vx: 0, vy: 0 }); })()`);

/** Read the figure (after the oracle's compose: outline, depth seams) and its emissive layer as one 1280×360 PNG. */
async function grab(file: string): Promise<void> {
  const b64 = (await page.evaluate(`(() => {
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
      const l = (y * W * 2 + x) * 4;
      const r = (y * W * 2 + W + x) * 4;
      for (let c = 0; c < 4; c++) {
        png.data[l + c] = buf[i + c]!;
        png.data[r + c] = buf[n + i + c]!;
      }
    }
  writeFileSync(file, PNG.sync.write(png));
}

/** The compose pass without a backdrop or a target canvas (we only want fig/emc). */
const COMPOSE = `window.__M.compose({ drawImage() {}, save() {}, restore() {} }, window.__oT || 0, false)`;

const frames = (a: number, b: number): number[] => {
  const out: number[] = [];
  for (let f = Math.round(a * EDGE.fps); f < Math.round(b * EDGE.fps); f++) out.push(f);
  return out;
};

// ---------------------------------------------------------------- edge: the coils slide along the bottom edge
{
  const dir = `${OUT}/edge`;
  mkdirSync(dir, { recursive: true });
  const list = probe ? [Math.round(80.5 * 60), Math.round(82.5 * 60)] : frames(EDGE.slideStart, EDGE.pullEnd);
  const P = W * 2 + H * 2;
  let k = 0;
  // run the oracle continuously from the slide's start (its motion is stateful); grab the frames we need
  const last = list[list.length - 1]!;
  for (let f = Math.round(EDGE.slideStart * 60); f <= last; f++) {
    const t = f / 60;
    const u = Math.min(1, Math.max(0, (t - EDGE.slideStart) / (EDGE.pullStart - EDGE.slideStart)));
    const sst = u * u * (3 - 2 * u);
    // along the bottom edge (W+H … 2W+H runs right to left): in from the right corner, slowing to a watchful stop
    const s = W + H + 40 + 300 * sst;
    await page.evaluate(`(() => { window.__F.s = ${s}; window.__F.step(1 / 60); window.__F.draw(); })()`);
    if (list.includes(f)) {
      await grab(`${dir}/${String(f - Math.round(EDGE.slideStart * 60)).padStart(4, '0')}.png`);
      k++;
    }
  }
  void P;
  console.log(`edge: ${k} frames`);
}

// ---------------------------------------------------------------- heap: the body outside the arena, at the camera's scale
{
  const dir = `${OUT}/heap`;
  mkdirSync(dir, { recursive: true });
  const list = probe
    ? [Math.round(84 * 60), Math.round(86.5 * 60), Math.round(88.9 * 60)]
    : frames(EDGE.pullStart, EDGE.pullEnd);
  const spine = heapSpine();
  for (const f of list) {
    const t = f / 60;
    const z = arenaZoom(t);
    const pts = spine.map(([x, y]) => {
      const [sx, sy] = toScreen(t, x, y);
      return [sx, sy, 62];
    });
    // the oracle's bundle (drawBundleF): 4 braided ropes of 4 strands each, at the heap's thickness × the camera's scale
    await page.evaluate(`(() => {
      const M = window.__M; const t = ${t.toFixed(4)}; window.__oT = t; M.setT(t); M.clr();
      // (capped: past ×2.2 the oracle's tube shading turns into flat panels; early in the pull-back the heap is barely
      // in the frame anyway)
      const K = ${Math.min(2.2, HEAP_THICK * z)};
      const P = ${JSON.stringify(pts)};
      const main = M.braidPaths(P, { n: 4, step: Math.max(2, 6 * Math.min(1, K)), br: (f) => (35 + 5 * Math.sin(f * 9 + t * 0.4)) * K,
        sr: (f, k) => (27 + 5 * Math.sin(f * 7 + k * 2 + t * 0.5) + 4 * Math.sin(f * 23 + k)) * K, twist: 0.02 / Math.max(0.2, K),
        writhe: 0.3, wob: 9 * K, sid: 10, phase: 0 }, t);
      main.forEach((path, k) => {
        const sub = M.braidPaths(M.asSpine(path), { n: 4, br: (f, S) => S.r * 0.5, sr: (f, j, S) => S.r * (0.5 + 0.1 * Math.sin(f * 17 + j * 2.1 + k)),
          twist: 0.05 / Math.max(0.2, K), writhe: 0.5, wob: 3 * K, sid: 100 + k * 3 }, t);
        sub.forEach((q, j) => M.drawPath(q, 100 + k * 3 + j, 0.1));
      });
      for (let k = 0; k < 5; k++) { const A = main[k % 4], B = main[(k + 1) % 4]; const i = Math.floor((k * 0.19 + 0.12) * A.length) % A.length;
        const pa = A[i], pb = B[Math.min(B.length - 1, i + 2)];
        if (pa && pb && Math.hypot(pa.p[0] - pb.p[0], pa.p[1] - pb.p[1]) < 90 * Math.max(1, K))
          M.slime([pa.p[0], pa.p[1], pa.p[2] + pa.r * 0.7], [pb.p[0], pb.p[1], pb.p[2] + pb.r * 0.7], (8 + k * 2) * Math.max(1, K), t, k * 13 + 3); }
      ${COMPOSE}; })()`);
    await grab(`${dir}/${String(f - Math.round(EDGE.pullStart * 60)).padStart(4, '0')}.png`);
  }
  console.log(`heap: ${list.length} frames`);
}

// ---------------------------------------------------------------- jaw: the head down its axis, closing over the lens
{
  const dir = `${OUT}/jaw`;
  mkdirSync(dir, { recursive: true });
  const list = probe
    ? [Math.round(89.3 * 60), Math.round(90.2 * 60), Math.round(90.7 * 60)]
    : frames(EDGE.wipeStart, EDGE.wipeEnd);
  for (const f of list) {
    const t = f / 60;
    const o = jawOpen(t);
    // the head down its axis, so big that at first its mouth is wider than the frame; it closes over the lens. What lies
    // deeper than its first ring of teeth (the gullet) is cut out: through it the scene is still seen, until it shuts.
    await page.evaluate(`(() => {
      const M = window.__M; const t = ${t.toFixed(4)}; window.__oT = t; M.setT(t); M.clr();
      const o = ${o.toFixed(4)};
      const Rh = 230 + o * 620; const gape = Math.max(0.02, 0.35 + o * 0.9);
      M.head([320, 180, 20], [0.0001, 0.0001, 1], Rh, t, { neckR: 60, open: 0.7 + o * 0.6, rs: 1, spinT: t * (2 + (1 - o) * 6), len: 0.6,
        roll: t * 0.4, gape, spread: 0, jit: 0, grind: 1 - o, pulse: 0 });
      ${COMPOSE};
      // the window: the oracle draws the gullet seen through the mouth with a depth bias of 3·Rh (ZBIAS while CLIP is set),
      // so whatever sits above 20 + 1.2·Rh in its depth buffer is the gullet: cut it out
      const ZB = M.zb(); const g = window.__fig.getContext('2d'); const im = g.getImageData(0, 0, 640, 360);
      const e = window.__emc.getContext('2d'); const em = e.getImageData(0, 0, 640, 360);
      const thr = 20 + Rh * 1.2;
      for (let i = 0; i < 640 * 360; i++) if (ZB[i] > thr) { im.data[i * 4 + 3] = 0; em.data[i * 4 + 3] = 0; }
      g.putImageData(im, 0, 0); e.putImageData(em, 0, 0); })()`);
    await grab(`${dir}/${String(f - Math.round(EDGE.wipeStart * 60)).padStart(4, '0')}.png`);
  }
  console.log(`jaw: ${list.length} frames`);
}

await browser.close();
await server.close();
