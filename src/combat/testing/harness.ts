import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type Btn as _Btn,
  type InputFrame,
  type InputSource,
  type MatchConfig,
  type MatterWorld,
  type TitanId,
} from '@/contracts';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef } from '@/titans';
import { createFighter } from '../index';
import { createMatterWorld } from '@/matter';
import { createFakeWorld } from './fakeWorld';

export type { _Btn };

export interface HarnessOptions {
  seed?: number;
  a?: TitanId;
  b?: TitanId;
  /** Provide a world factory (defaults to the REAL matter world; pass `createFakeWorld` for isolated unit tests). */
  createWorld?: (seed: number) => MatterWorld;
  infinite?: boolean;
  startState?: MatchConfig['startState'];
}

/** A real Match driving real Fighters against a world (the real matter world unless another is supplied). */
export function makeMatch(o: HarnessOptions = {}): Match {
  const cfg: MatchConfig = {
    seed: o.seed ?? 7,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: o.a ?? 'lastone', controller: 'human' },
      { titan: o.b ?? 'asteroid', controller: 'human' },
    ],
    infinite: o.infinite,
    startState: o.startState,
  };
  return createMatch(cfg, {
    createWorld: o.createWorld ?? ((seed) => createMatterWorld(seed)),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
}

/** Step until the round is live (intro over). */
export function skipIntro(m: Match): void {
  let guard = 0;
  while (m.phase === 'intro' && guard++ < 1000) m.step();
}

export function run(m: Match, n: number): void {
  for (let i = 0; i < n; i++) m.step();
}

/** A hand-driven input source: set fields, the harness turns them into edges. */
export class ManualSource implements InputSource {
  readonly kind = 'script' as const;
  moveX = 0;
  moveY = 0;
  held = 0;
  private prev = 0;
  poll(_tick: number, out: InputFrame): void {
    out.moveX = this.moveX;
    out.moveY = this.moveY;
    out.held = this.held;
    out.pressed = this.held & ~this.prev;
    out.released = this.prev & ~this.held;
    this.prev = this.held;
  }
}

export { createScriptSource, createFakeWorld };
