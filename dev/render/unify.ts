import {
  LOGICAL_H,
  LOGICAL_W,
  makeLayer,
  rgba,
  type FrameFx,
  type MatchApi,
  type MatchConfig,
  type RenderFrame,
  type RenderLayer,
  type StageId,
} from '@/contracts';
import { createAI } from '@/ai';
import { FxState } from '@/app/fx';
import { createFighter } from '@/combat';
import { cameraTargetOf, createCamera } from '@/engine';
import { createMatterWorld } from '@/matter';
import { createRenderer } from '@/render';
import { TITAN_SKY } from '@/render/unified';
import { VFX_WEIGHT_NAMES, type FrameFxVfx, type VfxImpact, type VfxWeight } from '@/render/vfx';
import { createAiSource, createMatch } from '@/sim';
import { STAGES } from '@/stages';
import { getTitanDef, witnessDef } from '@/titans';

/**
 * Gate 1 captures of the unified look (shared/UNIFICATION.md, VFX_SPEC.md), driven by tools/render/unify-capture.ts through
 * window.__UNIFY__:
 *  - `weightsSheet()`: the four VFX weights on a neutral background, frame by frame (one row per weight);
 *  - `weightsAt(frame)`: one frame of all four weights (the clip plays this in real time);
 *  - `fight(stage, unified, ticks)`: the Witness vs the Planet in a real AI match, `ticks` after the intro, drawn before / after.
 */

const canvas = document.getElementById('game') as HTMLCanvasElement;
const out = document.getElementById('out') as HTMLCanvasElement;
const renderer = createRenderer();
await renderer.init(canvas, { quality: 1, preserveDrawingBuffer: true, unified: true });
renderer.resize(LOGICAL_W, LOGICAL_H, 1);

const noFx = (): FrameFx => ({
  shockwaves: [],
  lenses: [],
  impulses: [],
  flash: 0,
  aberration: 0,
  intensity: 0.2,
  timeScale: 1,
});

/* ----------------------------------------- the VFX weights ----------------------------------------- */

/** Neutral background: flat mid grey with a faint 16 px grid (so the distortion ring shows what it bends). */
function neutralLayer(): RenderLayer {
  const l = makeLayer('neutral', 'screen', -50, LOGICAL_W, LOGICAL_H);
  const base = rgba(0x3b, 0x3b, 0x42, 255);
  const line = rgba(0x4d, 0x4c, 0x53, 255);
  for (let y = 0; y < LOGICAL_H; y++)
    for (let x = 0; x < LOGICAL_W; x++)
      l.pixels[y * LOGICAL_W + x] = x % 16 === 0 || y % 16 === 0 ? line : base;
  return l;
}
const neutral = neutralLayer();
const WX = [80, 240, 400, 560];
const WY = 180;

/** All four weights side by side (only < 0), or one weight alone in the middle of the frame (away from the vignette). */
function weightsFrame(frame: number, only = -1): RenderFrame {
  const fx = noFx() as FrameFxVfx;
  const vfx: VfxImpact[] = [];
  for (let w = 0; w < 4; w++) {
    if (only >= 0 && w !== only) continue;
    const x = only >= 0 ? 320 : WX[w]!;
    vfx.push({
      x,
      y: WY,
      weight: w as VfxWeight,
      age: frame / 60,
      dirX: 1,
      dirY: 0.3,
      seed: 1234 + w * 77,
      matter: 'rock',
    });
  }
  fx.vfx = vfx;
  return {
    tick: 1000 + frame,
    timeSec: 5,
    alpha: 0,
    camera: { x: 320, y: 180, zoom: 1, roll: 0, shakeX: 0, shakeY: 0, dolly: 0, kickX: 0, kickY: 0 },
    view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
    stage: 'tussenruimte',
    layers: [neutral],
    ui: null,
    fx,
  };
}

function drawLogical(
  px: Uint32Array,
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  k: number,
): void {
  const img = ctx.createImageData(sw * k, sh * k);
  for (let y = 0; y < sh * k; y++)
    for (let x = 0; x < sw * k; x++) {
      const v = px[(sy + Math.floor(y / k)) * LOGICAL_W + sx + Math.floor(x / k)] ?? 0;
      const o = (y * sw * k + x) * 4;
      img.data[o] = v & 255;
      img.data[o + 1] = (v >>> 8) & 255;
      img.data[o + 2] = (v >>> 16) & 255;
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, dx, dy);
}

const FRAMES = [0, 1, 2, 3, 4, 5, 7, 10, 14, 20, 40, 90, 150];

/** All four weights, frame by frame: one row per weight, 120×120 crops at ×2. Returns a PNG data URL. */
function weightsSheet(): string {
  renderer.setStage('tussenruimte');
  const C = 120;
  const K = 2;
  const label = 18;
  out.width = FRAMES.length * C * K;
  out.height = 4 * (C * K + label) + label;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.font = '14px monospace';
  ctx.fillStyle = '#cfe';
  FRAMES.forEach((f, i) => ctx.fillText(`f${f}`, i * C * K + 4, 14));
  for (const f of FRAMES) {
    for (let w = 0; w < 4; w++) {
      renderer.draw(weightsFrame(f, w));
      const px = renderer.captureLogical();
      const y = label + w * (C * K + label);
      if (f === 0) {
        ctx.fillStyle = '#cfe';
        ctx.fillText(VFX_WEIGHT_NAMES[w]!, 4, y + 14);
      }
      drawLogical(px, ctx, 320 - C / 2, WY - C / 2, C, C, FRAMES.indexOf(f) * C * K, y + label, K);
    }
  }
  return out.toDataURL('image/png');
}

function weightsAt(frame: number): void {
  renderer.draw(weightsFrame(frame));
}

/* ------------------------------------------ the two titans ------------------------------------------ */

function newMatch(stage: StageId, sky: boolean, seed: number): MatchApi {
  const cfg: MatchConfig = {
    seed,
    stage,
    mode: 'aivai',
    footwork: 'orbit',
    witness: true,
    slots: [
      { titan: 'lastone', controller: 'ai', aiLevel: 4 },
      { titan: 'planet', controller: 'ai', aiLevel: 4 },
    ],
  };
  const st = STAGES[stage];
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: st.arena,
    lighting: sky ? TITAN_SKY : st.lighting,
  });
  m.setSources(
    createAiSource(m, 0, createAI(4, witnessDef(getTitanDef('lastone')), seed * 7, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(4, getTitanDef('planet'), seed * 7 + 1, { footwork: 'orbit' })),
  );
  return m;
}

/** A real match, `ticks` sim ticks in, drawn on `stage` through the unified path or the classic one. Returns a PNG data URL. */
function fight(stage: StageId, unified: boolean, ticks: number, seed = 21): string {
  renderer.debugSetUnified(unified);
  renderer.setStage(stage);
  const m = newMatch(stage, unified, seed);
  const fx = new FxState();
  const cam = createCamera();
  cam.reset(m.fighters[0].view.x, m.fighters[0].view.y);
  for (let i = 0; i < ticks; i++) {
    m.step();
    fx.tick(m.events, m);
    cam.tick(
      { a: cameraTargetOf(m.fighters[0].view), b: cameraTargetOf(m.fighters[1].view), arena: m.arena },
      m.events,
    );
  }
  const c = cam.sample(0);
  const layers: RenderLayer[] = [];
  for (const f of m.fighters) layers.push(...f.renderLayers(c.view, 0));
  layers.push(...m.world.renderLayers(c.view, 0));
  // two frames: the second one has settled every per-frame state (governor, halo blur)
  for (let k = 0; k < 2; k++)
    renderer.draw({
      tick: m.tick,
      timeSec: ticks / 60,
      alpha: 0,
      camera: c.state,
      view: c.view,
      stage,
      layers,
      ui: null,
      fx: fx.sample(0),
    });
  return canvasPng();
}

/**
 * GPU cost (RENDERING.md budgets): a real match on `stage` at 1920×1080, `frames` frames drawn one per animation frame while the
 * match runs, in three variants — background only, background + both titans (+ their matter layers), and the same with a
 * stream of catastrophic VFX. Returns the p50 / p90 GPU ms of each (renderer timer query).
 */
async function perf(
  stage: StageId,
  unified: boolean,
  frames = 150,
): Promise<Record<string, [number, number]>> {
  renderer.debugSetUnified(unified);
  renderer.setStage(stage);
  canvas.width = 1920;
  canvas.height = 1080;
  renderer.resize(1920, 1080, 1);
  const m = newMatch(stage, unified, 21);
  const fx = new FxState();
  const cam = createCamera();
  cam.reset(m.fighters[0].view.x, m.fighters[0].view.y);
  for (let i = 0; i < 300; i++) {
    m.step();
    fx.tick(m.events, m);
    cam.tick(
      { a: cameraTargetOf(m.fighters[0].view), b: cameraTargetOf(m.fighters[1].view), arena: m.arena },
      m.events,
    );
  }
  const res: Record<string, [number, number]> = {};
  for (const mode of ['background', 'titans', 'titans+vfx'] as const) {
    const ms: number[] = [];
    for (let i = 0; i < frames; i++) {
      m.step();
      fx.tick(m.events, m);
      cam.tick(
        { a: cameraTargetOf(m.fighters[0].view), b: cameraTargetOf(m.fighters[1].view), arena: m.arena },
        m.events,
      );
      const c = cam.sample(0);
      const layers: RenderLayer[] = [];
      if (mode !== 'background') {
        for (const f of m.fighters) layers.push(...f.renderLayers(c.view, 0));
        layers.push(...m.world.renderLayers(c.view, 0));
      }
      const f = fx.sample(0) as FrameFxVfx;
      if (mode === 'titans+vfx') {
        // four impacts always in flight: a catastrophic, a heavy, a medium and a light blow at staggered ages
        f.vfx = [0, 1, 2, 3].map((w) => ({
          x: c.view.x0 + 200 + w * 80,
          y: c.view.y0 + 180,
          weight: (3 - w) as VfxWeight,
          age: ((i + w * 20) % 90) / 60,
          dirX: 1,
          dirY: 0,
          seed: w * 11 + 1,
          matter: 'rock' as const,
        }));
      }
      renderer.draw({
        tick: m.tick,
        timeSec: m.tick / 60,
        alpha: 0,
        camera: c.state,
        view: c.view,
        stage,
        layers,
        ui: null,
        fx: f,
      });
      await new Promise((r) => requestAnimationFrame(r));
      const g = renderer.stats.gpuMs;
      if (i > 20 && g !== null) ms.push(g);
    }
    ms.sort((a, b) => a - b);
    const q = (p: number): number => +(ms[Math.floor(p * (ms.length - 1))] ?? -1).toFixed(2);
    res[mode] = [q(0.5), q(0.9)];
  }
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  renderer.resize(LOGICAL_W, LOGICAL_H, 1);
  return res;
}

function canvasPng(): string {
  const px = renderer.captureLogical();
  out.width = LOGICAL_W;
  out.height = LOGICAL_H;
  drawLogical(px, out.getContext('2d')!, 0, 0, LOGICAL_W, LOGICAL_H, 0, 0, 1);
  return out.toDataURL('image/png');
}

(window as unknown as { __UNIFY__: unknown }).__UNIFY__ = {
  renderer,
  weightsSheet,
  weightsAt,
  fight,
  perf,
  canvasPng,
};
document.body.dataset.ready = '1';
