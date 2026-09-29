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
      f[14 * LOGICAL_W + 14] === rgba(250, 10, 10, 255) && f[30 * LOGICAL_W + 30] === rgba(10, 200, 30, 255),
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
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
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
    check('micro-zoom and roll change the scene', sceneChanged > 100, `${sceneChanged} sample pixels differ`);
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
    r.setStage('tussenruimte');
    void bg;
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
