import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { addDustBank } from '../toolkit/bank';
import { REF_X0, REF_Y0, addHeroStars, atRef, screenOf } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import { SpriteBuilder, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { layerBounds, makeStarField } from '../toolkit/stars';
import { addStreams } from '../toolkit/streams';
import {
  MAX_COMETS,
  type PrepareStep,
  type SceneryFrame,
  type SceneryInit,
  type SceneryLook,
} from '../types';

/**
 * STAR-BIRTH SHEARFIELD — violent, alive; the Planet's ground. A white-hot protostar tears its nursery apart: rose and orange gas
 * lanes sheared into long diagonal ribbons, plasma streaming off the star, clumps of proto-planetary matter, and rivers of rock
 * flowing through the fight. Comets (big matter chunks from the arena module) cross on visible trajectories: this layer gives
 * each one a tail and a faint dotted path ahead of it, so the Planet's Comet Shepherd has something to read.
 *
 * Reacting to the fight (≥ 3 reactive depth layers):
 *  - the gas lanes wake behind moving bodies, swirl and ripple after impacts (far → mid, forces at depth);
 *  - plasma ribbons bend with the shock rings;
 *  - the ASTEROID RIVERS bend toward gravity wells (Tidal Draw) and scatter under blasts (near);
 *  - wake dust in the fight plane; foreground gas wisps.
 * Value: the lanes are bright high and low; the fight band is compressed hard so both titans keep their silhouettes.
 */

const LOOK: SceneryLook = {
  exposure: 1.0,
  contrast: 1.08,
  bloomThreshold: 0.9,
  bloomGain: 0.5,
  godRayGain: 0.3,
  godRayGas: 0.18,
  godRayHalo: 130,
  godRayDecay: 0.968,
  vignette: 0.6,
  foreground: { color: [0.09, 0.035, 0.05], alpha: 0.9, density: 0.6 },
  spriteHalo: { strength: 0.34, radius: 10, desat: 0.45, rim: 0.5, rimReach: 1 },
  fightBand: { top: -150, bottom: 120, feather: 90, ceiling: 0.3, keep: 0.22 },
};

const STAR_PARALLAX = 0.05;
const STAR = { sx: 60, sy: 50 } as const;

/* Gas lanes: anisotropic fbm sheared along the field's direction, flowing fast along the lanes; dark lanes between. */
const LANES_FRAGMENT = /* glsl */ `
uniform vec2 uDir;         // shear direction (unit, screen)
uniform vec3 uCa;          // thin rose
uniform vec3 uCb;          // dense orange
uniform vec3 uCc;          // hot edge
uniform float uSpeed;
uniform float uForceK;
uniform float uGain;
uniform vec2 uBandDim;     // screen y of the fight height, depth of the dimming there (value room for a lit dark body)
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 n = vec2(-uDir.y, uDir.x);
  float u = dot(lp, uDir);
  float v = dot(lp, n);
  float warp = (fbm(vec2(u / 260.0, v / 90.0) + 3.1, 3) - 0.5) * 70.0;
  float lane = fbm(vec2(u / 520.0 - uFlow * uSpeed, (v + warp) / 34.0), 5);
  float d = smoothstep(0.45, 0.85, lane);
  float edge = smoothstep(0.62, 0.7, lane) - smoothstep(0.7, 0.86, lane);
  vec3 col = mix(uCa, uCb, smoothstep(0.55, 0.9, lane)) * d + uCc * max(edge, 0.0) * 0.6;
  col += impulseGlow(sp) * d * 0.4;
  float dy = (sp.y - uBandDim.x) / 80.0;
  col *= 1.0 - uBandDim.y * exp(-dy * dy);
  o = vec4(col * uGain * (1.0 + 0.4 * uIntensity), 1.0);
}
`;

/* The protostar's accretion disc: a tilted, flaring glow with a dark lane through it. */
const DISC_FRAGMENT = /* glsl */ `
uniform vec2 uC;           // centre (layer px)
uniform vec3 uHot;
uniform vec3 uWarm;
uniform float uForceK;
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax - uC;
  float a = -0.35;
  vec2 q = vec2(lp.x * cos(a) - lp.y * sin(a), lp.x * sin(a) + lp.y * cos(a));
  q.y *= 4.5;
  float r = length(q) / 150.0;
  float disc = exp(-r * r * 3.0) * (0.7 + 0.3 * fbm(vec2(atan(q.y, q.x) * 3.0 + uFlow * 0.05, r * 6.0), 3));
  float lane = smoothstep(2.0, 0.0, abs(q.y) / 4.5) * smoothstep(0.08, 0.3, r);
  vec3 col = mix(uWarm, uHot, exp(-r * 4.0)) * disc * (1.0 - 0.85 * lane);
  o = vec4(col, 1.0);
}
`;

/* Asteroid rivers: rocks flowing along a sinuous lane; lumpy, edge-lit; bent by gravity wells, scattered by blasts. */
const ROCK_HEADER_VERT = /* glsl */ `
uniform float uParallax;
uniform float uForceK;
uniform vec4 uRiver;       // x0, x1 (layer px), base y, amplitude
uniform vec2 uRiverK;      // wave number, flow speed (px per flow-second)
`;
const ROCK_VERT = /* glsl */ `
float par = uParallax;
float L = uRiver.y - uRiver.x;
float s = fract(aR0.x + uFlow * uRiverK.y * aR1.y / L);
float x = uRiver.x + s * L;
float y = uRiver.z + sin(x * uRiverK.x + aR0.y * 0.4) * uRiver.w + aR0.z;
vec2 c = vec2(x, y) - floor(uView * par + 0.5);
c = warpByForces(c, uForceK);
float size = aR1.x;
float ext = size * 1.6 + 4.0;
if (c.x < -ext || c.y < -ext || c.x > uRes.x + ext || c.y > uRes.y + ext) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0); vP = vec4(0.0);
  return;
}
float ang = aR0.w + uTime * (aR1.z - 0.5) * 0.4;
float cs = cos(ang);
float sn = sin(ang);
vec2 q = position.xy * 1.2;
vec2 off = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * size;
gl_Position = toNdc(camWarp(c, par) + off * camScale(par));
vQ = q;
vP = vec4(aR0.w, ang, aR1.z, smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.95, 1.0, s)));
`;
const ROCK_HEADER_FRAG = /* glsl */ `
uniform vec3 uRock0;
uniform vec3 uRock1;
uniform vec3 uRimC;
uniform vec2 uSunDir;
`;
const ROCK_FRAG = /* glsl */ `
float a = atan(vQ.y, vQ.x);
float rr = 0.78 + 0.13 * sin(a * 3.0 + vP.x * 9.0) + 0.07 * sin(a * 5.0 + vP.z * 13.0);
float r = length(vQ);
if (r > rr) discard;
vec2 sd = vec2(uSunDir.x * cos(vP.y) + uSunDir.y * sin(vP.y), -uSunDir.x * sin(vP.y) + uSunDir.y * cos(vP.y));
float lit = clamp(dot(vQ / max(r, 1e-3), sd) * smoothstep(rr * 0.4, rr, r), 0.0, 1.0);
vec3 c = mix(uRock0, uRock1, floor(lit * 3.0) / 3.0) + uRimC * step(rr - 0.14, r) * lit * 0.8;
o = vec4(c, vP.w);
`;

/* Comets: a tail streaming back from each (with its coma) and a faint dotted trajectory ahead. Two instances per comet slot. */
const COMET_HEADER_VERT = /* glsl */ `
uniform vec4 uComet[${MAX_COMETS}];
uniform vec4 uComet2[${MAX_COMETS}];
uniform int uNComet;
`;
const COMET_VERT = /* glsl */ `
int idx = int(aC0.x);
bool path = aC0.y > 0.5;
if (idx >= uNComet) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0); vP = vec4(0.0);
  return;
}
vec4 cm = uComet[idx];
vec4 c2 = uComet2[idx];
vec2 v = cm.zw;
float sp = max(length(v), 1.0);
vec2 dir = v / sp;
vec2 nrm = vec2(-dir.y, dir.x);
float r = max(c2.x, 3.0);
float warn = c2.z;
// tail: back along -v, longer when faster; path: ahead along +v, ~2 s of travel.
// A WARNING (not in play yet): the tail instance becomes a glint at the entry point pointing in, growing as entry nears; the
// path instance shows the planned line.
float len = path ? clamp(sp * 2.0, 80.0, 420.0) : (warn > 0.0 ? 10.0 + 26.0 * warn : clamp(30.0 + sp * 0.35, 40.0, 160.0));
float wid = path ? 1.5 : (warn > 0.0 ? 1.5 + 2.0 * warn : r * 1.6);
// an entry point off screen pins its glint to the frame edge it will come through
vec2 at = warn > 0.0 ? clamp(cm.xy, vec2(6.0), uRes - 6.0) : cm.xy;
vec2 base = at + (path ? dir * (warn > 0.0 ? 4.0 : r + 6.0) : vec2(0.0));
float t = position.x * 0.5 + 0.5;                      // 0 at the comet, 1 at the far end
vec2 along = path || warn > 0.0 ? dir : -dir;
vec2 p = base + along * t * len + nrm * position.y * wid * (path ? 1.0 : (1.0 - 0.6 * t));
gl_Position = toNdc(p);
vQ = vec2(t * len, position.y);
vP = vec4(path ? 1.0 : 0.0, len, c2.y, warn);
`;
const COMET_HEADER_FRAG = /* glsl */ `
uniform vec3 uHead;
uniform vec3 uTail;
uniform vec3 uPath;
uniform vec3 uCaught;
`;
const COMET_FRAG = /* glsl */ `
float t = vQ.x / max(vP.y, 1.0);
vec3 col;
float a;
if (vP.x > 0.5) {
  // a dotted line, fading ahead: dashes every 10 px
  if (fract(vQ.x / 10.0) > 0.35) discard;
  a = (1.0 - t) * (vP.w > 0.0 ? 0.25 + 0.3 * vP.w : 0.55);
  col = mix(uPath, uCaught, vP.z);
} else if (vP.w > 0.0) {
  // the warning glint: a hot needle pointing into the arena, pulsing (~4 Hz over a 1.5 s warning) as it grows
  float core = exp(-pow(vQ.y, 2.0) * 4.0);
  float flick = 0.75 + 0.25 * sin(vP.w * 40.0);
  a = core * (1.0 - t) * (0.4 + 0.6 * vP.w) * flick;
  col = uHead;
} else {
  float core = exp(-pow(vQ.y, 2.0) * 3.0);
  a = core * pow(1.0 - t, 1.6);
  col = mix(uHead, uTail, smoothstep(0.0, 0.6, t));
  col = mix(col, uCaught, vP.z * 0.5);
}
// additive layers blend with SRC_ALPHA (and never write alpha): colour × a
o = vec4(col, a);
`;

export class ShearfieldScenery extends SceneryBase {
  readonly id = 'shearfield' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x534846;
  private info: StageInfo = STAGE_INFO.shearfield;
  private light: [number, number] = atRef(STAR.sx, STAR.sy, STAR_PARALLAX);
  private view = { x0: REF_X0, y0: REF_Y0 };

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const arena = this.info.arena;
    const R = paletteRamps(this.info);
    // ramp order of STAGE_INFO.shearfield: void, rose, orange, white-hot, umber, violet, cyan, coral
    const [VOID, ROSE, ORANGE, HOT, UMBER, VIOLET, CYAN, CORAL] = [
      R[0]!,
      R[1]!,
      R[2]!,
      R[3]!,
      R[4]!,
      R[5]!,
      R[6]!,
      R[7]!,
    ];
    const rng = new Rng(0x5348);
    const sunDir: [number, number] = [-0.75, -0.66];
    const dir: [number, number] = [Math.cos(-0.33), Math.sin(-0.33)];

    /* ---- 1. the dark, rose-lit toward the star ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 360,
      warp: 1.1,
      octaves: 4,
      thresh: [0.28, 0.95],
      colA: scale(VOID[2]!, 0.7),
      colB: scale(VIOLET[2]!, 0.5),
      colC: scale(ROSE[3]!, 0.45),
      colD: scale(CORAL[1]!, 0.4),
      gain: 0.55,
      lightDir: [-0.7, -0.6],
      litK: 0.5,
      flowSpeed: 0.008,
      seed: [5.3, 2.2],
      mode: 'emit',
      forceK: 0.25,
    });
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: 600,
        bounds: layerBounds(arena, 0.04),
        size: [0.55, 1.0],
        base: 0.3,
        boost: 1.4,
        seed: 711,
      }),
      parallax: 0.04,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.12,
      forceK: 0.5,
    });
    // a scatter of cyan ions far off: the one cool accent
    const ion = new SpriteBuilder();
    const ib = layerBounds(arena, 0.08);
    for (let i = 0; i < 90; i++) {
      const c = rampAt(CYAN, rng.range(0.3, 0.8));
      const k = rng.range(0.3, 1.0);
      ion.push(
        rng.range(ib.x0, ib.x1),
        rng.range(ib.y0, ib.y0 + (ib.y1 - ib.y0) * 0.45),
        0,
        rng.next(),
        1,
        1,
        0,
        c[0] * k,
        c[1] * k,
        c[2] * k,
        1,
      );
    }
    kit.addSprites('ions', {
      buffer: ion.build(),
      parallax: 0.08,
      blend: 'add',
      soft: 3,
      snap: true,
      twinkle: 0.3,
      forceK: 0.6,
    });
    yield 0.1;

    /* ---- 2. the protostar and its accretion disc (the stage light) ---- */
    const sc = this.light;
    kit.addFullscreen('disc', DISC_FRAGMENT, 'add', STAR_PARALLAX, {
      uC: { value: [sc[0], sc[1]] },
      uHot: { value: [...scale(HOT[2]!, 1.6)] },
      uWarm: { value: [...scale(ORANGE[4]!, 0.9)] },
      uForceK: { value: 0.3 },
    });
    addHeroStars(kit, 'protostar', [
      {
        sx: STAR.sx,
        sy: STAR.sy,
        size: 120,
        core: 10,
        bright: 5,
        tint: rampAt(HOT, 0.8),
        parallax: STAR_PARALLAX,
        rot: 0.2,
      },
    ]);
    yield 0.18;

    /* ---- 3. gas lanes: far and mid, sheared along the field ---- */
    kit.addFullscreen('lanes-far', LANES_FRAGMENT, 'add', 0.12, {
      uDir: { value: dir },
      uCa: { value: [...scale(ROSE[3]!, 0.5)] },
      uCb: { value: [...scale(CORAL[2]!, 0.55)] },
      uCc: { value: [...scale(ORANGE[6]!, 0.6)] },
      uSpeed: { value: 0.05 },
      uForceK: { value: 0.8 },
      uGain: { value: 0.75 },
      uBandDim: { value: [200, 0.55] },
    });
    kit.addFullscreen('lanes-mid', LANES_FRAGMENT, 'add', 0.3, {
      uDir: { value: [Math.cos(-0.28), Math.sin(-0.28)] },
      uCa: { value: [...scale(ROSE[2]!, 0.45)] },
      uCb: { value: [...scale(ORANGE[3]!, 0.5)] },
      uCc: { value: [...scale(HOT[0]!, 0.5)] },
      uSpeed: { value: 0.09 },
      uForceK: { value: 1.4 },
      uGain: { value: 0.45 },
      uBandDim: { value: [200, 0.55] },
    });
    yield 0.3;

    /* ---- 4. plasma ribbons streaming off the protostar ---- */
    const so = atRef(STAR.sx, STAR.sy, 0.24);
    addStreams(kit, 'plasma', {
      parallax: 0.24,
      origin: [so[0], so[1]],
      count: 900,
      angle: [-0.15, 0.75],
      axisBias: 1.6,
      distance: [20, 760],
      speed: 70,
      size: [0.8, 2.2],
      stretch: 6,
      wobble: 8,
      colors: [rampAt(HOT, 0.9), rampAt(ORANGE, 0.6), rampAt(ROSE, 0.3)],
      brightness: 1.3,
      forceK: 1.1,
      seed: 721,
    });
    yield 0.4;

    /* ---- 5. proto-planetary matter: dark knots in the lanes, rim-lit by the star ---- */
    const kb = new SpriteBuilder();
    const kbb = layerBounds(arena, 0.42);
    for (let i = 0; i < 160; i++) {
      const c = mixRgb(rampAt(UMBER, rng.range(0.1, 0.4)), rampAt(VIOLET, 0.2), rng.next() * 0.4);
      const u = rng.next();
      const sy = u < 0.5 ? rng.range(10, 110) : rng.range(300, 370);
      kb.push(
        rng.range(kbb.x0, kbb.x1),
        atRef(0, sy, 0.42)[1],
        0,
        rng.next(),
        rng.range(3, 9),
        rng.range(2, 6),
        rng.range(0, 3.1),
        c[0],
        c[1],
        c[2],
        0.85,
      );
    }
    kit.addSprites('knots', {
      buffer: kb.build(),
      parallax: 0.42,
      blend: 'normal',
      soft: 3,
      breakup: 0.6,
      forceK: 1.2,
      drift: 4,
      driftFreq: 1 / 90,
      driftSpeed: 0.05,
    });
    yield 0.5;

    /* ---- 6. asteroid rivers: one behind the fight, one in front of the far lanes ---- */
    const river = (
      name: string,
      par: number,
      count: number,
      sy: number,
      amp: number,
      sizes: [number, number],
      speed: number,
      forceK: number,
      seed: number,
    ): void => {
      const b = layerBounds(arena, par, 120);
      const r0 = new Float32Array(count * 4);
      const r1 = new Float32Array(count * 4);
      const rr = new Rng(seed);
      for (let i = 0; i < count; i++) {
        r0.set([rr.next(), rr.range(-1, 1), rr.gauss() * amp * 0.25, rr.range(0, 6.28)], i * 4);
        r1.set(
          [sizes[0] + (sizes[1] - sizes[0]) * Math.pow(rr.next(), 2.2), rr.range(0.7, 1.3), rr.next(), 0],
          i * 4,
        );
      }
      kit.addInstanced(name, {
        count,
        attributes: { aR0: r0, aR1: r1 },
        varyings: ['vec2 vQ', 'vec4 vP'],
        vertex: ROCK_VERT,
        fragment: ROCK_FRAG,
        vertexHeader: ROCK_HEADER_VERT,
        fragmentHeader: ROCK_HEADER_FRAG,
        blend: 'normal',
        uniforms: {
          uParallax: { value: par },
          uForceK: { value: forceK },
          uRiver: { value: [b.x0, b.x1, atRef(0, sy, par)[1], amp] },
          uRiverK: { value: [0.006, speed] },
          uRock0: { value: [...scale(UMBER[0]!, 1.0)] },
          uRock1: { value: [...scale(UMBER[3]!, 1.0)] },
          uRimC: { value: [...scale(ORANGE[5]!, 0.9)] },
          uSunDir: { value: sunDir },
        },
      });
    };
    river('river-far', 0.55, 140, 92, 38, [1.5, 5], 26, 1.6, 731);
    river('river-near', 0.82, 70, 330, 26, [3, 9], 40, 2.4, 732);
    yield 0.65;

    /* ---- 7. comets: tails and dotted paths for the arena module's comets (drawn in the fight plane, behind the bodies) ---- */
    const c0 = new Float32Array(MAX_COMETS * 2 * 4);
    for (let i = 0; i < MAX_COMETS * 2; i++) c0.set([Math.floor(i / 2), i % 2, 0, 0], i * 4);
    kit.addInstanced('comets', {
      count: MAX_COMETS * 2,
      attributes: { aC0: c0 },
      varyings: ['vec2 vQ', 'vec4 vP'],
      vertex: COMET_VERT,
      fragment: COMET_FRAG,
      vertexHeader: COMET_HEADER_VERT,
      fragmentHeader: COMET_HEADER_FRAG,
      blend: 'add',
      uniforms: {
        uHead: { value: [...scale(HOT[3]!, 2.2)] },
        uTail: { value: [...scale(CYAN[3]!, 1.2)] },
        uPath: { value: [...scale(CYAN[4]!, 0.8)] },
        uCaught: { value: [...scale(ORANGE[6]!, 1.2)] },
      },
    });
    yield 0.75;

    /* ---- 8. the floor: violet dust, a coral lip; wake dust in the fight plane ---- */
    addDustBank(kit, 'floor', {
      parallax: 0.78,
      col: scale(VOID[1]!, 0.9),
      rim: scale(CORAL[1]!, 0.8),
      lip: 0.08,
      top: 0.9,
      slope: 0.07,
      roughness: 0.25,
      soft: 0.2,
      scale: [220, 60],
      speed: 0.02,
      alpha: 0.95,
      forceK: 1.2,
      rimK: 0.9,
    });
    kit.addSprites('wake-gas', {
      buffer: makeStarField({
        count: 280,
        bounds: layerBounds(arena, 0.95),
        size: [0.8, 1.8],
        base: 0.14,
        boost: 0.5,
        tint: mixRgb(rampAt(ROSE, 0.6), rampAt(ORANGE, 0.5), 0.5),
        seed: 741,
      }),
      parallax: 0.95,
      blend: 'add',
      soft: 2.2,
      drift: 7,
      driftFreq: 1 / 100,
      driftSpeed: 0.08,
      forceK: 2.6,
    });
  }

  protected override onUpdate(frame: SceneryFrame): void {
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
  }

  lightScreenPos(out: { x: number; y: number }): void {
    screenOf(this.light[0], this.light[1], STAR_PARALLAX, this.view, out);
  }
}
