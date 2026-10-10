import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch } from '../../lead/browser';
import { startRenderServer } from '../../render/devserver';
import { arg } from '../common';
import { TWORK } from './paths';

/**
 * The Mouth for the trailer (TRAILER.md shots 6–7; it is not in the game yet): the LOCKED oracle
 * (mouth/reference/demos/mouth-LOCKED-full.html) driven headless and deterministic at its own 640×360, frame by frame.
 * Only its figure is kept (no space backdrop, no opponent stand-in, no floating rocks, no screen shake), turned into a
 * silhouette (its own pixels, darkened; the emissive teeth and wounds keep a dull glow) and written as transparent PNG
 * frames to composite ×3 nearest over a real fight. → press/trailer/work/mouth-<id>/0000.png …
 *   npx tsx tools/press/trailer/mouth.ts [--only=turn,lunge]
 */
interface MouthShot {
  id: string;
  frames: number;
  /** perimeter position of the body per frame (the oracle's `s`: bottom edge is W+H … 2W+H, right to left) */
  s: (f: number) => number;
  /** where the head looks / strikes (the fighter it has chosen), in 640×360 frame px */
  target: [number, number];
  /** frame to begin a bite at (−1 = never), and its height variant (−1 low, 0, 1 high) */
  bite: number;
  variant: number;
  /** silhouette darkness: 0 = black, 1 = the oracle's own colours */
  shade: number;
  warm: number;
}
const W = 640;
const H = 360;
const SHOTS: MouthShot[] = [
  {
    // shot 6: a coil slides in along the bottom edge; the head stays low, watching
    id: 'turn',
    frames: 480,
    s: (f) => W + H + 40 + 300 * sst(f / 480),
    target: [330, 200],
    bite: -1,
    variant: 0,
    shade: 0.26,
    warm: 0.35,
  },
  {
    // shot 7: the feeding end comes up over the edge and lunges; the edit cuts to black before it lands
    id: 'lunge',
    frames: 150,
    s: () => W + H + 340,
    target: [330, 170],
    bite: 70,
    variant: 1,
    shade: 0.28,
    warm: 0.5,
  },
];
function sst(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

const only = arg('only', '');
const SRC = 'mouth/reference/demos/mouth-LOCKED-full.html';
const patch = (html: string): string => {
  const rep = (from: string, to: string): void => {
    if (!html.includes(from)) throw new Error(`oracle patch point missing: ${from}`);
    html = html.replace(from, to);
  };
  rep('for(let y=Math.floor(opp.y-58);', 'if(window.__noOpp!==true)for(let y=Math.floor(opp.y-58);');
  rep('for(let k=0;k<6;k++){const r=rng(k*13+5);rock(', 'if(window.__noRocks!==true)for(let k=0;k<6;k++){const r=rng(k*13+5);rock(');
  rep('if(shake>.4){', 'if(shake>.4&&window.__noShake!==true){');
  // the prototype's readability aids (the red tell ring, the speed-echo rings) are UI, not the creature
  rep("if(move&&(lab==='load'||lab==='reach'))ringPx(", "if(window.__noTell!==true&&move&&(lab==='load'||lab==='reach'))ringPx(");
  rep('for(const q of trail)if(q.a>.3)ringPx(', 'for(const q of trail)if(window.__noTell!==true&&q.a>.3)ringPx(');
  rep("const cv=document.getElementById('cv'),gx=cv.getContext('2d');", "window.__fig=fig;window.__emc=emc;const cv=document.getElementById('cv'),gx=cv.getContext('2d');");
  rep(
    'window.__F={DMG,',
    'window.__F={setFight:v=>{fightBack=v;},setOppMoves:v=>{oppMoves=v;},setVariant:v=>{variant=v;},setSlide:v=>{slideIn=v;sv=0;},DMG,',
  );
  return html;
};

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const html = patch(readFileSync(SRC, 'utf8'));
  for (const m of SHOTS) {
    if (only && !only.split(',').includes(m.id)) continue;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => console.error(`[oracle pageerror] ${e.message}`));
    // deterministic: no real-time loop, a seeded Math.random, the patched oracle
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
    await page.route('**/mouth-oracle.html', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(`${url}/mouth-oracle.html`);
    await page.waitForFunction(() => (window as unknown as { __F?: unknown }).__F !== undefined);
    const dir = `${TWORK}/mouth-${m.id}`;
    mkdirSync(dir, { recursive: true });
    await page.evaluate(
      ([tx, ty, v]) => {
        const F = (window as unknown as { __F: Record<string, (...a: unknown[]) => unknown> & { opp: { x: number; y: number; vx: number; vy: number } } }).__F;
        F.setFight!(false);
        F.setOppMoves!(false);
        F.setVariant!(v);
        F.setSlide!(0);
        Object.assign(F.opp, { x: tx, y: ty, vx: 0, vy: 0 });
      },
      [m.target[0], m.target[1], m.variant] as const,
    );
    for (let f = 0; f < m.frames; f++) {
      const b64 = (await page.evaluate(
        ([s, bite]) => {
          const w = window as unknown as {
            __F: { step(dt: number): void; draw(): void; begin(n: string): void; s: number };
            __fig: HTMLCanvasElement;
            __emc: HTMLCanvasElement;
          };
          w.__F.s = s;
          if (bite) w.__F.begin('bite');
          w.__F.step(1 / 60);
          w.__F.draw();
          const a = w.__fig.getContext('2d')!.getImageData(0, 0, 640, 360).data;
          const e = w.__emc.getContext('2d')!.getImageData(0, 0, 640, 360).data;
          const both = new Uint8Array(a.length * 2);
          both.set(a, 0);
          both.set(e, a.length);
          let out = '';
          for (let i = 0; i < both.length; i += 0x8000) out += String.fromCharCode(...both.subarray(i, i + 0x8000));
          return btoa(out);
        },
        [m.s(f), f === m.bite] as const,
      )) as string;
      const buf = Buffer.from(b64, 'base64');
      const n = W * H * 4;
      const png = new PNG({ width: W, height: H });
      for (let i = 0; i < n; i += 4) {
        const al = buf[i + 3]!;
        const ea = buf[n + i + 3]!;
        if (!al && !ea) continue;
        // silhouette: the oracle's own colours pulled toward black, a warm cast kept; emissive pixels glow through dimly
        const k = m.shade;
        let r = buf[i]! * k * (1 + m.warm);
        let g = buf[i + 1]! * k;
        let b = buf[i + 2]! * k * (1 + m.warm * 0.4);
        if (ea) {
          const q = (ea / 255) * 0.55;
          r += buf[n + i]! * q;
          g += buf[n + i + 1]! * q;
          b += buf[n + i + 2]! * q;
        }
        png.data[i] = Math.min(255, Math.round(r));
        png.data[i + 1] = Math.min(255, Math.round(g));
        png.data[i + 2] = Math.min(255, Math.round(b));
        png.data[i + 3] = Math.max(al, ea);
      }
      writeFileSync(`${dir}/${String(f).padStart(4, '0')}.png`, PNG.sync.write(png));
    }
    await page.close();
    console.log(`mouth ${m.id}: ${m.frames} frames → ${dir}`);
  }
} finally {
  await browser.close();
  await server.close();
}
