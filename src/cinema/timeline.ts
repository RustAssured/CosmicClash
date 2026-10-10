import type { StageId, TitanId } from '@/contracts';
import { CINEMA_FPS } from './types';

/**
 * timeline.json: the single source of truth of the trailer (docs/cinema/TRAILER_V3.md §2.1). WJ retimes the film by
 * editing numbers there. Every shot carries a `comment` saying what it is for (JSON has no comments, so it is a field).
 * Times inside a shot are SHOT seconds (0 = the shot's start); keys are interpolated (zoom in log space = exponential).
 */
export interface Timeline {
  comment: string;
  /** Frames per second of the timeline (fixed 60). */
  fps: number;
  shots: Shot[];
}

export interface Shot {
  id: string;
  comment: string;
  /** Timeline seconds [start, end). */
  start: number;
  end: number;
  /** The stage whose scenery is drawn behind everything (cinema actors may cover it). */
  stage: StageId;
  /** Seed of the shot's random numbers (actors' ctx.rng). */
  seed?: number;
  /** A real fight driving the shot (real titans, real moves, real damage), or none. */
  match?: ShotMatch;
  /** Time remap: [shotT, rate] steps (scene seconds per timeline second; 0 = freeze, 0.25 = ×0.25 slow motion). */
  time?: [number, number][];
  camera?: CameraKey[];
  /** Letterbox: [shotT, open] keys, open 0 = 2.39:1 bars (640×268 picture), 1 = full 16:9. */
  letterbox?: [number, number][];
  cards?: Card[];
  actors?: ActorEntry[];
}

export interface ShotMatch {
  a: TitanId;
  b: TitanId;
  seed: number;
  /** AI level for both slots (the harness's `ai`), or 0 = dummies driven only by the scripts. */
  ai: number;
  /** Scripted input per slot (src/contracts/harness.ts grammar; tick 0 = the tick the fight goes live, as in the harness, so every shot of one fight sees the same script). */
  script0?: string;
  script1?: string;
  /** Sim tick (after the intro) at which the shot's scene time 0 sits: the fight is fast-forwarded to it. */
  startTick: number;
  /** World palettes on Planet slots (src/cinema/world.ts), keyed by slot: { "0": "A", "1": "B" }. */
  worlds?: Partial<Record<'0' | '1', 'A' | 'B'>>;
  /**
   * The Witness close-up's pose (src/cinema/witness.ts), on the Witness's slot: `pupil` keys [shotT, 1 … 0.35] (contracts),
   * `rings` keys [shotT, 0 … 1] (the halo arcs click back into alignment).
   */
  /** Draw this slot's world (a `worlds` slot) in front of the other fighter: a horizon something rises behind. */
  front?: 0 | 1;
  witness?: { slot: 0 | 1; pupil?: [number, number][]; rings?: [number, number][] };
  /** px between the fighters at round start (default 380). */
  gap?: number;
}

export interface CameraKey {
  t: number;
  /** View centre in world px; omitted = follow the game camera (both fighters framed). */
  x?: number;
  y?: number;
  /** 1 = native; magnification at whole-pixel blocks (see camera.ts). Interpolated exponentially. */
  zoom?: number;
  /** The native-frame point the zoom closes in on (default the frame centre). */
  focus?: [number, number];
  /** MATTER CAM: draw each native pixel as a lit cell of matter (from a zoom of ×8 at the output scale). */
  matter?: boolean;
  /** Track a fighter (slot): the zoom closes in on its root, and `focus` becomes an offset from it (native px). */
  track?: 0 | 1;
  /** Dutch angle in whole quarter turns (1 = the picture turned 90° clockwise): pixels move, never resample. Held. */
  dutch?: number;
  /** Keep the game camera's shake (default true when following, false on a fixed camera). */
  shake?: boolean;
}

export interface Card {
  /** Shot seconds [in, out): cards cut on and off (no fades: no anti-aliasing anywhere). */
  t: [number, number];
  text: string;
  /** Whole-number scale of the game's pixel font. */
  scale: number;
  /** Native px: centre x (default 320) and top y (default: centred in the picture area). */
  x?: number;
  y?: number;
  /** Packed RGBA (0xAABBGGRR) or a #rrggbb string. */
  color?: number | string;
}

export interface ActorEntry {
  type: string;
  id?: string;
  depth: number;
  params?: Record<string, unknown>;
}

/** Validate a parsed timeline (throws with the offending shot), and return it typed. */
export function checkTimeline(raw: unknown): Timeline {
  const tl = raw as Timeline;
  if (!tl || !Array.isArray(tl.shots) || !tl.shots.length) throw new Error('timeline: no shots');
  if (tl.fps !== CINEMA_FPS) throw new Error(`timeline: fps must be ${CINEMA_FPS}`);
  let prev = 0;
  const ids = new Set<string>();
  for (const s of tl.shots) {
    const where = `timeline shot "${s.id}"`;
    if (!s.id || ids.has(s.id)) throw new Error(`${where}: missing or duplicate id`);
    ids.add(s.id);
    if (!s.comment || !s.comment.trim())
      throw new Error(`${where}: every shot needs a comment saying what it is for`);
    if (!(s.end > s.start)) throw new Error(`${where}: end must be after start`);
    if (Math.abs(s.start - prev) > 1e-9)
      throw new Error(`${where}: starts at ${s.start}, the previous shot ends at ${prev}`);
    prev = s.end;
    for (const k of s.camera ?? [])
      if (k.zoom !== undefined && !(k.zoom > 0)) throw new Error(`${where}: zoom must be > 0`);
    for (const c of s.cards ?? [])
      if (!Number.isInteger(c.scale) || c.scale < 1)
        throw new Error(`${where}: card scale must be a whole number`);
  }
  return tl;
}

export const durationOf = (tl: Timeline): number => tl.shots[tl.shots.length - 1]!.end;
export const frameCount = (tl: Timeline): number => Math.round(durationOf(tl) * tl.fps);

/** The shot playing at timeline second `t`. */
export function shotAt(tl: Timeline, t: number): Shot {
  for (const s of tl.shots) if (t >= s.start - 1e-9 && t < s.end - 1e-9) return s;
  return tl.shots[tl.shots.length - 1]!;
}

/** Scene seconds elapsed at shot second `shotT` under the shot's time remap (piecewise-constant rates, integrated). */
export function sceneTime(shot: Shot, shotT: number): number {
  const steps = shot.time && shot.time.length ? shot.time : [[0, 1] as [number, number]];
  let scene = 0;
  for (let i = 0; i < steps.length; i++) {
    const [t0, rate] = steps[i]!;
    if (shotT <= t0) break;
    const t1 = Math.min(shotT, steps[i + 1]?.[0] ?? Infinity);
    scene += (t1 - t0) * rate;
  }
  return scene;
}

/** Linear interpolation of [t, v] keys (held before the first and after the last). */
export function keyValue(keys: readonly [number, number][] | undefined, t: number, dflt: number): number {
  if (!keys || !keys.length) return dflt;
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i + 1 < keys.length; i++) {
    const [a, va] = keys[i]!;
    const [b, vb] = keys[i + 1]!;
    if (t <= b) return b > a ? va + ((vb - va) * (t - a)) / (b - a) : vb;
  }
  return keys[keys.length - 1]![1];
}
