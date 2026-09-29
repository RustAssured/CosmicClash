import { LOGICAL_H, LOGICAL_W, type DamageEvent, type MatterBody } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import type { TestBody } from '@/matter/testing/bodies';
import { composeFrame } from './compose';

export interface ScenarioEvent {
  tick: number;
  /** Which body (index into `bodies`). */
  body: number;
  ev: DamageEvent;
}

export interface ScenarioSpec {
  seed?: number;
  bodies: TestBody[];
  events: ScenarioEvent[];
  /** Ticks at which to capture a frame (after ticking). */
  capture: number[];
  /** Crop rectangle in world/logical px (view origin is 0,0). */
  crop: { x: number; y: number; w: number; h: number };
  /** Optional per-tick hook (e.g. set gravity sources, move transforms). */
  onTick?: (tick: number, world: MatterWorldEx, bodies: MatterBody[]) => void;
  /** Run once after bodies are created. */
  setup?: (world: MatterWorldEx, bodies: MatterBody[]) => void;
}

export interface ScenarioFrame {
  pixels: Uint32Array;
  w: number;
  h: number;
  tick: number;
}

/** Run a scripted damage scenario headlessly and return cropped frames. */
export function runScenario(spec: ScenarioSpec): {
  frames: ScenarioFrame[];
  world: MatterWorldEx;
  bodies: MatterBody[];
} {
  const world = createMatterWorld(spec.seed ?? 1);
  const bodies = spec.bodies.map((b) => world.createBody(b.spec));
  spec.setup?.(world, bodies);
  const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  const frames: ScenarioFrame[] = [];
  const last = Math.max(...spec.capture);
  const grab = (tick: number): void => {
    const layers = world.renderLayers(view, 0).map((l) => ({ ...l }));
    const full = composeFrame(layers, bodies, view);
    const { x, y, w, h } = spec.crop;
    const px = new Uint32Array(w * h);
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) px[yy * w + xx] = full[(y + yy) * LOGICAL_W + x + xx]!;
    frames.push({ pixels: px, w, h, tick });
  };
  if (spec.capture.includes(0)) grab(0);
  for (let t = 1; t <= last; t++) {
    for (const e of spec.events) if (e.tick === t) world.applyDamage(bodies[e.body]!.id, e.ev);
    spec.onTick?.(t, world, bodies);
    world.tick();
    if (spec.capture.includes(t)) grab(t);
  }
  return { frames, world, bodies };
}

export function dmg(
  over: Partial<DamageEvent> & Pick<DamageEvent, 'type' | 'shape' | 'energy'>,
): DamageEvent {
  return {
    dirX: 1,
    dirY: 0,
    duration: 1,
    sourceMass: 5,
    sourceBodyId: -1,
    originX: 0,
    originY: 0,
    flags: 0,
    params: {},
    ...over,
  };
}
