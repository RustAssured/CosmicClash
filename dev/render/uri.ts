import {
  LOGICAL_H,
  LOGICAL_W,
  angleToStep,
  makeLayer,
  rgba,
  type FrameFx,
  type RenderLayer,
  type RenderPart,
} from '@/contracts';
import { createRenderer } from '@/render';
import type { RenderLayerLit } from '@/render/unified';
import { URI_FIST_SPREAD_REST, URI_LOOP_REST, type UriLiveFx } from '@/render/uriLive';
import { uriPartMatter } from '@/titans';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';
import {
  URI_COLD_CORE,
  URI_HOT_CORE,
  URI_ORDER,
  URI_REF,
  corePositions,
  placeParts,
  restPose,
  emptyPlaces,
  uriPart,
  type UriPose,
} from '@/titans/uri/rig';

/**
 * Gate 2A render parity for 우리 (URI_SPEC §2–4), driven by tools/render/uri-capture.ts through window.__URI__:
 * the 13 parts of uri_rig.json packed into one atlas with the light and shade planes (what the 우리 behaviour hands the
 * renderer), placed by the rig at a pose, drawn by the real renderer (unified path) over black, with the live cores, loop and
 * orbit. Screen = reference + (URI_REF.screen − URI_REF.origin), exactly where the oracle draws it.
 */

await loadUriAsset(uriBinUrl);
const canvas = document.getElementById('game') as HTMLCanvasElement;
const out = document.getElementById('out') as HTMLCanvasElement;
const renderer = createRenderer();
await renderer.init(canvas, { quality: 1, preserveDrawingBuffer: true, unified: true });
renderer.resize(LOGICAL_W, LOGICAL_H, 1);
renderer.setStage('tussenruimte');

const OX = URI_REF.screenX - URI_REF.originX;
const OY = URI_REF.screenY - URI_REF.originY;

// ---- the atlas: every part's matter pixels, light and shade planes, packed in rows ----
const parts = uriPartMatter();
const ROW = 1024;
let ax = 0;
let ay = 0;
let rowH = 0;
const at = new Map<string, [number, number]>();
for (const k of URI_ORDER) {
  const p = parts.find((q) => q.key === k)!;
  if (ax + p.map.w > ROW) {
    ax = 0;
    ay += rowH;
    rowH = 0;
  }
  at.set(k, [ax, ay]);
  ax += p.map.w;
  rowH = Math.max(rowH, p.map.h);
}
const atlas = makeLayer('uri-test', 'world', 0, ROW, ay + rowH) as RenderLayerLit;
atlas.emissive = new Uint8Array(atlas.w * atlas.h);
atlas.light = new Uint8Array(atlas.w * atlas.h * 4);
atlas.shade = new Uint8Array(atlas.w * atlas.h * 4);
atlas.chunk = new Uint16Array(atlas.w * atlas.h);
for (const k of URI_ORDER) {
  const p = parts.find((q) => q.key === k)!;
  const [sx, sy] = at.get(k)!;
  const m = p.map;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      const o = (sy + y) * atlas.w + sx + x;
      atlas.pixels[o] = m.material[i] ? m.pixels[i]! || m.baseColor[i]! : 0;
      atlas.emissive[o] = m.emissive[i]!;
      atlas.chunk[o] = p.chunks[i]!;
      for (let c = 0; c < 4; c++) {
        atlas.light[o * 4 + c] = p.light[i * 4 + c]!;
        atlas.shade[o * 4 + c] = p.shade[i * 4 + c]!;
      }
    }
}
atlas.version = 1;
atlas.facing = 1;

const places = emptyPlaces();
let spreadNow = URI_FIST_SPREAD_REST;
const hot = { x: 0, y: 0 };
const cold = { x: 0, y: 0 };

/** Lay the parts out at `pose` and return the frame's layers. `shade = false` draws the matter colours (the CPU rest look). */
function layersAt(pose: UriPose, shade: boolean, t: number): RenderLayer[] {
  placeParts(pose, places);
  const ps: RenderPart[] = [];
  for (const k of URI_ORDER) {
    const meta = uriPart(k);
    const [sx, sy] = at.get(k)!;
    const pl = places[k];
    const ax2 = Math.round(meta.pivX);
    const ay2 = Math.round(meta.pivY);
    const c = Math.cos(pl.a);
    const s = Math.sin(pl.a);
    const dx = ax2 - meta.pivX;
    const dy = ay2 - meta.pivY;
    ps.push({
      sx,
      sy,
      sw: meta.w,
      sh: meta.h,
      px: ax2,
      py: ay2,
      wx: Math.round(OX + pl.x + dx * c - dy * s),
      wy: Math.round(OY + pl.y + dx * s + dy * c),
      step: angleToStep(pl.a),
      z: URI_ORDER.indexOf(k),
      sampler: 'majority4',
    } as RenderPart);
  }
  atlas.parts = ps;
  corePositions(pose, hot, cold);
  const live: UriLiveFx = {
    hotX: OX + hot.x,
    hotY: OY + hot.y,
    coldX: OX + cold.x,
    coldY: OY + cold.y,
    hotR: Math.round(URI_HOT_CORE[2]),
    coldR: Math.round(URI_COLD_CORE[2]),
    t,
    spin: 0.25 * t,
    hp: 100,
    loop: URI_LOOP_REST,
    afterZ: URI_ORDER.indexOf('chamber'),
    fistSpread: [spreadNow, spreadNow],
    fistZ: [URI_ORDER.indexOf('fistL'), URI_ORDER.indexOf('fistR')],
  };
  const L = atlas as RenderLayerLit;
  L.uriLive = live;
  if (!shade) {
    // the plain path: no shade plane (the matter colours as painted at rest)
    delete L.shade;
  }
  return [atlas];
}
const savedShade = atlas.shade;
/** Silhouette renders turn the shared bloom off (its glow spills past the body by design). */
const bloom = (renderer as unknown as { bloomMix: { near: number; far: number } }).bloomMix;
const setBloom = (on: boolean): void => {
  bloom.near = on ? 0.38 : 0;
  bloom.far = on ? 0.28 : 0;
  // and the luminance governor, which would hold back the sudden full-screen green differently in each frame
  renderer.debugSetGovernor(on);
};

const noFx = (): FrameFx => ({
  shockwaves: [],
  lenses: [],
  impulses: [],
  flash: 0,
  aberration: 0,
  intensity: 0,
  timeScale: 1,
});
const blackBg = makeLayer('bg', 'screen', -50, LOGICAL_W, LOGICAL_H);
blackBg.pixels.fill(rgba(5, 4, 10, 255));
blackBg.version = 1;

function draw(pose: UriPose, shade: boolean, t: number): void {
  atlas.shade = savedShade;
  atlas.version++;
  const layers = [blackBg, ...layersAt(pose, shade, t)];
  for (let k = 0; k < 2; k++)
    renderer.draw({
      tick: 100 + Math.round(t * 60),
      timeSec: t,
      alpha: 0,
      camera: { x: 320, y: 180, zoom: 1, roll: 0, shakeX: 0, shakeY: 0, dolly: 0, kickX: 0, kickY: 0 },
      view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
      stage: 'tussenruimte',
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

(window as unknown as { __URI__: unknown }).__URI__ = {
  renderer,
  rest(shade = true, t = 3): string {
    draw(restPose(), shade, t);
    return png();
  },
  /** A pose with every link of `links` set (radians / px): checks the live light on turned parts. */
  posed(links: Partial<UriPose>, t = 3, spread = URI_FIST_SPREAD_REST): string {
    spreadNow = spread;
    draw({ ...restPose(), ...links }, true, t);
    spreadNow = URI_FIST_SPREAD_REST;
    return png();
  },
  /** The rest pose over a pure green backdrop (no titan colour is green): the silhouette test reads it. */
  restOnGreen(t = 3, magenta = false, spread = URI_FIST_SPREAD_REST): string {
    spreadNow = spread;
    blackBg.pixels.fill(magenta ? rgba(255, 0, 255, 255) : rgba(0, 255, 0, 255));
    blackBg.version++;
    setBloom(false);
    draw(restPose(), true, t);
    const u = png();
    setBloom(true);
    spreadNow = URI_FIST_SPREAD_REST;
    blackBg.pixels.fill(rgba(5, 4, 10, 255));
    blackBg.version++;
    return u;
  },
  /** The backdrop alone (what is not figure); green = the restOnGreen backdrop. */
  backdrop(t = 3, green = false): string {
    if (green) {
      blackBg.pixels.fill(rgba(0, 255, 0, 255));
      blackBg.version++;
      setBloom(false);
    }
    for (let k = 0; k < 2; k++)
      renderer.draw({
        tick: 100 + Math.round(t * 60),
        timeSec: t,
        alpha: 0,
        camera: { x: 320, y: 180, zoom: 1, roll: 0, shakeX: 0, shakeY: 0, dolly: 0, kickX: 0, kickY: 0 },
        view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
        stage: 'tussenruimte',
        layers: [blackBg],
        ui: null,
        fx: noFx(),
      });
    const u = png();
    if (green) {
      blackBg.pixels.fill(rgba(5, 4, 10, 255));
      blackBg.version++;
      setBloom(true);
    }
    return u;
  },
  /** The frame as packed RGBA (for parity checks). */
  capture(): number[] {
    return Array.from(renderer.captureLogical());
  },
};
document.body.dataset.ready = '1';
