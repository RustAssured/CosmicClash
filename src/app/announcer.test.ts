import { describe, expect, it } from 'vitest';
import { ROUND_INTRO_TICKS, type HudState } from '@/contracts';
import { createMatch, createScriptSource } from '@/sim';
import { fakeDeps } from '@/sim/testing/fakes';
import { Btn } from '@/contracts';
import { announcerText, fillHudState } from './announcer';
import { createGuardDummy, tapSource } from './tap';

const mk = (): ReturnType<typeof createMatch> =>
  createMatch(
    {
      seed: 1,
      stage: 'nursery',
      mode: 'versus',
      slots: [
        { titan: 'lastone', controller: 'dummy' },
        { titan: 'asteroid', controller: 'dummy' },
      ],
    },
    fakeDeps(),
  );

describe('announcer', () => {
  it('walks ROUND → FIGHT → clear', () => {
    const m = mk();
    m.step();
    expect(announcerText(m)).toBe('ROUND 1');
    for (let i = 0; i < ROUND_INTRO_TICKS * 0.6; i++) m.step();
    expect(announcerText(m)).toBe('FIGHT');
    for (let i = 0; i < ROUND_INTRO_TICKS; i++) m.step();
    expect(m.phase).toBe('fight');
    expect(announcerText(m)).toBeNull();
  });
  it('fills a HUD state', () => {
    const m = mk();
    const out = { training: false } as HudState;
    fillHudState(out, m, true, false);
    expect(out.match).toBe(m);
    expect(out.training).toBe(true);
    expect(out.phase).toBe('intro');
  });
});

describe('tapSource', () => {
  it('reports pause/training edges and strips them from the sim frame', () => {
    const inner = createScriptSource([
      { tick: 1, buttons: Btn.PAUSE, hold: 0, moveX: 0, moveY: 0, moveTicks: 0 },
      { tick: 2, buttons: Btn.STRIKE | Btn.TRAINING, hold: 0, moveX: 0, moveY: 0, moveTicks: 0 },
    ]);
    const t = tapSource(inner);
    const f = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    t.poll(1, f);
    expect(f.held & Btn.PAUSE).toBe(0);
    expect(t.take()).toEqual({ pause: true, training: false });
    t.poll(2, f);
    expect(f.pressed).toBe(Btn.STRIKE);
    expect(t.take()).toEqual({ pause: false, training: true });
    expect(t.take()).toEqual({ pause: false, training: false });
  });
  it('guard dummy holds guard', () => {
    const d = createGuardDummy();
    const f = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    d.poll(1, f);
    expect(f.held).toBe(Btn.GUARD);
    expect(f.pressed).toBe(Btn.GUARD);
    d.poll(2, f);
    expect(f.pressed).toBe(0);
  });
});
