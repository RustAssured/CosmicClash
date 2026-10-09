import {
  LOGICAL_H,
  LOGICAL_W,
  Rng,
  makeLayer,
  rgba,
  type BodyTransform,
  type CameraState,
  type FrameFx,
  type MatchApi,
  type RenderFrame,
  type SimEvent,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { WebGLRenderer } from 'three';
import { createRenderer, type DebuggableRenderer } from '@/render';
import { makeRT } from '@/render/gl';
import { GpuTimer } from '@/render/gpuTimer';
import { ANGLE_STEPS, rotRasterAt, rotRasterMode, type RotPart, type RotPartEx } from '@/render/rotsprite';
import { RotSpritePass } from '@/render/rotspritePass';
import { FxState } from '@/app/fx';
import { createMatch } from '@/sim';
import { fakeDeps } from '@/sim/testing/fakes';
import { makeRockBody } from './testSprites';
import { masterPalette, unifyStagePalette } from '@/render/master';
import { UNIFIED_LOOK } from '@/render/unified';
import type { FrameFxVfx } from '@/render/vfx';
import { STAGES } from '@/stages';

/** '#rrggbb' → the packed RGBA (alpha 255) captureLogical() returns. */
const hexToPacked = (h: string): number => {
  const v = parseInt(h.slice(1), 16);
  return rgba((v >> 16) & 255, (v >> 8) & 255, v & 255, 255) >>> 0;
};
import { contractCell, makePlacement, placeLayer, sourceCell } from '@/render/layerMap';

/**
 * GPU conformance checks for the renderer, run in a real WebGL2 context (headless Chromium/SwiftShader in CI):
 *   node tools/render/verify.mjs
 * Each check draws known layers over an opaque black backdrop and compares the composited frame, bit for bit, with a CPU
 * reference built from the contract (`space.ts`). Post effects are checked through `captureLogical()` by differences.
 */

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
const out = document.getElementById('out') as HTMLPreElement;
const log = (r: Result): void => {
  results.push(r);
  out.textContent += `\n${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`;
};
const check = (name: string, ok: boolean, detail = ''): void => log({ name, ok, detail });

const view: ViewRect = { x0: 300, y0: 100, w: LOGICAL_W, h: LOGICAL_H };
const cam = (over: Partial<CameraState> = {}): CameraState => ({
  x: 620,
  y: 280,
  zoom: 1,
  roll: 0,
  shakeX: 0,
  shakeY: 0,
  dolly: 0,
  kickX: 0,
  kickY: 0,
  ...over,
});
const noFx = (): FrameFx => ({
  shockwaves: [],
  lenses: [],
  impulses: [],
  flash: 0,
  aberration: 0,
  intensity: 0,
  timeScale: 1,
});
let tick = 0;
const frameOf = (layers: RenderLayer[], over: Partial<RenderFrame> = {}): RenderFrame => ({
  tick: ++tick,
  timeSec: 10,
  alpha: 0,
  camera: cam(),
  view,
  stage: 'tussenruimte',
  layers,
  ui: null,
  fx: noFx(),
  ...over,
});

const BLACK = rgba(0, 0, 0, 255);
function blackBackdrop(): RenderLayer {
  const l = makeLayer('bg', 'screen', -50, LOGICAL_W, LOGICAL_H);
  l.pixels.fill(BLACK);
  l.version = 1;
  return l;
}

/** A sprite whose every cell has a unique opaque colour so the source cell can be read back from the frame. */
function uniqueSprite(id: string, w: number, h: number): RenderLayer {
  const l = makeLayer(id, 'world', 0, w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) l.pixels[y * w + x] = rgba(x * 7 + 3, y * 5 + 3, 200, 255);
  l.version = 1;
  return l;
}

const maxDiff = (a: Uint32Array, b: Uint32Array): { max: number; count: number } => {
  let max = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    count++;
    for (let k = 0; k < 32; k += 8)
      max = Math.max(max, Math.abs(((a[i]! >>> k) & 255) - ((b[i]! >>> k) & 255)));
  }
  return { max, count };
};
const meanAbsDiff = (
  a: Uint32Array,
  b: Uint32Array,
  x0 = 0,
  y0 = 0,
  x1 = LOGICAL_W,
  y1 = LOGICAL_H,
): number => {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = a[y * LOGICAL_W + x]!;
      const q = b[y * LOGICAL_W + x]!;
      for (let k = 0; k < 24; k += 8) sum += Math.abs(((p >>> k) & 255) - ((q >>> k) & 255));
      n += 3;
    }
  return sum / n;
};

/** Mean relative luminance (Rec. 709 on linearised sRGB, 0..1) of a captured frame: the measure telemetry uses for flashes. */
const lin8 = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const meanLuminance = (a: Uint32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    s += 0.2126 * lin8(p & 255) + 0.7152 * lin8((p >>> 8) & 255) + 0.0722 * lin8((p >>> 16) & 255);
  }
  return s / a.length;
};
/** An impact light (D5) at a WORLD point. */
const impactLight = (
  x: number,
  y: number,
  radius: number,
  intensity: number,
  c: [number, number, number] = [1, 0.93, 0.82],
): NonNullable<FrameFx['lights']>[number] => ({
  x,
  y,
  radius,
  r: c[0],
  g: c[1],
  b: c[2],
  intensity,
  slot: -1,
  kind: 'impact',
});
/** The slice's renderer checks (D5 flashes, sprite push, governor): also runnable alone with `?only=d5`. */
async function sliceChecks(r: DebuggableRenderer, canvas: HTMLCanvasElement): Promise<void> {
  /* ---------- 10b. sprite push (push=1 A/B, D27): off = sprites 1:1 under zoom; on = sharp-bilinear resampling ---------- */
  {
    const bg = blackBackdrop();
    const A = rgba(210, 200, 60, 255);
    const B = rgba(30, 70, 140, 255);
    const chk = makeLayer('pushchk', 'screen', -10, LOGICAL_W, LOGICAL_H);
    for (let y = 0; y < LOGICAL_H; y++)
      for (let x = 0; x < LOGICAL_W; x++) chk.pixels[y * LOGICAL_W + x] = ((x >> 3) + (y >> 3)) & 1 ? A : B;
    chk.version = 1;
    const c2 = document.createElement('canvas');
    c2.width = canvas.width;
    c2.height = canvas.height;
    const ctx = c2.getContext('2d', { willReadFrequently: true })!;
    const grab = (): Uint8ClampedArray => {
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, c2.width, c2.height).data;
    };
    r.draw(frameOf([bg, chk], { tick: 1100 }));
    const flatPx = grab();
    const flatLogical = r.captureLogical();
    r.draw(frameOf([bg, chk], { tick: 1100, camera: cam({ zoom: 1.06 }) }));
    const zoomedOff = grab();
    let diffOff = 0;
    for (let i = 0; i < flatPx.length; i += 4 * 97) if (flatPx[i] !== zoomedOff[i]) diffOff++;
    check(
      'without push=1 a camera zoom never resamples the sprites (1:1 pixels)',
      diffOff === 0,
      `${diffOff} differ`,
    );
    r.debugSetSpritePush(true);
    r.draw(frameOf([bg, chk], { tick: 1100, camera: cam({ zoom: 1.08 }) }));
    const pushed = grab();
    r.debugSetSpritePush(false);
    let diffOn = 0;
    let clean = 0;
    let n = 0;
    const near = (i: number, c: number): boolean =>
      Math.max(
        Math.abs(pushed[i]! - (c & 255)),
        Math.abs(pushed[i + 1]! - ((c >>> 8) & 255)),
        Math.abs(pushed[i + 2]! - ((c >>> 16) & 255)),
      ) <= 14;
    const lay = r.debugLayout();
    const zoom = 1.08;
    for (let y = lay.y + 40; y < lay.y + lay.h - 40; y += 5)
      for (let x = lay.x + 40; x < lay.x + lay.w - 40; x += 5) {
        const i = (y * c2.width + x) * 4;
        n++;
        if (pushed[i] !== flatPx[i]) diffOn++;
        // the source pixel this canvas pixel shows under the push: unblended = that pixel's own colour
        const lx = Math.floor(LOGICAL_W / 2 + ((x - lay.x + 0.5) / lay.scale - LOGICAL_W / 2) / zoom);
        const ly = Math.floor(LOGICAL_H / 2 + ((y - lay.y + 0.5) / lay.scale - LOGICAL_H / 2) / zoom);
        if (near(i, flatLogical[ly * LOGICAL_W + lx]!)) clean++;
      }
    check(
      'push=1: zoom pushes the frame in with sharp-bilinear edges (pixels stay flat inside, ≥ 80 % unblended)',
      diffOn > n * 0.2 && clean / n >= 0.8,
      `${diffOn}/${n} moved, ${((100 * clean) / n).toFixed(1)} % unblended`,
    );
  }

  /* ---------- 10b2. camera dolly + kick move the SCENERY by depth; sprites stay 1:1 (D27) ---------- */
  {
    const body = makeRockBody('dolly-rock', 5);
    const rock = body.layer;
    Object.assign(rock, { x: 620, y: 280, prevX: 620, prevY: 280, anchorX: 64, anchorY: 64 });
    r.draw(frameOf([rock], { tick: 1400 }));
    const still = r.captureLogical();
    r.draw(frameOf([rock], { tick: 1400, camera: cam({ dolly: 1, kickX: 8, kickY: -4 }) }));
    const pushed = r.captureLogical();
    // sprite interior (opaque, ≥ 3 px from its edge): unchanged up to a few levels of glow spill
    const sx0 = 620 - 64 - view.x0;
    const sy0 = 280 - 64 - view.y0;
    const opaque = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < rock.w && y < rock.h && rock.pixels[y * rock.w + x]! >>> 24 === 255;
    let inside = 0;
    let moved = 0;
    for (let y = 3; y < rock.h - 3; y++)
      for (let x = 3; x < rock.w - 3; x++) {
        if (!(opaque(x, y) && opaque(x - 3, y) && opaque(x + 3, y) && opaque(x, y - 3) && opaque(x, y + 3)))
          continue;
        inside++;
        const i = (sy0 + y) * LOGICAL_W + sx0 + x;
        const a = still[i]!;
        const b = pushed[i]!;
        for (let k = 0; k < 24; k += 8) if (Math.abs(((a >>> k) & 255) - ((b >>> k) & 255)) > 3) moved++;
      }
    const scenery =
      meanAbsDiff(still, pushed, 0, 0, 200, 100) + meanAbsDiff(still, pushed, 460, 260, 640, 360);
    check(
      'camera dolly + kick move the scenery but never a sprite (sprites stay 1:1)',
      inside > 2000 && moved === 0 && scenery > 0.5,
      `${inside} interior sprite pixels, ${moved} channel changes > 3; scenery corners Δ ${scenery.toFixed(2)}`,
    );
  }

  /* ---------- 10f. the compositor draws RenderLayer.parts: GPU = CPU twin per part, mirrored by facing, emissive follows ---------- */
  {
    const bg = blackBackdrop();
    const aw = 64;
    const ah = 48;
    const atlas = makeLayer('rig', 'world', 0, aw, ah);
    atlas.emissive = new Uint8Array(aw * ah);
    for (let y = 0; y < ah; y++)
      for (let x = 0; x < aw; x++) {
        const inA = x < 30 && y < 40 && ((x - 15) / 14) ** 2 + ((y - 20) / 19) ** 2 < 1;
        const inB = x >= 32 && y < 20;
        if (inA) atlas.pixels[y * aw + x] = rgba(40 + x * 5, 90 + y * 3, 200, 255);
        if (inB) atlas.pixels[y * aw + x] = rgba(230, 200 - x, 60 + y * 4, 255);
        if (inA && x > 10 && x < 20 && y > 12 && y < 26) atlas.emissive[y * aw + x] = 255;
      }
    atlas.version = 1;
    atlas.facing = -1;
    atlas.parts = [
      { sx: 0, sy: 0, sw: 30, sh: 40, px: 15, py: 30, wx: view.x0 + 200, wy: view.y0 + 150, step: 37, z: 0 },
      { sx: 32, sy: 0, sw: 32, sh: 20, px: 4, py: 10, wx: view.x0 + 330, wy: view.y0 + 170, step: 211, z: 1 },
    ];
    r.draw(frameOf([bg, atlas], { tick: 1500 }));
    const col = r.debugReadFrame(0);
    const emis = r.debugReadFrame(1);
    let bad = 0;
    let drawn = 0;
    let glow = 0;
    for (const part of atlas.parts) {
      const sub = new Uint32Array(part.sw * part.sh);
      for (let y = 0; y < part.sh; y++)
        for (let x = 0; x < part.sw; x++)
          sub[y * part.sw + x] = atlas.pixels[(part.sy + y) * aw + part.sx + x]!;
      const cpu = rotRasterAt({
        pixels: sub,
        w: part.sw,
        h: part.sh,
        px: part.px,
        py: part.py,
        step: part.step,
        facing: -1,
      });
      for (let y = 0; y < cpu.h; y++)
        for (let x = 0; x < cpu.w; x++) {
          const want = cpu.pixels[y * cpu.w + x]! >>> 0;
          if (want === 0) continue;
          const X = part.wx - view.x0 - cpu.ox + x;
          const Y = part.wy - view.y0 - cpu.oy + y;
          drawn++;
          if (col[Y * LOGICAL_W + X]! >>> 0 !== want) bad++;
          if (emis[Y * LOGICAL_W + X]! & 0xffffff) glow++;
        }
    }
    check(
      'compositor parts: each RenderLayer part = the CPU twin pixel for pixel (rotated, mirrored by facing), emissive follows',
      drawn > 1000 && bad === 0 && glow > 50,
      `${drawn} part pixels, ${bad} differ, ${glow} emissive`,
    );
  }
  /* ---------- 10g. Shearfield comets (proposal 165): a tail behind and a dotted path ahead, in the comet's own place ---------- */
  {
    r.setStage('shearfield');
    r.draw(frameOf([], { tick: 1600, stage: 'shearfield' }));
    const plain = r.captureLogical();
    const fx: FrameFx = noFx();
    fx.comets = [{ x: view.x0 + 320, y: view.y0 + 180, vx: 260, vy: -60, r: 10 }];
    r.draw(frameOf([], { tick: 1600, stage: 'shearfield', fx }));
    const withComet = r.captureLogical();
    const tail = meanAbsDiff(plain, withComet, 320 - 70, 180 - 6, 320 - 10, 180 + 22);
    const ahead = meanAbsDiff(plain, withComet, 320 + 30, 180 - 30, 320 + 150, 180 + 4);
    const far = meanAbsDiff(plain, withComet, 20, 20, 120, 80);
    check(
      'Shearfield: an arena comet gets a bright tail behind it and a dotted path ahead, nothing elsewhere',
      tail > 4 && ahead > 0.3 && far < 0.2,
      `tail Δ ${tail.toFixed(1)}, path Δ ${ahead.toFixed(2)}, far Δ ${far.toFixed(2)}`,
    );
    // the warning (comet-warn): an entry point OFF screen to the left pins a glint to the left edge, pointing in
    fx.comets = [{ x: view.x0 - 40, y: view.y0 + 200, vx: 200, vy: -20, r: 0, warn: 0.8 }];
    r.draw(frameOf([], { tick: 1600, stage: 'shearfield', fx }));
    const warned = r.captureLogical();
    const edge = meanAbsDiff(plain, warned, 0, 190, 40, 210);
    const right = meanAbsDiff(plain, warned, 400, 20, 620, 340);
    check(
      'Shearfield: a comet warning shows a glint at the frame edge it will come through, nothing on the far side',
      edge > 3 && right < 0.2,
      `edge Δ ${edge.toFixed(1)}, far side Δ ${right.toFixed(2)}`,
    );
    r.setStage('tussenruimte');
  }
  /* ---------- 10h. the unified look (shared/UNIFICATION.md): palette snap, outline, highlight ceiling, VFX, lit parts ---------- */
  if (r.unified) {
    const mp = masterPalette();
    const masterSet = new Set(mp.colors.map((h) => hexToPacked(h)));
    const outline = hexToPacked(mp.colors[mp.ramps['outline']![0]!]!);
    const st = 'mausoleum' as const;
    r.setStage(st);
    const stageSet = new Set(unifyStagePalette(STAGES[st].palette).colors.map((h) => hexToPacked(h)));
    const body = makeRockBody('uni-rock', 99, 64, 'celadon');
    const bx = view.x0 + 320;
    const by = view.y0 + 180;
    Object.assign(body.layer, { x: bx, y: by, prevX: bx, prevY: by, version: body.layer.version + 1 });
    const fx = noFx() as FrameFxVfx;
    fx.vfx = [
      {
        x: view.x0 + 160,
        y: view.y0 + 120,
        weight: 3,
        age: 2 / 60,
        dirX: 1,
        dirY: 0,
        seed: 7,
        matter: 'rock',
      },
    ];
    r.draw(frameOf([body.layer], { tick: 1700, stage: st, fx }));
    const f = r.captureLogical();
    let off = 0;
    let figOff = 0;
    let figs = 0;
    const inBody = (x: number, y: number): boolean => {
      const lx = x + view.x0 - bx + body.layer.anchorX;
      const ly = y + view.y0 - by + body.layer.anchorY;
      return (
        lx >= 0 &&
        ly >= 0 &&
        lx < body.layer.w &&
        ly < body.layer.h &&
        body.layer.pixels[ly * body.layer.w + lx]! >>> 24 === 255
      );
    };
    for (let y = 0; y < LOGICAL_H; y++)
      for (let x = 0; x < LOGICAL_W; x++) {
        const c = f[y * LOGICAL_W + x]! >>> 0;
        if (!masterSet.has(c) && !stageSet.has(c)) off++;
        if (inBody(x, y)) {
          figs++;
          if (!masterSet.has(c)) figOff++;
        }
      }
    if (UNIFIED_LOOK.snapFinal)
      check(
        'unified: every frame pixel is a palette colour (stage ∪ master), every titan pixel a master colour',
        off === 0 && figOff === 0 && figs > 1000,
        `${off} off-palette pixels, ${figOff} of ${figs} titan pixels off the master palette`,
      );
    // the outline: the first empty pixel left of the silhouette on each row is the outline colour
    let rows = 0;
    let outlined = 0;
    const seen = new Set<string>();
    for (let y = 0; y < LOGICAL_H; y++) {
      let x0 = -1;
      for (let x = 1; x < LOGICAL_W; x++)
        if (inBody(x, y)) {
          x0 = x;
          break;
        }
      if (x0 < 2 || inBody(x0 - 1, y) || inBody(x0 - 1, y - 1) || inBody(x0 - 1, y + 1)) continue;
      rows++;
      const got = f[y * LOGICAL_W + x0 - 1]! >>> 0;
      // with the final snap the outline is the exact master colour; without it (D34) the post pass's vignette and grain move it
      // by a few levels: a near-black pixel
      const lum = 0.2126 * (got & 255) + 0.7152 * ((got >>> 8) & 255) + 0.0722 * ((got >>> 16) & 255);
      if (UNIFIED_LOOK.snapFinal ? got === outline : lum <= 14) outlined++;
      else seen.add(got.toString(16));
    }
    check(
      'unified: one dark outline pixel around a titan silhouette',
      rows > 20 && outlined === rows,
      `${outlined} of ${rows} rows outlined on the left edge${seen.size ? `; found ${[...seen].slice(0, 4).join(' ')} for ${outline.toString(16)}` : ''}`,
    );
    // the highlight ceiling: no non-glowing titan pixel takes a non-glowing ramp's top step
    const capped = new Set<number>();
    for (let i = 0; i < mp.colors.length; i++)
      if (mp.ceiling[i] !== i) capped.add(hexToPacked(mp.colors[i]!));
    let tops = 0;
    for (let y = 0; y < LOGICAL_H; y++)
      for (let x = 0; x < LOGICAL_W; x++) if (inBody(x, y) && capped.has(f[y * LOGICAL_W + x]! >>> 0)) tops++;
    if (UNIFIED_LOOK.ceiling && UNIFIED_LOOK.snapFinal)
      check(
        'unified: stone / bone / metal never reach the top step (highlight ceiling)',
        tops === 0,
        `${tops} capped colours on the body`,
      );

    // the VFX weights: a local stepped star (never a disc), growing with the weight, no full-frame wash (D5)
    const bg = blackBackdrop();
    const meanLum = (px: Uint32Array): number => {
      let s = 0;
      for (const p of px) {
        const lin = (v: number): number => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        s += 0.2126 * lin(p & 255) + 0.7152 * lin((p >>> 8) & 255) + 0.0722 * lin((p >>> 16) & 255);
      }
      return s / px.length;
    };
    r.draw(frameOf([bg], { tick: 1710 }));
    const dark = r.captureLogical();
    const L0 = meanLum(dark);
    const radii: number[] = [];
    let spiky = true;
    let wash = 0;
    for (let w = 0; w < 4; w++) {
      const fw = noFx() as FrameFxVfx;
      fw.vfx = [
        {
          x: view.x0 + 320,
          y: view.y0 + 180,
          weight: w as 0 | 1 | 2 | 3,
          age: 2 / 60,
          dirX: 1,
          dirY: 0,
          seed: 3,
          matter: 'rock',
        },
      ];
      r.draw(frameOf([bg], { tick: 1711 + w, fx: fw }));
      const g = r.captureLogical();
      wash = Math.max(wash, meanLum(g) - L0);
      // the star's extent per direction (16 rays from the centre: brightest pixels only)
      const ext: number[] = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        let last = 0;
        for (let d = 0; d < 40; d++) {
          const x = Math.round(320 + Math.cos(a) * d);
          const y = Math.round(180 + Math.sin(a) * d);
          const p = g[y * LOGICAL_W + x]! >>> 0;
          if (((p & 255) + ((p >>> 8) & 255)) / 2 > 150) last = d;
        }
        ext.push(last);
      }
      radii.push(Math.max(...ext));
      if (w >= 1 && Math.max(...ext) < 1.4 * Math.min(...ext.map((e) => Math.max(e, 1)))) spiky = false;
    }
    check(
      'VFX: the four weights grow, the core flash is a star with angular spikes (not a disc), no full-frame wash (D5)',
      radii[1]! > radii[0]! && radii[2]! > radii[1]! && radii[3]! > radii[2]! && spiky && wash < 0.05,
      `flash reach ${radii.join(' / ')} px, frame luminance rise ${wash.toFixed(4)}`,
    );

    // D34: a screen-wide flash lifts the whole frame at full spectacle and does nothing in comfort mode (D5)
    {
      const washLum = (comfort: number): { mean: number; corner: number } => {
        r.setComfort(comfort);
        const fw = noFx() as FrameFxVfx;
        fw.wash = { r: 1, g: 0.96, b: 0.88, a: 0.32, x: view.x0 + 320, y: view.y0 + 180 };
        r.draw(frameOf([bg], { tick: 1730, fx: fw }));
        const px = r.captureLogical();
        // display-space (as seen) mean luma and the far corner's, 0..1
        const luma = (p: number): number =>
          (0.2126 * (p & 255) + 0.7152 * ((p >>> 8) & 255) + 0.0722 * ((p >>> 16) & 255)) / 255;
        let s = 0;
        for (const p of px) s += luma(p);
        return { mean: s / px.length, corner: luma(px[8 * LOGICAL_W + 8]!) };
      };
      r.debugSetGovernor(false);
      const base = washLum(1);
      r.draw(frameOf([bg], { tick: 1731 }));
      const off = (() => {
        const px = r.captureLogical();
        let s = 0;
        for (const p of px)
          s += (0.2126 * (p & 255) + 0.7152 * ((p >>> 8) & 255) + 0.0722 * ((p >>> 16) & 255)) / 255;
        return s / px.length;
      })();
      const comfortMode = washLum(0.5);
      r.setComfort(1);
      r.debugSetGovernor(true);
      check(
        'D34 spectacle: a catastrophic screen-wide flash lifts the whole frame (to its corners); comfort mode (D5) has none',
        base.mean - off > 0.1 && base.corner > 0.1 && comfortMode.mean - off < 0.002,
        `display luma rise ${(base.mean - off).toFixed(3)} (corner ${base.corner.toFixed(3)}) at full spectacle, ${(comfortMode.mean - off).toFixed(4)} in comfort mode`,
      );
    }

    // lit parts: identical to the painted atlas at rest, relit by the one sky as the part turns
    const aw = 24;
    const lit = makeLayer('lit', 'world', 0, aw, aw) as RenderLayer & { light?: Uint8Array };
    const plain = makeLayer('plain', 'world', 0, aw, aw);
    lit.light = new Uint8Array(aw * aw * 4);
    for (let i = 0; i < aw * aw; i++) {
      lit.pixels[i] = plain.pixels[i] = rgba(120, 120, 130, 255);
      // a face turned to screen-right, half form light
      lit.light[i * 4] = 128 + 120;
      lit.light[i * 4 + 1] = 128;
      lit.light[i * 4 + 2] = 0;
      lit.light[i * 4 + 3] = 128;
    }
    const meanAt = (l: RenderLayer, step: number): number => {
      l.version++;
      l.parts = [
        { sx: 0, sy: 0, sw: aw, sh: aw, px: 12, py: 12, wx: view.x0 + 320, wy: view.y0 + 180, step, z: 0 },
      ];
      r.draw(frameOf([bg, l], { tick: 1720 + step }));
      const c = r.debugReadFrame(0);
      let s = 0;
      for (let y = 174; y < 186; y++)
        for (let x = 314; x < 326; x++) s += (c[y * LOGICAL_W + x]! >>> 8) & 255;
      return s / 144;
    };
    const restLit = meanAt(lit, 0);
    const restPlain = meanAt(plain, 0);
    const half = ANGLE_STEPS / 2;
    const turnLit = meanAt(lit, half);
    const turnPlain = meanAt(plain, half);
    check(
      'lit parts: the painted look at rest, relit by the one sky when turned (wForm = 0.82·cos³θ)',
      Math.abs(restLit - restPlain) < 0.5 && turnLit < turnPlain * 0.85,
      `rest ${restLit.toFixed(1)} vs ${restPlain.toFixed(1)}; turned 180° ${turnLit.toFixed(1)} vs ${turnPlain.toFixed(1)}`,
    );
    r.setStage('tussenruimte');
  }

  /* ---------- 10e. rotation spike: GPU clean-edge sampler = CPU twin at EVERY quantised angle (dense grid), and its cost ---------- */
  {
    const glc = document.createElement('canvas');
    glc.width = 64;
    glc.height = 64;
    const three = new WebGLRenderer({ canvas: glc, antialias: false, alpha: true });
    const w = 48;
    const h = 70;
    const px = new Uint32Array(w * h);
    const rng = new Rng(77);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const blob = ((x - 24) / 22) ** 2 + ((y - 35) / 33) ** 2 < 1 && !((x - 30) ** 2 + (y - 20) ** 2 < 30);
        if (blob) px[y * w + x] = rgba(60 + ((x * 7) & 63), 120 + ((y * 5) & 63), 200, 255);
      }
    for (let i = 0; i < 40; i++) px[rng.int(w * h)] = rgba(250, 240, 120, 255); // speckles: the hardest case
    const pass = new RotSpritePass(256, 256);
    const part0: RotPart = { pixels: px, w, h, px: 21, py: 50, step: 0 };
    const tex = pass.texture(part0);
    const rt = makeRT(256, 256, { filter: 'nearest' });
    const bytes = new Uint8Array(256 * 256 * 4);
    let worst = 0;
    let mismatches = 0;
    let pixels = 0;
    for (let step = 0; step < ANGLE_STEPS; step++) {
      // proposal 161: alpha-first vote, and every other angle mirrored (facing −1)
      const part: RotPartEx = { ...part0, step, facing: step % 2 ? -1 : 1 };
      three.setRenderTarget(rt);
      three.setClearColor(0x000000, 0);
      three.clear(true, false, false);
      pass.draw(three, rt, [{ part, tex, qx: 128, qy: 128 }]);
      three.readRenderTargetPixels(rt, 0, 0, 256, 256, bytes);
      const got = new Uint32Array(bytes.buffer);
      const cpu = rotRasterAt(part);
      let bad = 0;
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) {
          const g = got[(255 - y) * 256 + x]! >>> 0;
          const lx = x - 128 + cpu.ox;
          const ly = y - 128 + cpu.oy;
          const want =
            lx >= 0 && ly >= 0 && lx < cpu.w && ly < cpu.h ? cpu.pixels[ly * cpu.w + lx]! >>> 0 : 0;
          pixels++;
          if ((g >>> 24 === 0 ? 0 : g) !== want) bad++;
        }
      mismatches += bad;
      worst = Math.max(worst, bad);
    }
    check(
      `rotation: GPU sampler = CPU twin (alpha-first vote, mirrored on odd steps), pixel for pixel, at all ${ANGLE_STEPS} angles`,
      mismatches === 0,
      `${mismatches} mismatching of ${pixels} pixels (worst angle ${worst})`,
    );
    // 10f. proposal 174: the 'majority4' mode (우리) — GPU = CPU twin at every angle, mirrored on odd steps
    {
      let bad4 = 0;
      let worst4 = 0;
      for (let step = 0; step < ANGLE_STEPS; step++) {
        const part: RotPartEx = { ...part0, step, facing: step % 2 ? -1 : 1 };
        three.setRenderTarget(rt);
        three.setClearColor(0x000000, 0);
        three.clear(true, false, false);
        pass.draw(three, rt, [{ part, tex, qx: 128, qy: 128, mode: 'majority4' }]);
        three.readRenderTargetPixels(rt, 0, 0, 256, 256, bytes);
        const got = new Uint32Array(bytes.buffer);
        const cpu = rotRasterMode(part, 'majority4');
        let bad = 0;
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            const g = got[(255 - y) * 256 + x]! >>> 0;
            const lx = x - 128 + cpu.ox;
            const ly = y - 128 + cpu.oy;
            const want =
              lx >= 0 && ly >= 0 && lx < cpu.w && ly < cpu.h ? cpu.pixels[ly * cpu.w + lx]! >>> 0 : 0;
            if ((g >>> 24 === 0 ? 0 : g) !== want) bad++;
          }
        bad4 += bad;
        worst4 = Math.max(worst4, bad);
      }
      check(
        `rotation: GPU majority4 sampler = CPU twin (proposal 174), pixel for pixel, at all ${ANGLE_STEPS} angles`,
        bad4 === 0,
        `${bad4} mismatching pixels (worst angle ${worst4})`,
      );
    }
    // cost: 24 parts (64×96, the size of a Witness arm segment) at random angles into a 640×360 target
    const big = new RotSpritePass(LOGICAL_W, LOGICAL_H);
    const pw = 64;
    const ph = 96;
    const ppx = new Uint32Array(pw * ph).fill(rgba(180, 200, 190, 255));
    const bigPart: RotPart = { pixels: ppx, w: pw, h: ph, px: 32, py: 80, step: 0 };
    const bigTex = big.texture(bigPart);
    const target = makeRT(LOGICAL_W, LOGICAL_H, { filter: 'nearest' });
    const parts = Array.from({ length: 24 }, (_, i) => ({
      part: { ...bigPart, step: rng.int(ANGLE_STEPS) },
      tex: bigTex,
      qx: 40 + ((i * 97) % 560),
      qy: 60 + ((i * 53) % 240),
    }));
    const gl = three.getContext() as WebGL2RenderingContext;
    const one = new Uint8Array(4);
    const time = (n: number): number => {
      const a = performance.now();
      for (let i = 0; i < n; i++) big.draw(three, target, parts);
      three.readRenderTargetPixels(target, 0, 0, 1, 1, one); // waits for the GPU
      gl.finish();
      return (performance.now() - a) / n;
    };
    time(5);
    const msWall = time(60);
    // GPU-only time from the timer query (Chromium on a real GPU), 20 frames in one query
    let msGpu: number | null = null;
    const timer = GpuTimer.create(gl);
    if (timer) {
      timer.begin();
      for (let i = 0; i < 20; i++) big.draw(three, target, parts);
      timer.end();
      for (let k = 0; k < 100 && msGpu === null; k++) {
        await new Promise((res) => setTimeout(res, 10));
        const v = timer.poll();
        if (v !== null) msGpu = v / 20;
      }
    }
    const c0 = performance.now();
    for (let i = 0; i < 24; i++) rotRasterAt({ ...bigPart, step: (i * 11) % ANGLE_STEPS });
    const msCpu = (performance.now() - c0) / 24;
    check(
      'rotation spike: cost of 24 rotated 64×96 parts per frame (GPU) and of one CPU-twin mask (64×96)',
      (msGpu ?? msWall) < 4,
      `GPU ${msGpu === null ? 'n/a' : msGpu.toFixed(3)} ms per frame of 24 parts (timer query), wall ${msWall.toFixed(2)} ms incl. read-back sync; CPU twin ${msCpu.toFixed(2)} ms per mask`,
    );
    pass.dispose();
    big.dispose();
    tex.dispose();
    bigTex.dispose();
    rt.dispose();
    target.dispose();
    three.dispose();
    three.forceContextLoss();
  }

  /* ---------- 10c. D5: a KO is local light + refraction, never a wash; the luminance governor caps the rest ---------- */
  {
    const rock = makeRockBody('ko-rock', 1).layer;
    Object.assign(rock, { x: 620, y: 280, prevX: 620, prevY: 280, anchorX: 64, anchorY: 64 });
    r.draw(frameOf([rock], { tick: 1200 }));
    const calm = r.captureLogical();
    const ko = noFx();
    ko.lights = [impactLight(620, 280, 200, 1.6, [0.62, 0.95, 0.88])];
    ko.aberration = 1;
    ko.shockwaves.push({ x: 620, y: 280, age: 0.15, radius: 140, strength: 1 });
    r.draw(frameOf([rock], { tick: 1200, fx: ko }));
    const koFrame = r.captureLogical();
    const dKo = Math.abs(meanLuminance(koFrame) - meanLuminance(calm));
    const corner = meanAbsDiff(calm, koFrame, 0, 0, 80, 60);
    check(
      'KO (impact light 1.6 + refraction + ring) changes full-frame mean luminance by ≤ 0.20, governor OFF',
      dKo <= 0.2 && corner < 1.5,
      `Δ mean ${dKo.toFixed(4)} (target ≤ 0.20), far-corner diff ${corner.toFixed(2)}`,
    );

    // Gate B: a blue KO light on the nursery's pink gas left a flat TEAL patch, and the old magnifying lens enlarged it.
    // The KO now brightens the gas in its own hue and ripples the image: no area may change hue.
    {
      r.setStage('nursery');
      r.draw(frameOf([], { tick: 1250, stage: 'nursery' }));
      const before = r.captureLogical();
      const ko2 = noFx();
      // the light alone (the ripple displaces pixels by design, which is not a tint)
      ko2.lights = [impactLight(620, 280, 130, 1.2, [0.55, 0.72, 1])];
      r.draw(frameOf([], { tick: 1250, stage: 'nursery', fx: ko2 }));
      const after = r.captureLogical();
      const hue = (p: number): number => {
        const R = p & 255;
        const G = (p >>> 8) & 255;
        const B = (p >>> 16) & 255;
        const mx = Math.max(R, G, B);
        const c = mx - Math.min(R, G, B);
        if (c < 30) return -1;
        const h = mx === R ? ((G - B) / c + 6) % 6 : mx === G ? (B - R) / c + 2 : (R - G) / c + 4;
        return h * 60;
      };
      let shifted = 0;
      let chromatic = 0;
      for (let y = 180 - 90; y < 180 + 90; y++)
        for (let x = 320 - 90; x < 320 + 90; x++) {
          const h0 = hue(before[y * LOGICAL_W + x]!);
          const h1 = hue(after[y * LOGICAL_W + x]!);
          chromatic++;
          if (h1 < 0) continue; // still neutral after the light: not a tint
          // tinted = pulled toward the LIGHT's own hue (≈ 205°, blue-teal) from somewhere else (brightening along a stage ramp
          // may move a hue — the nursery's ramps walk magenta → coral → amber — and that is the palette, not a tint)
          const dist = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
          // (a dark / neutral pixel turning blue-teal is exactly the Gate B patch: the dark dust column lit by the KO light)
          if (dist(h1, 205) < 35 && (h0 < 0 || dist(h0, 205) > 60)) shifted++;
        }
      const frac = shifted / Math.max(1, chromatic);
      check(
        'the KO light keeps the hue of the gas around the wound (no tinted area — the Gate B teal patch)',
        frac < 0.01,
        `${(100 * frac).toFixed(1)} % of ${chromatic} pixels within 90 px turned blue-teal (the light's hue)`,
      );
      r.setStage('tussenruimte');
    }
    // governor (comfort mode, D34: D5's limits are the comfort setting): a black frame, then the worst case — a full-frame white
    // emissive layer appears in one frame
    r.setComfort(0.5);
    r.debugSetGovernor(true);
    r.debugLumaReadback(true);
    r.drainLuma();
    const bg = blackBackdrop();
    const white = makeLayer('white', 'screen', -10, LOGICAL_W, LOGICAL_H);
    white.pixels.fill(rgba(255, 255, 255, 255));
    white.emissive = new Uint8Array(LOGICAL_W * LOGICAL_H).fill(255);
    white.version = 1;
    let ts = 20;
    const L: number[] = [];
    for (let i = 0; i < 30; i++) {
      ts += 1 / 60;
      r.draw(frameOf([bg], { tick: 1300, timeSec: ts }));
    }
    L.push(meanLuminance(r.captureLogical()));
    for (let i = 0; i < 90; i++) {
      ts += 1 / 60;
      r.draw(frameOf([bg, white], { tick: 1300, timeSec: ts }));
      L.push(meanLuminance(r.captureLogical()));
      // WebGL fences only update once control returns to the event loop (as between real frames)
      await new Promise((res) => setTimeout(res, 0));
    }
    let worst = 0;
    for (let i = 1; i < L.length; i++)
      for (let k = 1; k <= 6 && i - k >= 0; k++) worst = Math.max(worst, Math.abs(L[i]! - L[i - k]!));
    check(
      'governor (comfort mode): black → full-frame white emissive in one frame stays ≤ 0.20 change within 100 ms',
      worst <= 0.2 && L[L.length - 1]! > L[0]! + 0.3,
      `max Δ within 6 frames ${worst.toFixed(3)}, from ${L[0]!.toFixed(3)} to ${L[L.length - 1]!.toFixed(3)} after 1.5 s`,
    );
    r.setComfort(1);
    const samples = r.drainLuma();
    const health = r.debugLumaReadback(false);
    check(
      'governor: its mean luminance is read back asynchronously (stats.luma / drainLuma)',
      samples.length > 0 &&
        r.stats.luma !== null &&
        samples.some((s) => s.gain < 0.99) &&
        health.errors.length === 0,
      `${samples.length} samples (${health.skipped} skipped, collect ≤ ${health.pollMs.toFixed(2)} ms CPU), newest ${JSON.stringify(r.stats.luma)}${
        health.errors.length ? `, GL errors ${health.errors.join('; ')}` : ''
      }`,
    );
    r.debugSetGovernor(false);
  }
  /* ---------- 10d. D5 scripted fight on the brightest stage: heavy hits every 0.4 s, then a KO in slow motion ---------- */
  {
    r.setStage('nursery');
    const m = createMatch(
      {
        seed: 3,
        stage: 'nursery',
        mode: 'versus',
        slots: [
          { titan: 'lastone', controller: 'dummy' },
          { titan: 'planet', controller: 'dummy' },
        ],
      },
      fakeDeps(),
    );
    const v0 = m.fighters[0].view;
    const v1 = m.fighters[1].view;
    const mid = { x: (v0.x + v1.x) / 2, y: (v0.y + v1.y) / 2 };
    const fightView: ViewRect = {
      x0: Math.round(mid.x - 320),
      y0: Math.round(mid.y - 180),
      w: LOGICAL_W,
      h: LOGICAL_H,
    };
    const bodyA = makeRockBody('fA', 11, 110, 'celadon').layer;
    const bodyB = makeRockBody('fB', 12, 120, 'rock').layer;
    Object.assign(bodyA, { x: v0.x, y: v0.y, prevX: v0.x, prevY: v0.y, anchorX: 55, anchorY: 55 });
    Object.assign(bodyB, { x: v1.x, y: v1.y, prevX: v1.x, prevY: v1.y, anchorX: 60, anchorY: 60 });
    const run = (governor: boolean): { maxD: number; flashesPerSec: number } => {
      r.debugSetGovernor(governor);
      const fx = new FxState();
      let ts = 100;
      let acc = 0;
      let simTick = 0;
      let scale = 1;
      let slowLeft = 0;
      const L: number[] = [];
      for (let frame = 0; frame < 300; frame++) {
        acc += scale;
        while (acc >= 1) {
          acc -= 1;
          simTick++;
          const ev: SimEvent[] = [];
          const hx = v1.x - 30;
          if (simTick % 24 === 0 && simTick < 150)
            ev.push(
              {
                t: 'hit',
                attacker: 0,
                target: 1,
                titan: 'planet',
                x: hx,
                y: v1.y,
                dirX: 1,
                dirY: 0,
                type: 'FRACTURE',
                energy: 2600,
                cellsRemoved: 90,
                massRemoved: 40,
                blocked: 0,
                heavy: true,
                onDamaged: 0,
              },
              { t: 'shockwave', x: hx, y: v1.y, strength: 0.8, radius: 280, hue: 0.42 },
            );
          if (simTick === 150) {
            ev.push(
              { t: 'flash', amount: 0.7, x: hx, y: v1.y },
              { t: 'shockwave', x: hx, y: v1.y, strength: 1, radius: 240, hue: 0.1 },
              { t: 'ko', slot: 1, x: hx, y: v1.y },
            );
            scale = 0.3;
            slowLeft = 60;
          }
          const sm = Object.create(m, { timeScale: { value: scale } }) as MatchApi;
          fx.tick(ev, sm);
          if (slowLeft > 0 && --slowLeft === 0) scale = 1;
        }
        ts += 1 / 60;
        r.draw(
          frameOf([bodyA, bodyB], {
            tick: simTick,
            timeSec: ts,
            alpha: acc,
            view: fightView,
            stage: 'nursery',
            fx: fx.sample(acc),
          }),
        );
        L.push(meanLuminance(r.captureLogical()));
      }
      let maxD = 0;
      for (let i = 1; i < L.length; i++)
        for (let k = 1; k <= 6 && i - k >= 0; k++) maxD = Math.max(maxD, Math.abs(L[i]! - L[i - k]!));
      // WCAG-style opposing ≥ 0.1 transitions, as telemetry counts them
      const turns: number[] = [];
      let dir = 0;
      let anchor = L[0]!;
      for (let i = 1; i < L.length; i++) {
        const d = L[i]! - anchor;
        if (Math.abs(d) >= 0.1 && Math.min(L[i]!, anchor) < 0.8) {
          if (Math.sign(d) !== dir) {
            turns.push(i);
            dir = Math.sign(d);
          }
          anchor = L[i]!;
        } else if ((dir > 0 && L[i]! > anchor) || (dir < 0 && L[i]! < anchor)) anchor = L[i]!;
      }
      let perSec = 0;
      for (let i = 0; i < turns.length; i++) {
        let n = 0;
        for (let j = i; j < turns.length && turns[j]! - turns[i]! < 60; j++) n++;
        perSec = Math.max(perSec, Math.floor(n / 2));
      }
      return { maxD, flashesPerSec: perSec };
    };
    const bare = run(false);
    const governed = run(true);
    check(
      'D5 scripted fight (nursery, 6 heavy hits + KO in slow motion): max Δ mean luminance within 100 ms ≤ 0.20, ≤ 3 flashes/s',
      bare.maxD <= 0.2 && governed.maxD <= 0.2 && governed.flashesPerSec <= 3,
      `governor off ${bare.maxD.toFixed(3)} (${bare.flashesPerSec}/s), on ${governed.maxD.toFixed(3)} (${governed.flashesPerSec}/s); Gate A baseline 0.32`,
    );
    r.debugSetGovernor(false);
    r.setStage('tussenruimte');
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const r = createRenderer();
  await r.init(canvas, { quality: 0, preserveDrawingBuffer: true });
  r.setStage('tussenruimte');
  r.resize(1280, 720, 1);
  // conformance checks compare frame pairs bit for bit: the luminance governor (its own section) must not adapt between them
  r.debugSetGovernor(false);
  const ref = { x: 0, y: 0 };

  if (new URLSearchParams(location.search).get('only') === 'd5') {
    await sliceChecks(r, canvas);
    finish(r);
    return;
  }

  // `?only=stages` skips the long conformance sections and runs just the per-stage checks (readability, distinctness): a quick loop while tuning scenery.
  const onlyStages = new URLSearchParams(location.search).get('only') === 'stages';
  if (!onlyStages) {
    /* ---------- 1. mirror + row shear + placement match the contract, pixel for pixel ---------- */
    {
      const rng = new Rng(2024);
      let worst = 0;
      let bad = 0;
      const p = makePlacement();
      for (let trial = 0; trial < 14; trial++) {
        const w = rng.intRange(24, 90);
        const h = rng.intRange(24, 90);
        const t: BodyTransform = {
          x: rng.intRange(360, 800),
          y: rng.intRange(180, 360),
          anchorX: rng.intRange(0, w),
          anchorY: rng.intRange(1, h),
          facing: rng.chance(0.5) ? 1 : -1,
          lean: rng.intRange(-12, 12),
        };
        const sprite = uniqueSprite('s', w, h);
        Object.assign(sprite, {
          x: t.x,
          y: t.y,
          prevX: t.x,
          prevY: t.y,
          anchorX: t.anchorX,
          anchorY: t.anchorY,
          facing: t.facing,
          lean: t.lean,
        });
        const bg = blackBackdrop();
        r.draw(frameOf([bg, sprite]));
        const got = r.debugReadFrame(0);
        // CPU reference straight from the contract
        const want = new Uint32Array(LOGICAL_W * LOGICAL_H).fill(BLACK);
        placeLayer(sprite, view, 0, p);
        const tw: BodyTransform = { ...t, x: p.ax + view.x0, y: p.ay + view.y0 };
        for (let py = 0; py < LOGICAL_H; py++)
          for (let px = 0; px < LOGICAL_W; px++) {
            contractCell(tw, px + view.x0, py + view.y0, ref);
            if (ref.x >= 0 && ref.x < w && ref.y >= 0 && ref.y < h)
              want[py * LOGICAL_W + px] = sprite.pixels[ref.y * w + ref.x]!;
          }
        const d = maxDiff(got, want);
        worst = Math.max(worst, d.max);
        bad += d.count;
        // and the CPU twin used by the unit tests agrees with the contract on this transform too
        sourceCell(p, p.ax, p.ay, ref);
      }
      check(
        'layer mapping: facing / lean / anchor match contracts/space.ts exactly (14 random transforms)',
        bad === 0,
        `mismatching pixels ${bad}, worst channel diff ${worst}`,
      );
    }

    /* ---------- 2. integer positions: interpolation is snapped, never blurred ---------- */
    {
      const sprite = uniqueSprite('mover', 20, 20);
      Object.assign(sprite, { anchorX: 10, anchorY: 10, prevX: 500, x: 510, prevY: 300, y: 300 });
      const bg = blackBackdrop();
      const cols: number[] = [];
      for (const a of [0, 0.25, 0.5, 0.75]) {
        r.draw(frameOf([bg, sprite], { alpha: a }));
        const f = r.debugReadFrame(0);
        // the sprite's left edge column: first non-black pixel on the anchor row
        const row = 300 - view.y0;
        let c = -1;
        for (let x = 0; x < LOGICAL_W; x++)
          if (f[row * LOGICAL_W + x] !== BLACK) {
            c = x;
            break;
          }
        cols.push(c);
        // no partially covered pixels: every non-black pixel is one of the sprite's exact colours
        let blended = 0;
        for (let i = 0; i < f.length; i++) if (f[i] !== BLACK && !(((f[i]! >>> 16) & 255) === 200)) blended++;
        if (blended) cols.push(-999);
      }
      const expected = [0, 0.25, 0.5, 0.75].map((a) => Math.round(500 + 10 * a) - 10 - view.x0);
      check(
        'layer placement: interpolated position snaps to whole pixels (no sub-pixel blur)',
        JSON.stringify(cols) === JSON.stringify(expected),
        `got ${cols.join(',')} want ${expected.join(',')}`,
      );
    }

    /* ---------- 3. alpha and additive blending ---------- */
    {
      const base = makeLayer('grey', 'screen', -40, LOGICAL_W, LOGICAL_H);
      base.pixels.fill(rgba(128, 128, 128, 255));
      base.version = 1;
      const half = makeLayer('half', 'screen', 0, LOGICAL_W, LOGICAL_H);
      half.pixels.fill(rgba(200, 40, 100, 255));
      half.alpha = 0.5;
      half.version = 1;
      const add = makeLayer('add', 'screen', 5, LOGICAL_W, LOGICAL_H);
      add.pixels.fill(rgba(60, 30, 20, 255));
      add.blend = 'add';
      add.version = 1;
      const bg = blackBackdrop();
      r.draw(frameOf([bg, base, half]));
      let px = r.debugReadFrame(0)[100 * LOGICAL_W + 100]!;
      const want = [(200 + 128) / 2, (40 + 128) / 2, (100 + 128) / 2];
      const got = [px & 255, (px >>> 8) & 255, (px >>> 16) & 255];
      check(
        'normal blend at alpha 0.5',
        got.every((v, i) => Math.abs(v - want[i]!) <= 2),
        `got ${got} want ${want}`,
      );
      half.alpha = 0;
      r.draw(frameOf([bg, base, half, add]));
      px = r.debugReadFrame(0)[100 * LOGICAL_W + 100]!;
      check(
        'additive blend adds',
        (px & 255) === 188 && ((px >>> 8) & 255) === 158 && ((px >>> 16) & 255) === 148,
        `got ${px & 255},${(px >>> 8) & 255},${(px >>> 16) & 255}`,
      );
    }

    /* ---------- 4. texture cache: dirty rects, unchanged layers, size changes ---------- */
    {
      const w = 64;
      const h = 64;
      const l = makeLayer('dirty', 'screen', 0, LOGICAL_W, LOGICAL_H);
      // a 64x64 region of interest in a screen layer: fill it with a gradient
      const fill = (x0: number, y0: number, x1: number, y1: number, c: number): void => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) l.pixels[y * LOGICAL_W + x] = c;
      };
      fill(0, 0, w, h, rgba(10, 200, 30, 255));
      l.version = 1;
      const bg = blackBackdrop();
      r.draw(frameOf([bg, l]));
      const s0 = r.debugLayerStats();
      // partial update: change a 8x8 block and bump the version with its rect
      fill(10, 12, 18, 20, rgba(250, 10, 10, 255));
      l.version = 2;
      l.dirty = { x0: 10, y0: 12, x1: 18, y1: 20 };
      r.draw(frameOf([bg, l]));
      const s1 = r.debugLayerStats();
      let f = r.debugReadFrame(0);
      check(
        'dirty rect upload: the changed block appears',
        f[14 * LOGICAL_W + 14] === rgba(250, 10, 10, 255) &&
          f[30 * LOGICAL_W + 30] === rgba(10, 200, 30, 255),
      );
      check(
        'dirty rect upload: only the rect was uploaded (not the whole 640x360 layer)',
        s1.rect === s0.rect + 1 && s1.texels - s0.texels === 64 && l.dirty === null,
        `uploaded ${s1.texels - s0.texels} texels, dirty=${JSON.stringify(l.dirty)}`,
      );
      // unchanged version: the CPU array changes but the renderer must not touch the GPU copy
      fill(30, 30, 40, 40, rgba(1, 2, 3, 255));
      r.draw(frameOf([bg, l]));
      const s2 = r.debugLayerStats();
      f = r.debugReadFrame(0);
      check(
        'unchanged layers are never re-uploaded (same version ⇒ GPU copy untouched)',
        s2.texels === s1.texels && f[35 * LOGICAL_W + 35] === rgba(10, 200, 30, 255),
      );
      // version bump without a rect ⇒ full upload picks the change up
      l.version = 3;
      r.draw(frameOf([bg, l]));
      f = r.debugReadFrame(0);
      check(
        'version bump with no dirty rect uploads the whole layer',
        f[35 * LOGICAL_W + 35] === rgba(1, 2, 3, 255),
      );
    }

    /* ---------- 5. stale textures are freed ---------- */
    {
      r.debugSetStaleFrames(2);
      const l = uniqueSprite('ephemeral', 16, 16);
      const bg = blackBackdrop();
      r.draw(frameOf([bg, l]));
      const before = r.debugLayerStats().cached;
      for (let i = 0; i < 10; i++) r.draw(frameOf([bg]));
      const after = r.debugLayerStats().cached;
      r.debugSetStaleFrames(240);
      check('layer textures not drawn for a while are freed', after < before, `cached ${before} → ${after}`);
    }

    /* ---------- 6. emissive feeds bloom, and only emissive pixels glow ---------- */
    {
      const bg = blackBackdrop();
      const glow = makeLayer('glow', 'world', 0, 12, 12);
      glow.pixels.fill(rgba(255, 220, 160, 255));
      glow.emissive = new Uint8Array(12 * 12).fill(255);
      Object.assign(glow, { anchorX: 6, anchorY: 6, x: 620, y: 280, prevX: 620, prevY: 280, version: 1 });
      const cold = makeLayer('cold', 'world', 0, 12, 12);
      cold.pixels.fill(rgba(255, 220, 160, 255));
      Object.assign(cold, { anchorX: 6, anchorY: 6, x: 620, y: 280, prevX: 620, prevY: 280, version: 1 });
      r.draw(frameOf([bg, cold]));
      const a = r.captureLogical();
      r.draw(frameOf([bg, glow], { tick: tick }));
      const b = r.captureLogical();
      const cx = 620 - view.x0;
      const cy = 280 - view.y0;
      // a halo appears around the emissive sprite (pixels 10–18 px away) but not around the cold one
      // (unified path: the shared bloom, σ 3 and 10 px, snapped to the palette — measured 6–14 px out)
      const halo = r.unified
        ? meanAbsDiff(a, b, cx + 6, cy - 4, cx + 14, cy + 4)
        : meanAbsDiff(a, b, cx + 10, cy - 4, cx + 18, cy + 4);
      check(
        'bloom: an emissive layer casts a glow into its surroundings',
        halo > 1.5,
        `mean halo lift ${halo.toFixed(2)}`,
      );
      const far = meanAbsDiff(a, b, 20, 20, 120, 100);
      check('bloom: the glow stays local', far < 0.6, `far field diff ${far.toFixed(3)}`);
    }

    /* ---------- 7. UI is composited crisp, after post, and never bloomed or aberrated ---------- */
    {
      const bg = blackBackdrop();
      const ui = makeLayer('ui', 'screen', 100, LOGICAL_W, LOGICAL_H);
      ui.emissive = new Uint8Array(LOGICAL_W * LOGICAL_H).fill(255); // must be ignored for UI
      const marker = rgba(240, 30, 200, 255);
      for (let y = 0; y < 6; y++) for (let x = 0; x < 9; x++) ui.pixels[y * LOGICAL_W + x] = marker;
      for (let y = 100; y < 130; y++)
        for (let x = 600; x < 630; x++) ui.pixels[y * LOGICAL_W + x] = rgba(255, 255, 255, 255);
      ui.version = 1;
      const fx = noFx();
      fx.flash = 1;
      fx.aberration = 1;
      r.draw(frameOf([bg], { ui, fx }));
      const cap = r.captureLogical();
      check(
        'UI: pixels are exact (top row first, no flash / aberration / bloom)',
        cap[0] === marker &&
          cap[5 * LOGICAL_W + 8] === marker &&
          cap[115 * LOGICAL_W + 615] === rgba(255, 255, 255, 255) &&
          cap[6 * LOGICAL_W + 9] !== marker,
        `first pixel ${cap[0]!.toString(16)}`,
      );
      // The UI must not influence a single pixel outside its own opaque pixels: same frame with and without the UI layer,
      // maximum aberration + flash, identical everywhere except where UI pixels are.
      const fx2 = noFx();
      fx2.aberration = 1;
      fx2.flash = 0.4;
      r.draw(frameOf([bg], { ui, fx: fx2, tick: 77 }));
      const withUi = r.captureLogical();
      r.draw(frameOf([bg], { fx: fx2, tick: 77 }));
      const withoutUi = r.captureLogical();
      let leaked = 0;
      for (let i = 0; i < withUi.length; i++) {
        const covered = ui.pixels[i]! >>> 24 !== 0;
        if (!covered && withUi[i] !== withoutUi[i]) leaked++;
      }
      check(
        'UI: never bloomed, aberrated or blurred — no pixel outside the UI changes when the UI is added',
        leaked === 0,
        `${leaked} leaked pixels`,
      );
    }

    /* ---------- 8. determinism: identical frames render identically ---------- */
    {
      const bg = blackBackdrop();
      const s = uniqueSprite('det', 40, 40);
      Object.assign(s, { x: 600, y: 260, prevX: 600, prevY: 260, anchorX: 20, anchorY: 20 });
      const fx = noFx();
      fx.shockwaves.push({ x: 640, y: 260, age: 0.2, radius: 90, strength: 0.7 });
      r.draw(frameOf([bg, s], { fx, tick: 500 }));
      const a = r.captureLogical();
      r.draw(frameOf([bg, s], { fx, tick: 500 }));
      const b = r.captureLogical();
      check(
        'same tick + same inputs ⇒ identical frame (grain is tick-locked)',
        maxDiff(a, b).count === 0,
        `differing pixels ${maxDiff(a, b).count}`,
      );
      r.draw(frameOf([bg, s], { fx, tick: 501 }));
      const c = r.captureLogical();
      // the unified path's final snap has no grain (it would only sparkle through the dither); D34 turned the snap off
      if (r.unified && UNIFIED_LOOK.snapFinal)
        check(
          'unified path: no grain (a later tick with the same inputs renders the same)',
          maxDiff(a, c).count === 0,
          `differing pixels ${maxDiff(a, c).count}`,
        );
      else check('grain does animate from tick to tick', maxDiff(a, c).count > 100);
    }

    /* ---------- 9. shockwave refraction, flash, lensing, aberration act where they should ---------- */
    {
      const bg = blackBackdrop();
      const stripes = makeLayer('stripes', 'screen', -10, LOGICAL_W, LOGICAL_H);
      for (let y = 0; y < LOGICAL_H; y++)
        for (let x = 0; x < LOGICAL_W; x++)
          stripes.pixels[y * LOGICAL_W + x] = (x >> 3) & 1 ? rgba(220, 220, 220, 255) : rgba(30, 30, 30, 255);
      stripes.version = 1;
      r.draw(frameOf([bg, stripes], { tick: 900 }));
      const calm = r.captureLogical();
      const fx = noFx();
      fx.shockwaves.push({ x: 300 + 320, y: 100 + 180, age: 0.1, radius: 120, strength: 1 });
      r.draw(frameOf([bg, stripes], { fx, tick: 900 }));
      const shocked = r.captureLogical();
      const ring = meanAbsDiff(calm, shocked, 320 + 100, 180 - 8, 320 + 140, 180 + 8);
      const centre = meanAbsDiff(calm, shocked, 320 - 40, 180 - 40, 320 + 40, 180 + 40);
      const outside = meanAbsDiff(calm, shocked, 10, 10, 90, 90);
      check(
        'shockwave refraction bends the image on the ring only',
        ring > 4 && centre < 2 && outside < 0.5,
        `ring ${ring.toFixed(1)} centre ${centre.toFixed(2)} outside ${outside.toFixed(2)}`,
      );
      // D5: `flash` no longer whitens anything (it used to: this check asserted the opposite before the slice)
      const flash = noFx();
      flash.flash = 1;
      r.draw(frameOf([bg, stripes], { fx: flash, tick: 900 }));
      const flashed = r.captureLogical();
      const flashDl = Math.abs(meanLuminance(flashed) - meanLuminance(calm));
      check(
        'flash never washes the frame (D5): mean luminance unchanged by fx.flash = 1',
        flashDl < 0.005,
        `Δ mean luminance ${flashDl.toFixed(4)}`,
      );
      // `aberration` is now LOCAL wound refraction around impact lights: nothing happens without one, and with one the change
      // stays inside its lens
      const ab = noFx();
      ab.aberration = 1;
      r.draw(frameOf([bg, stripes], { fx: ab, tick: 900 }));
      check(
        'aberration without an impact light leaves the frame untouched',
        maxDiff(calm, r.captureLogical()).count === 0,
      );
      ab.lights = [impactLight(300 + 320, 100 + 180, 120, 0.03)];
      r.draw(frameOf([bg, stripes], { fx: ab, tick: 900 }));
      const refracted = r.captureLogical();
      const near = meanAbsDiff(calm, refracted, 320 - 60, 180 - 30, 320 + 60, 180 + 30);
      const farEdge = meanAbsDiff(calm, refracted, 560, 10, 640, 100);
      check(
        'wound refraction bends the image around the wound only (no full-frame aberration)',
        near > 4 && farEdge < 0.3,
        `near ${near.toFixed(1)} far edge ${farEdge.toFixed(2)}`,
      );
      const lens = noFx();
      lens.lenses.push({ x: 300 + 320, y: 100 + 180, horizonR: 30, strength: 1 });
      r.draw(frameOf([bg], { tick: 900, fx: lens }));
      // the black backdrop hides the scenery; lensing is a scenery effect, so the frame must be unchanged there
      const lensedCover = r.captureLogical();
      r.draw(frameOf([bg], { tick: 900 }));
      check(
        'lensing only bends the scenery (2D layers are untouched)',
        maxDiff(lensedCover, r.captureLogical()).count === 0,
      );
      r.draw(frameOf([], { tick: 901, fx: lens }));
      const lensedScenery = r.captureLogical();
      r.draw(frameOf([], { tick: 901 }));
      const plainScenery = r.captureLogical();
      const lensDiff = meanAbsDiff(plainScenery, lensedScenery, 320 - 90, 180 - 90, 320 + 90, 180 + 90);
      check(
        'lensing visibly bends the scenery around the lens',
        lensDiff > 0.4,
        `mean diff ${lensDiff.toFixed(2)}`,
      );
    }

    /* ---------- 10. micro-zoom + roll only touch the scene, and integer upscale is exact ---------- */
    {
      const bg = blackBackdrop();
      const stripes = makeLayer('stripes2', 'screen', -10, LOGICAL_W, LOGICAL_H);
      for (let y = 0; y < LOGICAL_H; y++)
        for (let x = 0; x < LOGICAL_W; x++)
          stripes.pixels[y * LOGICAL_W + x] = (x + y) & 8 ? rgba(200, 90, 30, 255) : rgba(20, 60, 120, 255);
      stripes.version = 1;
      const ui = makeLayer('ui2', 'screen', 100, LOGICAL_W, LOGICAL_H);
      for (let y = 20; y < 40; y++)
        for (let x = 20; x < 60; x++) ui.pixels[y * LOGICAL_W + x] = rgba(255, 0, 255, 255);
      ui.version = 1;
      r.draw(frameOf([bg, stripes], { tick: 1000, ui }));
      const flat = r.captureLogical();
      r.draw(frameOf([bg, stripes], { tick: 1000, ui, camera: cam({ zoom: 1.05, roll: 0.02 }) }));
      const gl = canvas.getContext('webgl2', {
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
      // (the renderer owns the context, so read the canvas through a 2D copy instead)
      void gl;
      const c2 = document.createElement('canvas');
      c2.width = canvas.width;
      c2.height = canvas.height;
      const ctx = c2.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(canvas, 0, 0);
      const lay = r.debugLayout();
      const img = ctx.getImageData(0, 0, c2.width, c2.height).data;
      const at = (x: number, y: number): number => {
        const i = (y * c2.width + x) * 4;
        return rgba(img[i]!, img[i + 1]!, img[i + 2]!, 255);
      };
      // UI stays put at exactly scale× its logical position even while the scene zooms and rolls
      const uiOk =
        at(lay.x + 30 * lay.scale + 1, lay.y + 30 * lay.scale + 1) === rgba(255, 0, 255, 255) &&
        at(lay.x + 19 * lay.scale, lay.y + 30 * lay.scale) !== rgba(255, 0, 255, 255);
      check('micro-zoom and roll do not move the UI', uiOk);
      let sceneChanged = 0;
      for (let y = 80; y < 300; y += 7)
        for (let x = 80; x < 560; x += 7)
          if (at(lay.x + x * lay.scale + 1, lay.y + y * lay.scale + 1) !== flat[y * LOGICAL_W + x])
            sceneChanged++;
      check(
        'micro-zoom and roll change the scene',
        sceneChanged > 100,
        `${sceneChanged} sample pixels differ`,
      );
      r.draw(frameOf([bg, stripes], { tick: 1000, ui }));
      const ok = new Array<boolean>();
      ctx.drawImage(canvas, 0, 0);
      const img2 = ctx.getImageData(0, 0, c2.width, c2.height).data;
      let wrong = 0;
      for (let y = 0; y < LOGICAL_H; y += 3)
        for (let x = 0; x < LOGICAL_W; x += 3) {
          const cx = lay.x + x * lay.scale + (lay.scale >> 1);
          const cy = lay.y + y * lay.scale + (lay.scale >> 1);
          const i = (cy * c2.width + cx) * 4;
          const got = rgba(img2[i]!, img2[i + 1]!, img2[i + 2]!, 255);
          const want = flat[y * LOGICAL_W + x]!;
          if (got !== want) wrong++;
        }
      ok.push(wrong === 0);
      check(
        `integer upscale is exact nearest-neighbour (scale ${lay.scale}, letterbox ${lay.x},${lay.y})`,
        wrong === 0,
        `${wrong} sampled pixels differ`,
      );
      // odd window sizes still use an integer scale and a centred letterbox
      r.resize(1900, 1000, 1);
      const l2 = r.debugLayout();
      check(
        'resize picks the largest integer scale and centres it',
        l2.scale === 2 && l2.x === 310 && l2.y === 140,
        JSON.stringify(l2),
      );
      r.resize(1280, 720, 1);
    }

    await sliceChecks(r, canvas);

    /* ---------- 11. context loss is survivable ---------- */
    if (!new URLSearchParams(location.search).has('skipctx')) {
      const bg = blackBackdrop();
      const s = uniqueSprite('ctx', 30, 30);
      Object.assign(s, { x: 600, y: 250, prevX: 600, prevY: 250, anchorX: 15, anchorY: 15 });
      r.draw(frameOf([bg, s], { tick: 1100 }));
      const before = r.captureLogical();
      r.debugLoseContext(true);
      await new Promise((res) => setTimeout(res, 200));
      let threw = false;
      try {
        r.draw(frameOf([bg, s], { tick: 1100 }));
      } catch {
        threw = true;
      }
      r.debugLoseContext(false);
      await new Promise((res) => setTimeout(res, 400));
      // The scenery rebuilds in the background: until it is back, draw() must still composite the 2D layers over black.
      r.draw(frameOf([bg, s], { tick: 1100 }));
      const during = r.debugReadFrame(0); // composited layers, before post: exact colours
      const px = 600 - view.x0 + (250 - view.y0) * LOGICAL_W;
      check(
        'context restore: 2D layers keep drawing (over black) while the scenery rebuilds in the background',
        during[px] === s.pixels[15 * 30 + 15] && !r.isStageReady('tussenruimte'),
        `sprite pixel ${during[px]!.toString(16)}`,
      );
      await r.prepareStage('tussenruimte');
      r.draw(frameOf([bg, s], { tick: 1100 }));
      const after = r.captureLogical();
      check(
        'context loss: draw() does not throw while lost, and rendering resumes identically after restore',
        !threw && maxDiff(before, after).count === 0,
        `differing pixels ${maxDiff(before, after).count}`,
      );
    }

    /* ---------- 12. stage switching and quality tiers ---------- */
    {
      const bg = blackBackdrop();
      for (const st of ['nursery', 'rim', 'quasar', 'mausoleum', 'shearfield'] as const) {
        r.setStage(st);
        r.draw(frameOf([], { stage: st, tick: 1200 }));
        const f = r.captureLogical();
        let lum = 0;
        for (let i = 0; i < f.length; i += 37)
          lum += (f[i]! & 255) + ((f[i]! >>> 8) & 255) + ((f[i]! >>> 16) & 255);
        check(`stage ${st} draws a non-blank scenery`, lum > 2000, `sum ${lum}`);
      }
      // God rays: an opaque body between the stage light and a probe region casts a shaft (the probe gets less ray light),
      // while a control region beside it is unaffected. Scenery is identical in both frames; only the occluder differs.
      r.setStage('nursery');
      const bar = makeLayer('bar', 'world', 0, 10, 300);
      // a tall bar just right of the light (the nursery's stars sit at screen ≈ (78,-26)): everything beyond it, seen from the light, is in its shadow
      bar.pixels.fill(rgba(4, 3, 5, 255));
      Object.assign(bar, {
        anchorX: 5,
        anchorY: 0,
        x: view.x0 + 117,
        y: view.y0 - 60,
        prevX: view.x0 + 117,
        prevY: view.y0 - 60,
        version: 1,
      });
      r.draw(frameOf([], { stage: 'nursery', tick: 3000 }));
      const open = r.captureLogical();
      r.draw(frameOf([bar], { stage: 'nursery', tick: 3000 }));
      const blocked = r.captureLogical();
      const lumAt = (f: Uint32Array, x0: number, y0: number, x1: number, y1: number): number => {
        let s = 0;
        let n = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const p = f[y * LOGICAL_W + x]!;
            s += (p & 255) + ((p >>> 8) & 255) + ((p >>> 16) & 255);
            n += 3;
          }
        return s / n;
      };
      const shadow = lumAt(open, 150, 20, 230, 70) - lumAt(blocked, 150, 20, 230, 70);
      const control = Math.abs(lumAt(open, 30, 60, 100, 110) - lumAt(blocked, 30, 60, 100, 110));
      check(
        'god rays: an opaque body between the light and a region casts a shaft there (and only there)',
        shadow > 0.4 && control < 0.5,
        `shaft dims the probe by ${shadow.toFixed(2)} levels, control region moves ${control.toFixed(2)}`,
      );
      r.setStage('tussenruimte');
      void bg;
    }

    /* ---------- 13. stage preparation never freezes the game ---------- */
    {
      r.setStage('tussenruimte');
      const bg = blackBackdrop();
      const frameMsDuring: number[] = [];
      const seen: number[] = [];
      let previousAlways = true;
      let nonBlank = true;
      let draws = 0;
      const tStart = performance.now();
      const ready = r.prepareStage('nursery', (f) => seen.push(f));
      const returnedIn = performance.now() - tStart;
      // Draw frames the whole time the background job runs, exactly like the game loop would.
      while (!r.isStageReady('nursery')) {
        const a = performance.now();
        r.draw(frameOf([], { stage: 'nursery', tick: 5000 + draws }));
        frameMsDuring.push(performance.now() - a);
        if (r.debugActiveStage() !== 'tussenruimte') previousAlways = false;
        const f = r.captureLogical();
        let lum = 0;
        for (let i = 0; i < f.length; i += 41)
          lum += (f[i]! & 255) + ((f[i]! >>> 8) & 255) + ((f[i]! >>> 16) & 255);
        if (lum < 1500) nonBlank = false;
        draws++;
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      }
      await ready;
      const prep = r.stats.prepare;
      check(
        'prepareStage returns immediately and reports monotonic progress ending at 1',
        returnedIn < 20 &&
          seen.length >= 6 &&
          seen.every((v, i) => i === 0 || v >= seen[i - 1]!) &&
          seen.at(-1) === 1,
        `returned in ${returnedIn.toFixed(1)} ms, ${seen.length} progress callbacks`,
      );
      check(
        'while a stage prepares, draw() keeps showing the previous stage (never black, never garbage) over several frames',
        previousAlways && nonBlank && draws >= 3,
        `${draws} frames drawn during the load, previous stage kept: ${previousAlways}`,
      );
      check(
        'the preparation is time-sliced: many frames, and no single slice longer than one shader compile',
        !!prep && prep.frames >= 5 && prep.maxSliceMs < 500,
        prep
          ? `${prep.frames} frames, longest slice ${prep.maxSliceMs.toFixed(1)} ms, cpu ${prep.cpuMs.toFixed(0)} ms of ${prep.wallMs.toFixed(0)} ms wall`
          : 'no stats',
      );
      const a = performance.now();
      r.draw(frameOf([bg], { stage: 'nursery', tick: 6000 }));
      const switchMs = performance.now() - a;
      check(
        'once ready, the switch to the prepared stage is instant (one draw)',
        r.debugActiveStage() === 'nursery' && switchMs < 400, // one draw; the bound is loose because software GL on a shared box makes the first draw's command submission slow
        `switched in ${switchMs.toFixed(1)} ms of CPU`,
      );
      // A stage nobody prepared: draw() must not block; it starts the job and keeps the current stage.
      const b = performance.now();
      r.draw(frameOf([], { stage: 'quasar', tick: 6001 }));
      const lazyMs = performance.now() - b;
      check(
        'drawing a never-prepared stage starts a background job instead of blocking',
        lazyMs < 150 && r.debugActiveStage() === 'nursery' && !r.isStageReady('quasar'),
        `draw took ${lazyMs.toFixed(1)} ms of CPU`,
      );
      await r.prepareStage('quasar');
      r.draw(frameOf([], { stage: 'quasar', tick: 6002 }));
      check('…and switches to it as soon as it is ready', r.debugActiveStage() === 'quasar');
    }

    /* ---------- 14. quality tiers: cheap to switch, brightness-neutral, adaptive controller wired up ---------- */
    {
      r.setStage('nursery');
      const meanLum = (f: Uint32Array): number => {
        let s = 0;
        for (let i = 0; i < f.length; i += 3)
          s += (f[i]! & 255) + ((f[i]! >>> 8) & 255) + ((f[i]! >>> 16) & 255);
        return s / (f.length / 3) / 3;
      };
      const lums: number[] = [];
      const switchMs: number[] = [];
      for (const t of [0, 1, 2] as const) {
        const a = performance.now();
        r.debugSetTier(t);
        switchMs.push(performance.now() - a);
        r.draw(frameOf([], { stage: 'nursery', tick: 7000 }));
        lums.push(meanLum(r.captureLogical()));
        if (r.stats.tier !== t) lums.push(-999);
      }
      const spread = (Math.max(...lums) - Math.min(...lums)) / Math.max(...lums);
      check(
        'quality tiers thin the scenery without changing its brightness (compensated) and report the tier in stats',
        spread < 0.12 && lums.every((v) => v > 0),
        `mean luminance by tier ${lums.map((v) => v.toFixed(1)).join(' / ')} (spread ${(spread * 100).toFixed(1)} %)`,
      );
      check(
        'switching tier is cheap (no scenery rebuild): a few ms of CPU',
        Math.max(...switchMs) < 120,
        `switch times ${switchMs.map((v) => v.toFixed(1)).join(' / ')} ms`,
      );
      r.debugSetTier(1);

      // Adaptive quality on a second renderer: in software GL every frame is slow, so it must walk down to tier 0 and stay.
      const c2 = document.createElement('canvas');
      c2.width = 640;
      c2.height = 360;
      document.body.appendChild(c2);
      const ra = createRenderer();
      await ra.init(c2, { quality: 'auto', preserveDrawingBuffer: true });
      await ra.prepareStage('tussenruimte');
      const startTier = ra.stats.tier;
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < 40_000 && ra.stats.tier > 0) {
        ra.draw(frameOf([], { stage: 'tussenruimte', tick: 8000 + n++ }));
        ra.captureLogical(); // force the GPU to finish so frame pacing reflects real cost
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      }
      const settled = ra.stats.tier;
      for (let i = 0; i < 40; i++) {
        ra.draw(frameOf([], { stage: 'tussenruimte', tick: 9000 + i }));
        ra.captureLogical();
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      }
      // in software GL every frame misses, so it must walk down to 0 and stay; on a real GPU (a timer query exists) the frames
      // are fast, so it may hold or step UP — what is checked there is only that it is wired (auto, starts at 1, reports)
      const realGpu = ra.stats.gpuMs !== null;
      check(
        realGpu
          ? 'adaptive quality (auto) starts at tier 1 and adapts on the real GPU (timer query wired)'
          : 'adaptive quality (auto) starts at tier 1, walks down under sustained misses and stays put at the bottom',
        realGpu
          ? ra.stats.auto && startTier === 1
          : ra.stats.auto &&
              startTier === 1 &&
              settled === 0 &&
              ra.stats.tier === 0 &&
              ra.stats.tierChanges >= 1,
        `start ${startTier} → ${settled}, changes ${ra.stats.tierChanges}, late ${(ra.stats.lateRate * 100).toFixed(0)} %, gpu timer ${ra.stats.gpuMs === null ? 'n/a' : ra.stats.gpuMs.toFixed(1) + ' ms'}`,
      );
      ra.dispose();
      c2.remove();
    }
  }

  /* ---------- 15. readability: a pale celadon body and a near-black basalt body read on EVERY stage ---------- */
  {
    const luma = (p: number): number =>
      0.2126 * (p & 255) + 0.7152 * ((p >>> 8) & 255) + 0.0722 * ((p >>> 16) & 255);
    const SIZE = 96;
    const stages = [
      'nursery',
      'rim',
      'redgiant',
      'quasar',
      'tussenruimte',
      'mausoleum',
      'shearfield',
    ] as const;
    for (const style of ['celadon', 'basalt'] as const) {
      const body = makeRockBody(`read-${style}`, 4242, SIZE, style);
      body.pulse(1);
      const worst: { stage: string; contrast: number; contact: number }[] = [];
      for (const st of stages) {
        await r.prepareStage(st);
        // two fighter positions, at the fight height (screen y ≈ 180): left and right of the arena centre
        let low = { contrast: 1e9, contact: 1e9 };
        for (const sx of [170, 470]) {
          const l = body.layer;
          const wx = view.x0 + sx;
          const wy = view.y0 + 200;
          Object.assign(l, {
            x: wx,
            y: wy,
            prevX: wx,
            prevY: wy,
            facing: 1,
            lean: 0,
            version: l.version + 1,
          });
          r.draw(frameOf([l], { stage: st, tick: 12000 + sx, timeSec: 12 }));
          const f = r.captureLogical();
          // silhouette in frame coordinates
          const inside = (fx: number, fy: number): boolean => {
            const lx = fx + view.x0 - wx + l.anchorX;
            const ly = fy + view.y0 - wy + l.anchorY;
            return lx >= 0 && ly >= 0 && lx < SIZE && ly < SIZE && l.pixels[ly * SIZE + lx]! >>> 24 !== 0;
          };
          let sIn = 0;
          let nIn = 0;
          let sRing = 0;
          let nRing = 0;
          let sContact = 0;
          let nContact = 0;
          for (let fy = 0; fy < LOGICAL_H; fy++)
            for (let fx = 0; fx < LOGICAL_W; fx++) {
              if (Math.abs(fx - sx) > 80 || Math.abs(fy - 200 + 0) > 90) continue;
              if (inside(fx, fy)) {
                sIn += luma(f[fy * LOGICAL_W + fx]!);
                nIn++;
                continue;
              }
              // distance to the silhouette (chebyshev, up to 10 px)
              let d = 99;
              for (let dy = -10; dy <= 10 && d > 1; dy++)
                for (let dx = -10; dx <= 10; dx++) {
                  if (inside(fx + dx, fy + dy)) d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
                }
              if (d >= 3 && d <= 10) {
                sRing += luma(f[fy * LOGICAL_W + fx]!);
                nRing++;
              } else if (d <= 2) {
                sContact += luma(f[fy * LOGICAL_W + fx]!);
                nContact++;
              }
            }
          const mIn = sIn / Math.max(1, nIn);
          const contrast = Math.abs(mIn - sRing / Math.max(1, nRing));
          const contact = Math.abs(mIn - sContact / Math.max(1, nContact));
          low = { contrast: Math.min(low.contrast, contrast), contact: Math.min(low.contact, contact) };
        }
        worst.push({ stage: st, ...low });
      }
      check(
        `readability: a ${style} body keeps luma contrast against the scenery on every stage`,
        worst.every((w) => w.contrast >= (style === 'celadon' ? 30 : 10)),
        worst.map((w) => `${w.stage} ${w.contrast.toFixed(0)}/${w.contact.toFixed(0)}`).join(', '),
      );
    }
    r.setStage('tussenruimte');
  }

  /* ---------- 17. the bodies as lights: scenery tinted near the source, sprites relit on the lit side, foreground leaves the fight band clear ---------- */
  {
    await r.prepareStage('quasar');
    r.debugSetTier(1);
    const bg = blackBackdrop();
    void bg;
    const lightFx = (on: boolean): FrameFx => ({
      ...noFx(),
      lights: on
        ? [
            { x: view.x0 + 480, y: view.y0 + 180, radius: 260, r: 1, g: 0.6, b: 0.2, intensity: 1, slot: 1 },
            {
              x: view.x0 + 200,
              y: view.y0 + 180,
              radius: 100,
              r: 0.6,
              g: 0.9,
              b: 0.9,
              intensity: 0.3,
              slot: 0,
            },
          ]
        : undefined,
    });
    const body = makeRockBody('lit', 77, 96, 'celadon');
    body.pulse(1);
    const l = body.layer;
    const wx = view.x0 + 200;
    const wy = view.y0 + 200;
    Object.assign(l, { x: wx, y: wy, prevX: wx, prevY: wy, facing: 1, lean: 0, version: l.version + 1 });
    r.debugSetForeground(false);
    r.draw(frameOf([], { stage: 'quasar', tick: 15000, fx: lightFx(false) }));
    const dark = r.captureLogical();
    r.draw(frameOf([], { stage: 'quasar', tick: 15000, fx: lightFx(true) }));
    const tinted = r.captureLogical();
    const redAt = (f: Uint32Array, x0: number, y0: number, x1: number, y1: number): number => {
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const p = f[y * LOGICAL_W + x]!;
          s += (p & 255) + ((p >>> 8) & 255) * 0.5;
          n++;
        }
      return s / n;
    };
    const nearGain = redAt(tinted, 400, 150, 470, 210) - redAt(dark, 400, 150, 470, 210);
    const farGain = redAt(tinted, 20, 290, 80, 340) - redAt(dark, 20, 290, 80, 340);
    check(
      'a body light tints the scenery near it and barely touches the far corner',
      nearGain > 3 && nearGain > farGain * 2.5,
      `near +${nearGain.toFixed(1)}, far +${farGain.toFixed(1)} (warm-channel levels)`,
    );
    r.draw(frameOf([l], { stage: 'quasar', tick: 15001, fx: lightFx(false) }));
    const unlit = r.captureLogical();
    r.draw(frameOf([l], { stage: 'quasar', tick: 15001, fx: lightFx(true) }));
    const lit = r.captureLogical();
    // the sprite spans about x 152..248 around wx; the warm light sits to its right: right third vs left third
    const dR = redAt(lit, 215, 150, 240, 210) - redAt(unlit, 215, 150, 240, 210);
    const dL = redAt(lit, 160, 150, 185, 210) - redAt(unlit, 160, 150, 185, 210);
    check(
      'a sprite is relit by the other body’s light: the side facing it gains warmth, the far side does not',
      dR > 2 && dR > dL + 2,
      `facing side ${dR.toFixed(1)}, far side ${dL.toFixed(1)}`,
    );
    r.debugSetForeground(false);
    r.draw(frameOf([], { stage: 'quasar', tick: 15002 }));
    const noFg = r.captureLogical();
    r.debugSetForeground(true);
    r.draw(frameOf([], { stage: 'quasar', tick: 15002 }));
    const withFg = r.captureLogical();
    // the fight band (screen y ≈ 60–250, the middle of the frame): the foreground changes few pixels there
    let bandChanged = 0;
    let edgeChanged = 0;
    let bandN = 0;
    let edgeN = 0;
    for (let y = 0; y < LOGICAL_H; y++)
      for (let x = 0; x < LOGICAL_W; x++) {
        const inBand = y >= 70 && y < 250;
        const ch = noFg[y * LOGICAL_W + x] !== withFg[y * LOGICAL_W + x];
        if (inBand) {
          bandN++;
          if (ch) bandChanged++;
        } else {
          edgeN++;
          if (ch) edgeChanged++;
        }
      }
    check(
      'the foreground pass leaves the fight band mostly clear (denser near the frame edges)',
      bandChanged / bandN < 0.2 && edgeChanged / edgeN >= bandChanged / bandN,
      `pixels changed: band ${((100 * bandChanged) / bandN).toFixed(1)} %, edges ${((100 * edgeChanged) / edgeN).toFixed(1)} %`,
    );
    r.debugSetTier(1);
    r.setStage('tussenruimte');
  }

  /* ---------- 16. the seven stages are visibly distinct (never a recolour of one another) ---------- */
  {
    const stages = [
      'nursery',
      'rim',
      'redgiant',
      'quasar',
      'tussenruimte',
      'mausoleum',
      'shearfield',
    ] as const;
    const BINS = 12;
    const sigs: { hue: number[]; mean: number; spread: number; layout: number[] }[] = [];
    for (const st of stages) {
      await r.prepareStage(st);
      r.draw(frameOf([], { stage: st, tick: 13000, timeSec: 14 }));
      const f = r.captureLogical();
      const hue = new Array<number>(BINS).fill(0);
      // coarse 8x4 luminance layout: where the light is, independent of colour
      const layout = new Array<number>(32).fill(0);
      const cnt = new Array<number>(32).fill(0);
      let total = 0;
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let y = 0; y < LOGICAL_H; y += 2)
        for (let x = 0; x < LOGICAL_W; x += 2) {
          const p = f[y * LOGICAL_W + x]!;
          const rr = (p & 255) / 255;
          const gg = ((p >>> 8) & 255) / 255;
          const bb = ((p >>> 16) & 255) / 255;
          const mx = Math.max(rr, gg, bb);
          const mn = Math.min(rr, gg, bb);
          const c = mx - mn;
          const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
          sum += l;
          sum2 += l * l;
          n++;
          const cell = Math.floor((y / LOGICAL_H) * 4) * 8 + Math.floor((x / LOGICAL_W) * 8);
          layout[cell]! += l;
          cnt[cell]!++;
          if (c < 0.06) continue;
          let h = 0;
          if (mx === rr) h = ((gg - bb) / c + 6) % 6;
          else if (mx === gg) h = (bb - rr) / c + 2;
          else h = (rr - gg) / c + 4;
          const w = c * (0.3 + mx);
          hue[Math.min(BINS - 1, Math.floor((h / 6) * BINS))]! += w;
          total += w;
        }
      const mean = sum / n;
      sigs.push({
        hue: hue.map((v) => v / Math.max(1e-6, total)),
        mean,
        spread: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
        layout: layout.map((v, i) => v / Math.max(1, cnt[i]!)),
      });
    }
    let minD = 1e9;
    let pair = '';
    const dists: string[] = [];
    for (let i = 0; i < stages.length; i++)
      for (let j = i + 1; j < stages.length; j++) {
        const a = sigs[i]!;
        const b = sigs[j]!;
        let dh = 0;
        for (let k = 0; k < BINS; k++) dh += Math.abs(a.hue[k]! - b.hue[k]!);
        let dl = 0;
        for (let k = 0; k < 32; k++) dl += Math.abs(a.layout[k]! - b.layout[k]!);
        // hue distribution (0..2), overall brightness and where the light sits: any one of them can tell two stages apart
        const d = dh * 0.5 + Math.abs(a.mean - b.mean) * 2 + (dl / 32) * 2;
        dists.push(`${stages[i]}/${stages[j]} ${d.toFixed(2)}`);
        if (d < minD) {
          minD = d;
          pair = `${stages[i]}/${stages[j]}`;
        }
      }
    check(
      'the seven stages are pairwise visibly distinct (hue mix, brightness and light layout)',
      minD > 0.3,
      `closest pair ${pair} = ${minD.toFixed(2)}; ${dists.join(', ')}`,
    );
    r.setStage('tussenruimte');
  }

  finish(r);
}

function finish(r: DebuggableRenderer): void {
  const failed = results.filter((x) => !x.ok).length;
  out.textContent += `\n\n${results.length - failed}/${results.length} passed`;
  (window as unknown as { __VERIFY__: unknown }).__VERIFY__ = { done: true, failed, results };
  r.dispose();
}

main().catch((e: unknown) => {
  out.textContent += `\nEXCEPTION ${(e as Error).stack ?? String(e)}`;
  (window as unknown as { __VERIFY__: unknown }).__VERIFY__ = {
    done: true,
    failed: 1,
    results,
    error: String(e),
  };
});
