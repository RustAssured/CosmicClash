import {
  ARENA_H,
  ARENA_W,
  DEFAULT_ARENA,
  LOGICAL_H,
  LOGICAL_W,
  STAGE_IDS,
  type CameraState,
  type FrameFx,
  type RenderFrame,
  type RenderLayer,
  type SimEvent,
  type StageId,
} from '@/contracts';
import { createCamera, createLoop } from '@/engine';
import { createRenderer, type QualitySetting } from '@/render';
import { STAGES } from '@/stages';
import { makeGridLayer, makeRockBody, makeSparkLayer, makeStarBody, makeUiLayer } from './testSprites';

/**
 * Render sandbox: a stage viewer with synthetic fighters (test sprites), fake FrameFx and camera events.
 * URL params: ?stage=nursery&quality=2&t=0&freeze=1&debug=0&x=1&fa=600&fb=1000&lens=1&grid=1&ui=1&text=0
 * Also exposed as window.__RENDER__ for tools/render/capture.mjs.
 */

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = q.get(k);
  return v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v);
};
const stageParam = q.get('stage') as StageId | null;
let stage: StageId =
  stageParam && (STAGE_IDS as readonly string[]).includes(stageParam) ? stageParam : 'nursery';
const qParam = q.get('quality');
/** 'auto' lets the adaptive controller pick the tier; 0 | 1 | 2 fix it. */
let quality: QualitySetting = qParam === 'auto' ? 'auto' : (num('quality', 2) as 0 | 1 | 2);
const frozen = q.get('freeze') === '1';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const help = document.getElementById('help') as HTMLDivElement;
if (q.get('text') === '0') {
  hud.style.display = 'none';
  help.style.display = 'none';
}

/* ---------------------------------- fake fight state ---------------------------------- */

interface Fighter {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  facing: 1 | -1;
}
const A: Fighter = { x: num('fa', 640), y: DEFAULT_ARENA.restY, px: 0, py: 0, vx: 0, facing: 1 };
const B: Fighter = { x: num('fb', 980), y: DEFAULT_ARENA.restY, px: 0, py: 0, vx: 0, facing: -1 };
A.px = A.x;
B.px = B.x;
A.py = A.y;
B.py = B.y;
const keys = new Set<string>();

const camera = createCamera();
camera.reset((A.x + B.x) / 2, DEFAULT_ARENA.restY);
const events: SimEvent[] = [];
let camState: CameraState = camera.sample(0).state;
let camView = camera.sample(0).view;

const fx: FrameFx = {
  shockwaves: [],
  lenses: [],
  impulses: [],
  flash: 0,
  aberration: 0,
  intensity: num('intensity', 0.25),
  timeScale: 1,
};
interface Shock {
  x: number;
  y: number;
  born: number;
  radius: number;
  strength: number;
}
const shocks: Shock[] = [];
const impulses: { x: number; y: number; born: number; strength: number; radius: number; hue: number }[] = [];
let lensOn = q.get('lens') === '1';
let koUntil = 0;

// ?bodies=readability (default): a pale celadon body vs near-black basalt (the two readability stress cases);
// ?bodies=classic: the original mid-tone rock vs an emissive star.
const bodiesParam = q.get('bodies') ?? 'readability';
const rock = makeRockBody('rock', 7, 128, bodiesParam === 'classic' ? 'rock' : 'celadon');
const star = bodiesParam === 'classic' ? makeStarBody('star', 11) : makeRockBody('star', 11, 128, 'basalt');
const grid = makeGridLayer();
const sparks = makeSparkLayer();
const ui = makeUiLayer();
const showGrid = q.get('grid') === '1';
const showUi = q.get('ui') !== '0';
const showSparks = q.get('sparks') !== '0';

const layers: RenderLayer[] = [];

let simTime = num('t', 0);
let tickCount = 0;
let pointerWorld = { x: 800, y: 260 };

/* ------------------------------------ helpers -------------------------------------- */

function fire(name: string): void {
  const cx = pointerWorld.x;
  const cy = pointerWorld.y;
  switch (name) {
    case 'shock':
      shocks.push({ x: cx, y: cy, born: simTime, radius: 260, strength: 0.9 });
      events.push({ t: 'shake', dirX: 1, dirY: 0.2, amp: 9 });
      break;
    case 'lens':
      lensOn = !lensOn;
      break;
    case 'flash':
      fx.flash = 1;
      break;
    case 'impulse':
      impulses.push({ x: cx, y: cy, born: simTime, strength: 1, radius: 190, hue: 0.06 });
      break;
    case 'aberration':
      fx.aberration = 1;
      break;
    case 'shake':
      events.push({ t: 'shake', dirX: 1, dirY: 0.3, amp: 12 });
      break;
    case 'zoom':
      events.push({ t: 'zoom', amount: 0.05 });
      break;
    case 'roll':
      events.push({ t: 'roll', radians: 0.02 });
      break;
    case 'ko':
      events.push({ t: 'ko', slot: 1, x: cx, y: cy });
      shocks.push({ x: cx, y: cy, born: simTime, radius: 420, strength: 1 });
      fx.flash = 1;
      fx.aberration = 1;
      koUntil = simTime + 1.6;
      break;
  }
}

/* ------------------------------------- the loop ------------------------------------ */

function tick(): void {
  tickCount++;
  const move = (f: Fighter, dir: number): void => {
    f.px = f.x;
    f.py = f.y;
    f.vx += (dir * 300 - f.vx) * 0.05;
    f.x = Math.max(120, Math.min(ARENA_W - 120, f.x + f.vx / 60));
    const rest = DEFAULT_ARENA.restY;
    f.y += (rest - f.y) * 0.06;
  };
  const dirA = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
  const dirB = (keys.has('arrowright') ? 1 : 0) - (keys.has('arrowleft') ? 1 : 0);
  move(A, dirA);
  move(B, dirB);
  if (keys.has('w')) A.y -= 3;
  if (keys.has('s')) A.y += 3;
  const gap = B.x - A.x;
  A.facing = gap >= 0 ? 1 : -1;
  B.facing = gap >= 0 ? -1 : 1;
  camera.tick(
    {
      a: { x: A.x, y: A.y, hw: 60, hh: 60 },
      b: { x: B.x, y: B.y, hw: 60, hh: 60 },
      arena: { ...DEFAULT_ARENA, maxX: ARENA_W, maxY: ARENA_H },
    },
    events,
  );
  events.length = 0;
}

function currentFx(): FrameFx {
  fx.shockwaves.length = 0;
  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i]!;
    const age = (simTime - s.born) / 0.9;
    if (age >= 1) {
      shocks.splice(i, 1);
      continue;
    }
    fx.shockwaves.push({
      x: s.x,
      y: s.y,
      age,
      // mirrors the app's FxState: eased radius, strength already decayed by the producer
      radius: s.radius * (1 - Math.pow(1 - age, 2.2)),
      strength: s.strength * Math.pow(1 - age, 1.6),
    });
  }
  fx.impulses.length = 0;
  for (let i = impulses.length - 1; i >= 0; i--) {
    const s = impulses[i]!;
    const age = (simTime - s.born) / 2.2;
    if (age >= 1) {
      impulses.splice(i, 1);
      continue;
    }
    fx.impulses.push({
      x: s.x,
      y: s.y,
      age,
      strength: s.strength * (1 - age * 0.7),
      radius: s.radius * (0.3 + 0.7 * Math.sqrt(age)),
      hue: s.hue,
    });
  }
  fx.lenses.length = 0;
  if (lensOn) fx.lenses.push({ x: B.x, y: B.y - 10, horizonR: 26, strength: 1 });
  fx.timeScale = simTime < koUntil ? 0.3 : 1;
  // the bodies carry lights (the app derives them per titan): A a cool one, B a strong warm one (`lights=0` turns them off)
  if (num('lights', 1) > 0) {
    fx.lights = [
      { x: A.x, y: A.y, radius: 120, r: 0.62, g: 0.95, b: 0.88, intensity: 0.28, slot: 0 },
      { x: B.x, y: B.y, radius: 280, r: 1, g: 0.72, b: 0.38, intensity: 0.95, slot: 1 },
    ];
  } else fx.lights = undefined;
  return fx;
}

let manualFrame: RenderFrame | null = null;
const renderer = createRenderer();

function buildFrame(alpha: number): RenderFrame {
  const s = camera.sample(alpha);
  camState = s.state;
  camView = s.view;
  const lean = (f: Fighter): number => Math.max(-9, Math.min(9, Math.round(f.vx * 0.03)));
  const place = (l: RenderLayer, f: Fighter): void => {
    l.x = f.x;
    l.y = f.y;
    l.prevX = f.px;
    l.prevY = f.py;
    l.facing = f.facing;
    l.lean = lean(f);
  };
  place(rock.layer, A);
  place(star.layer, B);
  rock.pulse(simTime);
  star.pulse(simTime);
  sparks.step(simTime);
  if (showGrid) grid.update(camView.x0, camView.y0);
  layers.length = 0;
  layers.push(rock.layer, star.layer);
  if (showGrid) layers.push(grid.layer);
  if (showSparks) layers.push(sparks.layer);
  fx.flash = Math.max(0, fx.flash - 0.03);
  fx.aberration = Math.max(0, fx.aberration - 0.02);
  const f = currentFx();
  return {
    tick: tickCount,
    timeSec: simTime,
    alpha,
    camera: camState,
    view: camView,
    stage,
    layers,
    ui: showUi ? ui : null,
    fx: f,
  };
}

let last = 0;
let loadingLine = '';
let frameCount = 0;
let wallStart = performance.now();
let wallFps = 0;
function frame(alpha: number, dtSec: number): void {
  simTime += dtSec * fx.timeScale;
  const fr = buildFrame(alpha);
  renderer.draw(fr);
  manualFrame = fr;
  frameCount++;
  const t = performance.now();
  if (t - wallStart > 1000) {
    wallFps = (frameCount * 1000) / (t - wallStart);
    frameCount = 0;
    wallStart = t;
  }
  if (t - last > 250) {
    last = t;
    const st = renderer.stats;
    hud.textContent =
      `${STAGES[stage].name} · ${STAGES[stage].nameKo}   tier ${st.tier}${st.auto ? ' (auto, ' + st.tierChanges + ' changes)' : ''}   ${wallFps.toFixed(1)} fps wall${st.gpuMs !== null ? '   gpu ' + st.gpuMs.toFixed(1) + ' ms' : ''}\n` +
      `cpu ${st.frameMs.toFixed(1)} ms (scenery ${st.sceneryMs.toFixed(1)} / post ${st.postMs.toFixed(1)})   draws ${st.drawCalls}   late ${(st.lateRate * 100).toFixed(0)}%${loadingLine}\n` +
      `view ${camView.x0},${camView.y0}  cam ${camState.x.toFixed(0)},${camState.y.toFixed(0)}  zoom ${camState.zoom.toFixed(3)}  t ${simTime.toFixed(1)}s`;
  }
}

const loop = createLoop({ tick, frame });

function fit(): void {
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}

async function boot(): Promise<void> {
  await renderer.init(canvas, { quality, preserveDrawingBuffer: true });
  // The first stage is prepared in the background like any other: the loop is already drawing (black) while it loads.
  const first = renderer.prepareStage(stage, (f) => {
    loadingLine = `   preparing ${(f * 100).toFixed(0)}%`;
  });
  fit();
  window.addEventListener('resize', fit);
  if (frozen) {
    // deterministic captures wait for the stage, then step the sim and draw once
    await first;
    renderer.setStage(stage);
    loop.stepTicks(num('ticks', 120));
    api.drawNow();
  } else {
    loop.start();
    void first.then(() => {
      loadingLine = '';
    });
  }
  document.body.dataset.ready = '1';
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '9')
    fire(['shock', 'lens', 'flash', 'impulse', 'aberration', 'shake', 'zoom', 'roll', 'ko'][+k - 1]!);
  else if (k === 'q') {
    const order: QualitySetting[] = [0, 1, 2, 'auto'];
    quality = order[(order.indexOf(quality) + 1) % order.length]!;
    location.search = `?stage=${stage}&quality=${quality}`;
  } else if (k === 'f') {
    if (loop.paused) loop.resume();
    else loop.pause();
  } else if (k === 'h') {
    hud.style.display = hud.style.display === 'none' ? '' : 'none';
    help.style.display = hud.style.display;
  } else if (k === 'n') {
    const i = (STAGE_IDS.indexOf(stage) + 1) % STAGE_IDS.length;
    stage = STAGE_IDS[i]!;
    // non-blocking: the previous stage keeps drawing while the next one builds over a few dozen frames
    void renderer.prepareStage(stage, (f) => {
      loadingLine = f < 1 ? `   preparing ${STAGES[stage].name} ${(f * 100).toFixed(0)}%` : '';
    });
  } else keys.add(k);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const lx = ((e.clientX - r.left) / r.width) * LOGICAL_W;
  const ly = ((e.clientY - r.top) / r.height) * LOGICAL_H;
  pointerWorld = { x: camView.x0 + lx, y: camView.y0 + ly };
});
canvas.addEventListener('pointerdown', () => fire('shock'));

/* ---------------------------------- test/capture API -------------------------------- */

const api = {
  ready: null as Promise<void> | null,
  renderer,
  loop,
  /** Set scenario state for a deterministic capture. */
  set(
    s: Partial<{
      stage: StageId;
      fa: number;
      fb: number;
      time: number;
      intensity: number;
      lens: boolean;
      timeScale: number;
      flash: number;
      aberration: number;
    }>,
  ): void {
    if (s.stage && s.stage !== stage) {
      stage = s.stage;
      renderer.setStage(stage);
    }
    if (s.fa !== undefined) {
      A.x = A.px = s.fa;
    }
    if (s.fb !== undefined) {
      B.x = B.px = s.fb;
    }
    if (s.time !== undefined) simTime = s.time;
    if (s.intensity !== undefined) fx.intensity = s.intensity;
    if (s.lens !== undefined) lensOn = s.lens;
    if (s.timeScale !== undefined) fx.timeScale = s.timeScale;
    if (s.flash !== undefined) fx.flash = s.flash;
    if (s.aberration !== undefined) fx.aberration = s.aberration;
  },
  fire,
  /** Run `n` sim ticks without advancing the scenery clock or drawing (lets the heavy camera arrive). */
  settle(n = 300): void {
    loop.pause();
    for (let i = 0; i < n; i++) tick();
  },
  point(x: number, y: number): void {
    pointerWorld = { x, y };
  },
  /** Advance `n` sim ticks then draw once (paused loop). */
  advance(n: number, dtSec = n / 60): void {
    loop.pause();
    for (let i = 0; i < n; i++) tick();
    simTime += dtSec * fx.timeScale;
    this.drawNow();
  },
  drawNow(alpha = 0): void {
    const fr = buildFrame(alpha);
    renderer.draw(fr);
    manualFrame = fr;
  },
  captureBase64(): string {
    const px = renderer.captureLogical();
    const u8 = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  stats: () => ({ ...renderer.stats, wallFps }),
  get view() {
    return camView;
  },
  get frame() {
    return manualFrame;
  },
  layers: { rock: rock.layer, star: star.layer },
  quality: () => quality,
};
api.ready = boot();
(window as unknown as { __RENDER__: typeof api }).__RENDER__ = api;
void loop;
