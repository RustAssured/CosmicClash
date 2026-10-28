import { describe, expect, it } from 'vitest';
import { makeLayer, type MotionPreset, type TitanDef } from '@/contracts';
import { getTitanDef } from '@/titans';
import { makeMatch, skipIntro } from '../../testing/harness';
import type { FighterImpl } from '../../fighter';
import { KitMotion, motionProblems, type MotionInput } from './motion';

/** The Cradle Child (a blob kit titan) with the given presets, and its body. */
function rig(motion: MotionPreset[]) {
  const m = makeMatch({ a: 'cradlechild', b: 'planet', seed: 3 });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const def: TitanDef = structuredClone(getTitanDef('cradlechild'));
  def.kit!.motion = motion;
  const k = new KitMotion(f.body.map, def);
  const body = makeLayer('body', 'world', 0, f.body.map.w, f.body.map.h);
  return { f, def, k, body, map: f.body.map };
}

const idle = (tick: number, over: Partial<MotionInput> = {}): MotionInput => ({
  tick,
  slot: null,
  phase: 'startup',
  phaseTick: 0,
  startup: 9,
  active: 4,
  recovery: 26,
  aim: 'forward',
  guarding: false,
  ...over,
});

const matOf = (r: ReturnType<typeof rig>, key: string): number =>
  r.def.materials.findIndex((m) => m.key === key) + 1;

describe('kit animation presets (kit.motion)', () => {
  it('swirl moves only its own material, and the same tick draws the same frame', () => {
    const r = rig([{ type: 'swirl', material: 'galaxy', speed: 4 }]);
    const g = matOf(r, 'galaxy');
    const out = [r.body];
    r.k.render(r.body, r.map, idle(10), out);
    const a = r.k.skin.px.slice();
    r.k.render(r.body, r.map, idle(40), out);
    const b = r.k.skin.px.slice();
    let moved = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      expect(r.map.material[i], 'only galaxy cells change').toBe(g);
      moved++;
    }
    expect(moved).toBeGreaterThan(20);
    const again = rig([{ type: 'swirl', material: 'galaxy', speed: 4 }]);
    again.k.render(again.body, again.map, idle(40), [again.body]);
    expect(again.k.skin.px).toEqual(b);
  });

  it('pulse brightens and glows its material on the beat', () => {
    const r = rig([{ type: 'pulse', material: 'flesh', rate: 1, depth: 2, glow: 120 }]);
    const c = matOf(r, 'flesh');
    const glowAt = (tick: number): number => {
      r.k.render(r.body, r.map, idle(tick), [r.body]);
      let e = 0;
      for (let i = 0; i < r.map.material.length; i++) if (r.map.material[i] === c) e += r.k.skin.emis[i]!;
      return e;
    };
    // a 1 Hz beat: the peak a quarter second in, the trough three quarters in
    expect(glowAt(15)).toBeGreaterThan(glowAt(45) + 100);
  });

  it('shimmer lights a few cells at a time', () => {
    const r = rig([{ type: 'shimmer', material: 'star', density: 0.2, rate: 4, glow: 200 }]);
    r.k.render(r.body, r.map, idle(7), [r.body]);
    let lit = 0;
    for (let i = 0; i < r.k.skin.emis.length; i++) if (r.k.skin.emis[i]! > (r.map.emissive?.[i] ?? 0)) lit++;
    expect(lit).toBeGreaterThan(0);
  });

  it('stretch pulls its material out only while its move is under way', () => {
    const r = rig([{ type: 'stretch', material: 'galaxy', reach: 140 }]);
    const drawn = (inp: MotionInput): number => {
      const out = [r.body];
      r.k.render(r.body, r.map, inp, out);
      const L = out[out.length - 1]!;
      let n = 0;
      for (let i = 0; i < L.pixels.length; i++) if (L.pixels[i]) n++;
      return n;
    };
    expect(drawn(idle(5))).toBe(0);
    expect(drawn(idle(6, { slot: 'crush', phase: 'active', phaseTick: 3 }))).toBe(0);
    expect(drawn(idle(7, { slot: 'strike', phase: 'active', phaseTick: 3 }))).toBeGreaterThan(200);
  });

  it('iris closes its petals while guarding and opens again after', () => {
    const r = rig([{ type: 'iris', material: 'galaxy', cover: 'bone', speed: 0.5 }]);
    const g = matOf(r, 'galaxy');
    const bone = new Set<number>();
    for (let i = 0; i < r.map.material.length; i++)
      if (r.map.material[i] === matOf(r, 'bone')) bone.add(r.map.baseColor[i]! >>> 0);
    const covered = (): number => {
      let n = 0;
      for (let i = 0; i < r.map.material.length; i++)
        if (r.map.material[i] === g && bone.has(r.k.skin.px[i]! >>> 0)) n++;
      return n;
    };
    r.k.render(r.body, r.map, idle(1), [r.body]);
    expect(covered()).toBe(0);
    for (let t = 2; t < 6; t++) r.k.render(r.body, r.map, idle(t, { guarding: true }), [r.body]);
    const shut = covered();
    expect(shut).toBeGreaterThan(50);
    for (let t = 6; t < 20; t++) r.k.render(r.body, r.map, idle(t), [r.body]);
    expect(covered()).toBe(0);
  });

  it('names what is wrong with a preset list', () => {
    const def: TitanDef = structuredClone(getTitanDef('cradlechild'));
    def.kit!.motion = [
      { type: 'swirl', material: 'galaxy' },
      { type: 'spin', material: 'galaxy' },
      { type: 'pulse', material: 'nothing' },
      { type: 'iris', material: 'galaxy', on: 'sometimes', cover: 'paper' },
    ];
    expect(motionProblems(def)).toEqual([
      "kit.motion[1]: unknown type 'spin'",
      "kit.motion[2]: no material 'nothing'",
      "kit.motion[3]: unknown trigger 'sometimes'",
      "kit.motion[3]: no cover material 'paper'",
    ]);
  });
});
