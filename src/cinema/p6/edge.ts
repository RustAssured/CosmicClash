/**
 * ACT IV, "the edge" (TRAILER_V3 1:17–1:35): the shared clock and geometry of the edgepull and jawwipe actors and of the
 * Mouth bake (tools/cinema/mouth-bake.ts), so the baked frames of the LOCKED Mouth and the actors that play them agree
 * to the frame. Pure numbers, no DOM.
 *
 * World units are the arena's own pixels: the arena is the game's 640×360 frame at (0,0)–(640,360). The Mouth is the
 * edge of that frame; the rest of its body (the coil heap) lies outside it, far larger than the arena.
 */
export const EDGE = {
  /** The stars at the frame's edges start sliding toward the rim, and a coil slides along the bottom edge. */
  slideStart: 80,
  /** The pull-back starts (the arena begins to shrink) … */
  pullStart: 83,
  /** … and ends, the arena a small rectangle in the coils. */
  pullEnd: 89,
  /** The jaw-rings close over the camera. */
  wipeStart: 89,
  wipeEnd: 91,
  /** Timeline frames per second. */
  fps: 60,
  /** The arena's scale at the end of the pull-back (1 = full frame). */
  zEnd: 1 / 7,
} as const;

const ease = (u: number): number => u * u * (3 - 2 * u);
const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The arena's scale at timeline second t: 1 until the pull-back, then exponential down to zEnd. */
export function arenaZoom(t: number): number {
  const u = ease(clamp((t - EDGE.pullStart) / (EDGE.pullEnd - EDGE.pullStart)));
  return Math.exp(Math.log(EDGE.zEnd) * u);
}

/** The world point at the centre of the frame: the arena's centre, drifting toward the coil heap as the camera pulls back. */
export function viewCentre(t: number): [number, number] {
  const u = ease(clamp((t - EDGE.pullStart) / (EDGE.pullEnd - EDGE.pullStart)));
  const k = u * u;
  return [320 + (HEAP_VIEW[0] - 320) * k, 180 + (HEAP_VIEW[1] - 180) * k];
}

/** The arena's rectangle on screen (native px) at t: where the shrinking game frame is drawn. */
export function arenaRect(t: number): { x: number; y: number; w: number; h: number; z: number } {
  const z = arenaZoom(t);
  const [cx, cy] = viewCentre(t);
  return {
    x: Math.round(320 + (0 - cx) * z),
    y: Math.round(180 + (0 - cy) * z),
    w: Math.max(1, Math.round(640 * z)),
    h: Math.max(1, Math.round(360 * z)),
    z,
  };
}

/** World → screen at t. */
export function toScreen(t: number, wx: number, wy: number): [number, number] {
  const z = arenaZoom(t);
  const [cx, cy] = viewCentre(t);
  return [320 + (wx - cx) * z, 180 + (wy - cy) * z];
}

/**
 * The coil heap (world units): a spiral of the Mouth's body outside the arena's bottom-right, its innermost turn running up
 * to the arena's bottom edge, where the feeding end lives. Control points for the oracle's braid (catmull spine).
 */
export const HEAP_CENTRE: [number, number] = [2150, 1350];
export const HEAP_VIEW: [number, number] = [1900, 1200];
export function heapSpine(): [number, number, number][] {
  const P: [number, number, number][] = [];
  const turns = 1.75;
  const N = 34;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const a = Math.PI * 1.05 + f * turns * Math.PI * 2;
    const r = 3200 - f * 2600; // the outer turns run on past the frame: the rest of it does not fit
    P.push([HEAP_CENTRE[0] + Math.cos(a) * r, HEAP_CENTRE[1] + Math.sin(a) * r * 0.66, 0]);
  }
  // the neck: from the innermost turn back up to the arena's bottom edge
  P.push([1100, 900, 0], [640, 560, 0], [420, 380, 0]);
  return P;
}
/** The heap's thickness relative to the coils at the arena's edge (the oracle's bundle): it is far bigger out there. */
export const HEAP_THICK = 4.5;

/**
 * The four words (HUNGER. DEVOURS. ENDS. REPEATS.), one per coil pass: the moments the pull-back has shrunk the arena past
 * each of four scales, i.e. as each further turn of the heap comes into the frame. Timeline seconds.
 */
export const EDGE_WORDS = ['HUNGER.', 'DEVOURS.', 'ENDS.', 'REPEATS.'] as const;
export function edgeWordCues(): number[] {
  const marks = [0.6, 0.38, 0.24, 0.158];
  return marks.map((m) => {
    // invert arenaZoom by bisection (it is monotonic over the pull-back)
    let a: number = EDGE.pullStart;
    let b: number = EDGE.pullEnd;
    for (let i = 0; i < 40; i++) {
      const c = (a + b) / 2;
      if (arenaZoom(c) > m) a = c;
      else b = c;
    }
    return Math.round(((a + b) / 2) * EDGE.fps) / EDGE.fps;
  });
}

/** The jaw-wipe: the opening's radius as a share of the frame's half-diagonal, 1 (open) → 0 (shut), with a bite at the end. */
export function jawOpen(t: number): number {
  const u = clamp((t - EDGE.wipeStart) / (EDGE.wipeEnd - EDGE.wipeStart));
  // a slow close, then the snap: the last 25 % of the opening goes in 6 frames
  if (u < 0.8) return 1 - ease(u / 0.8) * 0.75;
  return Math.max(0, 0.25 * (1 - (u - 0.8) / 0.05));
}
