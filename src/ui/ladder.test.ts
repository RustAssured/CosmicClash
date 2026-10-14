import { describe, expect, it } from 'vitest';
import { NEW_TITAN_DAYS, STAGE_IDS, TITAN_IDS, type GameUI, type TitanId, type UIAction } from '@/contracts';
import { Pad, createInputManager, createMemoryStore } from '@/input';
import { createFakeGamepads, proStandard, type FakePad } from '@/input/testing';
import { STAGE_INFO } from '@/stages/info';
import { ladderRoster } from '@/titans/roster';
import { FIXTURE_TITANS, fixturePortraitProvider } from './fixtures';
import {
  AI_RAMPS,
  CLEARED,
  LADDER_DIFFICULTIES,
  LADDER_ORDER,
  LADDER_RUNGS,
  LADDER_STORAGE_KEY,
  LADDER_V1_KEY,
  aiRamp,
  cosmicCount,
  cosmicFoes,
  emptyLadder,
  isNewTitan,
  ladderFor,
  loadLadder,
  migrateLadderV1,
  parseLadder,
  recordLoss,
  recordWin,
  runOf,
  runRungs,
  saveLadder,
  startRun,
  unlockOnClear,
  type LadderTitan,
} from './ladder';
import { ENDING_LINES, FINAL_LINES, RUNG_LINES, SUBBOSS_LINES, storyCard } from './ladderStory';
import { UI_STORAGE_KEY } from './settings';
import type { TitanInfo } from './types';
import { createUI, showLadder } from './index';

/** Every pick a player can make (the Mouth once unlocked). */
const PICKS: TitanId[] = [...TITAN_IDS];
/** The real roster's tournament data (src/titans/roster.ts). */
const ROSTER = ladderRoster();
const SHIPPED = ROSTER.filter((t) => !t.wip).map((t) => t.id);

describe('CLASSIC order', () => {
  it("우리's ladder is the approved one: seven titans with the Cradle, the Last One (sub-boss), the Mouth (boss)", () => {
    const l = ladderFor('uri');
    expect(l.map((r) => r.foe)).toEqual([
      'asteroid',
      'planet',
      'lastone',
      'nexus',
      'blackhole',
      'supernova',
      'cradle',
      'colossus',
      'mouth',
    ]);
    expect(l).toHaveLength(LADDER_RUNGS);
    expect(LADDER_RUNGS).toBe(9);
    expect(l.map((r) => r.role)).toEqual([...Array(7).fill('fight'), 'subboss', 'final']);
    expect(l[8]!.boss).toBe(true);
    expect(l.filter((r) => r.boss)).toHaveLength(1);
    expect(storyCard(l[6]!).text).toBe('Then something began to prepare you.');
    expect(RUNG_LINES.cradle).toBeDefined();
  });

  it.each(LADDER_ORDER)('%s: the rest in the same order, 우리 the sub-boss, then the Mouth', (pick) => {
    const l = ladderFor(pick);
    expect(l.map((r) => r.foe)).toEqual([...LADDER_ORDER.filter((id) => id !== pick), 'uri', 'mouth']);
    expect(l[7]).toMatchObject({ n: 8, foe: 'uri', role: 'subboss', boss: false });
    expect(l[8]).toMatchObject({ n: 9, foe: 'mouth', role: 'final', boss: true });
  });

  it("the Mouth's own ladder: the eight, the Last One still the sub-boss, and 우리 as its final boss", () => {
    const l = ladderFor('mouth');
    expect(l.map((r) => r.foe)).toEqual([...LADDER_ORDER, 'uri']);
    expect(l[7]!.role).toBe('subboss');
    expect(l[8]).toMatchObject({ foe: 'uri', role: 'final', boss: false });
  });

  it.each(PICKS)(
    '%s: distinct foes, never itself, a real stage and a story line each, every difficulty',
    (pick) => {
      for (const difficulty of LADDER_DIFFICULTIES) {
        const l = ladderFor(pick, { difficulty });
        expect(l).toHaveLength(LADDER_RUNGS);
        expect(new Set(l.map((r) => r.foe)).size).toBe(LADDER_RUNGS);
        expect(l.some((r) => r.foe === pick)).toBe(false);
        expect(l.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(l.map((r) => r.aiLevel)).toEqual(aiRamp(difficulty, LADDER_RUNGS));
        for (const r of l) expect(STAGE_IDS).toContain(r.stage);
        for (const r of l) expect(storyCard(r).text.length).toBeGreaterThan(5);
        expect(storyCard(l[7]!)).toBe(SUBBOSS_LINES[l[7]!.foe]);
        expect(storyCard(l[8]!)).toBe(FINAL_LINES[l[8]!.foe]);
        // the boss Mouth on NORMAL and TITAN; EASY meets the normal Mouth
        expect(l[8]!.boss).toBe(l[8]!.foe === 'mouth' && difficulty !== 'easy');
      }
    },
  );

  it('clearing either mode unlocks the Mouth for every pick but the Mouth itself', () => {
    for (const p of PICKS) {
      expect(unlockOnClear(p)).toBe(p === 'mouth' ? null : 'mouth');
      expect(unlockOnClear(p, { mode: 'cosmic', roster: ROSTER, seed: 3 })).toBe(
        p === 'mouth' ? null : 'mouth',
      );
    }
    expect(ENDING_LINES.length).toBeGreaterThan(0);
  });
});

describe('COSMIC CLASH order', () => {
  it.each(PICKS)(
    '%s: every shipped titan once (never itself), the Last One and the Mouth always last',
    (pick) => {
      for (const seed of [1, 2, 99, 123456]) {
        const foes = cosmicFoes(pick, ROSTER, seed);
        const expected = SHIPPED.filter((id) => id !== pick);
        if (pick !== 'mouth') expected.push('mouth');
        expect([...foes].sort()).toEqual([...expected].sort());
        expect(new Set(foes).size).toBe(foes.length);
        const tail = foes.slice(-2);
        if (pick === 'colossus') expect(tail).toEqual(['uri', 'mouth']);
        else if (pick === 'mouth') expect(tail).toEqual(['colossus', 'uri']);
        else expect(tail).toEqual(['colossus', 'mouth']);
        const l = ladderFor(pick, { mode: 'cosmic', roster: ROSTER, seed });
        expect(l.at(-1)!.role).toBe('final');
        expect(l.at(-2)!.role).toBe('subboss');
        for (const r of l) expect(STAGE_IDS).toContain(r.stage);
      }
    },
  );

  it('opens on the light titans (tier 1), then the shuffled middle', () => {
    const tier = (id: TitanId): number => ROSTER.find((t) => t.id === id)!.tier;
    const light = ROSTER.filter((t) => !t.wip && t.tier <= 1).map((t) => t.id);
    expect(light.length).toBeGreaterThan(0);
    for (const seed of [1, 7, 42]) {
      const foes = cosmicFoes('uri', ROSTER, seed);
      expect(foes.slice(0, light.length).every((id) => tier(id) <= 1)).toBe(true);
      expect(foes.slice(light.length, -2).every((id) => tier(id) > 1)).toBe(true);
    }
  });

  it('includes a newly shipped titan with no code edits, and leaves out work in progress', () => {
    const gloop = { id: 'gloop' as TitanId, tier: 2, shippedAt: '2026-10-20', catalogue: 10 };
    const withNew: LadderTitan[] = [...ROSTER, gloop];
    expect(cosmicFoes('uri', withNew, 5)).toContain('gloop');
    expect(cosmicCount(withNew)).toBe(cosmicCount(ROSTER) + 1);
    const wip: LadderTitan[] = ROSTER.map((t) => (t.id === 'cradle' ? { ...t, wip: true } : t));
    for (const seed of [1, 2, 3]) expect(cosmicFoes('uri', wip, seed)).not.toContain('cradle');
    expect(cosmicCount(wip)).toBe(cosmicCount(ROSTER) - 1);
    expect(cosmicFoes('uri', [...ROSTER, { ...gloop, wip: true }], 5)).not.toContain('gloop');
  });

  it('the shuffle is seeded: the same seed deals the same lineup, other seeds vary it', () => {
    expect(cosmicFoes('planet', ROSTER, 77)).toEqual(cosmicFoes('planet', ROSTER, 77));
    // the roster's own order does not matter
    expect(cosmicFoes('planet', [...ROSTER].reverse(), 77)).toEqual(cosmicFoes('planet', ROSTER, 77));
    const seen = new Set<string>();
    for (let s = 1; s <= 20; s++) seen.add(cosmicFoes('planet', ROSTER, s).join(','));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('a run keeps the lineup it was dealt (a titan shipped mid-run does not reshuffle it) and resumes exactly', () => {
    const store = createMemoryStore();
    const s = emptyLadder();
    const r = startRun(s, 'nexus', { mode: 'cosmic', difficulty: 'titan', roster: ROSTER, seed: 31 });
    expect(r.order).toEqual(cosmicFoes('nexus', ROSTER, 31));
    saveLadder(store, s);
    const back = loadLadder(store);
    const run = runOf(back, 'cosmic', 'titan')!;
    const grown: LadderTitan[] = [...ROSTER, { id: 'gloop' as TitanId, tier: 2 }];
    expect(runRungs(run, 'cosmic', 'titan', grown).map((x) => x.foe)).toEqual(r.order);
  });

  it('a newly shipped titan wears NEW for its first weeks; the launch roster never does', () => {
    const day = (s: string): number => Date.parse(`${s}T12:00:00Z`);
    const cradle = ROSTER.find((t) => t.id === 'cradle')!;
    expect(cradle).toMatchObject({ shippedAt: '2026-10-14', catalogue: 9 });
    expect(isNewTitan(cradle, day('2026-10-14'))).toBe(true);
    expect(isNewTitan(cradle, day('2026-11-01'))).toBe(true);
    expect(isNewTitan(cradle, day('2026-10-14') + NEW_TITAN_DAYS * 86_400_000)).toBe(false);
    for (const t of ROSTER.filter((x) => x.id !== 'cradle'))
      expect(isNewTitan(t, day('2026-10-14'))).toBe(false);
  });

  it('catalogue numbers run ADK-001 … in arrival order, one each, the Cradle ninth', () => {
    const nums = ROSTER.filter((t) => !t.wip).map((t) => t.catalogue);
    expect(nums.every((n) => typeof n === 'number')).toBe(true);
    expect([...nums].sort((a, b) => a! - b!)).toEqual(nums.map((_, i) => i + 1));
  });
});

describe('difficulty ramps', () => {
  it('NORMAL is the original ramp at eight rungs, stretched to any length', () => {
    expect(aiRamp('normal', 8)).toEqual([3, 3, 4, 4, 5, 6, 6, 6]);
    expect(aiRamp('normal', 9)).toEqual([3, 3, 4, 4, 5, 5, 6, 6, 6]);
    expect(AI_RAMPS.normal).toEqual([3, 3, 4, 4, 5, 6, 6, 6]);
  });

  it.each([2, 5, 8, 9, 12, 20])(
    '%i rungs: every ramp climbs; EASY tops out mid, TITAN starts high and stays on top',
    (n) => {
      for (const d of LADDER_DIFFICULTIES) {
        const r = aiRamp(d, n);
        expect(r).toHaveLength(n);
        for (let i = 1; i < n; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!);
      }
      expect(Math.max(...aiRamp('easy', n))).toBeLessThanOrEqual(3);
      expect(aiRamp('easy', n)[0]).toBe(1);
      expect(aiRamp('normal', n)[0]).toBe(3);
      expect(aiRamp('normal', n).at(-1)).toBe(6);
      expect(aiRamp('titan', n)[0]).toBeGreaterThanOrEqual(5);
      expect(
        aiRamp('titan', n)
          .slice(1)
          .every((l) => l === 6),
      ).toBe(true);
    },
  );
});

describe('progress', () => {
  it('climbs rung by rung, keeps the rung on a loss, ends the run and records CLEARED at the top', () => {
    const s = emptyLadder();
    startRun(s, 'planet');
    expect(runOf(s, 'classic', 'normal')).toEqual({ player: 'planet', rung: 1, continues: 0, seed: 1 });
    expect(s.best.classic.planet).toBe(1);
    recordLoss(s);
    expect(runOf(s, 'classic', 'normal')).toMatchObject({ rung: 1, continues: 1 });
    for (let i = 1; i < LADDER_RUNGS; i++) expect(recordWin(s)).toBe('next');
    expect(runOf(s, 'classic', 'normal')!.rung).toBe(9);
    expect(s.best.classic.planet).toBe(9);
    expect(recordWin(s)).toBe('cleared');
    expect(runOf(s, 'classic', 'normal')).toBeNull();
    expect(s.best.classic.planet).toBe(CLEARED);
    startRun(s, 'planet');
    expect(s.best.classic.planet).toBe(CLEARED);
  });

  it('keeps a run per mode and difficulty, and the best rung per mode', () => {
    const s = emptyLadder();
    startRun(s, 'uri', { rung: 4 });
    startRun(s, 'planet', { mode: 'cosmic', difficulty: 'easy', roster: ROSTER, seed: 9 });
    startRun(s, 'nexus', { mode: 'classic', difficulty: 'titan', rung: 2 });
    expect(runOf(s, 'classic', 'normal')!.player).toBe('uri');
    expect(runOf(s, 'cosmic', 'easy')!.player).toBe('planet');
    expect(runOf(s, 'classic', 'titan')).toMatchObject({ player: 'nexus', rung: 2 });
    expect(runOf(s, 'cosmic', 'normal')).toBeNull();
    recordWin(s, 'cosmic', 'easy', ROSTER);
    expect(runOf(s, 'cosmic', 'easy')!.rung).toBe(2);
    expect(runOf(s, 'classic', 'normal')!.rung).toBe(4);
    expect(s.best.cosmic.planet).toBe(2);
    expect(s.best.classic.planet).toBeUndefined();
    expect(s.last).toEqual({ mode: 'classic', difficulty: 'titan' });
  });

  it('a COSMIC CLASH run clears after its own length', () => {
    const s = emptyLadder();
    const r = startRun(s, 'asteroid', { mode: 'cosmic', roster: ROSTER, seed: 4 });
    const n = r.order!.length;
    for (let i = 1; i < n; i++) expect(recordWin(s, 'cosmic', 'normal', ROSTER)).toBe('next');
    expect(recordWin(s, 'cosmic', 'normal', ROSTER)).toBe('cleared');
    expect(s.best.cosmic.asteroid).toBe(CLEARED);
  });

  it('persists under one key and tolerates garbage', () => {
    const store = createMemoryStore();
    const s = emptyLadder();
    startRun(s, 'uri', { rung: 5 });
    startRun(s, 'planet', { mode: 'cosmic', difficulty: 'titan', roster: ROSTER, seed: 12 });
    s.best.classic.asteroid = 3;
    saveLadder(store, s);
    expect(loadLadder(store)).toEqual(s);
    expect(JSON.parse(store.getItem(LADDER_STORAGE_KEY)!).runs['classic:normal'].rung).toBe(5);
    expect(parseLadder('nope')).toEqual(emptyLadder());
    expect(
      parseLadder(
        JSON.stringify({
          runs: { 'classic:normal': { player: 'zzz', rung: 3 }, 'x:y': { player: 'uri', rung: 1 } },
          best: { classic: { uri: 999, x: 2 } },
          last: { mode: 'nope', difficulty: 'easy' },
        }),
      ),
    ).toEqual(emptyLadder());
    expect(
      parseLadder(JSON.stringify({ runs: { 'classic:easy': { player: 'uri', rung: 10 } } })).runs,
    ).toEqual({});
    expect(
      parseLadder(
        JSON.stringify({ runs: { 'cosmic:easy': { player: 'uri', rung: 3, order: ['planet', 'bogus'] } } }),
      ).runs,
    ).toEqual({});
    expect(loadLadder(null)).toEqual(emptyLadder());
  });

  it('migrates the S12 save (adeuk.ladder.v1) into CLASSIC NORMAL, at the same foe', () => {
    const store = createMemoryStore();
    store.setItem(
      LADDER_V1_KEY,
      JSON.stringify({
        run: { player: 'uri', rung: 7, continues: 2 },
        best: { uri: 9, planet: 5, nexus: 8 },
      }),
    );
    const s = loadLadder(store);
    // rung 7 was the Last One (sub-boss); with the Cradle at 7 it is rung 8 now
    expect(runOf(s, 'classic', 'normal')).toEqual({ player: 'uri', rung: 8, continues: 2, seed: 1 });
    expect(ladderFor('uri')[7]!.foe).toBe('colossus');
    expect(s.best.classic).toEqual({ uri: CLEARED, planet: 5, nexus: 9 });
    expect(s.best.cosmic).toEqual({});
    // written as v2 at once; v2 wins from then on
    expect(JSON.parse(store.getItem(LADDER_STORAGE_KEY)!).runs['classic:normal'].rung).toBe(8);
    store.setItem(LADDER_V1_KEY, JSON.stringify({ run: { player: 'planet', rung: 1 } }));
    expect(runOf(loadLadder(store), 'classic', 'normal')!.player).toBe('uri');
    expect(migrateLadderV1('garbage')).toBeNull();
    expect(migrateLadderV1(JSON.stringify({ run: { player: 'uri', rung: 12 } }))!.runs).toEqual({});
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
    extra('cradle', 'The Cradle', '태반체'),
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
    today: () => Date.parse('2026-10-14T12:00:00Z'),
    attractAfterSec: 1e9,
    lockedTitans: [MOUTH_INFO],
    onUnlock: (id) => unlocked.push(id),
    roster: ROSTER,
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

/** Title → TOURNAMENT → join with the pad → confirm → the mode / difficulty screen. */
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
  expect(r.ui.screen).toBe('tourney');
  r.step(15);
}

const screenOf = (ui: GameUI): string => ui.screen;

describe('tournament flow', () => {
  it('menu → CLASSIC → NORMAL → pick (우리 highlighted) → tower → story card → fight → climb → defeat → CONTINUE', () => {
    const r = rig();
    toTournament(r);
    r.tap(Pad.EAST); // CLASSIC (the default)
    r.tap(Pad.EAST); // NORMAL (the default)
    expect(r.ui.screen).toBe('select');
    r.tap(Pad.EAST); // lock the default highlight: 우리
    r.step(50);
    expect(r.ui.screen).toBe('ladder');
    expect(runOf(loadLadder(r.store), 'classic', 'normal')).toMatchObject({
      player: 'uri',
      rung: 1,
      continues: 0,
    });
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
    r.ui.showHud();
    r.ui.showResults(0);
    expect(screenOf(r.ui)).toBe('ladder');
    expect(runOf(loadLadder(r.store), 'classic', 'normal')!.rung).toBe(2);
    r.ui.showResults(1);
    expect(runOf(loadLadder(r.store), 'classic', 'normal')).toMatchObject({ rung: 2, continues: 1 });
    r.step(40);
    r.tap(Pad.EAST); // CONTINUE
    expect(r.started()!.slots[1]).toMatchObject({ titan: 'planet', aiLevel: 3 });
  });

  it('COSMIC CLASH on TITAN: deals the previewed lineup, top-level AI from rung 2', () => {
    const r = rig();
    toTournament(r);
    r.tap(Pad.RIGHT); // COSMIC CLASH
    r.tap(Pad.EAST);
    r.tap(Pad.DOWN); // NORMAL → TITAN
    r.tap(Pad.EAST);
    expect(r.ui.screen).toBe('select');
    r.tap(Pad.EAST); // 우리
    r.step(50);
    expect(r.ui.screen).toBe('ladder');
    const run = runOf(loadLadder(r.store), 'cosmic', 'titan')!;
    expect(run.seed).toBe(77);
    expect(run.order).toEqual(cosmicFoes('uri', ROSTER, 77));
    expect(loadLadder(r.store).last).toEqual({ mode: 'cosmic', difficulty: 'titan' });
    r.step(40);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    expect(r.started()!.slots[1]).toMatchObject({ titan: run.order![0], aiLevel: 5 });
    r.ui.showHud();
    r.ui.showResults(0);
    r.step(80);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    expect(r.started()!.slots[1]).toMatchObject({ titan: run.order![1], aiLevel: 6 });
  });

  it('EASY ends on the normal Mouth; beating it still unlocks the Mouth', () => {
    const r = rig();
    r.step(3);
    showLadder(r.ui, 'ladder', { dev: { player: 'uri', rung: 9 } }, { mode: 'classic', difficulty: 'easy' });
    r.step(40);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    expect(r.started()!.slots[1]).toEqual({ titan: 'mouth', controller: 'ai', aiLevel: 3 });
    r.ui.showHud();
    r.ui.showResults(0);
    expect(r.unlocked).toEqual(['mouth']);
    expect(loadLadder(r.store).best.classic.uri).toBe(CLEARED);
  });

  it('the final rung is the boss Mouth; beating it shows the ending and unlocks the Mouth for the select', () => {
    const r = rig();
    r.step(3);
    showLadder(
      r.ui,
      'ladder',
      { dev: { player: 'uri', rung: 9 } },
      { mode: 'classic', difficulty: 'normal' },
    );
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
    expect(runOf(s, 'classic', 'normal')).toBeNull();
    expect(s.best.classic.uri).toBe(CLEARED);
    r.ui.draw(null);
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

  it('beating the COSMIC CLASH final boss unlocks the Mouth too', () => {
    const r = rig();
    r.step(3);
    const n = cosmicFoes('planet', ROSTER, 1).length;
    showLadder(
      r.ui,
      'ladder',
      { dev: { player: 'planet', rung: n } },
      { mode: 'cosmic', difficulty: 'normal' },
    );
    r.step(40);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    expect(r.started()!.slots[1]).toMatchObject({ titan: 'mouth', boss: true });
    r.ui.showHud();
    r.ui.showResults(0);
    expect(r.unlocked).toEqual(['mouth']);
    expect(loadLadder(r.store).best.cosmic.planet).toBe(CLEARED);
  });

  it('a closed tab resumes at the stored rung (the chosen mode and difficulty skip the select)', () => {
    const store = createMemoryStore();
    const s = emptyLadder();
    startRun(s, 'nexus', { rung: 4 });
    saveLadder(store, s);
    const r = rig(store);
    toTournament(r);
    r.tap(Pad.EAST); // CLASSIC
    r.tap(Pad.EAST); // NORMAL: the stored run
    expect(r.ui.screen).toBe('ladder');
    r.step(40);
    r.tap(Pad.EAST);
    r.step(30);
    r.tap(Pad.EAST);
    r.tap(Pad.EAST);
    // nexus's ladder: asteroid, planet, lastone, blackhole (rung 4)
    expect(r.started()!.slots).toMatchObject([{ titan: 'nexus' }, { titan: 'blackhole', aiLevel: 4 }]);
  });

  it('every tournament view draws', () => {
    const r = rig();
    r.step(3);
    const views: [Parameters<typeof showLadder>[1], unknown, Parameters<typeof showLadder>[3]][] = [
      ['tourney', { phase: 'mode' }, {}],
      ['tourney', { phase: 'difficulty' }, { mode: 'cosmic' }],
      ['tourney', { phase: 'difficulty' }, { mode: 'classic', difficulty: 'easy' }],
      ['select', undefined, { mode: 'cosmic', difficulty: 'normal' }],
      ['ladder', { dev: { player: 'uri', rung: 3 } }, { mode: 'classic' }],
      ['ladder', { dev: { player: 'uri', rung: 3 }, seed: 5 }, { mode: 'cosmic' }],
      ['ladder', { dev: { player: 'planet', rung: 7 }, view: 'card' }, { mode: 'classic' }],
      ['ladder', { dev: { player: 'colossus', rung: 9 }, view: 'lose' }, { mode: 'cosmic' }],
      ['ladder', { ending: { player: 'uri', unlocked: true } }, {}],
    ];
    for (const [id, p, pick] of views) {
      showLadder(r.ui, id, p, pick);
      r.step(240);
      r.ui.draw(null);
      let ink = 0;
      for (const c of r.ui.layer.pixels) if (c >>> 24) ink++;
      expect(ink).toBeGreaterThan(5000);
    }
  });
});
