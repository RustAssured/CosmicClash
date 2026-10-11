import { describe, expect, it } from 'vitest';
import { STAGE_IDS, TITAN_IDS, type GameUI, type TitanId, type UIAction } from '@/contracts';
import { Pad, createInputManager, createMemoryStore } from '@/input';
import { createFakeGamepads, proStandard, type FakePad } from '@/input/testing';
import { STAGE_INFO } from '@/stages/info';
import { FIXTURE_TITANS, fixturePortraitProvider } from './fixtures';
import {
  CLEARED,
  LADDER_AI,
  LADDER_ORDER,
  LADDER_RUNGS,
  LADDER_STORAGE_KEY,
  emptyLadder,
  ladderFor,
  loadLadder,
  parseLadder,
  recordLoss,
  recordWin,
  saveLadder,
  startRun,
  unlockOnClear,
} from './ladder';
import { ENDING_LINES, FINAL_LINES, SUBBOSS_LINES, storyCard } from './ladderStory';
import { UI_STORAGE_KEY } from './settings';
import type { TitanInfo } from './types';
import { createUI, showLadder } from './index';

/** Every pick a player can make (the Mouth once unlocked). */
const PICKS: TitanId[] = [...TITAN_IDS];

describe('ladder order', () => {
  it("우리's ladder is the approved one: six titans, the Last One (sub-boss), the Mouth (final boss, its boss variant)", () => {
    const l = ladderFor('uri');
    expect(l.map((r) => r.foe)).toEqual([
      'asteroid',
      'planet',
      'lastone',
      'nexus',
      'blackhole',
      'supernova',
      'colossus',
      'mouth',
    ]);
    expect(l.map((r) => r.role)).toEqual([
      'fight',
      'fight',
      'fight',
      'fight',
      'fight',
      'fight',
      'subboss',
      'final',
    ]);
    expect(l[7]!.boss).toBe(true);
    expect(l.filter((r) => r.boss)).toHaveLength(1);
  });

  it.each(LADDER_ORDER)(
    '%s: the rest in the same order, 우리 the sub-boss at rung 7, then the Mouth',
    (pick) => {
      const l = ladderFor(pick);
      expect(l.map((r) => r.foe)).toEqual([...LADDER_ORDER.filter((id) => id !== pick), 'uri', 'mouth']);
      expect(l[6]).toMatchObject({ n: 7, foe: 'uri', role: 'subboss', boss: false });
      expect(l[7]).toMatchObject({ n: 8, foe: 'mouth', role: 'final', boss: true });
    },
  );

  it('the Last One as the player: 우리 takes rung 7', () => {
    const l = ladderFor('colossus');
    expect(l.slice(0, 6).map((r) => r.foe)).toEqual([
      'asteroid',
      'planet',
      'lastone',
      'nexus',
      'blackhole',
      'supernova',
    ]);
    expect(l[6]!.foe).toBe('uri');
    expect(l[7]!.foe).toBe('mouth');
  });

  it("the Mouth's own ladder: the seven, the Last One still the sub-boss, and 우리 as its final boss", () => {
    const l = ladderFor('mouth');
    expect(l.map((r) => r.foe)).toEqual([...LADDER_ORDER, 'uri']);
    expect(l[6]!.role).toBe('subboss');
    expect(l[7]).toMatchObject({ foe: 'uri', role: 'final', boss: false });
  });

  it.each(PICKS)(
    '%s: eight distinct foes, never itself, difficulty ramps 3 → 6, a real stage each',
    (pick) => {
      const l = ladderFor(pick);
      expect(l).toHaveLength(LADDER_RUNGS);
      expect(new Set(l.map((r) => r.foe)).size).toBe(LADDER_RUNGS);
      expect(l.some((r) => r.foe === pick)).toBe(false);
      expect(l.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(l.map((r) => r.aiLevel)).toEqual([...LADDER_AI]);
      for (let i = 1; i < l.length; i++) expect(l[i]!.aiLevel).toBeGreaterThanOrEqual(l[i - 1]!.aiLevel);
      expect(l[0]!.aiLevel).toBe(3);
      expect(l[5]!.aiLevel).toBe(6);
      for (const r of l) expect(STAGE_IDS).toContain(r.stage);
      // every rung has a story line, the bosses their own
      for (const r of l) expect(storyCard(r).text.length).toBeGreaterThan(5);
      expect(storyCard(l[6]!)).toBe(SUBBOSS_LINES[l[6]!.foe]);
      expect(storyCard(l[7]!)).toBe(FINAL_LINES[l[7]!.foe]);
    },
  );

  it('clearing the ladder unlocks the Mouth for every pick but the Mouth itself', () => {
    for (const p of PICKS) expect(unlockOnClear(p)).toBe(p === 'mouth' ? null : 'mouth');
    expect(ENDING_LINES.length).toBeGreaterThan(0);
  });
});

describe('ladder progress', () => {
  it('climbs rung by rung, keeps the rung on a loss, ends the run and records CLEARED at the top', () => {
    const s = emptyLadder();
    startRun(s, 'planet');
    expect(s.run).toEqual({ player: 'planet', rung: 1, continues: 0 });
    expect(s.best.planet).toBe(1);
    recordLoss(s);
    expect(s.run).toMatchObject({ rung: 1, continues: 1 });
    for (let i = 1; i < LADDER_RUNGS; i++) expect(recordWin(s)).toBe('next');
    expect(s.run!.rung).toBe(8);
    expect(s.best.planet).toBe(8);
    expect(recordWin(s)).toBe('cleared');
    expect(s.run).toBeNull();
    expect(s.best.planet).toBe(CLEARED);
    // a new run never lowers the best
    startRun(s, 'planet');
    expect(s.best.planet).toBe(CLEARED);
  });

  it('persists under one key and tolerates garbage', () => {
    const store = createMemoryStore();
    const s = emptyLadder();
    startRun(s, 'uri', 5);
    s.best.asteroid = 3;
    saveLadder(store, s);
    expect(loadLadder(store)).toEqual(s);
    expect(JSON.parse(store.getItem(LADDER_STORAGE_KEY)!).run.rung).toBe(5);
    expect(parseLadder('nope')).toEqual(emptyLadder());
    expect(parseLadder(JSON.stringify({ run: { player: 'zzz', rung: 3 }, best: { uri: 99, x: 2 } }))).toEqual(
      emptyLadder(),
    );
    expect(parseLadder(JSON.stringify({ run: { player: 'uri', rung: 9 } })).run).toBeNull();
    expect(loadLadder(null)).toEqual(emptyLadder());
  });
});

/* ------------------------------------------------------------------------------------------------ *
 *  the flow through the real UI runtime
 * ------------------------------------------------------------------------------------------------ */
const extra = (id: TitanId, name: string, nameKo: string): TitanInfo => ({
  ...FIXTURE_TITANS[0]!,
  id,
  name,
  nameKo,
});
const MOUTH_INFO = extra('mouth', 'The Mouth', '아귀');

function rig(store = createMemoryStore()) {
  const pads = createFakeGamepads();
  let now = 1000;
  const input = createInputManager({
    window: new EventTarget(),
    getGamepads: pads.getGamepads,
    storage: createMemoryStore(),
    now: () => now,
    hid: null,
    userAgent: 'Chrome',
  });
  input.attach();
  if (!store.getItem(UI_STORAGE_KEY)) store.setItem(UI_STORAGE_KEY, JSON.stringify({ seenHowTo: true }));
  const unlocked: TitanId[] = [];
  const titans = [
    ...FIXTURE_TITANS,
    extra('colossus', 'The Last One', '마지막 하나'),
    extra('uri', '우리', '우리'),
  ];
  const ui = createUI({
    input,
    titans,
    portrait: fixturePortraitProvider,
    stages: STAGE_IDS.map((id) => STAGE_INFO[id]),
    implementedTitans: titans.map((t) => t.id),
    implementedStages: [...STAGE_IDS],
    storage: store,
    newSeed: () => 77,
    now: () => now,
    attractAfterSec: 1e9,
    lockedTitans: [MOUTH_INFO],
    onUnlock: (id) => unlocked.push(id),
  });
  const actions: UIAction[] = [];
  const step = (frames = 1): void => {
    for (let i = 0; i < frames; i++) {
      now += 16;
      input.poll(now);
      ui.update(1 / 60);
      ui.drainActions(actions);
    }
  };
  const pad = pads.plug(proStandard());
  const tap = (b: number): void => {
    pad.set(b, true);
    step(2);
    pad.releaseAll();
    step(2);
  };
  const started = (): Extract<UIAction, { type: 'startMatch' }>['config'] | undefined =>
    actions.filter((a): a is Extract<UIAction, { type: 'startMatch' }> => a.type === 'startMatch').at(-1)
      ?.config;
  return { ui, store, step, tap, pad: pad as FakePad, actions, started, unlocked };
}

/** Title → TOURNAMENT → join with the pad → confirm. */
function toTournament(r: ReturnType<typeof rig>): void {
  r.step(3);
  r.tap(Pad.EAST);
  r.step(20);
  r.tap(Pad.DOWN);
  r.tap(Pad.DOWN); // VERSUS, VS AI, TOURNAMENT
  r.tap(Pad.EAST);
  expect(r.ui.screen).toBe('assign');
  r.tap(Pad.SOUTH); // join
  r.step(3);
  r.tap(Pad.EAST);
}

const screenOf = (ui: GameUI): string => ui.screen;

describe('tournament flow', () => {
  it('menu → pick (우리 highlighted) → tower → story card → fight → climb → defeat → CONTINUE', () => {
    const r = rig();
    toTournament(r);
    expect(r.ui.screen).toBe('select');
    r.tap(Pad.EAST); // lock the default highlight: 우리
    r.step(50);
    expect(r.ui.screen).toBe('ladder');
    expect(loadLadder(r.store).run).toEqual({ player: 'uri', rung: 1, continues: 0 });
    r.step(40);
    r.tap(Pad.EAST); // FIGHT → the story card
    r.step(30);
    r.tap(Pad.EAST); // finish the line
    r.tap(Pad.EAST); // fight
    expect(r.started()).toMatchObject({
      mode: 'vsai',
      stage: 'shearfield',
      slots: [
        { titan: 'uri', controller: 'human' },
        { titan: 'asteroid', controller: 'ai', aiLevel: 3 },
      ],
    });
    // the match ends: P1 won → back on the tower, one rung up
    r.ui.showHud();
    r.ui.showResults(0);
    expect(screenOf(r.ui)).toBe('ladder');
    expect(loadLadder(r.store).run!.rung).toBe(2);
    // lost the next one: CONTINUE retries the same rung
    r.ui.showResults(1);
    expect(loadLadder(r.store).run).toMatchObject({ rung: 2, continues: 1 });
    r.step(40);
    r.tap(Pad.EAST); // CONTINUE
    expect(r.started()!.slots[1]).toMatchObject({ titan: 'planet', aiLevel: 3 });
  });

  it('the final rung is the boss Mouth; beating it shows the ending and unlocks the Mouth for the select', () => {
    const r = rig();
    r.step(3);
    showLadder(r.ui, 'ladder', { dev: { player: 'uri', rung: 8 } });
    r.step(40);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    expect(r.started()!.slots[1]).toEqual({ titan: 'mouth', controller: 'ai', aiLevel: 6, boss: true });
    r.ui.showHud();
    r.ui.showResults(0);
    expect(r.ui.screen).toBe('ladder');
    expect(r.unlocked).toEqual(['mouth']);
    const s = loadLadder(r.store);
    expect(s.run).toBeNull();
    expect(s.best.uri).toBe(CLEARED);
    r.ui.draw(null);
    // the ending leads to the title; the Mouth is now a ready pick
    r.step(120);
    r.tap(Pad.EAST);
    expect(r.ui.screen).toBe('title');
    expect(r.actions.some((a) => a.type === 'quitToTitle')).toBe(true);
    showLadder(r.ui, 'select');
    r.step(5);
    const ctx = r.ui as unknown as { isTitanReady(id: TitanId): boolean; deps: { titans: TitanInfo[] } };
    expect(ctx.isTitanReady('mouth')).toBe(true);
    expect(ctx.deps.titans.some((t) => t.id === 'mouth')).toBe(true);
    r.ui.draw(null);
  });

  it('a closed tab resumes at the stored rung (TOURNAMENT skips the select)', () => {
    const store = createMemoryStore();
    const s = emptyLadder();
    startRun(s, 'nexus', 4);
    saveLadder(store, s);
    const r = rig(store);
    toTournament(r);
    expect(r.ui.screen).toBe('ladder');
    r.step(40);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    // nexus's ladder: asteroid, planet, lastone, blackhole (rung 4)
    expect(r.started()!.slots).toMatchObject([{ titan: 'nexus' }, { titan: 'blackhole', aiLevel: 4 }]);
  });

  it('every ladder view draws', () => {
    const r = rig();
    r.step(3);
    for (const p of [
      { dev: { player: 'uri' as TitanId, rung: 3 } },
      { dev: { player: 'planet' as TitanId, rung: 7 }, view: 'card' as const },
      { dev: { player: 'colossus' as TitanId, rung: 8 }, view: 'lose' as const },
      { ending: { player: 'uri' as TitanId, unlocked: true } },
    ]) {
      showLadder(r.ui, 'ladder', p);
      r.step(240);
      r.ui.draw(null);
      let ink = 0;
      for (const c of r.ui.layer.pixels) if (c >>> 24) ink++;
      expect(ink).toBeGreaterThan(5000);
    }
  });
});
