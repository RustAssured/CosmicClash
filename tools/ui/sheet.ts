/**
 * Render every UI screen headlessly (Node, no browser) to .scratch/ui/*.png over a stage-palette backdrop, using real titan
 * portraits for the implemented titans and fixtures for the rest.
 *   npx tsx tools/ui/sheet.ts [scale=2] [only,names]
 */
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGICAL_H, LOGICAL_W, type TitanId, type UIScreenId } from '../../src/contracts';
import { createInputManager, createMemoryStore, Pad } from '../../src/input';
import { createFakeGamepads, proStandard } from '../../src/input/testing';
import { createUI, showScreen, titanInfoFromDef } from '../../src/ui';
import { FIXTURE_TITANS, fakeHud, fixturePortraitProvider } from '../../src/ui/fixtures';
import { stagePreview } from '../../src/ui/screens/stage';
import { STAGE_INFO } from '../../src/stages/info';
import { TITAN_DEFS, renderPortrait } from '../../src/titans';
import { STAGE_IDS } from '../../src/contracts';

const scale = parseInt(process.argv[2] ?? '2', 10);
const only = process.argv[3]?.split(',');

const titans = FIXTURE_TITANS.map((t) => {
  const d = TITAN_DEFS[t.id];
  return d ? titanInfoFromDef(d) : t;
});
const portrait = (id: TitanId) => {
  if (TITAN_DEFS[id]) {
    try {
      return renderPortrait(id, 1);
    } catch (e) {
      // another builder's generator may be mid-edit: fall back to the stand-in so screens can still be reviewed
      console.warn(`portrait(${id}) failed (${(e as Error).message}); using fixture`);
    }
  }
  return fixturePortraitProvider(id);
};

function write(path: string, px: Uint32Array, w: number, h: number, bg: Uint32Array | null): void {
  const png = new PNG({ width: w * scale, height: h * scale });
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const i = Math.floor(y / scale) * w + Math.floor(x / scale);
      const c = px[i]!;
      const b = bg ? bg[i]! : 0xff1a0c08;
      const a = (c >>> 24) / 255;
      const o = (y * w * scale + x) * 4;
      png.data[o] = Math.round((c & 255) * a + (b & 255) * (1 - a));
      png.data[o + 1] = Math.round(((c >>> 8) & 255) * a + ((b >>> 8) & 255) * (1 - a));
      png.data[o + 2] = Math.round(((c >>> 16) & 255) * a + ((b >>> 16) & 255) * (1 - a));
      png.data[o + 3] = 255;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

const backdrop = stagePreview(STAGE_INFO.nursery, LOGICAL_W, LOGICAL_H).pixels;

function makeUI() {
  const pads = createFakeGamepads();
  const win = new EventTarget();
  let now = 1000;
  const input = createInputManager({
    window: win,
    getGamepads: pads.getGamepads,
    storage: createMemoryStore(),
    now: () => now,
    keyboard: false,
    hid: null,
    userAgent: 'Chrome',
  });
  input.attach();
  const ui = createUI({
    input,
    titans,
    portrait,
    stages: STAGE_IDS.map((id) => STAGE_INFO[id]),
    implementedTitans: ['lastone', 'asteroid'],
    implementedStages: ['nursery'],
    storage: createMemoryStore(),
    version: 'v0.1.0',
    now: () => now,
    attractAfterSec: 1e9,
  });
  const pad = pads.plug(proStandard().withRumble());
  const step = (n: number): void => {
    for (let i = 0; i < n; i++) {
      now += 16;
      input.poll(now);
      ui.update(1 / 60);
    }
  };
  return { ui, input, pad, step, pads, now: () => now };
}

function shot(
  name: string,
  screen: UIScreenId | null,
  setup?: (r: ReturnType<typeof makeUI>) => void,
  hud?: () => ReturnType<typeof fakeHud>,
  after?: (r: ReturnType<typeof makeUI>) => void,
): void {
  if (only && !only.includes(name)) return;
  const r = makeUI();
  r.step(2);
  if (screen) showScreen(r.ui, screen);
  setup?.(r);
  r.step(30);
  if (after) {
    // apply device state and refresh the input manager only, so scripted presses are not consumed as menu navigation
    after(r);
    r.input.poll(r.now() + 16);
  }
  r.ui.draw(hud ? hud() : null);
  write(`.scratch/ui/${name}.png`, r.ui.layer.pixels, LOGICAL_W, LOGICAL_H, backdrop);
  console.log('wrote', name);
}

shot('boot', 'boot');
shot('title', 'title');
shot('mode', 'mode');
shot('assign', 'assign', (r) => {
  r.step(3);
  r.pad.set(Pad.EAST, true);
  r.step(2);
  r.pad.releaseAll();
});
shot('select', 'select');
shot('select-locked', 'select', (r) => {
  r.step(2);
});
shot('stage', 'stage');
shot('controller', 'controller', undefined, undefined, (r) => {
  r.pad
    .set(Pad.EAST, true)
    .set(Pad.R2, 0.7)
    .set(Pad.L1, true)
    .set(Pad.LEFT, true)
    .axis(0, -0.55)
    .axis(1, 0.3)
    .axis(2, 0.15)
    .axis(3, -0.7);
});
shot('controller-remap', 'controller', () => undefined);
shot('options', 'options');
shot('hud', 'hud', undefined, () =>
  fakeHud({
    a: { slot: 0, titan: 'lastone', massFrac: 0.78, meter: 1 },
    b: { slot: 1, titan: 'asteroid', massFrac: 0.45, guardUp: true },
    wins: [1, 0],
    round: 2,
  }),
);
shot('hud-fight', 'hud', undefined, () =>
  fakeHud({
    phase: 'intro',
    phaseTick: 90,
    a: { slot: 0, titan: 'lastone' },
    b: { slot: 1, titan: 'asteroid' },
  }),
);
shot('hud-low', 'hud', undefined, () =>
  fakeHud({
    a: { slot: 0, titan: 'lastone', massFrac: 0.28, meter: 0.2 },
    b: { slot: 1, titan: 'asteroid', massFrac: 0.9 },
    ticksLeft: 8 * 60,
    wins: [0, 1],
  }),
);
shot('hud-ko', 'hud', undefined, () =>
  fakeHud({
    phase: 'ko',
    phaseTick: 30,
    a: { slot: 0, titan: 'lastone', massFrac: 0.1 },
    b: { slot: 1, titan: 'asteroid', massFrac: 0.8 },
  }),
);
shot('hud-training', 'hud', undefined, () =>
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
    b: { slot: 1, titan: 'asteroid' },
  }),
);
shot(
  'pause',
  'hud',
  (r) => r.ui.showPause(true),
  () => fakeHud({}),
);
shot(
  'results',
  null,
  (r) => r.ui.showResults(0),
  () =>
    fakeHud({
      phase: 'matchend',
      wins: [2, 1],
      a: { slot: 0, titan: 'lastone', massFrac: 0.55 },
      b: { slot: 1, titan: 'asteroid', massFrac: 0.1 },
    }),
);
