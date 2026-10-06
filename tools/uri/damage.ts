/**
 * Gate 2C evidence: 우리's damage and breaking in the game beside the locked oracle, scenario by scenario, the same blows at the
 * same screen points (the oracle's `__K.hitAt(x, y, power)` / `__K.breakApart()`; the game's blows routed by UriBehaviour).
 * The oracle tears with Math.random, the game with its seeded streams: the pieces differ, the behaviour must not.
 * The game side is rasterised from the matter itself (each live part body's displayed pixels at its transform, every debris
 * chunk's sprite at its angle, 4-sample majority as the oracle) plus the two cores as discs where the live pass draws them.
 *   npx tsx tools/uri/damage.ts [--scenarios=hits,wrist,break] [--out=docs/gallery/wip]
 * Writes <out>/uri-2c-<scenario>.png: per shot, the oracle (left) and the game (right).
 */
import { PNG } from 'pngjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ANGLE_STEPS,
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type DamageEvent,
  type MatchConfig,
  type MatterBody,
  type TitanId,
  type BlowWeight,
} from '@/contracts';
import { createFighter } from '@/combat';
import type { FighterImpl } from '@/combat/fighter';
import type { UriBehaviour } from '@/combat/behaviours/uri';
import { makeDamageSum } from '@/combat/damageSum';
import { skipIntro } from '@/combat/testing/harness';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { createMatch } from '@/sim';
import { getTitanDef, URI_ID, uriDef } from '@/titans';
import { URI_ORDER, URI_REF, uriPart, type UriPartKey } from '@/titans/uri/rig';
import { launch } from '../lead/browser';
import { writePng } from '../lead/png';
import { URI_SIDES } from './sides';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const SCEN = opt('scenarios', 'hits,wrist,break').split(',');
const OUT = opt('out', 'docs/gallery/wip');
const W = 640;
const H = 360;
const OX = URI_REF.screenX - URI_REF.originX;
const OY = URI_REF.screenY - URI_REF.originY;
const POWER: Record<BlowWeight, number> = { light: 1.1, medium: 1.6, heavy: 2.2, catastrophic: 2.4 };

/** One scripted action at a frame: a blow at an oracle-screen point, a move, or the break-apart. */
type Act = { f: number } & ({ hit: [number, number]; w: BlowWeight } | { move: string } | { brk: true });
interface Scenario {
  name: string;
  side: string;
  acts: Act[];
  shots: number[];
}

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A live cell's centre of part `k` at rest, on the oracle's screen. */
function restPoint(k: UriPartKey, rnd: () => number, mat: Uint8Array): [number, number] {
  const p = uriPart(k);
  for (;;) {
    const i = Math.floor(rnd() * mat.length);
    if (!mat[i]) continue;
    return [p.x0 + (i % p.w) + 0.5 + OX, p.y0 + Math.floor(i / p.w) + 0.5 + OY];
  }
}

function scenarios(mats: Map<UriPartKey, Uint8Array>): Scenario[] {
  const rnd = mulberry(2024);
  const keys: UriPartKey[] = ['chamber', 'domeL', 'domeR', 'uaL', 'uaR', 'faL', 'faR', 'pelvis', 'moon'];
  const hits: Act[] = [{ f: 0, move: 'punch' }];
  for (let h = 0; h < 20; h++) {
    const k = keys[Math.floor(rnd() * keys.length)]!;
    hits.push({ f: 4 + h * 4, hit: restPoint(k, rnd, mats.get(k)!), w: 'medium' });
  }
  const fa = uriPart('faR');
  const wrist: [number, number] = [fa.jb![0] + OX, fa.jb![1] + OY];
  const wristActs: Act[] = [];
  // heavy blows around the wrist joint (a spiral out to 10 px: what a hole already took is missed)
  for (let h = 0; h < 16; h++)
    wristActs.push({
      f: h * 4,
      hit: [
        Math.round(wrist[0] + (Math.cos(h * 2.4) * (h * 10)) / 16),
        Math.round(wrist[1] + (Math.sin(h * 2.4) * (h * 10)) / 16),
      ],
      w: 'heavy',
    });
  const all: Scenario[] = [
    { name: 'hits', side: 'right', acts: hits, shots: [22, 44, 84, 150] },
    { name: 'wrist', side: 'right', acts: wristActs, shots: [9, 33, 65, 100, 160] },
    { name: 'break', side: 'right', acts: [{ f: 0, brk: true }], shots: [1, 10, 30, 60, 120] },
  ];
  return all.filter((s) => SCEN.includes(s.name));
}

/* ------------------------------------------------------------------ the oracle */

async function oracleShots(sc: Scenario[]): Promise<Map<string, Uint32Array[]>> {
  const out = new Map<string, Uint32Array[]>();
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(pathToFileURL(resolve('uri/reference/demos/uri-LOCKED-kinetic-pass.html')).href, {
      waitUntil: 'load',
    });
    await page.waitForTimeout(500);
    for (const s of sc) {
      // a fresh page per scenario: restore() does not mend torn parts
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(300);
      await page.evaluate((target) => {
        const K = (window as unknown as { __K: Record<string, unknown> }).__K as unknown as {
          playing: boolean;
          demo: boolean;
          target: number[];
          restore(): void;
          step(dt: number): void;
        };
        K.playing = false;
        K.demo = false;
        K.restore();
        K.target = target;
        for (let f = 0; f < 240; f++) K.step(1 / 60);
      }, URI_SIDES[s.side]!);
      const shots: Uint32Array[] = [];
      const last = Math.max(...s.shots);
      for (let f = 0; f <= last; f++) {
        const acts = s.acts.filter((a) => a.f === f);
        await page.evaluate(
          ({ acts, P }) => {
            const K = (window as unknown as { __K: Record<string, unknown> }).__K as unknown as {
              begin(n: string): void;
              hitAt(x: number, y: number, p: number): boolean;
              breakApart(): void;
              step(dt: number): void;
            };
            for (const a of acts as { hit?: [number, number]; w?: string; move?: string; brk?: boolean }[]) {
              if (a.move) K.begin(a.move);
              if (a.hit) K.hitAt(a.hit[0], a.hit[1], (P as Record<string, number>)[a.w!]!);
              if (a.brk) K.breakApart();
            }
            K.step(1 / 60);
          },
          { acts, P: POWER },
        );
        if (!s.shots.includes(f)) continue;
        const b64 = await page.evaluate(
          () => (document.getElementById('cvM') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]!,
        );
        const png = PNG.sync.read(Buffer.from(b64, 'base64'));
        const img = new Uint32Array(W * H);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const i = (y * png.width + x) * 4;
            img[y * W + x] = (255 << 24) | (png.data[i + 2]! << 16) | (png.data[i + 1]! << 8) | png.data[i]!;
          }
        shots.push(img);
      }
      out.set(s.name, shots);
      console.log(`oracle ${s.name}: ${shots.length} shots`);
    }
  } finally {
    await browser.close();
  }
  return out;
}

/* ------------------------------------------------------------------ the game */

/** Majority-4 rasterisation of a pixel source placed at (px, py) with angle `a` and pivot (cx, cy) in its own grid. */
function blit(
  img: Uint32Array,
  px: number,
  py: number,
  a: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  pix: Uint32Array,
  solid: (i: number) => boolean,
): void {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const ext = Math.hypot(w, h) + 2;
  for (let y = Math.max(0, Math.floor(py - ext)); y <= Math.min(H - 1, Math.ceil(py + ext)); y++)
    for (let x = Math.max(0, Math.floor(px - ext)); x <= Math.min(W - 1, Math.ceil(px + ext)); x++) {
      let cnt = 0;
      let best = -1;
      for (let s = 0; s < 4; s++) {
        const dx = x + (s & 1 ? 0.75 : 0.25) - px;
        const dy = y + (s & 2 ? 0.75 : 0.25) - py;
        const ix = Math.floor(dx * ca + dy * sa + cx);
        const iy = Math.floor(-dx * sa + dy * ca + cy);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        const i = iy * w + ix;
        if (!solid(i)) continue;
        cnt++;
        if (s === 3 || best < 0) best = i;
      }
      if (cnt >= 2) img[y * W + x] = pix[best]! | 0xff000000;
    }
}

function disc(img: Uint32Array, x: number, y: number, r: number, c: number): void {
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++)
    for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++)
      if (i >= 0 && j >= 0 && i < W && j < H && (i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2 <= r * r)
        img[j * W + i] = c;
}

function gameShots(s: Scenario): Uint32Array[] {
  const cfg: MatchConfig = {
    seed: 7,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: URI_ID, controller: 'human' },
      { titan: 'planet', controller: 'human' },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (sd) => createMatterWorld(sd),
    createFighter,
    getTitanDef: (id: TitanId) => (id === URI_ID ? uriDef() : getTitanDef(id)),
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  const u = m.fighters[0] as FighterImpl;
  const beh = u.behaviour as unknown as UriBehaviour;
  const w = m.world as MatterWorldEx;
  const kin = (beh as unknown as { kin: { t: number; begin(n: string): void } }).kin;
  m.step();
  // the reference → world offset without the idle bob, frozen here (the root does not move until the KO tumble)
  const base = {
    x: beh.offset.x - Math.sin(kin.t * 0.37) * 1.2,
    y: beh.offset.y - Math.sin(kin.t * 0.53) * 1.6,
  };
  const toWorld = (sx: number, sy: number): [number, number] => [sx - OX + base.x, sy - OY + base.y];
  const foe = m.fighters[1] as unknown as { px: number; py: number };
  const [tx, ty] = toWorld(...URI_SIDES[s.side]!);
  foe.px = tx;
  foe.py = ty;
  for (let f = 0; f < 240; f++) m.step();
  const shots: Uint32Array[] = [];
  const last = Math.max(...s.shots);
  for (let f = 0; f <= last; f++) {
    for (const a of s.acts.filter((q) => q.f === f)) {
      if ('move' in a) kin.begin(a.move);
      if ('brk' in a) (beh as unknown as { breakApart(): void }).breakApart();
      if ('hit' in a && !beh.brokenApart) {
        const [x, y] = toWorld(...a.hit);
        const ev: DamageEvent = {
          type: 'KINETIC',
          shape: { kind: 'point', x, y, r: 1 },
          energy: 400,
          dirX: 1,
          dirY: 0,
          duration: 1,
          sourceMass: 4,
          sourceBodyId: -1,
          originX: x,
          originY: y,
          flags: 0,
          params: {},
          weight: a.w,
        };
        beh.routeDamage(ev, makeDamageSum());
      }
    }
    m.step();
    if (!s.shots.includes(f)) continue;
    const img = new Uint32Array(W * H).fill(0xff120a0a);
    const toScreen = (x: number, y: number): [number, number] => [x - base.x + OX, y - base.y + OY];
    const bodies: MatterBody[] = [];
    for (const k of [
      'pyL',
      'pyR',
      'pelvis',
      ...URI_ORDER.filter((q) => !['pyL', 'pyR', 'pelvis'].includes(q)),
    ])
      if (!beh.isLost(k as UriPartKey)) bodies.push(beh.bodyOf(k as UriPartKey));
    for (const b of bodies) {
      const t = b.transform;
      const [px, py] = toScreen(t.x, t.y);
      const mat = b.map.material;
      blit(
        img,
        px,
        py,
        ((t.rot ?? 0) * 2 * Math.PI) / ANGLE_STEPS,
        t.anchorX,
        t.anchorY,
        b.map.w,
        b.map.h,
        b.map.pixels,
        (i) => mat[i] !== 0,
      );
    }
    for (const c of w.core.chunks.list) {
      if (!c.alive) continue;
      const [px, py] = toScreen(c.x, c.y);
      blit(img, px, py, c.angle, c.cx, c.cy, c.w, c.h, c.pixels, (i) => c.pixels[i]! >>> 24 !== 0);
    }
    const L = u
      .renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 1)
      .find((q) => q.id.startsWith('uri-front')) as unknown as {
      uriLive: {
        hotX: number;
        hotY: number;
        coldX: number;
        coldY: number;
        hotR: number;
        coldR: number;
        hp: number;
      };
    };
    const live = L.uriLive;
    const dim = live.hp > 0 ? 1 : 0.45;
    const sh = (r: number, g: number, b: number): number =>
      0xff000000 | (Math.round(b * dim) << 16) | (Math.round(g * dim) << 8) | Math.round(r * dim);
    disc(img, ...toScreen(live.hotX, live.hotY), live.hotR, sh(224, 116, 40));
    disc(img, ...toScreen(live.coldX, live.coldY), live.coldR, sh(138, 110, 224));
    shots.push(img);
  }
  console.log(
    `game ${s.name}: ${shots.length} shots, loop ${beh.loop.toFixed(1)}, fistR ${beh.isLost('fistR') ? 'gone' : 'on'}`,
  );
  return shots;
}

const mats = new Map(
  (await import('@/titans/uri/maps')).uriPartMatter().map((p) => [p.key, p.map.material] as const),
);
const sc = scenarios(mats);
const orc = await oracleShots(sc);
for (const s of sc) {
  const g = gameShots(s);
  const o = orc.get(s.name)!;
  const SW = W * 2;
  const sheet = new Uint32Array(SW * H * g.length);
  for (let r = 0; r < g.length; r++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        sheet[(r * H + y) * SW + x] = o[r]![y * W + x]!;
        sheet[(r * H + y) * SW + W + x] = g[r]![y * W + x]!;
      }
  const name = `${OUT}/uri-2c-${s.name}.png`;
  writePng(name, sheet, SW, H * g.length, 1);
  console.log(`saved ${name} (left: oracle, right: game; frames ${s.shots.join(', ')})`);
}
