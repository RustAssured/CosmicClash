import { describe, expect, it } from 'vitest';
import { asShape, makeFatShape } from './shapes';
import { parseScript, type DamageEvent, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';
import type { FighterImpl } from './fighter';

/** The Remainder (slot 0) against a foe `gap` px away, both scripted. */
function setup(script0: string, script1 = '', gap = 260, foe: TitanId = 'lastone') {
  const m = makeMatch({ a: 'remainder', b: foe, seed: 21, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const g = m.fighters[1] as FighterImpl;
  g.px = f.px + gap;
  g.py = f.py;
  m.setSources(
    createScriptSource(parseScript(script0), m.tick + 1),
    createScriptSource(parseScript(script1), m.tick + 1),
  );
  return { m, f, g };
}

const cues = (m: ReturnType<typeof setup>['m'], ticks: number): string[] => {
  const out: string[] = [];
  for (let t = 0; t < ticks; t++) {
    m.step();
    for (const e of m.events) if (e.t === 'cue' && e.slot === 0) out.push(e.id);
  }
  return out;
};

describe('the Remainder', () => {
  it('Inhale yanks the foe toward it (much further than the same foe drifts on its own)', () => {
    const still = setup('', '', 280);
    const pulled = setup('10:crush', '', 280);
    for (let t = 0; t < 90; t++) {
      still.m.step();
      pulled.m.step();
    }
    const gap = (s: ReturnType<typeof setup>): number => s.g.px - s.f.px;
    expect(gap(pulled)).toBeLessThan(gap(still) - 25);
  });

  it('Snap and Inhale hoard Mass from what they tear off the foe', () => {
    const { m, f } = setup('10:strike,60:crush', '', 200);
    const before = f.resource;
    for (let t = 0; t < 170; t++) m.step();
    expect(f.resource).toBeGreaterThan(before + 0.2);
  });

  it('Compaction fires a slug forward (Mass spent, a launched chunk) and grows plates when aimed down', () => {
    const shot = setup('10:sig*50');
    const before = shot.f.resource;
    const ids = cues(shot.m, 120);
    expect(ids).toContain('compaction-crack');
    expect(shot.f.resource).toBeLessThan(before);

    const plates = setup('8:down*60,10:sig*20');
    const cells0 = (plates.f.view.bodyStats as { cells: number }).cells;
    const pid = cues(plates.m, 90);
    expect(pid).toContain('compaction-merge');
    expect((plates.f.view.bodyStats as { cells: number }).cells).toBeGreaterThan(cells0);
  });

  it('Fold is untouchable while it is folded and leaves where it was', () => {
    const { m, f } = setup('10:surge', '', 400);
    const x0 = f.px;
    const ids = cues(m, 60);
    expect(ids).toContain('fold-collapse');
    expect(ids).toContain('fold-unfold');
    expect(Math.abs(f.px - x0)).toBeGreaterThan(80);
  });

  it('Hold Shut swallows blows into Mass', () => {
    const { m, f } = setup('2:guard*200', '20:crush,110:strike', 190);
    const before = f.resource;
    const ids = cues(m, 200);
    expect(ids).toContain('shut-consume');
    expect(f.resource).toBeGreaterThan(before);
  });

  it('Loosening exposes the core: a blow that reaches the eye while it is open lands twice', () => {
    const blow = (open: boolean): number => {
      const { m, f } = setup(open ? '10:ult' : '', '', 400);
      ((f as unknown as { meter: number }).meter as number) = 1;
      for (let t = 0; t < 70; t++) m.step();
      if (open) expect(f.mv.def?.id).toBe('remainder.loosening');
      const sh = makeFatShape();
      sh.kind = 'point';
      const res = { absorbed: 0, partsHit: 0, extraCells: 0, extraMass: 0, touched: false };
      const ev: DamageEvent = {
        type: 'KINETIC',
        shape: asShape(sh),
        energy: 900,
        dirX: -1,
        dirY: 0,
        duration: 1,
        sourceMass: 5,
        sourceBodyId: -1,
        originX: 0,
        originY: 0,
        flags: 0,
        params: {},
      };
      (
        f as unknown as { behaviour: { intercept(e: DamageEvent, i: unknown, r: typeof res): void } }
      ).behaviour.intercept(ev, {}, res);
      return res.extraCells;
    };
    expect(blow(false)).toBe(0);
    expect(blow(true)).toBeGreaterThan(0);
  });

  it('Cannibal: below a third of its mass it eats its own shell, guards weaker and turns faster', () => {
    const { m, f } = setup('');
    const beh = (f as unknown as { behaviour: { massFrac(): number; guardMultiplier(): number } }).behaviour;
    expect(beh.guardMultiplier()).toBe(1);
    // the starved state (how it got there is the fight's business): the behaviour reads its mass fraction
    beh.massFrac = () => 0.3;
    const cells0 = (f.view.bodyStats as { cells: number }).cells;
    const ids = cues(m, 120);
    expect(ids.filter((i) => i === 'cannibal-strip').length).toBeGreaterThanOrEqual(2);
    expect(beh.guardMultiplier()).toBeLessThan(1);
    // the shell is really eaten: cells leave the body (the core grows back far fewer)
    expect((f.view.bodyStats as { cells: number }).cells).toBeLessThan(cells0);
  });

  it('replays every move deterministically', () => {
    const run = (): number => {
      const { m } = setup(
        '10:strike,50:crush,150:surge,190:sig*40,260:down*40,262:sig*20,330:guard*40',
        '20:crush,120:strike,220:crush,340:strike',
        220,
      );
      for (let t = 0; t < 420; t++) m.step();
      return m.hash();
    };
    expect(run()).toBe(run());
  });
});
