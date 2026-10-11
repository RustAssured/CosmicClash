import { LOGICAL_H, LOGICAL_W, makeLayer, rgba, type FrameFx, type RenderLayer } from '@/contracts';
import { createRenderer } from '@/render';
import { MouthCore, type MouthStepOut } from '@/combat/mouth/core';
import { MouthGeom } from '@/combat/mouth/geom';
import type { RenderLayerMouth } from '@/render/mouthPass';
import type { MouthMoveName } from '@/combat/mouth/tuning';

/**
 * The Mouth's look and feel on the real renderer (Gates 3B / 3C), driven by tools/mouth/parity.ts through window.__MOUTH__:
 * the crane (MouthCore) on the oracle's own arena (the 640×360 screen), laid out by MouthGeom and drawn by the GPU pass, the
 * same frames the oracle (mouth/reference/demos/mouth-LOCKED-full.html) draws for the same script.
 */

const canvas = document.getElementById('game') as HTMLCanvasElement;
const out = document.getElementById('out') as HTMLCanvasElement;
const renderer = createRenderer();
await renderer.init(canvas, { quality: 1, preserveDrawingBuffer: true, unified: true });
renderer.resize(LOGICAL_W, LOGICAL_H, 1);
renderer.setStage('mausoleum');

const ARENA = { minX: 0, maxX: LOGICAL_W, minY: 0, maxY: LOGICAL_H, restY: 180, softWall: 0 };
const noFx = (): FrameFx => ({
  shockwaves: [],
  lenses: [],
  impulses: [],
  flash: 0,
  aberration: 0,
  intensity: 0,
  timeScale: 1,
});
const bg = makeLayer('bg', 'screen', -50, LOGICAL_W, LOGICAL_H);
bg.pixels.fill(rgba(5, 4, 10, 255));
bg.version = 1;

let seed = 0x5a17c0de;
const rand = (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let core = new MouthCore({ arena: ARENA, rand });
const geom = new MouthGeom();
const back = makeLayer('mouth-back', 'screen', -0.9, 1, 1) as RenderLayerMouth;
const front = makeLayer('mouth-front', 'screen', 0.5, 1, 1) as RenderLayerMouth;
back.mouth = { list: geom.list, back: true };
front.mouth = { list: geom.list, back: false };
const so: MouthStepOut = { impact: null, coiling: false, ended: false };

interface Script {
  /** Anchor arc length (the oracle's s); default PER − H/2 (left wall, middle). */
  s?: number;
  /** Opponent position (the oracle's opp). */
  opp?: [number, number];
  /** Frames to step after the oracle's 30 warm-up steps. */
  frames?: number;
  /** Strikes: [frame, move, height −1 / 0 / +1]. */
  begin?: [number, MouthMoveName, number][];
  /** Slide input per frame range: [from, to, value]. */
  slide?: [number, number, number][];
  /** Hits: [frame, part, power]. */
  hits?: [number, 'head' | 'neck' | 'coil', number][];
  /** Knock out at this frame (with `sever`: three strands cut first, the severed end). */
  ko?: number;
  sever?: boolean;
  sky?: number;
  tell?: boolean;
  /** 'black' backdrop (parity) or the stage. */
  backdrop?: 'black' | 'stage';
  /** Coil & crush grabs (a stand-in foe of this core radius at opp); null = whiff. */
  grab?: number | null;
}

function run(sc: Script): void {
  seed = 0x5a17c0de;
  core = new MouthCore({ arena: ARENA, rand });
  const per = core.per;
  core.s = sc.s ?? per - LOGICAL_H * 0.5;
  const opp = sc.opp ?? [470, 170];
  core.oppX = opp[0];
  core.oppY = opp[1];
  core.oppR = sc.grab ?? 40;
  core.grabCheck = sc.grab === undefined || sc.grab === null ? null : () => true;
  // the oracle's start: head at (300, 180), the neck laid on its first step, 30 warm-up steps
  core.hdX = 300;
  core.hdY = 180;
  for (let k = 0; k < 30; k++) core.step(1 / 60, so);
  const n = sc.frames ?? 1;
  for (let f = 0; f < n; f++) {
    core.slideIn = 0;
    for (const [a, b, v] of sc.slide ?? []) if (f >= a && f < b) core.slideIn = v;
    for (const [fr, mv, v] of sc.begin ?? [])
      if (fr === f) {
        core.variant = v;
        core.begin(mv);
      }
    for (const [fr, part, p] of sc.hits ?? []) if (fr === f) core.hit(part, p, 0.5, 0);
    if (sc.ko === f) {
      if (sc.sever) {
        core.dmg.severF[0] = 0.5;
        core.dmg.severF[1] = 0.6;
        core.dmg.severF[2] = 0.45;
      }
      core.dmg.hp = 0;
      core.knockout();
    }
    core.step(1 / 60, so);
  }
}

function draw(sc: Script): void {
  geom.build(core, { sky: sc.sky ?? 0, tell: sc.tell ?? false });
  const layers: RenderLayer[] = sc.backdrop === 'stage' ? [back, front] : [bg, back, front];
  for (let k = 0; k < 2; k++)
    renderer.draw({
      tick: 100,
      timeSec: core.t,
      alpha: 0,
      camera: { x: 320, y: 180, zoom: 1, roll: 0, shakeX: 0, shakeY: 0, dolly: 0, kickX: 0, kickY: 0 },
      view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
      stage: 'mausoleum',
      layers,
      ui: null,
      fx: noFx(),
    });
}

function png(): string {
  const px = renderer.captureLogical();
  out.width = LOGICAL_W;
  out.height = LOGICAL_H;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(LOGICAL_W, LOGICAL_H);
  for (let i = 0; i < px.length; i++) {
    const v = px[i]!;
    img.data[i * 4] = v & 255;
    img.data[i * 4 + 1] = (v >>> 8) & 255;
    img.data[i * 4 + 2] = (v >>> 16) & 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out.toDataURL('image/png');
}

(window as unknown as { __MOUTH__: unknown }).__MOUTH__ = {
  renderer,
  /** Run a script from the oracle's start and return the last frame as a PNG data URL. */
  shot(sc: Script): string {
    run(sc);
    draw(sc);
    return png();
  },
  /** The head, the exit and the neck after a script (feel parity: positions per frame). */
  trace(sc: Script & { every?: number }): number[][] {
    const rows: number[][] = [];
    const n = sc.frames ?? 1;
    const every = sc.every ?? 1;
    for (let f = every; f <= n; f += every) {
      run({ ...sc, frames: f });
      rows.push([f, core.hdX, core.hdY, core.I.Xx, core.I.Xy, core.s]);
    }
    return rows;
  },
  /**
   * Cost of the Mouth pass alone: draw `n` frames of a running scene, with and without the Mouth's layers, and report the
   * mean wall time per draw with a GPU sync (readPixels of one pixel) after each, plus the CPU layout time.
   */
  perf(
    sc: Script,
    n = 120,
  ): { withMs: number; withoutMs: number; layoutMs: number; tubes: number; stamps: number } {
    run(sc);
    const gl = (
      renderer as unknown as { three: { getContext(): WebGL2RenderingContext } }
    ).three.getContext();
    const px = new Uint8Array(4);
    const frame = (layers: RenderLayer[]): void =>
      renderer.draw({
        tick: 100,
        timeSec: core.t,
        alpha: 0,
        camera: { x: 320, y: 180, zoom: 1, roll: 0, shakeX: 0, shakeY: 0, dolly: 0, kickX: 0, kickY: 0 },
        view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
        stage: 'mausoleum',
        layers,
        ui: null,
        fx: noFx(),
      });
    let layout = 0;
    const time = (withMouth: boolean): number => {
      // warm
      for (let i = 0; i < 10; i++) frame(withMouth ? [bg, back, front] : [bg]);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        if (withMouth) {
          core.step(1 / 60, so);
          const a = performance.now();
          geom.build(core, { sky: 1, tell: true });
          layout += performance.now() - a;
        }
        frame(withMouth ? [bg, back, front] : [bg]);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / n;
    };
    const withoutMs = time(false);
    const withMs = time(true);
    return { withMs, withoutMs, layoutMs: layout / n, tubes: geom.list.nTubes, stamps: geom.list.nStamps };
  },
};
document.body.dataset.ready = '1';
