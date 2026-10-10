/**
 * CINEMA MODE contracts (docs/cinema/TRAILER_V3.md §2.1). Everything a cinema actor needs to know, and nothing more.
 *
 * The frame is the game's native 640×360. An actor draws into a NATIVE BUFFER of exactly that size (packed RGBA as
 * everywhere in the game, see src/contracts/color.ts; alpha 0 = transparent). The Director hands each actor's buffer to the
 * real renderer as a screen-space layer at the actor's `depth` (the RenderLayer z order: scenery −100 … titans 0 … fx 20),
 * so actors get the same post (bloom, flashes, grain) as the titans. Camera zoom, the letterbox and the cards are applied
 * after that, at integer scales only. Time is the timeline's, never the wall clock: an actor must draw the same pixels for
 * the same context (determinism test, tools/cinema/determinism.ts).
 */

/** The native frame: the game's logical resolution. */
export const NATIVE_W = 640;
export const NATIVE_H = 360;
/** Fixed timeline rate: one frame = 1/60 s of timeline time. */
export const CINEMA_FPS = 60;

/** A native-resolution canvas an actor draws into. Cleared to transparent before every `draw`. */
export interface NativeBuffer {
  readonly w: number;
  readonly h: number;
  /** Packed RGBA (0xAABBGGRR, little-endian), row-major, top row first. */
  readonly pixels: Uint32Array;
  /** Per-pixel glow 0..255 (what the bloom picks up); 0 = matte. */
  readonly emissive: Uint8Array;
}

/** The cinema camera at a frame (CineCamera). Coordinates are world px; zoom 1 = native, applied at integer scales. */
export interface CineCameraState {
  /** View centre, world px. */
  x: number;
  y: number;
  /** 1 = native; > 1 magnifies (rendered as whole-pixel blocks at the output scale; see camera.ts). */
  zoom: number;
  /** Dutch angle, radians (reserved; 0 in P0). */
  dutch: number;
  /** Shake offset in native px (integer), also applied to the letterbox bars. */
  shakeX: number;
  shakeY: number;
}

/** What an actor knows when it draws one frame. */
export interface CineContext {
  /** Frame index on the timeline (0-based) and timeline time in seconds (= frame / 60). */
  readonly frame: number;
  readonly t: number;
  /** The current shot, and seconds since it started (timeline time, before time remapping). */
  readonly shot: string;
  readonly shotT: number;
  /** Seconds of SCENE time since the shot started (after slow motion / freezes / ramps). */
  readonly sceneT: number;
  readonly camera: Readonly<CineCameraState>;
  /** The view rectangle of this frame in world px (integer origin), i.e. what native pixel (0,0) shows. */
  readonly view: { readonly x0: number; readonly y0: number };
  /** Deterministic random numbers in [0,1): seeded per shot, advanced only by actors (call order matters). */
  readonly rng: () => number;
  /** Actor parameters from timeline.json (`actors[].params`). */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * A cinema-only actor (the doomed worlds, the genesis, the ark swarm, parallax layers…). Self-contained: it may use the
 * game's renderers and matter, but only through what it owns. Registered by type name in src/cinema/actors/index.ts.
 */
export interface Actor {
  readonly id: string;
  /** Draw order as a RenderLayer z: < 0 behind the titans (−100 is the stage scenery), 0 titans, > 0 in front. */
  readonly depth: number;
  /** One-time set-up (asset loads, bakes) before the shot's first frame. */
  init?(ctx: CineContext): Promise<void> | void;
  /** Draw this frame into `buf` (already cleared). Must be a pure function of `ctx` and the actor's own state. */
  draw(buf: NativeBuffer, ctx: CineContext): void;
  dispose?(): void;
}

/** Builds an actor from its timeline entry. */
export type ActorFactory = (id: string, depth: number, params: Readonly<Record<string, unknown>>) => Actor;

/** A fresh, cleared native buffer. */
export function nativeBuffer(w = NATIVE_W, h = NATIVE_H): NativeBuffer {
  return { w, h, pixels: new Uint32Array(w * h), emissive: new Uint8Array(w * h) };
}

/** Parallax factor of a depth (how far a layer moves per world px of camera motion): far layers move less. */
export function parallaxOf(depth: number): number {
  if (depth >= 0) return 1 + depth / 40;
  return Math.max(0.02, 1 + depth / 105);
}
