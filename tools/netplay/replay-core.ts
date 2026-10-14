/**
 * Netplay Step 0 (docs/netplay/STEP0.md): the engine-neutral core of the replay tool. No Node or DOM imports, so the same
 * code runs under Node (tsx, any flags) and bundled in a browser page (tools/netplay/crossengine.ts).
 *
 * A Recording is a match config plus every tick's input frame for both slots, exactly as the sim polled it. `recordMatch`
 * makes one by letting two AIs fight and logging what they pressed; `replayMatch` plays it back with no AI (pure input
 * lockstep, as a netplay peer would) and returns the state hash of every tick.
 */
import {
  DEFAULT_ARENA,
  ROUND_LENGTH_PACE,
  ROUND_LENGTH_SECONDS,
  type InputFrame,
  type InputSource,
  type MatchConfig,
  type StageId,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { arenaForMatch } from '@/combat/mouth/arena';
import { createMatterWorld } from '@/matter';
import { TITAN_SKY } from '@/render/unified';
import { createAiSource, createMatch, type Match } from '@/sim';
import { STAGE_INFO } from '@/stages/info';
import { getTitanDef } from '@/titans';

/** Every titan a netplay match can field: the roster (the Cradle and 우리 included) plus the boss, the Mouth. */
export const NET_TITANS: readonly TitanId[] = [
  'colossus',
  'lastone',
  'asteroid',
  'nexus',
  'blackhole',
  'supernova',
  'planet',
  'uri',
  'cradle',
  'mouth',
] as TitanId[];

/** Every unordered pairing, mirrors included (10 titans: 55 pairings). */
export function allPairings(): [TitanId, TitanId][] {
  const out: [TitanId, TitanId][] = [];
  for (let i = 0; i < NET_TITANS.length; i++)
    for (let j = i; j < NET_TITANS.length; j++) out.push([NET_TITANS[i]!, NET_TITANS[j]!]);
  return out;
}

export interface Recording {
  v: 1;
  a: TitanId;
  b: TitanId;
  stage: StageId;
  seed: number;
  ticks: number;
  /** Per slot, per tick (t = 1 … ticks): moveX, moveY, held: 3 numbers a tick. Edges are derived on playback. */
  inputs: [number[], number[]];
}

export function matchConfig(
  rec: Pick<Recording, 'a' | 'b' | 'stage' | 'seed'>,
  controller: 'ai' | 'human',
): MatchConfig {
  return {
    seed: rec.seed,
    stage: rec.stage,
    mode: controller === 'ai' ? 'aivai' : 'versus',
    footwork: 'orbit',
    // pinned: a netplay config must name its pace and clock (the default reads a global the debug overlay can move)
    pace: ROUND_LENGTH_PACE.normal,
    roundSeconds: ROUND_LENGTH_SECONDS.normal,
    slots: [
      { titan: rec.a, controller, aiLevel: 5 },
      { titan: rec.b, controller, aiLevel: 5 },
    ],
  };
}

export function buildMatch(cfg: MatchConfig): Match {
  const stage = STAGE_INFO[cfg.stage];
  return createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: arenaForMatch(stage?.arena ?? DEFAULT_ARENA, [cfg.slots[0].titan, cfg.slots[1].titan]),
    lighting: TITAN_SKY,
  });
}

/** Wraps a source and logs every frame it produces (moveX, moveY, held). */
function logging(src: InputSource, log: number[]): InputSource {
  return {
    kind: src.kind,
    poll(tick, out) {
      src.poll(tick, out);
      log.push(out.moveX, out.moveY, out.held);
    },
  };
}

/**
 * A recorded input stream played back by tick: edges derived from held, exactly as the live sources do. `fromTick`: the
 * last tick already played (a source taking over mid-match starts from that tick's held buttons).
 */
export function playbackSource(log: readonly number[], fromTick = 0): InputSource {
  const o0 = (fromTick - 1) * 3 + 2;
  let prev = fromTick > 0 && o0 < log.length ? log[o0]! : 0;
  return {
    kind: 'human',
    poll(tick: number, out: InputFrame) {
      const o = (tick - 1) * 3;
      const held = o + 2 < log.length ? log[o + 2]! : 0;
      out.moveX = o < log.length ? log[o]! : 0;
      out.moveY = o + 1 < log.length ? log[o + 1]! : 0;
      out.held = held;
      out.pressed = held & ~prev;
      out.released = prev & ~held;
      prev = held;
    },
  };
}

/** Let two level-5 AIs fight for `ticks` ticks and log their inputs. Also returns the hashes of that live run. */
export function recordMatch(
  a: TitanId,
  b: TitanId,
  seed: number,
  ticks: number,
  stage: StageId = 'nursery',
): { rec: Recording; hashes: Uint32Array } {
  const rec: Recording = { v: 1, a, b, stage, seed, ticks, inputs: [[], []] };
  const m = buildMatch(matchConfig(rec, 'ai'));
  m.setSources(
    logging(
      createAiSource(m, 0, createAI(5, getTitanDef(a), seed * 7 + 1, { footwork: 'orbit' })),
      rec.inputs[0],
    ),
    logging(
      createAiSource(m, 1, createAI(5, getTitanDef(b), seed * 7 + 2, { footwork: 'orbit' })),
      rec.inputs[1],
    ),
  );
  const hashes = new Uint32Array(ticks);
  for (let t = 0; t < ticks; t++) {
    m.step();
    hashes[t] = m.hash();
  }
  return { rec, hashes };
}

export interface ReplayResult {
  a: TitanId;
  b: TitanId;
  ticks: number;
  /** Full state hash (Match.hash) after every tick. */
  hashes: Uint32Array;
  /** The cheap netplay checksum (Match.checksum) after every tick, when the build has it. */
  checksums: Uint32Array | null;
  /** Every `every` ticks: [tick, hash, phase, round, wins0, wins1]. */
  checkpoints: (string | number)[][];
  final: { tick: number; phase: string; round: number; wins: [number, number]; hash: number };
  /** Wall time of the whole replay (ms), sim + hashing. */
  ms: number;
}

/**
 * A replay that can be advanced in slices (a browser page yields between slices so no engine flags the script as hung).
 * `advance(n)` runs up to n more ticks and returns true once every tick has run.
 */
export function startReplay(
  rec: Recording,
  now: () => number,
  every = 500,
): { advance(n: number): boolean; result(): ReplayResult } {
  let ms = 0;
  let t0 = now();
  const m = buildMatch(matchConfig(rec, 'human'));
  m.setSources(playbackSource(rec.inputs[0]), playbackSource(rec.inputs[1]));
  ms += now() - t0;
  const hashes = new Uint32Array(rec.ticks);
  const cs = (m as Partial<{ checksum(): number }>).checksum;
  const checksums = typeof cs === 'function' ? new Uint32Array(rec.ticks) : null;
  const checkpoints: (string | number)[][] = [];
  let t = 0;
  return {
    advance(n: number): boolean {
      t0 = now();
      for (const end = Math.min(rec.ticks, t + n); t < end; t++) {
        m.step();
        hashes[t] = m.hash();
        if (checksums) checksums[t] = cs!.call(m);
        if ((t + 1) % every === 0)
          checkpoints.push([m.tick, hashes[t]!, m.phase, m.round, m.wins[0], m.wins[1]]);
      }
      ms += now() - t0;
      return t >= rec.ticks;
    },
    result(): ReplayResult {
      return {
        a: rec.a,
        b: rec.b,
        ticks: rec.ticks,
        hashes,
        checksums,
        checkpoints,
        final: { tick: m.tick, phase: m.phase, round: m.round, wins: [m.wins[0], m.wins[1]], hash: m.hash() },
        ms,
      };
    },
  };
}

/** Play a recording back with no AI; hash every tick. `now` is the host's clock (performance.now), for timing only. */
export function replayMatch(rec: Recording, now: () => number, every = 500): ReplayResult {
  const r = startReplay(rec, now, every);
  r.advance(rec.ticks);
  return r.result();
}

/**
 * The host engine's own libm, probed: each implementation-approximated Math function (and `**`) on the same 2000 inputs.
 * Compared across engines (tools/netplay/crossengine.ts) it shows directly where engines round differently. The `d*`
 * entries are the deterministic replacements (src/contracts/dmath.ts), when the bundle has them: those must agree everywhere.
 */
export function mathProbe(
  extra: Record<string, (x: number, y: number) => number> = {},
): Record<string, number[]> {
  const n = 2000;
  const xs: number[] = [];
  const ys: number[] = [];
  let s = 12345;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    return (s >>> 8) / 16777216;
  };
  for (let i = 0; i < n; i++) {
    // a spread of magnitudes like the sim's: angles, distances, ratios, tick counts
    const mag = [0.01, 1, 3.2, 40, 900][i % 5]!;
    xs.push((rnd() * 2 - 1) * mag);
    ys.push((rnd() * 2 - 1) * mag);
  }
  // `**` and Math.pow are folded at compile time on constants: the base is a variable so this is the engine's runtime path
  const fns: Record<string, (x: number, y: number) => number> = {
    sin: (x) => Math.sin(x),
    cos: (x) => Math.cos(x),
    tan: (x) => Math.tan(x),
    atan: (x) => Math.atan(x),
    atan2: (x, y) => Math.atan2(y, x),
    asin: (x) => Math.asin(Math.max(-1, Math.min(1, x / 3.2))),
    acos: (x) => Math.acos(Math.max(-1, Math.min(1, x / 3.2))),
    exp: (x) => Math.exp(x / 40),
    log: (x) => Math.log(Math.abs(x) + 1e-3),
    pow: (x, y) => Math.pow(Math.abs(x) + 1e-3, y / 40),
    sq: (x) => x ** 2,
    cube: (x) => x ** 3,
    pow13: (x) => Math.abs(x) ** 1.3,
    hypot: (x, y) => Math.hypot(x, y),
    hypot3: (x, y) => Math.hypot(x, y, x - y),
    cbrt: (x) => Math.cbrt(x),
    tanh: (x) => Math.tanh(x),
    ...extra,
  };
  const out: Record<string, number[]> = {};
  for (const [k, f] of Object.entries(fns)) out[k] = xs.map((x, i) => f(x, ys[i]!));
  return out;
}

/** First tick index where two hash streams differ, or -1. */
export function firstDiff(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
  return x.length === y.length ? -1 : n;
}

/** A compact digest of a hash stream (so engines can be compared without shipping every hash). */
export function digest(h: ArrayLike<number>): string {
  let d = 0x811c9dc5 | 0;
  for (let i = 0; i < h.length; i++) {
    d = Math.imul(d ^ h[i]!, 0x01000193);
    d ^= d >>> 15;
  }
  return (d >>> 0).toString(16).padStart(8, '0');
}
