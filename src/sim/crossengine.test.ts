import { describe, expect, it, vi } from 'vitest';
import type { MatchConfig, StageId, TitanId } from '@/contracts';

/**
 * Netplay Step 0 (docs/netplay/STEP0.md): the simulation must not depend on the engine's own Math library, because V8,
 * SpiderMonkey and JavaScriptCore (and even two Chromium versions) round sin, cos, atan2, exp, log, pow, hypot… differently.
 *
 * Proof without a second engine: run the same fights with a PERTURBED Math (every implementation-approximated function off
 * by a few ulp, as another engine's libm would be) and require identical state hashes every tick. The modules are reloaded
 * under the perturbed Math, so module-level tables (rotation LUT, painted titans, the titan sky) are covered too.
 * The cross-engine run itself: tools/netplay/crossengine.ts.
 */
const FNS = [
  'sin',
  'cos',
  'tan',
  'atan',
  'atan2',
  'asin',
  'acos',
  'exp',
  'log',
  'pow',
  'hypot',
  'cbrt',
  'tanh',
] as const;

async function fight(a: TitanId, b: TitanId, stage: StageId, ticks: number, seed: number): Promise<number[]> {
  vi.resetModules();
  const { createMatch, createAiSource } = await import('@/sim');
  const { createFighter } = await import('@/combat');
  const { arenaForMatch } = await import('@/combat/mouth/arena');
  const { createMatterWorld } = await import('@/matter');
  const { TITAN_SKY } = await import('@/render/unified');
  const { STAGE_INFO } = await import('@/stages/info');
  const { getTitanDef } = await import('@/titans');
  const { createAI } = await import('@/ai');
  const cfg: MatchConfig = {
    seed,
    stage,
    mode: 'aivai',
    footwork: 'orbit',
    pace: 1.3,
    roundSeconds: 120,
    slots: [
      { titan: a, controller: 'ai', aiLevel: 5 },
      { titan: b, controller: 'ai', aiLevel: 5 },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: arenaForMatch(STAGE_INFO[stage].arena, [a, b]),
    lighting: TITAN_SKY,
  });
  m.setSources(
    createAiSource(m, 0, createAI(5, getTitanDef(a), seed * 7 + 1, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(5, getTitanDef(b), seed * 7 + 2, { footwork: 'orbit' })),
  );
  const out: number[] = [];
  for (let t = 0; t < ticks; t++) {
    m.step();
    out.push(m.hash(), m.checksum());
  }
  return out;
}

async function perturbed<T>(run: () => Promise<T>): Promise<T> {
  const M = Math as unknown as Record<string, (...a: number[]) => number>;
  const saved = FNS.map((k) => M[k]!);
  // a few ulp off, like another engine's libm (exact results such as sin(0) stay exact: x · (1 + ε) of 0 is 0)
  FNS.forEach((k, i) => (M[k] = (...a: number[]): number => saved[i]!(...a) * (1 + 1 / 2 ** 48)));
  try {
    return await run();
  } finally {
    FNS.forEach((k, i) => (M[k] = saved[i]!));
  }
}

describe('cross-engine determinism (netplay Step 0)', () => {
  it('the perturbation is visible: a native Math function really changes under it', async () => {
    const x = 0.7;
    const clean = Math.sin(x);
    expect(await perturbed(async () => Math.sin(x))).not.toBe(clean);
  });

  for (const [a, b, stage] of [
    ['colossus', 'cradle', 'nursery'],
    ['uri', 'mouth', 'nursery'],
    ['planet', 'supernova', 'shearfield'],
    ['lastone', 'nexus', 'nursery'],
    ['asteroid', 'blackhole', 'shearfield'],
  ] as const) {
    it(`${a} v ${b} (${stage}, AI v AI): every tick's hash and checksum ignore the engine's Math`, async () => {
      const clean = await fight(a, b, stage, 420, 3);
      const off = await perturbed(() => fight(a, b, stage, 420, 3));
      const first = off.findIndex((h, i) => h !== clean[i]);
      expect(first, `first differing tick ${first >> 1}`).toBe(-1);
    }, 120_000);
  }
});
