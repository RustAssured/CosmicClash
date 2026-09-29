import { describe, expect, it } from 'vitest';
import {
  LOGICAL_H,
  LOGICAL_W,
  STAGE_IDS,
  type GameUI,
  type HudState,
  type UIAction,
  type UiSoundId,
  type UIScreenId,
} from '@/contracts';
import { Pad, createInputManager, createMemoryStore, type InputManager } from '@/input';
import { createFakeGamepads, proStandard, xboxStandard, type FakePad } from '@/input/testing';
import { STAGE_INFO } from '@/stages/info';
import { FIXTURE_TITANS, fakeHud, fixturePortraitProvider } from './fixtures';
import { damageDealt } from './screens/results';
import { showScreen } from './ui';
import { createUI } from './index';
import { UI_STORAGE_KEY } from './settings';

interface Rig {
  ui: GameUI;
  input: InputManager;
  pads: ReturnType<typeof createFakeGamepads>;
  actions: UIAction[];
  sounds: UiSoundId[];
  /** Every action ever drained, in order (`drain()` clears `actions`; this keeps the record). */
  history: UIAction[];
  store: ReturnType<typeof createMemoryStore>;
  win: EventTarget;
  step: (frames?: number, dt?: number) => void;
  /** Press a pad button for a few frames, then release. */
  tap: (pad: FakePad, b: number) => void;
  key: (code: string) => void;
  drain: () => UIAction[];
  now: () => number;
  draw: () => void;
}

function rig(
  o: {
    attractAfterSec?: number;
    implementedTitans?: string[];
    store?: ReturnType<typeof createMemoryStore>;
  } = {},
): Rig {
  const pads = createFakeGamepads();
  const win = new EventTarget();
  let now = 1000;
  const input = createInputManager({
    window: win,
    getGamepads: pads.getGamepads,
    storage: createMemoryStore(),
    now: () => now,
    hid: null,
    userAgent: 'Chrome',
  });
  input.attach();
  const actions: UIAction[] = [];
  const sounds: UiSoundId[] = [];
  const history: UIAction[] = [];
  const store = o.store ?? createMemoryStore();
  const ui = createUI({
    input,
    titans: FIXTURE_TITANS,
    portrait: fixturePortraitProvider,
    stages: STAGE_IDS.map((id) => STAGE_INFO[id]),
    implementedTitans: (o.implementedTitans ?? ['lastone', 'asteroid']) as never,
    implementedStages: ['nursery'],
    storage: store,
    sound: (id) => sounds.push(id),
    newSeed: () => 1234,
    now: () => now,
    attractAfterSec: o.attractAfterSec ?? 1e9,
  });
  const step = (frames = 1, dt = 1 / 60): void => {
    for (let i = 0; i < frames; i++) {
      now += Math.round(dt * 1000);
      input.poll(now);
      ui.update(dt);
      const before = actions.length;
      ui.drainActions(actions);
      for (let k = before; k < actions.length; k++) history.push(actions[k]!);
    }
  };
  const tap = (pad: FakePad, b: number): void => {
    pad.set(b, true);
    step(2);
    pad.releaseAll();
    step(2);
  };
  const key = (code: string): void => {
    win.dispatchEvent(Object.assign(new Event('keydown'), { code, repeat: false }));
    step(2);
    win.dispatchEvent(Object.assign(new Event('keyup'), { code }));
    step(2);
  };
  return {
    ui,
    input,
    pads,
    actions,
    sounds,
    history,
    store,
    win,
    step,
    tap,
    key,
    drain: () => actions.splice(0),
    now: () => now,
    draw: () => ui.draw(null),
  };
}

const startMatch = (a: UIAction[]): Extract<UIAction, { type: 'startMatch' }> | undefined =>
  a.find((x): x is Extract<UIAction, { type: 'startMatch' }> => x.type === 'startMatch');

const inkCount = (ui: GameUI, x0: number, y0: number, x1: number, y1: number): number => {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (ui.layer.pixels[y * LOGICAL_W + x]! >>> 24) n++;
  return n;
};

describe('layer contract', () => {
  it('is one screen-space layer at logical resolution, drawn last, transparent by default', () => {
    const r = rig();
    expect(r.ui.layer.space).toBe('screen');
    expect(r.ui.layer.w).toBe(LOGICAL_W);
    expect(r.ui.layer.h).toBe(LOGICAL_H);
    expect(r.ui.layer.pixels.length).toBe(LOGICAL_W * LOGICAL_H);
    expect(r.ui.layer.z).toBe(100);
    const v = r.ui.layer.version;
    r.ui.draw(null);
    expect(r.ui.layer.version).toBeGreaterThan(v);
  });
});

describe('boot → title', () => {
  it('waits for any button, then unlocks audio, applies saved volumes and quality, and shows the title', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    r.step(5);
    expect(r.ui.screen).toBe('boot');
    expect(r.actions.length).toBe(0);
    r.tap(pad, Pad.WEST);
    expect(r.ui.screen).toBe('title');
    const a = r.drain();
    expect(a[0]).toEqual({ type: 'unlockAudio' });
    expect(a[1]).toEqual({ type: 'setVolume', master: 0.8, music: 0.7, sfx: 0.8 });
    expect(a[2]).toEqual({ type: 'setQuality', quality: 2 });
    expect(r.sounds).toContain('confirm');
  });
  it('a keyboard press also boots (it is a real user gesture)', () => {
    const r = rig();
    r.step(3);
    r.key('Space');
    expect(r.ui.screen).toBe('title');
  });
});

describe('match setup flow', () => {
  function toTitle(r: Rig, pad: FakePad): void {
    r.step(3);
    r.tap(pad, Pad.EAST);
    r.step(20);
    r.drain();
  }

  it('VS AI: title → difficulty → assign → titans → stage → startMatch with the AI level', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    toTitle(r, pad);
    expect(r.ui.screen).toBe('title');
    r.tap(pad, Pad.DOWN); // VS AI
    r.tap(pad, Pad.EAST);
    expect(r.ui.screen).toBe('mode');
    r.tap(pad, Pad.DOWN);
    r.tap(pad, Pad.DOWN); // level 3 → 5
    r.tap(pad, Pad.EAST);
    expect(r.ui.screen).toBe('assign');
    r.tap(pad, Pad.SOUTH); // any button joins (Nintendo B = bottom)
    r.step(3);
    r.tap(pad, Pad.EAST); // confirm
    expect(r.ui.screen).toBe('select');
    r.tap(pad, Pad.EAST); // lock Last One
    r.tap(pad, Pad.EAST); // opponent defaults to Asteroid: lock
    r.step(50);
    expect(r.ui.screen).toBe('stage');
    r.tap(pad, Pad.EAST);
    const m = startMatch(r.drain());
    expect(m).toBeDefined();
    expect(m!.config).toMatchObject({
      seed: 1234,
      stage: 'nursery',
      mode: 'vsai',
      infinite: false,
      slots: [
        { titan: 'lastone', controller: 'human' },
        { titan: 'asteroid', controller: 'ai', aiLevel: 5 },
      ],
    });
    expect(r.sounds).toContain('start');
    expect(JSON.parse(r.store.data.get(UI_STORAGE_KEY)!)).toMatchObject({
      aiLevel: 5,
      lastP1: 'lastone',
      lastP2: 'asteroid',
    });
  });

  it('Training: no difficulty screen, dummy opponent, infinite clock', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    toTitle(r, pad);
    r.tap(pad, Pad.DOWN);
    r.tap(pad, Pad.DOWN); // TRAINING
    r.tap(pad, Pad.EAST);
    expect(r.ui.screen).toBe('assign');
    r.tap(pad, Pad.SOUTH);
    r.step(3);
    r.tap(pad, Pad.EAST);
    r.tap(pad, Pad.EAST);
    r.tap(pad, Pad.EAST);
    r.step(50);
    r.tap(pad, Pad.EAST);
    const m = startMatch(r.drain());
    expect(m!.config).toMatchObject({
      mode: 'training',
      infinite: true,
      slots: [{ controller: 'human' }, { controller: 'dummy' }],
    });
  });

  it('Versus with two pads: each player drives their own cursor and both must lock in', () => {
    const r = rig();
    const p1 = r.pads.plug(proStandard());
    const p2 = r.pads.plug(xboxStandard(1));
    toTitle(r, p1);
    r.tap(p1, Pad.EAST); // VERSUS
    expect(r.ui.screen).toBe('assign');
    r.tap(p1, Pad.SOUTH); // P1 joins
    r.step(3);
    r.tap(p2, Pad.SOUTH); // P2 joins
    r.step(3);
    expect(r.input.assignment()).toEqual(['pad:0', 'pad:1']);
    r.tap(p1, Pad.EAST);
    expect(r.ui.screen).toBe('select');
    // P1 stays on Last One (index 0); P2 (cursor starts on Asteroid) moves left then back right
    r.tap(p2, Pad.LEFT);
    r.tap(p2, Pad.RIGHT);
    r.tap(p1, Pad.EAST); // P1 locks (Nintendo A)
    r.step(20);
    expect(r.ui.screen).toBe('select'); // P2 hasn't locked
    r.tap(p2, Pad.SOUTH); // Xbox A locks
    r.step(50);
    expect(r.ui.screen).toBe('stage');
    r.tap(p1, Pad.EAST);
    const m = startMatch(r.drain());
    expect(m!.config).toMatchObject({
      mode: 'versus',
      slots: [
        { titan: 'lastone', controller: 'human' },
        { titan: 'asteroid', controller: 'human' },
      ],
    });
  });

  it('refuses to lock an unimplemented titan or start an unimplemented stage ("coming soon")', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    toTitle(r, pad);
    r.tap(pad, Pad.DOWN);
    r.tap(pad, Pad.EAST);
    r.tap(pad, Pad.EAST); // difficulty default
    r.tap(pad, Pad.SOUTH);
    r.step(3);
    r.tap(pad, Pad.EAST);
    expect(r.ui.screen).toBe('select');
    r.tap(pad, Pad.RIGHT); // Nexus: not implemented
    r.sounds.length = 0;
    r.tap(pad, Pad.EAST);
    expect(r.sounds).toContain('error');
    expect(r.ui.screen).toBe('select');
    r.tap(pad, Pad.LEFT);
    r.tap(pad, Pad.EAST);
    r.tap(pad, Pad.EAST);
    r.step(50);
    expect(r.ui.screen).toBe('stage');
    r.tap(pad, Pad.RIGHT); // Galactic Rim: not implemented
    r.drain();
    r.sounds.length = 0;
    r.tap(pad, Pad.EAST);
    expect(startMatch(r.drain())).toBeUndefined();
    expect(r.sounds).toContain('error');
  });

  it('Back walks the stack in reverse and never leaves the player stuck', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    toTitle(r, pad);
    r.tap(pad, Pad.EAST); // versus → assign
    expect(r.ui.screen).toBe('assign');
    r.tap(pad, Pad.SOUTH); // join
    r.step(3);
    r.tap(pad, Pad.SOUTH); // B = back (Nintendo)
    r.tap(pad, Pad.SOUTH);
    expect(['assign', 'title']).toContain(r.ui.screen);
    for (let i = 0; i < 4; i++) r.tap(pad, Pad.SOUTH);
    expect(r.ui.screen).toBe('title');
  });
});

describe('pause, results and attract', () => {
  it('pause: Resume emits resume and returns to the HUD; Quit emits quitToTitle', () => {
    const r = rig();
    r.ui.showHud();
    r.step(2);
    expect(r.ui.screen).toBe('hud');
    r.ui.showPause(true);
    expect(r.ui.screen).toBe('pause');
    const pad = r.pads.plug(proStandard());
    r.step(20);
    r.tap(pad, Pad.EAST);
    expect(r.drain()).toContainEqual({ type: 'resume' });
    expect(r.ui.screen).toBe('hud');
    r.ui.showPause(true);
    r.step(20);
    r.ui.showPause(false);
    expect(r.ui.screen).toBe('hud');
    r.ui.showPause(true);
    r.step(20);
    for (let i = 0; i < 4; i++) r.tap(pad, Pad.DOWN); // → QUIT TO TITLE
    r.tap(pad, Pad.EAST);
    expect(r.drain()).toContainEqual({ type: 'quitToTitle' });
    expect(r.ui.screen).toBe('title');
  });

  it('training pause menu cycles the overlay, toggles frame data and asks the app for dummy changes', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    r.ui.showHud();
    r.ui.draw(fakeHud({ mode: 'training', training: true }));
    r.ui.showPause(true);
    r.step(20);
    r.tap(pad, Pad.DOWN); // OVERLAY
    r.tap(pad, Pad.RIGHT);
    expect(r.drain()).toContainEqual({ type: 'setTrainingView', overlay: 'hitboxes' });
    r.tap(pad, Pad.RIGHT);
    expect(r.drain()).toContainEqual({ type: 'setTrainingView', overlay: 'matter' });
    r.tap(pad, Pad.DOWN); // FRAME DATA
    r.tap(pad, Pad.EAST);
    expect(r.drain()).toContainEqual({ type: 'toggleTraining' });
    r.tap(pad, Pad.DOWN); // DUMMY
    r.tap(pad, Pad.RIGHT);
    expect(r.drain()).toContainEqual({ type: 'setDummy', mode: 'guard' });
  });

  it('training pause menu: RESET POSITIONS and HEAL BOTH emit their own actions, then resume', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    r.ui.showHud();
    r.ui.draw(fakeHud({ mode: 'training', training: true }));
    r.ui.showPause(true);
    r.step(20);
    for (let i = 0; i < 4; i++) r.tap(pad, Pad.DOWN); // → RESET POSITIONS
    r.tap(pad, Pad.EAST);
    const reset = r.drain().map((a) => a.type);
    expect(reset).toEqual(expect.arrayContaining(['resetPositions', 'resume']));
    r.ui.showPause(false);
    r.step(5);
    r.ui.showPause(true);
    r.step(20);
    for (let i = 0; i < 5; i++) r.tap(pad, Pad.DOWN); // → HEAL BOTH
    r.tap(pad, Pad.EAST);
    expect(r.drain().map((a) => a.type)).toEqual(expect.arrayContaining(['healBoth', 'resume']));
  });

  it('results: waits a beat, then REMATCH emits rematch; TITLE quits', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    r.ui.showResults(0);
    r.ui.draw(fakeHud({ phase: 'matchend', wins: [2, 0] }));
    expect(r.ui.screen).toBe('results');
    r.tap(pad, Pad.EAST); // too early (< 0.8 s and only a couple of frames): ignored
    expect(r.drain().find((a) => a.type === 'rematch')).toBeUndefined();
    r.step(60);
    r.tap(pad, Pad.EAST);
    expect(r.drain()).toContainEqual({ type: 'rematch' });
    r.ui.showResults(1);
    r.step(60);
    r.tap(pad, Pad.DOWN);
    r.tap(pad, Pad.EAST);
    expect(r.drain()).toContainEqual({ type: 'quitToTitle' });
    expect(r.ui.screen).toBe('title');
  });

  it('results stats: damage dealt is the mass removed from the foe, clamped to 0..1; the screen draws with them', () => {
    const hud = fakeHud({ phase: 'matchend', wins: [2, 1], round: 3 });
    const [a, b] = hud.match.fighters.map((f) => f.view.bodyStats) as unknown as {
      mass: number;
      initialMass: number;
    }[];
    a!.initialMass = 1000;
    a!.mass = 250; // slot 0's body lost 75 %: slot 1 dealt 75 %
    b!.initialMass = 1000;
    b!.mass = 1400; // an accretor that grew: nothing was removed, clamped at 0
    expect(damageDealt(hud, 1)).toBeCloseTo(0.75);
    expect(damageDealt(hud, 0)).toBe(0);
    const r = rig();
    r.ui.showResults(1);
    r.step(40);
    r.ui.draw(hud);
    expect(r.ui.screen).toBe('results');
    expect(inkCount(r.ui, 270, 144, 370, 210)).toBeGreaterThan(80);
  });

  it('input guards are robust to slow frames: at 2 fps the results screen accepts input after a few frames, not many seconds', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    r.ui.showResults(0);
    r.ui.draw(fakeHud({ phase: 'matchend', wins: [2, 0] }));
    r.step(4, 0.5);
    pad.set(Pad.EAST, true);
    r.step(1, 0.5);
    pad.releaseAll();
    r.step(1, 0.5);
    expect(r.drain()).toContainEqual({ type: 'rematch' });
    // and one huge hitch (a hidden tab) is capped: it must not fast-forward the idle timer past the attract threshold at once
    const r2 = rig({ attractAfterSec: 5 });
    r2.step(3);
    r2.ui.update(600);
    expect(r2.ui.screen).not.toBe('attract');
  });

  it('attract: idle on the title for N seconds emits attractStart; any input emits attractStop and returns', () => {
    const r = rig({ attractAfterSec: 2 });
    const pad = r.pads.plug(proStandard());
    r.step(3);
    r.tap(pad, Pad.EAST);
    r.step(20);
    r.drain();
    expect(r.ui.screen).toBe('title');
    expect(r.ui.idleSeconds).toBeGreaterThan(0);
    r.step(150);
    expect(r.drain()).toContainEqual({ type: 'attractStart' });
    expect(r.ui.screen).toBe('attract');
    r.step(40);
    r.tap(pad, Pad.WEST);
    expect(r.drain()).toContainEqual({ type: 'attractStop' });
    expect(r.ui.screen).toBe('title');
    expect(r.ui.idleSeconds).toBeLessThan(1);
  });

  it('idle time resets on input and only counts on the title', () => {
    const r = rig({ attractAfterSec: 100 });
    const pad = r.pads.plug(proStandard());
    r.step(3);
    r.tap(pad, Pad.EAST);
    r.step(60);
    const idle = r.ui.idleSeconds;
    expect(idle).toBeGreaterThan(0.5);
    r.tap(pad, Pad.DOWN);
    expect(r.ui.idleSeconds).toBeLessThan(idle);
    showScreen(r.ui, 'options');
    r.step(30);
    expect(r.ui.idleSeconds).toBe(0);
  });
});

describe('options', () => {
  it('volume changes emit setVolume and persist; quality emits setQuality; deadzone/labels reach the input manager', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    showScreen(r.ui, 'options');
    r.step(20);
    r.tap(pad, Pad.LEFT);
    r.tap(pad, Pad.LEFT);
    const v = r.drain().filter((a) => a.type === 'setVolume');
    expect(v.length).toBe(2);
    expect(v[1]).toEqual({ type: 'setVolume', master: 0.6, music: 0.7, sfx: 0.8 });
    expect(JSON.parse(r.store.data.get(UI_STORAGE_KEY)!).master).toBe(6);
    for (let i = 0; i < 3; i++) r.tap(pad, Pad.DOWN); // deadzone
    r.tap(pad, Pad.RIGHT);
    expect(r.input.settings.deadzone).toBeCloseTo(0.19);
    r.tap(pad, Pad.DOWN); // labels
    r.tap(pad, Pad.RIGHT);
    expect(r.input.settings.labelMode).toBe('nintendo');
    r.tap(pad, Pad.DOWN); // confirm mode
    r.tap(pad, Pad.RIGHT);
    expect(r.input.settings.confirmMode).toBe('positional');
    r.tap(pad, Pad.DOWN);
    r.tap(pad, Pad.DOWN); // quality
    r.tap(pad, Pad.RIGHT);
    expect(r.drain().filter((a) => a.type === 'setQuality')).toEqual([{ type: 'setQuality', quality: 0 }]);
    expect(r.sounds).toContain('tick');
  });
});

describe('Controller Check screen', () => {
  it('shows live state, remaps an action through the UI, and persists the binding', () => {
    const r = rig();
    const pad = r.pads.plug(proStandard());
    showScreen(r.ui, 'controller');
    r.step(20);
    pad.set(Pad.EAST, true);
    r.step(1);
    expect(r.input.live('pad:0')!.canon[Pad.EAST]).toBe(1);
    pad.releaseAll();
    r.step(3);
    // LIVE tab → REMAP (Right), move onto the list (Down), CONFIRM on STRIKE
    r.tap(pad, Pad.RIGHT);
    r.tap(pad, Pad.DOWN);
    r.tap(pad, Pad.EAST);
    expect(r.input.capture.status).toBe('waiting');
    expect(r.input.capture.action).toBe('strike');
    r.tap(pad, 10); // L3
    expect(r.input.live('pad:0')!.bindings.strike).toEqual([{ k: 'b', i: 10 }]);
    r.step(3);
    r.draw();
    expect(r.input.actionLabel('pad:0', 'strike')).toBe('LS');
    // the game now sees Strike on L3
    const frame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    pad.set(10, true);
    r.input.source(0).poll(9999, frame);
    expect(frame.held & 1).toBe(1);
  });

  it('draws for every device kind without throwing, including an unknown non-standard pad', () => {
    const r = rig();
    r.pads.plug(proStandard());
    r.pads.plug(xboxStandard(1));
    showScreen(r.ui, 'controller');
    r.step(20);
    r.draw();
    const tab = { tab: 'tools' };
    showScreen(r.ui, 'controller', tab);
    r.step(20);
    r.draw();
    showScreen(r.ui, 'controller', { tab: 'remap' });
    r.step(20);
    r.draw();
    expect(inkCount(r.ui, 0, 0, LOGICAL_W, LOGICAL_H)).toBeGreaterThan(2000);
  });
});

describe('screens draw', () => {
  const all: UIScreenId[] = ['boot', 'title', 'mode', 'assign', 'select', 'stage', 'controller', 'options'];
  it.each(all)(
    '%s draws visible pixels, deterministically, and transparent margins let the scenery through',
    (id) => {
      const r = rig();
      r.pads.plug(proStandard());
      showScreen(r.ui, id);
      r.step(30);
      r.ui.draw(null);
      const first = r.ui.layer.pixels.slice();
      expect(first.some((c) => c >>> 24)).toBe(true);
      r.ui.draw(null);
      expect(Buffer.from(r.ui.layer.pixels.buffer).equals(Buffer.from(first.buffer))).toBe(true);
      // the very corner of the frame is never inked by any menu chrome except scrims; menus keep it low-alpha
      expect(r.ui.layer.pixels[0]! >>> 24).toBeLessThan(255);
    },
  );
});

describe('HUD', () => {
  const hudRig = (): Rig => {
    const r = rig();
    r.ui.showHud();
    r.step(30);
    return r;
  };

  it('never covers the fight: the middle of the frame is transparent during play', () => {
    const r = hudRig();
    r.ui.draw(fakeHud({ phase: 'fight', phaseTick: 400 }));
    // arena view: keep the central band between the top plates and the bottom strip clear
    expect(inkCount(r.ui, 80, 96, LOGICAL_W - 80, LOGICAL_H - 40)).toBe(0);
  });

  it('draws portraits, plates, clock and meters at the corners and top edge', () => {
    const r = hudRig();
    r.ui.draw(fakeHud({}));
    expect(inkCount(r.ui, 0, 0, 70, 64)).toBeGreaterThan(300); // P1 portrait
    expect(inkCount(r.ui, LOGICAL_W - 70, 0, LOGICAL_W, 64)).toBeGreaterThan(300); // P2 portrait
    expect(inkCount(r.ui, 290, 0, 350, 50)).toBeGreaterThan(100); // clock
    expect(inkCount(r.ui, 0, LOGICAL_H - 24, LOGICAL_W, LOGICAL_H)).toBeGreaterThan(100); // ultimate strip
  });

  it('the portrait is a LIVE sample of the remaining body: damage removes pixels from it', () => {
    const r = hudRig();
    r.ui.draw(fakeHud({ a: { slot: 0, titan: 'lastone', massFrac: 1 } }));
    const intact = inkCount(r.ui, 9, 7, 59, 57);
    const r2 = hudRig();
    r2.ui.draw(fakeHud({ a: { slot: 0, titan: 'lastone', massFrac: 0.3 } }));
    const carved = inkCount(r2.ui, 9, 7, 59, 57);
    // the frame's ghost silhouette is dim but still ink, so compare the bright (live) pixels instead
    const bright = (ui: GameUI): number => {
      let n = 0;
      for (let y = 7; y < 57; y++)
        for (let x = 9; x < 59; x++) {
          const c = ui.layer.pixels[y * LOGICAL_W + x]!;
          if (c >>> 24 === 255 && ((c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255)) / 3 > 60) n++;
        }
      return n;
    };
    expect(bright(r2.ui)).toBeLessThan(bright(r.ui) * 0.8);
    void intact;
    void carved;
  });

  it('announces ROUND / FIGHT / K.O. / winner from the round phase when the app gives no text', () => {
    const r = hudRig();
    r.ui.draw(fakeHud({ phase: 'intro', phaseTick: 30 }));
    const round = inkCount(r.ui, 160, 90, 480, 160);
    expect(round).toBeGreaterThan(200);
    r.ui.draw(fakeHud({ phase: 'fight', phaseTick: 300 }));
    expect(inkCount(r.ui, 160, 90, 480, 160)).toBe(0);
    r.ui.draw(fakeHud({ phase: 'ko', phaseTick: 40 }));
    expect(inkCount(r.ui, 160, 90, 480, 160)).toBeGreaterThan(200);
    r.ui.draw(fakeHud({ phase: 'fight', phaseTick: 300, announcer: 'ROUND 3' }));
    expect(inkCount(r.ui, 160, 90, 480, 160)).toBeGreaterThan(200);
  });

  it('training overlay adds frame data for both fighters', () => {
    const r = hudRig();
    r.ui.draw(fakeHud({ mode: 'training', training: false }));
    const off = inkCount(r.ui, 0, 64, 220, 140);
    r.ui.draw(
      fakeHud({
        mode: 'training',
        training: true,
        a: {
          slot: 0,
          titan: 'lastone',
          state: 'active',
          moveId: 'tendril-lash',
          phase: 'active',
          moveTick: 15,
          moveTotal: 34,
        },
      }),
    );
    expect(inkCount(r.ui, 0, 64, 220, 140)).toBeGreaterThan(off + 200);
  });

  it('draws in well under a millisecond-scale budget per frame', () => {
    const r = hudRig();
    const hud: HudState = fakeHud({ mode: 'training', training: true });
    for (let i = 0; i < 20; i++) r.ui.draw(hud);
    const t0 = performance.now();
    const n = 300;
    for (let i = 0; i < n; i++) {
      r.step(1);
      r.ui.draw(hud);
    }
    const ms = (performance.now() - t0) / n;
    expect(ms).toBeLessThan(4);
  });
});
