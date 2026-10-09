/**
 * Gate 2A (S4's half): 우리's rest pose from the REAL matter bodies vs the reference silhouette and the oracle's own renderer.
 *   npx tsx tools/matter/uri2a.ts [--out=docs/gallery/integration/uri-2a-rest.png]
 * The bodies are built from S2's loader (src/titans/uri/maps.ts: uri_rig.json as is) exactly as the behaviour builds them
 * ('part' region bodies, pivot = the rounded local pivot, the 'majority4' sampler of proposal 174), placed at rest.
 * - silhouette overlap: every reference pixel of uri/data/uri_silhouette_rest.png against the bodies' hit test (solidAt);
 * - parts render: each screen pixel takes the front-most body's displayed pixel (the rig's draw order) — what matter holds and
 *   the renderer uploads — beside the oracle's `drawPart` at rest (tools/matter/urioracle.ts), with a per-pixel diff;
 * - rotation: the spec's three test angles (30°, 90°, 150°), every part about its own pivot through the 'majority4' sampler.
 * Parts only: cores, loop, command-moon glow and cast shadows are S5's pass; the fists are the authored grid (spread 1.00).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { rotRasterMode, type BodySpec, type RotPartEx } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { buildMaterialTable } from '@/matter/materials';
import { URI_MATERIALS, cloneUriMap, uriPartMatter } from '@/titans';
import { URI_ORDER, URI_REF, uriPart } from '@/titans/uri/rig';
import { uriGridOf } from '@/titans/uri/scale';
import { writePng } from '../lead/png';
import { oracleRest } from './urioracle';

const W = 640;
const H = 360;
const OFFX = URI_REF.screenX - URI_REF.originX;
const OFFY = URI_REF.screenY - URI_REF.originY;

/** 우리's 13 region bodies at rest, in draw order: reference pixel (X, Y) ↔ world pixel (X + dx, Y + dy). */
export function uriRestBodies(
  world: MatterWorldEx,
  dx: number,
  dy: number,
  slot: 0 | 1 = 0,
  scale = 1,
): number[] {
  const mats = buildMaterialTable(URI_MATERIALS);
  const parts = uriPartMatter(scale);
  return URI_ORDER.map((k, z) => {
    const src = parts.find((p) => p.key === k)!;
    const meta = uriGridOf(uriPart(k), scale);
    const ax = Math.round(meta.pivX);
    const ay = Math.round(meta.pivY);
    const spec: BodySpec = {
      kind: 'part',
      ownerSlot: slot,
      map: cloneUriMap(src.map),
      materials: mats,
      attributes: { mass: 9, cohesion: 7, heat: 6, gravity: 4, reach: 6, tempo: 3 },
      seed: 11 + z,
      transform: {
        x: dx + meta.x0 + ax,
        y: dy + meta.y0 + ay,
        anchorX: ax,
        anchorY: ay,
        facing: 1,
        lean: 0,
        rot: 0,
      },
      takesDebrisImpacts: true,
      sampler: 'majority4',
    };
    const id = world.createBody(spec).id;
    world.setCellGroups(id, src.chunks);
    world.setFieldHeld(id, true); // held by fields (URI_SPEC §1): holes never shed what they cut off
    world.setGroupScale(id, scale); // torn pieces fly at the body's own scale

    return id;
  });
}

export interface Gate2A {
  silhouette: number;
  covered: number;
  spill: number;
  oraclePixels: number;
  samePixels: number;
  sameColour: number;
  ours: Uint32Array;
  oracle: Uint32Array;
}

export function gate2A(root = process.cwd()): Gate2A {
  const world = createMatterWorld(1);
  const ids = uriRestBodies(world, OFFX, OFFY);
  const sil = PNG.sync.read(readFileSync(join(root, 'uri/data/uri_silhouette_rest.png')));
  let s = 0;
  let cov = 0;
  let spill = 0;
  for (let Y = 0; Y < URI_REF.h; Y++)
    for (let X = 0; X < URI_REF.w; X++) {
      const inSil = sil.data[(Y * URI_REF.w + X) * 4]! > 127;
      let hit = false;
      for (const id of ids) if (world.solidAt(id, X + OFFX + 0.5, Y + OFFY + 0.5)) hit = true;
      if (inSil) s++;
      if (inSil && hit) cov++;
      if (!inSil && hit) spill++;
    }
  const ours = new Uint32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let k = ids.length - 1; k >= 0; k--) {
        const b = world.core.bodyById[ids[k]!]!;
        const c = b.cellAtWorld(x + 0.5, y + 0.5);
        if (c < 0 || b.map.material[c] === 0) continue;
        ours[y * W + x] = b.map.pixels[c]! >>> 0;
        break;
      }
  const o = oracleRest(root, 1);
  const oracle = new Uint32Array(W * H);
  let op = 0;
  let same = 0;
  let sameCol = 0;
  for (let i = 0; i < W * H; i++) {
    if (o.fb[i * 4 + 3]) {
      oracle[i] = ((255 << 24) | (o.fb[i * 4 + 2]! << 16) | (o.fb[i * 4 + 1]! << 8) | o.fb[i * 4]!) >>> 0;
      op++;
    }
    const a = oracle[i]! !== 0;
    const b = ours[i]! !== 0;
    if (a && b) same++;
    if (a && b && oracle[i] === ours[i]) sameCol++;
  }
  return {
    silhouette: s,
    covered: cov,
    spill,
    oraclePixels: op,
    samePixels: same,
    sameColour: sameCol,
    ours,
    oracle,
  };
}

function rotatedSheets(): Uint32Array[] {
  const world = createMatterWorld(2);
  const ids = uriRestBodies(world, OFFX, OFFY);
  return [21, 64, 107].map((step) => {
    // 30°, 90°, 150° (256 steps per turn): every part about its own pivot, through the 'majority4' sampler
    const sheet = new Uint32Array(W * H);
    for (const id of ids) {
      const b = world.core.bodyById[id]!;
      const part: RotPartEx = {
        pixels: b.map.pixels,
        w: b.w,
        h: b.h,
        px: b.transform.anchorX,
        py: b.transform.anchorY,
        step,
        facing: 1,
      };
      const r = rotRasterMode(part, 'majority4');
      const qx = Math.round(b.transform.x);
      const qy = Math.round(b.transform.y);
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const c = r.pixels[y * r.w + x]!;
          const sx = qx - r.ox + x;
          const sy = qy - r.oy + y;
          if (c >>> 24 !== 0 && sx >= 0 && sy >= 0 && sx < W && sy < H) sheet[sy * W + sx] = c;
        }
    }
    return sheet;
  });
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/matter/uri2a.ts')) {
  const root = process.cwd();
  const out = (
    process.argv.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/integration/uri-2a-rest.png'
  ).slice(6);
  const g = gate2A(root);
  console.log(
    `silhouette overlap: ${g.covered} / ${g.silhouette} reference pixels = ${((100 * g.covered) / g.silhouette).toFixed(3)} %; spill outside it ${g.spill} px`,
  );
  console.log(
    `parts vs the oracle's drawPart at rest: ${g.samePixels} / ${g.oraclePixels} pixels drawn by both; identical colour ${g.sameColour} (${((100 * g.sameColour) / g.oraclePixels).toFixed(3)} %)`,
  );
  const diff = new Uint32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = g.oracle[i]!;
    const b = g.ours[i]!;
    if (a !== 0 || b !== 0) diff[i] = a === b ? 0xff3a3a3a : 0xff2020ff;
  }
  const rows = [[g.oracle, g.ours, diff], rotatedSheets()];
  const SW = W * 3;
  const sheet = new Uint32Array(SW * H * 2);
  rows.forEach((row, ry) =>
    row.forEach((img, rx) => {
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const c = img[y * W + x]!;
          if (c >>> 24 !== 0) sheet[(ry * H + y) * SW + rx * W + x] = c;
        }
    }),
  );
  writePng(join(root, out), sheet, SW, H * 2, 1, 0xff120a0a);
  console.log(`wrote ${out} (top: oracle | matter bodies | diff; bottom: majority4 at 30° / 90° / 150°)`);
}
