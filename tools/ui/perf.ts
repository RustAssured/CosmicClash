/** UI draw cost per screen in Node (software, single thread). `npx tsx tools/ui/perf.ts` */
import { STAGE_IDS, LOGICAL_H, LOGICAL_W, type UIScreenId } from '../../src/contracts';
import { createInputManager, createMemoryStore } from '../../src/input';
import { createFakeGamepads, proStandard } from '../../src/input/testing';
import { createUI, showScreen } from '../../src/ui';
import { FIXTURE_TITANS, fakeHud, fixturePortraitProvider } from '../../src/ui/fixtures';
import { STAGE_INFO } from '../../src/stages/info';

const pads = createFakeGamepads();
pads.plug(proStandard());
let now = 1000;
const input = createInputManager({
  window: new EventTarget(),
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
  titans: FIXTURE_TITANS,
  portrait: fixturePortraitProvider,
  stages: STAGE_IDS.map((i) => STAGE_INFO[i]),
  implementedTitans: ['lastone', 'asteroid'],
  implementedStages: ['nursery'],
  storage: null,
});
const hud = fakeHud({ mode: 'training', training: true, a: { slot: 0, titan: 'lastone', massFrac: 0.6 } });

function measure(name: string, id: UIScreenId | null, h: typeof hud | null): void {
  if (id) showScreen(ui, id);
  else ui.showHud();
  for (let i = 0; i < 40; i++) {
    now += 16;
    input.poll(now);
    ui.update(1 / 60);
    ui.draw(h);
  }
  const n = 400;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    now += 16;
    input.poll(now);
    ui.update(1 / 60);
    ui.draw(h);
  }
  console.log(
    `${name.padEnd(12)} ${((performance.now() - t0) / n).toFixed(3)} ms/frame (update + draw, ${LOGICAL_W}x${LOGICAL_H})`,
  );
}
measure('hud', null, hud);
for (const id of ['title', 'select', 'stage', 'controller', 'options', 'assign', 'mode'] as UIScreenId[])
  measure(id, id, null);
measure('hud (again)', null, hud);
