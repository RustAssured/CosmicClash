/**
 * The 우리 oracle's own part renderer, run headless: uri/src/00_shared_helpers.js + 10_parts_render.js + 20_kinetics.js are
 * evaluated as is (the rig JSON substituted for __RIG__, like uri/src/assemble.py) and their `drawPart` / `drawFist` draw the
 * rest pose into the oracle's frame buffer. Used by tools/matter/uri2a.ts for the Gate 2A side-by-side. Tool only (node:vm).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

export interface OracleRest {
  /** 640×360 RGBA bytes (the oracle's FB: alpha 255 where a part pixel is drawn) and its owner part index per pixel (-1). */
  fb: Uint8ClampedArray;
  own: Int16Array;
  w: number;
  h: number;
}

/**
 * Draw every part at rest (angle 0, the rig's own pivots, drawn at screen (320,186) for body origin (200,170)), in the rig's
 * order. `fistSpread` = the fists' chunk spread (1 = the grid as authored; the oracle's still pose uses 1.12).
 */
export function oracleRest(root: string, fistSpread = 1): OracleRest {
  const src = (f: string): string => readFileSync(join(root, 'uri/src', f), 'utf8');
  const rig = readFileSync(join(root, 'uri/data/uri_rig.json'), 'utf8');
  const code =
    src('00_shared_helpers.js') +
    src('10_parts_render.js')
      .replace('__RIG__', rig)
      .replace(/__REFIMG__|__REFSIL__/g, '') +
    src('20_kinetics.js') +
    `
;prepParts();clr();
const OXr=CX-ORX,OYr=CY-ORY;
for(let z=0;z<ORDER.length;z++){const n=ORDER[z];const P=PARTS[n];
  if(n.startsWith('fist'))drawFist(P,P.pg[0]+OXr,P.pg[1]+OYr,0,z,__SPREAD__);else drawPart(P,P.pg[0]+OXr,P.pg[1]+OYr,0,z);}
globalThis.__OUT={fb:FB,own:OWN};
}`.replace('__SPREAD__', String(fistSpread));
  const ctx: Record<string, unknown> = {
    Math,
    console,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Int16Array,
    Int8Array,
    Float32Array,
    Float64Array,
    Array,
    Object,
    Set,
    Map,
    JSON,
    String,
    Number,
    parseInt,
  };
  ctx.atob = (s: string): string => Buffer.from(s, 'base64').toString('binary');
  ctx.globalThis = ctx;
  runInNewContext(code, ctx);
  const out = ctx.__OUT as { fb: Uint8ClampedArray; own: Int16Array };
  return { fb: out.fb, own: out.own, w: 640, h: 360 };
}
