import {
  LOGICAL_H,
  LOGICAL_W,
  Rng,
  makeLayer,
  rgba,
  type BodyTransform,
  type CameraState,
  type FrameFx,
  type RenderFrame,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { createRenderer } from '@/render';
import { makeRockBody } from './testSprites';
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

async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const r = createRenderer();
  await r.init(canvas, { quality: 0, preserveDrawingBuffer: true });
  r.setStage('tussenruimte');
  r.resize(1280, 720, 1);
  const ref = { x: 0, y: 0 };

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
      const halo = meanAbsDiff(a, b, cx + 10, cy - 4, cx + 18, cy + 4);
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
      check('grain does animate from tick to tick', maxDiff(a, c).count > 100);
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
      const flash = noFx();
      flash.flash = 1;
      r.draw(frameOf([bg, stripes], { fx: flash, tick: 900 }));
      const flashed = r.captureLogical();
      check('flash brightens the frame', meanAbsDiff(calm, flashed) > 20);
      const ab = noFx();
      ab.aberration = 1;
      r.draw(frameOf([bg, stripes], { fx: ab, tick: 900 }));
      const aberrated = r.captureLogical();
      const edge = meanAbsDiff(calm, aberrated, 600, 100, 640, 260);
      const mid = meanAbsDiff(calm, aberrated, 300, 150, 340, 210);
      check(
        'chromatic aberration grows toward the screen edge',
        edge > mid * 2 && edge > 3,
        `edge ${edge.toFixed(1)} mid ${mid.toFixed(1)}`,
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
      for (const st of ['nursery', 'rim', 'quasar'] as const) {
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
      check(
        'adaptive quality (auto) starts at tier 1, walks down under sustained misses and stays put at the bottom',
        ra.stats.auto && startTier === 1 && settled === 0 && ra.stats.tier === 0 && ra.stats.tierChanges >= 1,
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
    const stages = ['nursery', 'rim', 'redgiant', 'quasar', 'tussenruimte'] as const;
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

  /* ---------- 16. the five stages are visibly distinct (never a recolour of one another) ---------- */
  {
    const stages = ['nursery', 'rim', 'redgiant', 'quasar', 'tussenruimte'] as const;
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
      'the five stages are pairwise visibly distinct (hue mix, brightness and light layout)',
      minD > 0.3,
      `closest pair ${pair} = ${minD.toFixed(2)}; ${dists.join(', ')}`,
    );
    r.setStage('tussenruimte');
  }

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
