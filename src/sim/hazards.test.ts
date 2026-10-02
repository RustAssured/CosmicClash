import { describe, expect, it } from 'vitest';
import { DEFAULT_ARENA, DEFAULT_LIGHTING, type ArenaInfo, type SimEvent } from '@/contracts';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { getTitanDef } from '@/titans';
import { createMatch } from './match';

const ARENA: ArenaInfo = {
  ...DEFAULT_ARENA,
  comets: { every: [90, 90], warn: 30, speed: [220, 220], mass: 80, maxLive: 2 },
};

function run(
  seed: number,
  ticks: number,
): { events: SimEvent[]; hash: number; m: ReturnType<typeof createMatch> } {
  const m = createMatch(
    {
      seed,
      stage: 'nursery',
      mode: 'versus',
      slots: [
        // two idle Last Ones: the hazards only need the Planet's comet PAINTER, not a Planet fighter
        { titan: 'lastone', controller: 'dummy' },
        { titan: 'lastone', controller: 'dummy' },
      ],
    },
    { createWorld: createMatterWorld, createFighter, getTitanDef, arena: ARENA, lighting: DEFAULT_LIGHTING },
  );
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    m.step();
    for (const e of m.events) if (e.t === 'hazard') events.push({ ...e });
  }
  return { events, hash: m.hash(), m };
}

describe('arena comets', () => {
  it('warn, then enter as real matter on a readable cadence', () => {
    const { events, m } = run(3, 120 + 400);
    const warns = events.filter((e) => e.t === 'hazard' && e.kind === 'comet-warn');
    const enters = events.filter((e) => e.t === 'hazard' && e.kind === 'comet-enter');
    // every 90 ticks, but at most 2 uncaught comets in play (a crossing takes > 3 s): the third waits for room
    expect(warns.length).toBeGreaterThanOrEqual(2);
    expect(enters.length).toBe(warns.length);
    // every entry is a live matter chunk at the warned spot, heading where the warning said
    const e0 = enters[0] as Extract<SimEvent, { t: 'hazard' }>;
    const w0 = warns[0] as Extract<SimEvent, { t: 'hazard' }>;
    expect(e0.x).toBeCloseTo(w0.x, 6);
    expect(Math.hypot(e0.vx, e0.vy)).toBeCloseTo(220, 3);
    expect(e0.id).toBeGreaterThanOrEqual(0);
    const st = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      spin: 0,
      mass: 0,
      radius: 0,
      mode: 0,
      owner: -1,
      origin: -1,
      temp: 0,
    };
    const last = enters[enters.length - 1] as Extract<SimEvent, { t: 'hazard' }>;
    expect(m.world.chunkState!(last.id, st)).toBe(true);
    expect(st.mass).toBeGreaterThan(0);
  });

  it('retires comets that leave uncaught and never exceeds maxLive in play', () => {
    const { events } = run(5, 120 + 1500);
    let live = 0;
    let max = 0;
    for (const e of events) {
      if (e.t !== 'hazard') continue;
      if (e.kind === 'comet-enter') live++;
      if (e.kind === 'comet-retire') live--;
      max = Math.max(max, live);
    }
    expect(events.some((e) => e.t === 'hazard' && e.kind === 'comet-retire')).toBe(true);
    expect(max).toBeLessThanOrEqual(2);
  });

  it('is deterministic and folded into the match hash', () => {
    const a = run(9, 120 + 300);
    const b = run(9, 120 + 300);
    expect(a.hash).toBe(b.hash);
    expect(a.events).toEqual(b.events);
  });
});
