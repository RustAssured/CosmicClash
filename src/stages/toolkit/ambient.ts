import { Rng, hash32 } from '@/contracts';
import { SpriteBuilder, type KitLayer, type SceneryKit } from './kit';
import type { Rgb } from './color';

/**
 * Ambient life for a backdrop: comets that streak across the sky and distant supernovae that flare and fade.
 *
 * Everything is a PURE FUNCTION OF TIME (`update(timeSec)`): event n of slot i is generated from hash32(seed, i, n), so
 * the sky is identical for a given clock reading (screenshots and replays are reproducible) and nothing accumulates
 * state. Events live in a handful of pre-allocated instanced sprites whose attributes are rewritten each frame.
 */

export interface AmbientOpts {
  seed: number;
  /** Parallax of the sky these live in (they are far away: ≈ 0.03–0.08). */
  parallax: number;
  /** Colour of comet heads/tails and of the supernova flare (linear HDR, multiplied by brightness). */
  cometColor: Rgb;
  flareColor: Rgb;
  /** Comet slots, seconds between comets (per slot) and their lifetime in seconds. */
  comets: number;
  cometPeriod: [number, number];
  cometLife: number;
  /** Supernova flare slots and the seconds between flares. */
  flares: number;
  flarePeriod: [number, number];
  /** Layer-space region events are placed in (screen px at the reference camera, before parallax). */
  region: { x0: number; y0: number; x1: number; y1: number };
}

const TAIL_SEGMENTS = 3;

interface CometSlot {
  period: number;
  offset: number;
  n: number;
  sx: number;
  sy: number;
  speed: number;
  dirX: number;
  dirY: number;
  jitter: [number, number, number];
}

interface FlareSlot {
  period: number;
  offset: number;
  n: number;
  x: number;
  y: number;
}

export class AmbientLife {
  private readonly tails: KitLayer;
  private readonly heads: KitLayer;
  private readonly rings: KitLayer;
  private readonly comets: CometSlot[] = [];
  private readonly flares: FlareSlot[] = [];
  private readonly tailBuf: SpriteArrays;
  private readonly headBuf: SpriteArrays;
  private readonly ringBuf: SpriteArrays;

  constructor(
    kit: SceneryKit,
    private readonly o: AmbientOpts,
  ) {
    const blank = (n: number): ReturnType<SpriteBuilder['build']> => {
      const b = new SpriteBuilder();
      for (let i = 0; i < n; i++) b.push(-9999, -9999, 0, i / Math.max(1, n), 1, 1, 0, 0, 0, 0, 0);
      return b.build();
    };
    this.tails = kit.addSprites('ambient-tails', {
      buffer: blank(o.comets * TAIL_SEGMENTS),
      parallax: o.parallax,
      blend: 'add',
      soft: 2.4,
      forceK: 0.05,
    });
    this.heads = kit.addSprites('ambient-heads', {
      buffer: blank(o.comets + o.flares),
      parallax: o.parallax,
      blend: 'add',
      profile: 'star',
      soft: 1.6,
      forceK: 0.05,
    });
    this.rings = kit.addSprites('ambient-rings', {
      buffer: blank(o.flares),
      parallax: o.parallax,
      blend: 'add',
      profile: 'ring',
      forceK: 0.05,
    });
    this.tailBuf = arraysOf(this.tails);
    this.headBuf = arraysOf(this.heads);
    this.ringBuf = arraysOf(this.rings);
    const rnd = (...k: number[]): number => hash32(...k) / 4294967296;
    for (let i = 0; i < o.comets; i++) {
      const period = o.cometPeriod[0] + (o.cometPeriod[1] - o.cometPeriod[0]) * rnd(o.seed, i);
      this.comets.push({
        period,
        offset: rnd(o.seed, i, 7) * period,
        n: -1,
        sx: 0,
        sy: 0,
        speed: 0,
        dirX: 1,
        dirY: 0,
        jitter: [0, 0, 0],
      });
    }
    for (let i = 0; i < o.flares; i++) {
      const period = o.flarePeriod[0] + (o.flarePeriod[1] - o.flarePeriod[0]) * rnd(o.seed, 100 + i);
      this.flares.push({ period, offset: rnd(o.seed, 100 + i, 9) * period, n: -1, x: 0, y: 0 });
    }
  }

  /** Roll the random parameters of comet event `n` (only when the event index changes: allocation-free otherwise). */
  private rollComet(i: number, c: CometSlot, n: number): void {
    const o = this.o;
    const rng = new Rng(hash32(o.seed, i, n, 3));
    const fromLeft = rng.chance(0.5);
    c.n = n;
    c.sx = fromLeft ? o.region.x0 : o.region.x1;
    c.sy = o.region.y0 + rng.next() * (o.region.y1 - o.region.y0) * 0.55;
    c.speed = 95 + rng.next() * 90;
    const ang = 0.25 + rng.next() * 0.5;
    c.dirX = Math.cos(ang) * (fromLeft ? 1 : -1);
    c.dirY = Math.sin(ang);
    c.jitter[0] = rng.next() * 6;
    c.jitter[1] = rng.next() * 6;
    c.jitter[2] = rng.next() * 6;
  }

  private rollFlare(i: number, f: FlareSlot, n: number): void {
    const o = this.o;
    const rng = new Rng(hash32(o.seed, 100 + i, n, 5));
    f.n = n;
    f.x = o.region.x0 + rng.next() * (o.region.x1 - o.region.x0);
    f.y = o.region.y0 + rng.next() * (o.region.y1 - o.region.y0);
  }

  update(t: number): void {
    const o = this.o;
    let ti = 0;
    for (let i = 0; i < this.comets.length; i++) {
      const c = this.comets[i]!;
      const n = Math.floor((t + c.offset) / c.period);
      const u = t + c.offset - n * c.period;
      if (n !== c.n) this.rollComet(i, c, n);
      const active = u < o.cometLife;
      const hx = c.sx + c.dirX * c.speed * u;
      const hy = c.sy + c.dirY * c.speed * u;
      const fade = active ? Math.min(1, u / 0.6) * Math.min(1, (o.cometLife - u) / 1.2) : 0;
      const flick = 0.85 + 0.15 * Math.sin(u * 23 + i);
      const rot = Math.atan2(c.dirY, c.dirX);
      for (let k = 0; k < TAIL_SEGMENTS; k++) {
        const len = 26 + k * 34 + c.jitter[k]!;
        const b = fade * (0.22 - k * 0.05);
        setSprite(
          this.tailBuf,
          ti++,
          active ? hx - c.dirX * len * 0.5 : -9999,
          hy - c.dirY * len * 0.5,
          len * 0.5,
          1.5 + k * 0.5,
          rot,
          o.cometColor,
          b,
          1,
        );
      }
      setSprite(this.headBuf, i, active ? hx : -9999, hy, 22, 22, 0.3, o.cometColor, 2.4 * fade * flick, 1);
    }
    for (let i = 0; i < this.flares.length; i++) {
      const f = this.flares[i]!;
      const n = Math.floor((t + f.offset) / f.period);
      const u = t + f.offset - n * f.period;
      if (n !== f.n) this.rollFlare(i, f, n);
      // fast rise, slow exponential decay; the shell expands and thins
      const env = u < 0.25 ? u / 0.25 : Math.exp(-(u - 0.25) / 1.7);
      const on = u < 7 ? env : 0;
      const shell = Math.min(1, u / 4.5);
      setSprite(
        this.headBuf,
        this.comets.length + i,
        on > 0.01 ? f.x : -9999,
        f.y,
        46,
        46,
        0.2,
        o.flareColor,
        4 * on,
        1,
      );
      const ringA = on > 0.01 && u > 0.2 ? Math.max(0, 1 - shell) * 0.5 : 0;
      setSprite(
        this.ringBuf,
        i,
        ringA > 0.01 ? f.x : -9999,
        f.y,
        6 + 64 * shell,
        6 + 64 * shell,
        0,
        o.flareColor,
        ringA,
        1,
      );
    }
    for (const l of [this.tails, this.heads, this.rings]) {
      l.mesh.geometry.getAttribute('aPos').needsUpdate = true;
      l.mesh.geometry.getAttribute('aShape').needsUpdate = true;
      l.mesh.geometry.getAttribute('aColor').needsUpdate = true;
    }
  }
}

interface SpriteArrays {
  pos: Float32Array;
  shape: Float32Array;
  color: Float32Array;
}

function arraysOf(layer: KitLayer): SpriteArrays {
  const g = layer.mesh.geometry;
  return {
    pos: g.getAttribute('aPos').array as Float32Array,
    shape: g.getAttribute('aShape').array as Float32Array,
    color: g.getAttribute('aColor').array as Float32Array,
  };
}

function setSprite(
  a: SpriteArrays,
  i: number,
  x: number,
  y: number,
  hw: number,
  hh: number,
  rot: number,
  rgb: Rgb,
  k: number,
  alpha: number,
): void {
  a.pos[i * 4] = x;
  a.pos[i * 4 + 1] = y;
  a.shape[i * 4] = hw;
  a.shape[i * 4 + 1] = hh;
  a.shape[i * 4 + 2] = rot;
  a.color[i * 4] = rgb[0] * k;
  a.color[i * 4 + 1] = rgb[1] * k;
  a.color[i * 4 + 2] = rgb[2] * k;
  a.color[i * 4 + 3] = alpha;
}
