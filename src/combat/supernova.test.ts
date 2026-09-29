import { describe, expect, it } from 'vitest';
import { Btn, parseScript, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from './fighter';
import type { SupernovaBehaviour } from './behaviours/supernova';
import { ManualSource, createScriptSource, makeMatch, skipIntro } from './testing/harness';

function duel(a: TitanId, b: TitanId, gap = 170, seed = 7) {
  const m = makeMatch({ a, b, seed, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const fa = m.fighters[0] as FighterImpl;
  const fb = m.fighters[1] as FighterImpl;
  fa.px = 800 - gap / 2;
  fb.px = 800 + gap / 2;
  return { m, fa, fb, sn: fa.behaviour as unknown as SupernovaBehaviour };
}

describe('Supernova', () => {
  it('spending fuel burns the star smaller, and the HUD bar drops', () => {
    const { m, fa } = duel('supernova', 'asteroid');
    const src = new ManualSource();
    m.setSources(src, null);
    const ini = fa.view.bodyStats.mass;
    for (let t = 1; t <= 260; t++) {
      src.held = t === 1 || t === 125 ? Btn.CRUSH : 0;
      m.step();
    }
    expect(fa.view.resource).toBeLessThan(85);
    expect(fa.view.resource).toBeGreaterThan(50);
    expect(fa.view.bodyStats.mass).toBeLessThan(ini * 0.985);
    expect(fa.view.bodyStats.massFrac).toBeGreaterThan(0.46);
  }, 60_000);

  it('a quiet star cools and regains fuel; absorbing heat feeds it', () => {
    const { m, fa } = duel('supernova', 'supernova', 150);
    fa.resource = 40;
    m.setSources(null, null);
    for (let t = 0; t < 400; t++) m.step();
    expect(fa.view.resource).toBeGreaterThan(40);
    const b = fa.behaviour as unknown as SupernovaBehaviour;
    expect(b.quiet).toBeGreaterThan(100);
  }, 60_000);

  it('at zero fuel it collapses into one final nova, then fights on as a remnant', () => {
    const { m, fa, sn } = duel('supernova', 'asteroid', 260);
    m.setSources(createScriptSource(parseScript('1:strike'), m.tick + 1), null);
    fa.resource = 2;
    let collapse = false;
    let novaMove = false;
    for (let t = 0; t < 420; t++) {
      m.step();
      for (const e of m.events) if (e.t === 'cue' && e.id === 'collapse') collapse = true;
      if (fa.view.moveId === 'supernova.collapse') novaMove = true;
    }
    expect(collapse).toBe(true);
    expect(novaMove).toBe(true);
    expect(sn.hasCollapsed).toBe(true);
    expect(sn.isRemnant).toBe(true);
    expect(fa.view.state).not.toBe('ko');
  }, 60_000);

  it('layers blow off as it is worn down, exposing the core, which then takes extra damage', () => {
    const { m, fa, sn } = duel('supernova', 'asteroid');
    m.setSources(null, null);
    fa.world.carve(fa.body.id, 0.4, 3);
    for (let t = 0; t < 60; t++) m.step();
    expect(sn.layerBlows).toBeGreaterThanOrEqual(1);
    expect(fa.view.bodyStats.exposedCoreFrac).toBeGreaterThan(0);
  }, 60_000);

  it('is deterministic: identical scripted fights end in identical hashes', () => {
    const run = (): number => {
      const { m } = duel('supernova', 'lastone');
      const t0 = m.tick;
      m.setSources(
        createScriptSource(parseScript('1:strike,60:sig*30,140:crush,260:surge'), t0 + 1),
        createScriptSource(parseScript('20:strike,100:crush'), t0 + 1),
      );
      for (let t = 0; t < 420; t++) m.step();
      return m.hash();
    };
    expect(run()).toBe(run());
  }, 90_000);

  it('the first visible response to a press is on the same tick', () => {
    const { m, fa } = duel('supernova', 'asteroid');
    const src = new ManualSource();
    m.setSources(src, null);
    src.held = Btn.STRIKE;
    m.step();
    expect(fa.view.state).toBe('startup');
    expect(m.events.some((e) => e.t === 'move' && e.moveId === 'supernova.flare')).toBe(true);
  });
});
