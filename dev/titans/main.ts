import {
  Btn,
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  LOGICAL_H,
  LOGICAL_W,
  TITAN_IDS,
  parseScript,
  type DebugShape,
  type Difficulty,
  type InputFrame,
  type InputSource,
  type MatchConfig,
  type StageLighting,
  type TitanId,
  type ViewRect,
} from '@/contracts';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch, createNullSource, createScriptSource, type Match } from '@/sim';
import { createAI } from '@/ai';
import { getTitanDef, IMPLEMENTED_TITANS } from '@/titans';
import { blitLayers, makeFrame, paintBackdrop } from './blit';

/**
 * Titans sandbox: a sprite viewer (lighting presets, intact/50%/10%, animated tendrils) and a keyboard-playable fight against
 * an AI / dummy / second human on the REAL matter world, composited by dev/titans/blit.ts. This is where the weight is felt.
 * URL harness: ?a=lastone&b=asteroid&mode=fight|viewer&ai=3&ctl=ai|dummy|human&light=nursery|cold|noon&state=intact|50|10
 *              &seed=7&t=120 (skip the intro, advance N fight ticks, then freeze with freeze=1)&script0=…&script1=… (tick 0 = fight goes live; see contracts/harness.ts)&hitboxes=1
 */

const LIGHTS: Record<string, StageLighting> = {
  nursery: DEFAULT_LIGHTING,
  cold: { dir: [-0.3, -0.6, 0.74], color: '#cfe6ff', ambient: '#0e1a3a', rim: '#7fc8ff', screenPos: [0.3, -0.1] },
  noon: { dir: [0, -0.7, 0.71], color: '#fff3d6', ambient: '#2b2a3a', rim: '#ffd9a0', screenPos: [0.5, -0.2] },
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;
const off = document.createElement('canvas');
off.width = LOGICAL_W;
off.height = LOGICAL_H;
const offCtx = off.getContext('2d')!;
const q = new URLSearchParams(location.search);

const sel = {
  mode: $<HTMLSelectElement>('mode'),
  a: $<HTMLSelectElement>('a'),
  b: $<HTMLSelectElement>('b'),
  ctl: $<HTMLSelectElement>('ctl'),
  ai: $<HTMLSelectElement>('ai'),
  light: $<HTMLSelectElement>('light'),
  state: $<HTMLSelectElement>('state'),
  speed: $<HTMLSelectElement>('speed'),
};
const pick = (el: HTMLSelectElement, key: string): void => {
  const v = q.get(key);
  if (v && [...el.options].some((o) => o.value === v || o.text === v)) el.value = v;
};
pick(sel.mode, 'mode');
pick(sel.a, 'a');
pick(sel.b, 'b');
pick(sel.ctl, 'ctl');
pick(sel.ai, 'ai');
pick(sel.light, 'light');
pick(sel.state, 'state');
let debug = q.get('hitboxes') === '1';
let paused = q.get('freeze') === '1' || q.has('t');
let stepOnce = false;
const seed = parseInt(q.get('seed') ?? '7', 10) || 7;

/* ------------------------------------------------------------------------------------------------ *
 *  keyboard input (P1 wasd + jkl…, P2 arrows + digits)
 * ------------------------------------------------------------------------------------------------ */
const down = new Set<string>();
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  down.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e: KeyboardEvent) => down.delete(e.code));

function humanSource(map: Record<string, number>, keys: { l: string; r: string; u: string; d: string }): InputSource {
  let prev = 0;
  return {
    kind: 'human',
    poll(_t: number, out: InputFrame) {
      let held = 0;
      for (const [code, bit] of Object.entries(map)) if (down.has(code)) held |= bit;
      out.moveX = (down.has(keys.r) ? 1 : 0) - (down.has(keys.l) ? 1 : 0);
      out.moveY = (down.has(keys.d) ? 1 : 0) - (down.has(keys.u) ? 1 : 0);
      out.held = held;
      out.pressed = held & ~prev;
      out.released = prev & ~held;
      prev = held;
    },
  };
}
const P1 = humanSource(
  { KeyJ: Btn.STRIKE, KeyK: Btn.CRUSH, KeyL: Btn.SURGE, KeyI: Btn.SIGNATURE, KeyO: Btn.ULTIMATE, KeyU: Btn.GUARD, KeyQ: Btn.FEINT },
  { l: 'KeyA', r: 'KeyD', u: 'KeyW', d: 'KeyS' },
);
const P2 = humanSource(
  { Digit1: Btn.STRIKE, Digit2: Btn.CRUSH, Digit3: Btn.SURGE, Digit4: Btn.SIGNATURE, Digit5: Btn.ULTIMATE, Digit6: Btn.GUARD, Digit7: Btn.FEINT },
  { l: 'ArrowLeft', r: 'ArrowRight', u: 'ArrowUp', d: 'ArrowDown' },
);

/* ------------------------------------------------------------------------------------------------ *
 *  match lifecycle
 * ------------------------------------------------------------------------------------------------ */
let match!: Match;
let acc = 0;
let camX = 0;
let camY = 0;
let last = performance.now();
let ticksAdvanced = 0;

function titanOf(v: string): TitanId {
  return (TITAN_IDS as readonly string[]).includes(v) && (IMPLEMENTED_TITANS as readonly string[]).includes(v) ? (v as TitanId) : 'lastone';
}

function start(): void {
  const viewer = sel.mode.value === 'viewer';
  const a = titanOf(sel.a.value);
  const b = titanOf(sel.b.value);
  const level = parseInt(sel.ai.value, 10) as Difficulty;
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: viewer ? 'training' : 'vsai',
    slots: [
      { titan: a, controller: 'human' },
      { titan: b, controller: viewer ? 'dummy' : (sel.ctl.value as 'ai' | 'dummy' | 'human'), aiLevel: level },
    ],
    startState: sel.state.value === '50' ? '50' : sel.state.value === '10' ? '10' : 'intact',
    infinite: true,
  };
  const lighting = LIGHTS[sel.light.value] ?? DEFAULT_LIGHTING;
  match = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting,
  });
  const ctl = viewer ? 'dummy' : sel.ctl.value;
  // harness semantics (contracts/harness.ts): the intro is fast-forwarded silently, script tick 0 is the tick the fight goes live
  match.setSources(createNullSource(), createNullSource());
  for (let guard = 0; match.phase !== 'fight' && guard < 900; guard++) match.step();
  // the first live step polls tick t0 + 1, so measure scripts from there (script tick 0 = the first live tick)
  const t0 = match.tick;
  const s0 = q.get('script0');
  const s1 = q.get('script1');
  const second: InputSource | null =
    s1 !== null
      ? createScriptSource(parseScript(s1), t0 + 1)
      : ctl === 'ai'
        ? createAiSource(match, 1, createAI(level, getTitanDef(b), seed + 3))
        : ctl === 'human'
          ? P2
          : null;
  match.setSources(s0 !== null ? createScriptSource(parseScript(s0), t0 + 1) : P1, second);
  const a0 = match.fighters[0].view;
  const b0 = match.fighters[1].view;
  camX = (a0.x + b0.x) / 2;
  camY = (a0.y + b0.y) / 2 - 24;
  acc = 0;
  ticksAdvanced = 0;
  const t = parseInt(q.get('t') ?? '0', 10) || 0;
  for (let i = 0; i < t; i++) advance();
  (window as unknown as { __TITANS__: unknown }).__TITANS__ = { match, get tick() { return match.tick; }, ticks: () => ticksAdvanced };
}

function advance(): void {
  match.step();
  ticksAdvanced++;
}

/* ------------------------------------------------------------------------------------------------ *
 *  frame
 * ------------------------------------------------------------------------------------------------ */
const frame = makeFrame();
const dbgShapes: DebugShape[] = [];

function draw(alpha: number): void {
  const viewer = sel.mode.value === 'viewer';
  const a = match.fighters[0].view;
  const b = match.fighters[1].view;
  const tx = viewer ? a.x : (a.x + b.x) / 2;
  const ty = (viewer ? a.y - 30 : (a.y + b.y) / 2) - 24;
  camX += (tx - camX) * 0.08;
  camY += (ty - camY) * 0.05;
  const zoom = viewer ? 2 : 1;
  const vw = LOGICAL_W / zoom;
  const vh = LOGICAL_H / zoom;
  const view: ViewRect = { x0: Math.round(camX - vw / 2), y0: Math.round(camY - vh / 2), w: vw, h: vh };
  const fw = vw;
  const fh = vh;
  const fr = fw === LOGICAL_W ? frame : makeFrame(fw, fh);
  paintBackdrop(fr, fw, fh, view.x0 * 0.002);
  const layers = [
    ...match.fighters[0].renderLayers(view, alpha),
    ...match.fighters[1].renderLayers(view, alpha),
    ...match.world.renderLayers(view, alpha),
  ];
  blitLayers(fr, layers, view, alpha, fw, fh);
  const img = offCtx.createImageData(fw, fh);
  new Uint32Array(img.data.buffer).set(fr);
  const small = zoom === 1 ? off : document.createElement('canvas');
  if (zoom !== 1) {
    small.width = fw;
    small.height = fh;
    small.getContext('2d')!.putImageData(img, 0, 0);
  } else offCtx.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

  if (debug) drawDebug(view, zoom);
  hud();
}

function drawDebug(view: ViewRect, zoom: number): void {
  const sx = canvas.width / view.w;
  ctx.lineWidth = 1;
  for (const f of match.fighters) {
    dbgShapes.length = 0;
    f.debugShapes(dbgShapes);
    for (const d of dbgShapes) {
      ctx.strokeStyle = `#${(d.color & 0xffffff).toString(16).padStart(6, '0')}`;
      const s = d.shape;
      ctx.beginPath();
      if (s.kind === 'point' || s.kind === 'field') ctx.arc((s.x - view.x0) * sx, (s.y - view.y0) * sx, s.r * sx, 0, 6.283);
      else if (s.kind === 'line') {
        ctx.moveTo((s.x0 - view.x0) * sx, (s.y0 - view.y0) * sx);
        ctx.lineTo((s.x1 - view.x0) * sx, (s.y1 - view.y0) * sx);
      } else if (s.kind === 'cone') {
        const a = Math.atan2(s.dirY, s.dirX);
        ctx.moveTo((s.x - view.x0) * sx, (s.y - view.y0) * sx);
        ctx.arc((s.x - view.x0) * sx, (s.y - view.y0) * sx, s.range * sx, a - s.halfAngle, a + s.halfAngle);
        ctx.closePath();
      } else ctx.arc((s.x - view.x0) * sx, (s.y - view.y0) * sx, s.r1 * sx, 0, 6.283);
      ctx.stroke();
    }
    const v = f.view;
    ctx.strokeStyle = '#5f8';
    ctx.strokeRect((v.boundsX0 - view.x0) * sx, (v.boundsY0 - view.y0) * sx, (v.boundsX1 - v.boundsX0) * sx, (v.boundsY1 - v.boundsY0) * sx);
  }
  void zoom;
}

function hud(): void {
  const lines: string[] = [];
  for (const f of match.fighters) {
    const v = f.view;
    lines.push(
      `${v.titan.padEnd(8)} ${v.state.padEnd(9)} ${(v.moveId ?? '-').padEnd(18)} ${v.phase ?? ''}`,
      `  integrity ${v.integrityPct.toFixed(0).padStart(3)}%  mass ${(v.bodyStats.massFrac * 100).toFixed(0)}%  meter ${(v.meter * 100).toFixed(0)}%`,
      `  parts ${v.parts}/${v.resourceMax}  guard ${(v.guardHealth * 100).toFixed(0)}%  spd×${v.stats.speedMul.toFixed(2)} dmg×${v.stats.damageMul.toFixed(2)}`,
    );
  }
  lines.push(`tick ${match.tick}  phase ${match.phase}  ${paused ? 'PAUSED' : ''}`);
  $<HTMLPreElement>('hud').textContent = lines.join('\n');
}

function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const speed = parseFloat(sel.speed.value);
  if (!paused) acc += dt * speed;
  if (stepOnce) {
    stepOnce = false;
    advance();
  }
  while (acc >= 1 / 60) {
    acc -= 1 / 60;
    if (match.phase === 'matchend') start();
    advance();
  }
  draw(paused ? 1 : Math.min(0.999, acc * 60));
  requestAnimationFrame(loop);
}

for (const el of Object.values(sel)) el.addEventListener('change', start);
$('restart').addEventListener('click', start);
$('pause').addEventListener('click', () => (paused = !paused));
$('step').addEventListener('click', () => {
  paused = true;
  stepOnce = true;
});
$('dbg').addEventListener('click', () => (debug = !debug));

start();
requestAnimationFrame(loop);
