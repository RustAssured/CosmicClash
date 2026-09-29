import {
  DAMAGE_TYPES,
  DamageFlag,
  LOGICAL_H,
  LOGICAL_W,
  type DamageEvent,
  type DamageShape,
  type DamageType,
  type DebugOverlayMode,
  type MatterBody,
} from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { DEBUG_MODES } from '@/matter/debug';
import * as bodies from '@/matter/testing/bodies';
import { composeFrame, drawLayer } from '../../tools/matter/compose';

const PRESETS: Record<string, (o: bodies.TestBodyOpts) => bodies.TestBody> = {
  'layered disc': bodies.layeredDisc,
  'ribbed slab': bodies.ribbedSlab,
  celadon: bodies.celadonBody,
  'lattice disc': bodies.latticeDisc,
  'sparse lattice': bodies.sparseLattice,
  'gas planet': bodies.gasPlanet,
  star: bodies.star,
  'black hole': bodies.blackHole,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('c');
const ctx2d = canvas.getContext('2d')!;
const img = ctx2d.createImageData(LOGICAL_W, LOGICAL_H);
const img32 = new Uint32Array(img.data.buffer);

const typeSel = $<HTMLSelectElement>('type');
for (const t of DAMAGE_TYPES) typeSel.add(new Option(t, t));
const flagBoxes: Record<string, HTMLInputElement> = {};
for (const [name, bit] of Object.entries(DamageFlag)) {
  const l = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.bit = String(bit);
  flagBoxes[name] = cb;
  l.append(cb, name);
  $('flags').append(l);
}
for (const id of ['presetL', 'presetR']) {
  const sel = $<HTMLSelectElement>(id);
  for (const k of Object.keys(PRESETS)) sel.add(new Option(k, k));
}
$<HTMLSelectElement>('presetL').value = 'layered disc';
$<HTMLSelectElement>('presetR').value = 'celadon';
const dbgSel = $<HTMLSelectElement>('dbg');
for (const m of DEBUG_MODES) dbgSel.add(new Option(m, m));

let world!: MatterWorldEx;
let bodyList: MatterBody[] = [];
let paused = false;
let seedN = 1;
let msAvg = 0;
let msMax = 0;
let ticksRun = 0;

function build(): void {
  world = createMatterWorld(seedN);
  const optsL = { seed: 3, x: 190, y: 190, ownerSlot: 0 as const, facing: 1 as const };
  const optsR = { seed: 5, x: 450, y: 190, ownerSlot: 1 as const, facing: -1 as const };
  const l = PRESETS[$<HTMLSelectElement>('presetL').value]!(optsL);
  const r = PRESETS[$<HTMLSelectElement>('presetR').value]!(optsR);
  bodyList = [world.createBody(l.spec), world.createBody(r.spec)];
  applyGravity();
  ticksRun = 0;
}
function applyGravity(): void {
  const on = $<HTMLInputElement>('bh').checked;
  const b = bodyList[1];
  if (!b) return;
  world.setGravitySource(
    1,
    on
      ? {
          x: b.transform.x,
          y: b.transform.y,
          strength: 420,
          radius: 300,
          consumeRadius: 14,
          creditBodyId: b.id,
        }
      : null,
  );
}

function currentEvent(
  a: { x: number; y: number },
  bpt: { x: number; y: number },
  reverse: boolean,
): DamageEvent {
  const tIdx = Number($<HTMLSelectElement>('target').value);
  const target = bodyList[tIdx]!;
  const src = bodyList[1 - tIdx]!;
  let dx = bpt.x - a.x;
  let dy = bpt.y - a.y;
  const dragLen = Math.hypot(dx, dy);
  if (dragLen < 4) {
    dx = target.transform.x - src.transform.x;
    dy = 0;
  }
  if (reverse) {
    dx = -dx;
    dy = -dy;
  }
  const dl = Math.hypot(dx, dy) || 1;
  const ux = dx / dl;
  const uy = dy / dl;
  const r = Number($<HTMLInputElement>('radius').value);
  const kind = $<HTMLSelectElement>('shape').value;
  let shape: DamageShape;
  const p = dragLen < 4 ? bpt : a;
  switch (kind) {
    case 'line':
      shape = {
        kind: 'line',
        x0: a.x,
        y0: a.y,
        x1: dragLen < 4 ? a.x + ux * 80 : bpt.x,
        y1: dragLen < 4 ? a.y + uy * 80 : bpt.y,
        width: Math.max(2, r * 0.5),
      };
      break;
    case 'cone':
      shape = { kind: 'cone', x: p.x, y: p.y, dirX: ux, dirY: uy, range: r * 3, halfAngle: 0.5 };
      break;
    case 'ring':
      shape = { kind: 'ring', x: bpt.x, y: bpt.y, r0: r * 0.6, r1: r };
      break;
    case 'field':
      shape = { kind: 'field', x: bpt.x, y: bpt.y, r: r * 2, falloff: 1.5 };
      break;
    default:
      shape = { kind: 'point', x: bpt.x, y: bpt.y, r };
  }
  let flags = 0;
  for (const cb of Object.values(flagBoxes)) if (cb.checked) flags |= Number(cb.dataset.bit);
  const heat = Number($<HTMLInputElement>('heat').value);
  const shock = Number($<HTMLInputElement>('shock').value);
  return {
    type: typeSel.value as DamageType,
    shape,
    energy: Number($<HTMLInputElement>('energy').value),
    dirX: ux,
    dirY: uy,
    duration: 1,
    sourceMass: 6,
    sourceBodyId: src.id,
    originX: src.transform.x,
    originY: src.transform.y,
    flags,
    params: {
      latch: 200,
      harvest: 0.6,
      pull: 1.2,
      embed: 3,
      embedDelay: 42,
      crackSeeds: 3,
      compress: 12,
      ...(heat > 0 ? { heat } : {}),
      ...(shock > 0 ? { shock } : {}),
    },
  };
}

function fire(ev: DamageEvent): void {
  const tIdx = Number($<HTMLSelectElement>('target').value);
  const r = world.applyDamage(bodyList[tIdx]!.id, ev);
  lastResult = JSON.stringify({
    ...r,
    contactX: +r.contactX.toFixed(1),
    contactY: +r.contactY.toFixed(1),
    impulseX: Math.round(r.impulseX),
    impulseY: Math.round(r.impulseY),
    massRemoved: +r.massRemoved.toFixed(1),
  });
  continuous = ev.flags & DamageFlag.CONTINUOUS ? ev : null;
}
let lastResult = '';
let continuous: DamageEvent | null = null;

let dragStart: { x: number; y: number; right: boolean } | null = null;
const toWorld = (e: MouseEvent): { x: number; y: number } => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * LOGICAL_W, y: ((e.clientY - r.top) / r.height) * LOGICAL_H };
};
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  dragStart = { ...toWorld(e), right: e.button === 2 };
});
window.addEventListener('mouseup', (e) => {
  if (!dragStart) return;
  const end = toWorld(e);
  fire(currentEvent(dragStart, end, dragStart.right));
  dragStart = null;
});

for (const id of ['energy', 'radius'])
  $<HTMLInputElement>(id).addEventListener(
    'input',
    () => ($(id + 'V').textContent = $<HTMLInputElement>(id).value),
  );
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'resume' : 'pause';
});
$('step').addEventListener('click', () => stepN(1));
$('step10').addEventListener('click', () => stepN(10));
$('reset').addEventListener('click', () => {
  seedN++;
  build();
});
$('c50').addEventListener('click', () =>
  world.carve(bodyList[Number($<HTMLSelectElement>('target').value)]!.id, 0.5, seedN),
);
$('c10').addEventListener('click', () =>
  world.carve(bodyList[Number($<HTMLSelectElement>('target').value)]!.id, 0.1, seedN),
);
$('heal').addEventListener('click', () =>
  world.heal(bodyList[Number($<HTMLSelectElement>('target').value)]!.id, 0.5, seedN),
);
$('restore').addEventListener('click', () =>
  world.restore(bodyList[Number($<HTMLSelectElement>('target').value)]!.id),
);
$('presetL').addEventListener('change', build);
$('presetR').addEventListener('change', build);
$('bh').addEventListener('change', applyGravity);

function stepN(n: number): void {
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    if (continuous) world.applyDamage(bodyList[Number($<HTMLSelectElement>('target').value)]!.id, continuous);
    world.tick();
    const dt = performance.now() - t0;
    msAvg += (dt - msAvg) * 0.05;
    if (dt > msMax) msMax = dt;
    ticksRun++;
  }
}

const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
function draw(alpha: number): void {
  const layers = world.renderLayers(view, alpha);
  const frame = composeFrame(layers, bodyList, view);
  const mode = dbgSel.value as DebugOverlayMode | '';
  if (mode) {
    for (const b of bodyList) {
      const ov = world.debugOverlay(b.id, mode);
      if (!ov) continue;
      const t = b.transform;
      for (let y = 0; y < ov.h; y++) {
        const wy = Math.round(t.y) + (y - t.anchorY);
        if (wy < 0 || wy >= LOGICAL_H) continue;
        const shift = t.lean === 0 ? 0 : Math.round((t.lean * (t.anchorY - y)) / Math.max(1, t.anchorY));
        for (let x = 0; x < ov.w; x++) {
          const c = ov.pixels[y * ov.w + x]!;
          if (c >>> 24 === 0) continue;
          const wx =
            (t.facing === 1 ? Math.round(t.x) + (x - t.anchorX) : Math.round(t.x) - (x - t.anchorX) - 1) +
            shift;
          if (wx < 0 || wx >= LOGICAL_W) continue;
          frame[wy * LOGICAL_W + wx] = c;
        }
      }
    }
  }
  void drawLayer;
  img32.set(frame);
  ctx2d.putImageData(img, 0, 0);
}

function updateStats(): void {
  const led = world.ledger();
  const d = world.diagnostics();
  const lines: string[] = [];
  bodyList.forEach((b, i) => {
    const s = world.stats(b.id);
    lines.push(
      `body ${i}: mass ${s.mass.toFixed(0)}/${s.initialMass.toFixed(0)} (${(s.massFrac * 100).toFixed(1)}%)`,
      `  cells ${s.cells}/${s.initialCells} core ${(s.coreIntegrity * 100).toFixed(0)}% exposed ${(s.exposedCoreFrac * 100).toFixed(0)}%`,
      `  burn ${s.burningCells} infect ${s.infectedCells} crack ${s.crackedCells}`,
      `  gained ${s.massGained.toFixed(0)} lost ${s.massLost.toFixed(0)}`,
    );
  });
  lines.push(
    `chunks ${d.chunks}  particles ${d.particles}`,
    `ledger error ${led.error.toExponential(1)}  dissipated ${led.dissipated.toFixed(0)}`,
    `tick ${world.tickCount}  ${msAvg.toFixed(2)} ms/tick (max ${msMax.toFixed(1)})`,
    `hash ${world.hash().toString(16)}`,
    `last: ${lastResult}`,
  );
  $('stats').textContent = lines.join('\n');
}

let acc = 0;
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += dt * 60 * Number($<HTMLInputElement>('speed').value);
    let n = 0;
    while (acc >= 1 && n < 8) {
      stepN(1);
      acc -= 1;
      n++;
    }
    if (n === 8) acc = 0;
  }
  draw(paused ? 0 : Math.min(0.99, acc));
  if ((ticksRun & 3) === 0) updateStats();
  requestAnimationFrame(frame);
}

build();
/** Scripting hook for headless screenshots/tests: window.__MATTER__.fire(ev) / run(n). */
(window as unknown as { __MATTER__: unknown }).__MATTER__ = {
  world: () => world,
  bodies: () => bodyList,
  fire: (ev: DamageEvent, target = 1) => world.applyDamage(bodyList[target]!.id, ev),
  run: (n: number) => stepN(n),
  pause: () => {
    paused = true;
  },
  ready: true,
};
const q = new URLSearchParams(location.search);
if (q.get('left')) $<HTMLSelectElement>('presetL').value = q.get('left')!;
if (q.get('right')) $<HTMLSelectElement>('presetR').value = q.get('right')!;
if (q.get('left') || q.get('right')) build();
if (q.get('dbg')) dbgSel.value = q.get('dbg')!;
if (q.get('pause') === '1') paused = true;
updateStats();
requestAnimationFrame(frame);
