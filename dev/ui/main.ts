import { LOGICAL_H, LOGICAL_W, STAGE_IDS, emptyInput, type TitanId, type UIAction, type UIScreenId } from '@/contracts';
import { createInputManager } from '@/input';
import { createUI, showScreen, titanInfoFromDef, type UIExtraAction } from '@/ui';
import { FIXTURE_TITANS, fakeHud, fixturePortraitProvider } from '@/ui/fixtures';
import { stagePreview } from '@/ui/screens/stage';
import { STAGE_INFO } from '@/stages/info';
import { TITAN_DEFS, renderPortrait } from '@/titans';
import { createAudioEngine } from '@/audio/engine';

/**
 * UI sandbox: the real input manager, the real UI and the real audio engine wired the way the app is meant to wire them, over a
 * stage backdrop, with no simulation behind it. It is the reference for `docs/proposals/001` (what the app must do with each
 * UIAction) and the page the e2e specs drive with fake gamepads.
 *
 *   ?screen=title|mode|assign|select|stage|controller|options|pause|results|attract   jump straight to a screen
 *   &hud=1                                                                           draw the in-match HUD instead
 *   &attract=<seconds>                                                               idle time before attract mode
 *
 * Test hooks on `window.__sandbox`: the UI, the input manager, every UIAction and UIExtraAction seen, the last audio events.
 */
declare global {
  interface Window {
    __sandbox?: {
      ui: ReturnType<typeof createUI>;
      input: ReturnType<typeof createInputManager>;
      audio: ReturnType<typeof createAudioEngine>;
      actions: UIAction[];
      extras: UIExtraAction[];
      quality: number[];
      /** Every menu sound the UI asked for, in order. */
      sounds: string[];
      frames: number;
      ready: boolean;
      /** What the game would see: each slot's InputFrame sampled at 60 Hz, edges accumulated until `resetSeen()`. */
      game: { held: [number, number]; seenPressed: [number, number]; moveX: [number, number]; moveY: [number, number] };
      resetSeen(): void;
    };
  }
}

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const image = g.createImageData(LOGICAL_W, LOGICAL_H);
const out32 = new Uint32Array(image.data.buffer);

const titans = FIXTURE_TITANS.map((t) => {
  const d = TITAN_DEFS[t.id];
  return d ? titanInfoFromDef(d) : t;
});
const portrait = (id: TitanId): ReturnType<typeof fixturePortraitProvider> => {
  if (TITAN_DEFS[id]) {
    try {
      return renderPortrait(id, 1);
    } catch {
      /* the generator may be mid-edit in the shared tree: the fixture keeps the screens reviewable */
    }
  }
  return fixturePortraitProvider(id);
};

const input = createInputManager({});
input.attach();
const audio = createAudioEngine();
audio.autoUnlock(document);

const actions: UIAction[] = [];
const extras: UIExtraAction[] = [];
const quality: number[] = [];
const sounds: string[] = [];
const ui = createUI({
  input,
  titans,
  portrait,
  stages: STAGE_IDS.map((id) => STAGE_INFO[id]),
  implementedTitans: ['lastone', 'asteroid'],
  implementedStages: ['nursery'],
  sound: (id) => {
    sounds.push(id);
    audio.handle([{ t: 'ui', id }]);
  },
  onQuality: (v) => quality.push(v),
  onExtra: (a) => extras.push(a),
  version: 'sandbox',
  attractAfterSec: Number(q.get('attract') ?? 60),
});
const game = { held: [0, 0] as [number, number], seenPressed: [0, 0] as [number, number], moveX: [0, 0] as [number, number], moveY: [0, 0] as [number, number] };
const box = {
  ui,
  input,
  audio,
  actions,
  extras,
  quality,
  sounds,
  frames: 0,
  ready: false,
  game,
  resetSeen: (): void => {
    game.seenPressed[0] = 0;
    game.seenPressed[1] = 0;
  },
};
window.__sandbox = box;

const backdrop = stagePreview(STAGE_INFO.nursery, LOGICAL_W, LOGICAL_H).pixels;
const screen = q.get('screen') as UIScreenId | null;
if (screen) showScreen(ui, screen);
const hud = q.has('hud') ? fakeHud() : null;
if (hud) ui.showHud();

const drained: UIAction[] = [];
const sources = [input.source(0), input.source(1)] as const;
const gameFrames = [emptyInput(), emptyInput()] as const;
let tick = 0;
let acc = 0;
let last = performance.now();
const frame = (now: number): void => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.poll(now);
  // the fixed-step sampling the sim does: once per 1/60 s, in tick order, straight from the InputSource
  acc += dt;
  while (acc >= 1 / 60) {
    if (q.has('nosim')) {
      acc = 0;
      break;
    }
    acc -= 1 / 60;
    for (const s of [0, 1] as const) {
      sources[s].poll(tick, gameFrames[s]);
      game.held[s] = gameFrames[s].held;
      game.seenPressed[s] |= gameFrames[s].pressed;
      game.moveX[s] = gameFrames[s].moveX;
      game.moveY[s] = gameFrames[s].moveY;
    }
    tick++;
  }
  ui.update(dt);
  // the wiring the app is expected to do (docs/proposals/001): audio unlock + volumes from the UI, everything else recorded
  drained.length = 0;
  ui.drainActions(drained);
  for (const a of drained) {
    actions.push(a);
    if (a.type === 'unlockAudio') void audio.unlock();
    else if (a.type === 'setVolume') audio.setVolumes(a);
    else if (a.type === 'resume') ui.showPause(false);
    else if (a.type === 'quitToTitle') ui.showTitle();
  }
  audio.update(
    {
      phase: ui.screen === 'attract' ? 'attract' : ui.screen === 'pause' ? 'pause' : ui.screen === 'hud' ? 'fight' : 'menu',
      stage: 'nursery',
      intensity: 0.3,
      listenerX: 0,
      fighters: null,
      lowestIntegrity: 1,
      timeScale: 1,
    },
    dt,
  );
  ui.draw(hud && ui.screen === 'hud' ? hud : null);
  const px = ui.layer.pixels;
  for (let i = 0; i < out32.length; i++) {
    const c = px[i]!;
    const a = c >>> 24;
    if (a === 255) out32[i] = c;
    else if (a === 0) out32[i] = backdrop[i]!;
    else {
      const b = backdrop[i]!;
      const ia = 255 - a;
      const r = ((c & 255) * a + (b & 255) * ia) / 255;
      const gg = (((c >>> 8) & 255) * a + ((b >>> 8) & 255) * ia) / 255;
      const bl = (((c >>> 16) & 255) * a + ((b >>> 16) & 255) * ia) / 255;
      out32[i] = (0xff000000 | (bl << 16) | (gg << 8) | r) >>> 0;
    }
  }
  g.putImageData(image, 0, 0);
  box.frames++;
  box.ready = true;
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
