import {
  SIZE_CLASSES,
  STAGE_IDS,
  TITAN_KINDS,
  validateTitanDef,
  type MatterMap,
  type SizeClass,
  type StageId,
  type TitanDef,
  type TitanKind,
} from '@/contracts';
import { MATERIAL_ARCHETYPES } from '@/matter/archetypes';
import { STAGE_INFO } from '@/stages/info';
import { kitTitan } from '@/titans/kit';
import { paintBlob, type BlobParams } from '@/titans/kit/blob';
import { BLOB_KEYS, BLOB_SIZE_SCALE, KIND_PRESETS, kindMaterials } from '@/titans/kit/kinds';
import { buildRamp, hexToHsl, rotateHue } from '@/titans/kit/palette';
import { checkPaletteOf, checkSizeOf, type CheckResult } from '../../tools/titans/checks';

/**
 * THE TITAN BUILDER (v2 of the titan kit): edit a kit titan's JSON with sliders and see it repaint live, with the roster's
 * size and palette checks and the definition validator running on every change. Saving writes the JSON through the dev
 * server's bridge (tools/builder/plugin.ts), so `npm run dev` must be running; the game tabs reload on it.
 *
 *   npm run dev, then http://localhost:5173/dev/builder/
 *
 * Unsaved edits survive a reload (Vite reloads every page when a titan is saved or made) as a draft in sessionStorage.
 */

/* ------------------------------------------------------------------------------------------------ state */

interface ListedTitan {
  id: string;
  name: string;
  template: string;
  kind: TitanKind | null;
  wip: boolean;
}

interface UiState {
  id: string;
  open: string[];
  light: string;
  seed: number;
  zoom: number;
  layers: boolean;
  fit: boolean;
}

const UI_KEY = 'adeuk.builder.ui';
const draftKey = (id: string): string => `adeuk.builder.draft.${id}`;

function loadUi(): UiState {
  const d: UiState = {
    id: '',
    open: ['kind', 'body', 'checks'],
    light: 'home',
    seed: 1,
    zoom: 3,
    layers: false,
    fit: true,
  };
  try {
    return { ...d, ...(JSON.parse(sessionStorage.getItem(UI_KEY) ?? '{}') as Partial<UiState>) };
  } catch {
    return d;
  }
}
const ui = loadUi();
function saveUi(): void {
  try {
    sessionStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* storage blocked: the page still works, it just forgets */
  }
}

let titans: ListedTitan[] = [];
let def: TitanDef | null = null;
let saved = '';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const D = (): TitanDef => def!;
/** The JSON blocks the fighter reads untyped (src/combat/feel.ts): `feel` and `balance`. */
type Untyped = { feel?: { fx?: { kind: string } }; balance?: { power?: number; durability?: number } };
const X = (): TitanDef & Untyped => def as TitanDef & Untyped;
const kit = (): NonNullable<TitanDef['kit']> => D().kit!;
const isBlob = (): boolean =>
  kit().template === 'blob' && BLOB_KEYS.every((k) => D().materials.some((m) => m.key === k));
/** Snap to the slider's step, without float noise (0.7, not 0.7000000000000001). */
const round = (v: number, step: number): number => {
  if (step >= 1) return Math.round(v);
  const decimals = Math.min(6, Math.ceil(-Math.log10(step)));
  return +(Math.round(v / step) * step).toFixed(decimals);
};

/* ------------------------------------------------------------------------------------------------ the bridge */

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/__builder/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-titan-builder': '1', ...(init.headers ?? {}) },
  });
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok && body.error) throw new Error(body.error);
  return body;
}

function status(text: string, cls = ''): void {
  const s = $('status');
  s.textContent = text;
  s.className = cls;
}

const dirty = (): boolean => !!def && JSON.stringify(def) !== saved;

/** Everything that follows an edit: the draft, the header, a repaint on the next frame. */
function changed(): void {
  if (!def) return;
  const d = dirty();
  try {
    if (d) sessionStorage.setItem(draftKey(def.id), JSON.stringify(def));
    else sessionStorage.removeItem(draftKey(def.id));
  } catch {
    /* no storage: no draft */
  }
  ($('save') as HTMLButtonElement).disabled = !d;
  ($('revert') as HTMLButtonElement).disabled = !d;
  status(d ? 'unsaved changes' : 'saved', d ? 'dirty' : '');
  scheduleRender();
}

/* ------------------------------------------------------------------------------------------------ painting */

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function lighting(): (typeof STAGE_INFO)[StageId]['lighting'] {
  const stage = (ui.light === 'home' ? kit().stage : ui.light) as StageId;
  return (STAGE_INFO[stage] ?? STAGE_INFO.nursery).lighting;
}

interface Sprite {
  w: number;
  h: number;
  px: Uint32Array;
  /** Material id per sprite pixel (0 = empty). */
  mat: Uint8Array;
}

function crop(map: MatterMap): Sprite {
  let x0 = map.w;
  let y0 = map.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++)
      if (map.material[y * map.w + x] !== 0) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return { w: 1, h: 1, px: new Uint32Array(1), mat: new Uint8Array(1) };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const px = new Uint32Array(w * h);
  const mat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + y0) * map.w + (x + x0);
      const m = map.material[i]!;
      if (m === 0) continue;
      px[y * w + x] = map.baseColor[i]! | 0xff000000;
      mat[y * w + x] = m;
    }
  return { w, h, px, mat };
}

/** '#rrggbb' → packed ABGR (the canvas's little-endian Uint32 view). */
const packHex = (hex: string): number => {
  const v = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255)) >>> 0;
};

/** Distinct colours for the material layers view and the legend (material i → LAYER_COLOURS[i % n]). */
const LAYER_COLOURS = [
  '#e8dc96',
  '#6fb7ff',
  '#ff8a7a',
  '#8fd6a0',
  '#c27ae0',
  '#ffb060',
  '#5ad1c8',
  '#ff6fb0',
  '#a0a8ff',
  '#d0f070',
];
const layerColour = (i: number): string => LAYER_COLOURS[i % LAYER_COLOURS.length]!;
const layerColours = (): number[] => D().materials.map((_, i) => packHex(layerColour(i)));

function draw(canvas: HTMLCanvasElement, s: Sprite, scale: number, layers: boolean): void {
  canvas.width = s.w;
  canvas.height = s.h;
  canvas.style.width = `${s.w * scale}px`;
  canvas.style.height = `${s.h * scale}px`;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(s.w, s.h);
  const out = new Uint32Array(img.data.buffer);
  if (layers) {
    const cols = layerColours();
    for (let i = 0; i < s.mat.length; i++) if (s.mat[i]) out[i] = cols[s.mat[i]! - 1] ?? 0xffff00ff;
  } else out.set(s.px);
  ctx.putImageData(img, 0, 0);
}

/** Box-filter downscale so the longest side is `target` px (alpha-weighted, like tools/titans/sheet.ts). */
function thumbnail(s: Sprite, target: number): Sprite {
  const k = target / Math.max(s.w, s.h);
  const w = Math.max(1, Math.round(s.w * k));
  const h = Math.max(1, Math.round(s.h * k));
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / k);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / k));
      const sy0 = Math.floor(y / k);
      const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / k));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = sy0; yy < Math.min(sy1, s.h); yy++)
        for (let xx = sx0; xx < Math.min(sx1, s.w); xx++) {
          const c = s.px[yy * s.w + xx]!;
          n++;
          if (!(c >>> 24)) continue;
          a++;
          r += c & 255;
          g += (c >> 8) & 255;
          b += (c >> 16) & 255;
        }
      if (a * 2 < n || a === 0) continue;
      px[y * w + x] =
        (0xff000000 | (Math.round(b / a) << 16) | (Math.round(g / a) << 8) | Math.round(r / a)) >>> 0;
    }
  return { w, h, px, mat: new Uint8Array(w * h) };
}

function render(): void {
  if (!def) return;
  const painter = kitTitan(def.id)?.paint ?? (isBlob() ? paintBlob : null);
  const checks: [string, CheckResult][] = [];
  const problems: string[] = [];
  let sprite: Sprite | null = null;
  if (!painter) problems.push(`no painter for '${def.id}' (reload the page after making a titan)`);
  else
    try {
      const t0 = performance.now();
      const painted = painter(def, ui.seed, lighting());
      $('paintTime').textContent = `painted in ${(performance.now() - t0).toFixed(0)} ms`;
      const map = (painted.rig as { portrait?: MatterMap | null }).portrait ?? painted.map;
      sprite = crop(map);
      // every authored material should show (titans.test.ts: only runtime materials, named dead*, may be absent)
      const counts = new Array<number>(def.materials.length + 1).fill(0);
      for (const m of sprite.mat) counts[m]!++;
      legend(counts);
      const missing = def.materials
        .filter((m, i) => !counts[i + 1] && !m.key.startsWith('dead'))
        .map((m) => m.key);
      checks.push([
        'materials',
        {
          ok: missing.length === 0,
          detail: `${def.materials.length} materials, ${sprite.mat.filter((m) => m).length.toLocaleString()} px of matter`,
          problems: missing.map((k) => `'${k}' does not appear in the body (the roster tests require it)`),
        },
      ]);
    } catch (e) {
      problems.push(`the painter failed: ${(e as Error).message}`);
    }

  if (sprite) {
    draw($('big'), sprite, ui.zoom, ui.layers);
    draw($('one'), sprite, 1, ui.layers);
    draw($('thumb'), thumbnail(sprite, 64), 1, false);
    checks.unshift(['size', checkSizeOf(sprite.w, sprite.h, kit().size)]);
  }
  checks.unshift(['palette', checkPaletteOf(def.id, [kit().site.accent, kit().site.accent2], true)]);
  const v = validateTitanDef(def).map((s) => s.replace(`${def!.id}: `, ''));
  checks.push([
    'definition',
    { ok: v.length === 0, detail: 'validateTitanDef (frame data, slots, attributes)', problems: v },
  ]);
  if (problems.length) checks.unshift(['paint', { ok: false, detail: 'live preview', problems }]);

  const box = $('checks');
  box.replaceChildren(
    ...checks.map(([name, r]) =>
      el(
        'div',
        { className: 'check' },
        el('b', { className: r.ok ? 'ok' : 'bad', textContent: r.ok ? 'PASS ' : 'FAIL ' }),
        `${name}: ${r.detail}`,
        ...(r.problems.length ? [el('ul', {}, ...r.problems.map((p) => el('li', { textContent: p })))] : []),
      ),
    ),
  );
}

function swatch(colour: string): HTMLElement {
  const i = el('i');
  i.style.background = colour;
  return i;
}

function legend(counts: number[]): void {
  $('legend').replaceChildren(
    ...D().materials.map((m, i) => el('span', {}, swatch(layerColour(i)), `${m.key} ${counts[i + 1] ?? 0}`)),
  );
}

/* ------------------------------------------------------------------------------------------------ fields */

interface NumOpts {
  min: number;
  max: number;
  step: number;
  /** Runs after the value is set (e.g. canvas refit). */
  after?: () => void;
}

function slider(
  parent: HTMLElement,
  label: string,
  get: () => number,
  set: (v: number) => void,
  o: NumOpts,
): void {
  const input = el('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step) });
  const out = el('output');
  const show = (): void => {
    const v = get();
    input.value = String(v);
    out.textContent = String(round(v, o.step));
  };
  input.addEventListener('input', () => {
    set(round(+input.value, o.step));
    o.after?.();
    out.textContent = input.value;
    changed();
  });
  show();
  parent.append(
    el('div', { className: 'field' }, el('label', { textContent: label, title: label }), input, out),
  );
}

function textField(
  parent: HTMLElement,
  label: string,
  get: () => string,
  set: (v: string) => void,
  multi = false,
): void {
  const input = multi ? el('textarea', { rows: 3 }) : el('input', { type: 'text' });
  input.value = get() ?? '';
  input.addEventListener('input', () => {
    set(input.value);
    changed();
  });
  parent.append(el('div', { className: 'field wide' }, el('label', { textContent: label }), input));
}

function selectField(
  parent: HTMLElement,
  label: string,
  options: readonly string[],
  get: () => string,
  set: (v: string) => void,
): void {
  const s = el('select', {}, ...options.map((o) => el('option', { value: o, textContent: o })));
  s.value = get();
  s.addEventListener('change', () => {
    set(s.value);
    changed();
  });
  parent.append(el('div', { className: 'field wide' }, el('label', { textContent: label }), s));
}

function colourField(parent: HTMLElement, label: string, get: () => string, set: (v: string) => void): void {
  const c = el('input', { type: 'color', value: get() });
  c.style.width = '100%';
  c.addEventListener('input', () => {
    set(c.value);
    changed();
  });
  parent.append(el('div', { className: 'field wide' }, el('label', { textContent: label }), c));
}

function section(key: string, title: string, sub: string, fill: (body: HTMLElement) => void): HTMLElement {
  const body = el('div', { className: 'body' });
  fill(body);
  const d = el('details', {}, el('summary', {}, title, ' ', el('small', { textContent: sub })), body);
  d.open = ui.open.includes(key);
  d.addEventListener('toggle', () => {
    ui.open = d.open ? [...new Set([...ui.open, key])] : ui.open.filter((k) => k !== key);
    saveUi();
  });
  return d;
}

/* ------------------------------------------------------------------------------------------------ panels */

const params = (): BlobParams => D().art.params as unknown as BlobParams;

/** Size the blob's canvas to its body (plus lobes and wobble), centred, so nothing is clipped and nothing is wasted. */
function fitCanvas(): void {
  if (!ui.fit || !isBlob()) return;
  const p = params();
  const lobe = Math.min(p.body.rx, p.body.ry) * p.lobeSize * 1.15;
  const halfW = Math.ceil(Math.max(p.body.rx, p.lobes ? p.body.rx * 0.82 + lobe : 0) + p.wobble + 8);
  const halfH = Math.ceil(Math.max(p.body.ry, p.lobes ? p.body.ry * 0.82 + lobe : 0) + p.wobble + 8);
  const a = D().art;
  a.w = Math.min(300, halfW * 2);
  a.h = Math.min(300, halfH * 2);
  p.centre = [Math.round(a.w / 2), Math.round(a.h / 2)];
  a.coreX = p.centre[0] + p.core.x;
  a.coreY = p.centre[1] + p.core.y;
  a.coreRadius = p.core.r;
}

function kindPanel(b: HTMLElement): void {
  const blurb = el('p', { className: 'note' });
  const grid = el('div', { className: 'kinds' });
  const paint = (): void => {
    const k = kit().kind;
    for (const btn of grid.querySelectorAll<HTMLButtonElement>('button'))
      btn.classList.toggle('on', btn.dataset['kind'] === k);
    const p = k ? KIND_PRESETS[k] : null;
    blurb.textContent = p
      ? `${p.blurb} Suits ${p.destruction} damage. Applying the preset sets the five blob materials, the outline, the voice and the wake; colours keep the current hue.`
      : 'No kind yet: pick what this titan is.';
  };
  for (const k of TITAN_KINDS) {
    const p = KIND_PRESETS[k];
    const btn = el('button', { className: 'kind' }, el('b', { textContent: p.label }), ` ${p.ko}`);
    btn.dataset['kind'] = k;
    btn.addEventListener('click', () => {
      kit().kind = k;
      paint();
      changed();
    });
    grid.append(btn);
  }
  const apply = el('button', { textContent: 'Apply kind preset (blob)' });
  apply.disabled = !isBlob();
  apply.title = isBlob() ? '' : 'only the blob template has the five kind materials';
  apply.addEventListener('click', () => {
    const k = kit().kind;
    if (!k) return;
    if (
      !confirm(
        `Replace the materials, outline numbers, voice and wake with the ${KIND_PRESETS[k].label} preset?`,
      )
    )
      return;
    applyKind(k);
    buildPanels();
    changed();
  });
  b.append(grid, blurb, el('div', { className: 'row' }, apply));
  paint();
}

function applyKind(k: TitanKind): void {
  const preset = KIND_PRESETS[k];
  const hue = hexToHsl(D().ui.accent)[0];
  const s = BLOB_SIZE_SCALE[kit().size];
  D().materials = kindMaterials(k, hue);
  const p = params();
  Object.assign(p, {
    ...preset.shape,
    wobble: preset.shape.wobble * s,
    markingSize: preset.shape.markingSize * s,
  });
  kit().voice = { ...preset.voice };
  if (X().feel?.fx) X().feel!.fx!.kind = preset.wake;
  fitCanvas();
}

function bodyPanel(b: HTMLElement): void {
  if (!isBlob()) {
    b.append(
      el('p', {
        className: 'note',
        textContent: `This titan paints with its own painter (template '${kit().template}'). Its art.params numbers are listed raw; ranges are guesses around each value.`,
      }),
    );
    rawParams(b, D().art.params as Record<string, unknown>, '');
    return;
  }
  const p = params;
  const fit = el('input', { type: 'checkbox', checked: ui.fit });
  fit.addEventListener('change', () => {
    ui.fit = fit.checked;
    saveUi();
    fitCanvas();
    changed();
  });
  b.append(el('label', { className: 'note' }, fit, ' fit the canvas to the body (centred)'));
  const o = (min: number, max: number, step: number): NumOpts => ({ min, max, step, after: fitCanvas });
  slider(
    b,
    'width (rx)',
    () => p().body.rx,
    (v) => (p().body.rx = v),
    o(16, 140, 1),
  );
  slider(
    b,
    'height (ry)',
    () => p().body.ry,
    (v) => (p().body.ry = v),
    o(16, 140, 1),
  );
  slider(
    b,
    'lobes',
    () => p().lobes,
    (v) => (p().lobes = v),
    o(0, 8, 1),
  );
  slider(
    b,
    'lobe size',
    () => p().lobeSize,
    (v) => (p().lobeSize = v),
    o(0.2, 0.6, 0.01),
  );
  slider(
    b,
    'wobble',
    () => p().wobble,
    (v) => (p().wobble = v),
    o(0, 12, 0.1),
  );
  slider(
    b,
    'skin',
    () => p().skin,
    (v) => (p().skin = v),
    o(1, 14, 1),
  );
  slider(
    b,
    'markings',
    () => p().markings,
    (v) => (p().markings = v),
    o(0, 1, 0.01),
  );
  slider(
    b,
    'marking size',
    () => p().markingSize,
    (v) => (p().markingSize = v),
    o(4, 32, 0.5),
  );
  slider(
    b,
    'eyes',
    () => p().eyes,
    (v) => (p().eyes = v),
    o(0, 7, 1),
  );
  slider(
    b,
    'eye radius',
    () => p().eyeR,
    (v) => (p().eyeR = v),
    o(2, 20, 0.5),
  );
  slider(
    b,
    'core x',
    () => p().core.x,
    (v) => (p().core.x = v),
    o(-40, 40, 1),
  );
  slider(
    b,
    'core y',
    () => p().core.y,
    (v) => (p().core.y = v),
    o(-40, 40, 1),
  );
  slider(
    b,
    'core radius',
    () => p().core.r,
    (v) => (p().core.r = v),
    o(3, 30, 1),
  );
  selectField(
    b,
    'size class',
    Object.keys(SIZE_CLASSES),
    () => kit().size,
    (v) => (kit().size = v as SizeClass),
  );
}

/** Every number under art.params as a slider (painters other than the blob). */
function rawParams(
  b: HTMLElement,
  obj: Record<string, unknown> | unknown[],
  path: string,
  budget = { n: 80 },
): void {
  for (const [k, v] of Object.entries(obj)) {
    if (budget.n <= 0) return;
    const label = path ? `${path}.${k}` : k;
    if (typeof v === 'number') {
      budget.n--;
      const mag = Math.max(1, Math.abs(v) * 2);
      const step = Number.isInteger(v) ? 1 : mag / 200;
      const target = obj as Record<string, number>;
      slider(
        b,
        label,
        () => target[k]!,
        (x) => (target[k] = x),
        { min: v < 0 ? -mag : 0, max: mag, step },
      );
    } else if (v && typeof v === 'object') rawParams(b, v as Record<string, unknown>, label, budget);
  }
}

/** Estimate a ramp's generator numbers (hue, saturation, darkest, lightest) from its colours. */
function rampGen(ramp: string[]): { h: number; s: number; lo: number; hi: number } {
  const hsl = ramp.map(hexToHsl);
  const mid = hsl[Math.floor(hsl.length / 2)]!;
  return {
    h: Math.round(mid[0]),
    s: Math.round((hsl.reduce((a, c) => a + c[1], 0) / hsl.length) * 100) / 100,
    lo: Math.round(hsl[0]![2] * 100) / 100,
    hi: Math.round(hsl[hsl.length - 1]![2] * 100) / 100,
  };
}

function palettePanel(b: HTMLElement): void {
  // hue: rotate every colour of the definition from where the drag started
  let base = '';
  let from = 0;
  const hue = el('input', { type: 'range', min: '-180', max: '180', step: '1', value: '0' });
  const out = el('output', { textContent: '0°' });
  const grab = (): void => {
    base = JSON.stringify(def);
    from = +hue.value;
  };
  hue.addEventListener('pointerdown', grab);
  hue.addEventListener('keydown', grab);
  hue.addEventListener('input', () => {
    if (!base) grab();
    const deg = +hue.value - from;
    def = JSON.parse(
      base.replace(/"#([0-9a-fA-F]{6})"/g, (_, h: string) => `"${rotateHue(`#${h}`, deg)}"`),
    ) as TitanDef;
    out.textContent = `${hue.value}°`;
    changed();
  });
  hue.addEventListener('change', () => {
    base = '';
    buildPanels();
  });
  b.append(el('div', { className: 'field' }, el('label', { textContent: 'hue shift (all)' }), hue, out));

  const setAccent = (i: 0 | 1, v: string): void => {
    if (i === 0) D().ui.accent = kit().site.accent = v;
    else D().ui.accent2 = kit().site.accent2 = v;
  };
  colourField(
    b,
    'accent',
    () => kit().site.accent,
    (v) => setAccent(0, v),
  );
  colourField(
    b,
    'accent 2',
    () => kit().site.accent2,
    (v) => setAccent(1, v),
  );

  const archetypes = Object.keys(MATERIAL_ARCHETYPES);
  D().materials.forEach((_, mi) => {
    const m = (): TitanDef['materials'][number] => D().materials[mi]!;
    const box = el('div', { className: 'mat' });
    const arch = el('select', {}, ...archetypes.map((a) => el('option', { value: a, textContent: a })));
    arch.value = m().base;
    arch.title = 'physics archetype (src/matter/archetypes.ts)';
    arch.addEventListener('change', () => {
      m().base = arch.value;
      changed();
    });
    box.append(el('h3', {}, el('span', { textContent: m().key }), arch));
    const ramp = el('div', { className: 'ramp' });
    const fillRamp = (): void => {
      ramp.replaceChildren(
        ...m().visual.ramp.map((c, i) => {
          const inp = el('input', { type: 'color', value: c, title: `step ${i}` });
          inp.addEventListener('input', () => {
            m().visual.ramp[i] = inp.value;
            changed();
          });
          return inp;
        }),
      );
    };
    fillRamp();
    box.append(ramp);
    slider(
      box,
      'glow',
      () => m().visual.emissive,
      (v) => (m().visual.emissive = v),
      { min: 0, max: 90, step: 1 },
    );
    // the ramp generator (src/titans/kit/palette.ts buildRamp): any change rebuilds the whole ramp
    const gen = rampGen(m().visual.ramp);
    const rebuild = (): void => {
      const r = buildRamp(gen.h, m().visual.ramp.length, gen.s, gen.lo, gen.hi);
      Object.assign(m().visual, { ramp: r, char: r[1], crack: r[0], debris: r[Math.floor(r.length / 2)] });
      fillRamp();
    };
    const g = (label: string, key: keyof typeof gen, min: number, max: number, step: number): void =>
      slider(
        box,
        label,
        () => gen[key],
        (v) => (gen[key] = v),
        { min, max, step, after: rebuild },
      );
    g('ramp hue', 'h', 0, 359, 1);
    g('ramp saturation', 's', 0, 1, 0.01);
    g('ramp darkest', 'lo', 0, 0.6, 0.01);
    g('ramp lightest', 'hi', 0.4, 1, 0.01);
    const phys = (): NonNullable<TitanDef['materials'][number]['physics']> => (m().physics ??= {});
    const arc = (): (typeof MATERIAL_ARCHETYPES)[string] =>
      MATERIAL_ARCHETYPES[m().base] ?? MATERIAL_ARCHETYPES['rock']!;
    slider(
      box,
      'toughness',
      () => m().physics?.toughness ?? arc().toughness,
      (v) => (phys().toughness = v),
      {
        min: 0.02,
        max: 1,
        step: 0.01,
      },
    );
    slider(
      box,
      'density',
      () => m().physics?.density ?? arc().density,
      (v) => (phys().density = v),
      {
        min: 0.05,
        max: 4,
        step: 0.05,
      },
    );
    b.append(box);
  });
}

function statsPanel(b: HTMLElement): void {
  const a = D().attributes as unknown as Record<string, number>;
  for (const k of Object.keys(a))
    slider(
      b,
      k,
      () => a[k]!,
      (v) => (a[k] = v),
      { min: 1, max: 10, step: 1 },
    );
  const bal = (): NonNullable<Untyped['balance']> => (X().balance ??= { power: 1, durability: 1 });
  slider(
    b,
    'power',
    () => X().balance?.power ?? 1,
    (v) => (bal().power = v),
    { min: 0.5, max: 2, step: 0.01 },
  );
  slider(
    b,
    'durability',
    () => X().balance?.durability ?? 1,
    (v) => (bal().durability = v),
    { min: 0.5, max: 2, step: 0.01 },
  );
  b.append(el('p', { className: 'note', textContent: 'AI personality (0–1):' }));
  const w = D().ai.weights as Record<string, number>;
  for (const k of Object.keys(w))
    slider(
      b,
      k,
      () => w[k]!,
      (v) => (w[k] = v),
      { min: 0, max: 1, step: 0.01 },
    );
}

function voicePanel(b: HTMLElement): void {
  // getters read the default without writing it (opening a titan must not dirty it); setters write it
  const v = (): NonNullable<NonNullable<TitanDef['kit']>['voice']> =>
    kit().voice ?? { pitch: 55, grit: 0.5, ring: 0.3, wet: 0.5 };
  const w = (): NonNullable<NonNullable<TitanDef['kit']>['voice']> => (kit().voice ??= { ...v() });
  slider(
    b,
    'pitch (Hz)',
    () => v().pitch,
    (x) => (w().pitch = x),
    { min: 25, max: 140, step: 1 },
  );
  slider(
    b,
    'grit',
    () => v().grit,
    (x) => (w().grit = x),
    { min: 0, max: 1, step: 0.01 },
  );
  slider(
    b,
    'ring',
    () => v().ring,
    (x) => (w().ring = x),
    { min: 0, max: 1, step: 0.01 },
  );
  slider(
    b,
    'wet',
    () => v().wet,
    (x) => (w().wet = x),
    { min: 0, max: 1, step: 0.01 },
  );
  b.append(
    el('p', {
      className: 'note',
      textContent: 'Hear it in Training after saving (30 Hz = a mountain, 120 = a boulder).',
    }),
  );
}

function cardPanel(b: HTMLElement): void {
  const s = (): NonNullable<TitanDef['kit']>['site'] => kit().site;
  textField(
    b,
    'name',
    () => D().name,
    (v) => (D().name = s().name = v),
  );
  textField(
    b,
    'Korean name',
    () => D().nameKo,
    (v) => (D().nameKo = s().ko = v),
  );
  textField(
    b,
    'epithet',
    () => D().epithet ?? '',
    (v) => (D().epithet = v),
  );
  textField(
    b,
    'essence',
    () => s().essence,
    (v) => (s().essence = v),
  );
  textField(
    b,
    'tagline',
    () => D().ui.tagline ?? '',
    (v) => (D().ui.tagline = v),
  );
  textField(
    b,
    'lore',
    () => s().lore,
    (v) => (s().lore = v),
    true,
  );
  textField(
    b,
    'mechanic',
    () => s().mech.title,
    (v) => (s().mech.title = v),
  );
  textField(
    b,
    'mechanic text',
    () => s().mech.text,
    (v) => (s().mech.text = v),
    true,
  );
  textField(
    b,
    'homage notes',
    () => kit().homage ?? '',
    (v) => (kit().homage = v),
    true,
  );
  selectField(
    b,
    'home stage',
    STAGE_IDS,
    () => kit().stage,
    (v) => (kit().stage = v),
  );
  slider(
    b,
    'tier',
    () => kit().tier ?? 2,
    (v) => (kit().tier = v),
    { min: 1, max: 5, step: 1 },
  );
}

function jsonPanel(b: HTMLElement): void {
  const ta = el('textarea', { rows: 16, spellcheck: false, value: JSON.stringify(def, null, 2) });
  const apply = el('button', { textContent: 'Apply JSON' });
  apply.addEventListener('click', () => {
    try {
      const next = JSON.parse(ta.value) as TitanDef;
      if (next.id !== D().id) throw new Error(`the id must stay '${D().id}'`);
      def = next;
      buildPanels();
      changed();
    } catch (e) {
      status(`JSON: ${(e as Error).message}`, 'err');
    }
  });
  b.append(ta, el('div', { className: 'row' }, apply));
}

function buildPanels(): void {
  const p = $('panels');
  if (!def) return p.replaceChildren();
  const kindLabel = kit().kind ? KIND_PRESETS[kit().kind!].label : 'none';
  p.replaceChildren(
    section('kind', 'KIND · 종류', kindLabel, kindPanel),
    section('body', 'BODY · 몸', isBlob() ? 'blob painter' : kit().template, bodyPanel),
    section('palette', 'PALETTE & MATERIALS · 색', `${D().materials.length} materials`, palettePanel),
    section('stats', 'ATTRIBUTES & AI · 능력치', 'mass, tempo, personality', statsPanel),
    section('voice', 'VOICE · 목소리', 'kit voice', voicePanel),
    section('card', 'CARD · 카드', 'name, lore, stage', cardPanel),
    section('json', 'RAW JSON', 'everything else', jsonPanel),
  );
}

/* ------------------------------------------------------------------------------------------------ titans */

async function loadList(): Promise<void> {
  titans = await api<ListedTitan[]>('titans');
  const sel = $<HTMLSelectElement>('titan');
  sel.replaceChildren(
    ...titans.map((t) =>
      el('option', {
        value: t.id,
        textContent: `${t.name} (${t.id})${t.kind ? ` · ${t.kind}` : ''}${t.wip ? ' · WIP' : ''}`,
      }),
    ),
  );
}

async function open(id: string): Promise<void> {
  const fresh = await api<TitanDef>(`titan?id=${encodeURIComponent(id)}`);
  saved = JSON.stringify(fresh);
  def = fresh;
  let restored = false;
  try {
    const draft = sessionStorage.getItem(draftKey(id));
    if (draft && draft !== saved) {
      def = JSON.parse(draft) as TitanDef;
      restored = true;
    }
  } catch {
    /* no draft */
  }
  ui.id = id;
  saveUi();
  $<HTMLSelectElement>('titan').value = id;
  const q = (s: string): string => `/?${s}&wip=${id}`;
  $<HTMLAnchorElement>('lnkTraining').href = q(`mode=training&a=${id}&b=planet`);
  $<HTMLAnchorElement>('lnkVsAi').href = q(`a=${id}&b=planet&p1=human&p2=ai`);
  $<HTMLAnchorElement>('lnkSandbox').href = `/dev/titans/?mode=viewer&a=${id}&state=50`;
  $('report').textContent = '';
  buildPanels();
  changed();
  if (restored) status('unsaved changes (restored draft)', 'dirty');
}

async function save(): Promise<void> {
  if (!def) return;
  status('saving…');
  try {
    const r = await api<{ saved: string }>(`titan?id=${def.id}`, {
      method: 'PUT',
      body: JSON.stringify(def),
    });
    saved = JSON.stringify(def);
    changed();
    status(`saved ${r.saved}`);
  } catch (e) {
    status(`save failed: ${(e as Error).message}`, 'err');
  }
}

function newDialog(): void {
  const dlg = $<HTMLDialogElement>('newDlg');
  const form = $<HTMLFormElement>('newForm');
  let kind: TitanKind = 'organic';
  const grid = $('newKinds');
  const paint = (): void => {
    for (const b of grid.querySelectorAll<HTMLButtonElement>('button'))
      b.classList.toggle('on', b.dataset['kind'] === kind);
  };
  grid.replaceChildren(
    ...TITAN_KINDS.map((k) => {
      const p = KIND_PRESETS[k];
      const b = el(
        'button',
        { type: 'button', className: 'kind' },
        el('b', { textContent: p.label }),
        ` ${p.ko}`,
        el('span', { textContent: p.blurb }),
      );
      b.dataset['kind'] = k;
      b.addEventListener('click', () => {
        kind = k;
        paint();
      });
      return b;
    }),
  );
  paint();
  $('newOut').textContent = '';
  $<HTMLButtonElement>('newGo').onclick = async (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const body = Object.fromEntries(f.entries());
    $('newOut').textContent = 'running new:titan… (it formats files and can take a few seconds)';
    // remember the new id first: the scaffold's registry edits make Vite reload this page before the request answers
    const before = ui.id;
    ui.id = String(body['id']);
    saveUi();
    try {
      const r = await api<{ ok: boolean; output: string }>('new', {
        method: 'POST',
        body: JSON.stringify({ ...body, kind }),
      });
      $('newOut').textContent = r.output;
      // the scaffold edited the registries: Vite reloads the page by itself; this is the fallback
      if (r.ok) setTimeout(() => location.reload(), 1500);
      else {
        ui.id = before;
        saveUi();
      }
    } catch (e) {
      ui.id = before;
      saveUi();
      $('newOut').textContent = (e as Error).message;
    }
  };
  dlg.showModal();
}

/* ------------------------------------------------------------------------------------------------ boot */

function bootView(): void {
  const light = $<HTMLSelectElement>('light');
  light.replaceChildren(
    el('option', { value: 'home', textContent: 'home stage' }),
    ...STAGE_IDS.map((s) => el('option', { value: s, textContent: STAGE_INFO[s].name })),
  );
  light.value = ui.light;
  const seed = $<HTMLInputElement>('seed');
  seed.value = String(ui.seed);
  const zoom = $<HTMLSelectElement>('zoom');
  zoom.value = String(ui.zoom);
  const layers = $<HTMLInputElement>('layers');
  layers.checked = ui.layers;
  const sync = (): void => {
    ui.light = light.value;
    ui.seed = Math.max(1, Math.round(+seed.value) || 1);
    ui.zoom = +zoom.value;
    ui.layers = layers.checked;
    saveUi();
    scheduleRender();
  };
  for (const c of [light, seed, zoom, layers]) c.addEventListener('change', sync);
  seed.addEventListener('input', sync);

  $<HTMLSelectElement>('titan').addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    if (
      dirty() &&
      !confirm('This titan has unsaved changes (kept as a draft for this tab). Switch anyway?')
    ) {
      sel.value = ui.id;
      return;
    }
    void open(sel.value);
  });
  $('save').addEventListener('click', () => void save());
  $('revert').addEventListener('click', () => {
    if (!def || !confirm('Throw away the unsaved changes?')) return;
    def = JSON.parse(saved) as TitanDef;
    buildPanels();
    changed();
  });
  $('new').addEventListener('click', newDialog);
  $('runCheck').addEventListener('click', async () => {
    if (!def) return;
    $('report').textContent = dirty()
      ? 'checking the SAVED version (save first to check these edits)…'
      : 'running titan:check --quick…';
    try {
      const r = await api<{ ok: boolean; output: string }>(`check?id=${def.id}`, { method: 'POST' });
      $('report').textContent = r.output;
    } catch (e) {
      $('report').textContent = (e as Error).message;
    }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (dirty()) void save();
    }
  });
}

async function boot(): Promise<void> {
  bootView();
  try {
    await loadList();
  } catch (e) {
    status(`no builder bridge (run npm run dev): ${(e as Error).message}`, 'err');
    return;
  }
  if (!titans.length) {
    status('no kit titans yet: make one with + New titan');
    return;
  }
  const id = titans.some((t) => t.id === ui.id) ? ui.id : titans[0]!.id;
  await open(id);
}

void boot();
