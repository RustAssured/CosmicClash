/// <reference lib="webworker" />
/**
 * The Planet's rotation frames, baked off the main thread (idle handover specs/planet.md §2: "the sim never waits on it").
 * The main thread (src/combat/behaviours/planetFrames.ts) starts a job and keeps telling the worker which frame is on screen
 * and which way the world turns; the worker paints the nearest missing frame in that direction next, so the bake stays
 * ahead of the rotation. Each frame is the face only (`paintPlanetFace`): colour and surface class per face cell.
 */
import type { StageLighting } from '@/contracts';
import { getTitanDef } from '@/titans';
import { paintPlanetFace } from './planet';

interface Start {
  t: 'start';
  titan: string;
  seed: number;
  lighting: StageLighting;
  cells: Int32Array;
  frames: number;
  aim: number;
  dir: number;
}
interface Aim {
  t: 'aim';
  aim: number;
  dir: number;
}

let job: Start | null = null;
let have: Uint8Array = new Uint8Array(0);
let aim = 0;
let dir = 1;
let busy = false;

function next(): number {
  if (!job) return -1;
  const F = job.frames;
  // the nearest missing frame in the direction the world turns, then behind it
  for (let k = 0; k < F; k++) {
    const fi = (((aim + dir * k) % F) + F) % F;
    if (!have[fi]) return fi;
  }
  return -1;
}

function work(): void {
  busy = false;
  const j = job;
  if (!j) return;
  const fi = next();
  if (fi < 0) return;
  const def = getTitanDef(j.titan as never);
  const { colors, cls } = paintPlanetFace(def, j.seed, j.lighting, (fi / j.frames) * Math.PI * 2);
  const n = j.cells.length;
  const col = new Uint32Array(n);
  const cl = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const i = j.cells[k]!;
    col[k] = colors[i]!;
    cl[k] = cls[i]!;
  }
  have[fi] = 1;
  (self as unknown as Worker).postMessage({ t: 'frame', fi, col, cl }, [col.buffer, cl.buffer]);
  busy = true;
  // flat out until the bake is AHEAD frames in front of the rotation, then with a rest after each frame: a world turns about
  // 5 frames a second. A bake running beside a fight costs the game on a laptop (docs/idle/PORT.md §4: the perf gate's
  // Colossus v Planet clash has 6–8 frames over 34 ms while it runs, 1–2 without; a longer rest did not help)
  setTimeout(work, ahead() >= AHEAD ? PACE_MS : 0);
}

const AHEAD = 24;
const PACE_MS = 120;
function ahead(): number {
  if (!job) return 0;
  const F = job.frames;
  let k = 0;
  while (k < F && have[(((aim + dir * k) % F) + F) % F]) k++;
  return k;
}

self.onmessage = (e: MessageEvent<Start | Aim>): void => {
  const m = e.data;
  if (m.t === 'start') {
    job = m;
    have = new Uint8Array(m.frames);
    aim = m.aim;
    dir = m.dir;
  } else {
    aim = m.aim;
    dir = m.dir;
  }
  if (!busy) {
    busy = true;
    setTimeout(work, 0);
  }
};
