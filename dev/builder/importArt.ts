import type { SizeClass, TitanDef, TitanKind } from '@/contracts';
import { DEFAULT_LIGHTING } from '@/contracts';
import { paintImage } from '@/titans/kit/image';
import {
  autoMask,
  brush,
  convert,
  cutBackground,
  fillHoles,
  fillPolygon,
  interiorPoint,
  keepLargest,
  makeSource,
  type Converted,
  type Source,
} from './artImport';

/**
 * THE IMPORT ART WORKSPACE (titan builder): load key art, mark what is the creature, and turn it into the titan's body.
 *
 *  - Auto mask makes a first guess (everything unlike the frame's border, the piece in the middle).
 *  - Lasso + / − add or cut a freehand outline; Brush + / − paint the mask; Background picks colours that are NOT the
 *    creature, and Cut background removes them from inside the mask; Core places the KO anchor.
 *  - The size, materials and ramp steps shape the conversion; the preview on the right is the real game painter.
 *  - Apply hands the result to the builder (materials, art, body); Save writes it with the key art.
 */

export interface ImportResult {
  converted: Converted;
  /** The key art, re-encoded small enough to keep (webp data URL). */
  keyart: string;
  /** Use the suggested accent colours. */
  accents: boolean;
  /** The painter's form light and dither (art.params) the preview used. */
  form: number;
  dither: number;
}

type Tool = 'lasso+' | 'lasso-' | 'brush+' | 'brush-' | 'bg' | 'core';

const TARGET: Record<SizeClass, number> = { small: 120, medium: 170, large: 230, huge: 280 };

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

export function openImport(opts: {
  def: TitanDef;
  kind: TitanKind;
  size: SizeClass;
  onApply: (r: ImportResult) => void;
}): void {
  let src: Source | null = null;
  let img: HTMLImageElement | null = null;
  let mask: Uint8Array = new Uint8Array(0);
  const undo: Uint8Array[] = [];
  const bg: { x: number; y: number }[] = [];
  let core: { x: number; y: number } | null = null;
  let tool: Tool = 'lasso+';
  let lasso: [number, number][] = [];
  let converted: Converted | null = null;

  const dlg = el('dialog', { className: 'import' });
  const view = el('canvas', { className: 'src' });
  const ink = el('canvas', { className: 'ink' });
  const stage = el('div', { className: 'importStage' }, view, ink);
  const note = el('p', { className: 'note', textContent: 'Load the key art (or drop it here).' });
  const prev = el('canvas', { className: 'prev' });
  const prevNote = el('p', { className: 'note' });

  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  const tools = el('div', { className: 'row tools' });
  const toolNames: [Tool, string][] = [
    ['lasso+', 'Lasso +'],
    ['lasso-', 'Lasso −'],
    ['brush+', 'Brush +'],
    ['brush-', 'Brush −'],
    ['bg', 'Background'],
    ['core', 'Core'],
  ];
  for (const [t, label] of toolNames) {
    const b = el('button', { type: 'button', textContent: label });
    b.dataset['tool'] = t;
    b.addEventListener('click', () => {
      tool = t;
      paintTools();
    });
    tools.append(b);
  }
  const paintTools = (): void => {
    for (const b of tools.querySelectorAll<HTMLButtonElement>('button'))
      b.classList.toggle('on', b.dataset['tool'] === tool);
  };

  const num = (label: string, min: number, max: number, step: number, value: number): HTMLInputElement => {
    const i = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    });
    const o = el('output', { textContent: String(value) });
    i.addEventListener('input', () => (o.textContent = i.value));
    controls.append(el('div', { className: 'field' }, el('label', { textContent: label }), i, o));
    return i;
  };
  const button = (label: string, fn: () => void, parent: HTMLElement): HTMLButtonElement => {
    const b = el('button', { type: 'button', textContent: label });
    b.addEventListener('click', fn);
    parent.append(b);
    return b;
  };

  const controls = el('div', { className: 'body' });
  controls.append(el('h1', { textContent: 'IMPORT KEY ART' }), file, tools);
  const brushR = num('brush size', 2, 60, 1, 14);
  const strength = num('background cut', 0.4, 2.5, 0.05, 1);
  const maskRow = el('div', { className: 'row' });
  controls.append(maskRow);
  button('Auto mask', () => edit(() => (mask = autoMask(src!, +strength.value))), maskRow);
  const cutBtn = button(
    'Cut background',
    () => edit(() => cutBackground(src!, mask, bg, +strength.value)),
    maskRow,
  );
  button('Fill holes', () => edit(() => fillHoles(mask, src!.w, src!.h)), maskRow);
  button('Keep largest', () => edit(() => keepLargest(mask, src!.w, src!.h)), maskRow);
  button(
    'Clear samples',
    () => {
      bg.length = 0;
      redraw();
    },
    maskRow,
  );
  button(
    'Undo',
    () => {
      const m = undo.pop();
      if (m) mask = m;
      redraw();
      reconvert();
    },
    maskRow,
  );
  controls.append(el('p', { className: 'note', textContent: 'Conversion' }));
  const target = num('size (px)', 80, 300, 1, TARGET[opts.size]);
  const nMat = num('materials', 2, 10, 1, 5);
  const structure = num('structure', 0, 1, 0.05, 0.8);
  const veins = num('veins', 0, 3, 1, 2);
  const steps = num('ramp steps', 5, 8, 1, 7);
  const coreR = num('core radius', 4, 24, 1, 10);
  const simplify = num('simplify', 0, 8, 1, 2);
  const vibrance = num('vibrance', 1, 1.8, 0.05, 1.35);
  const form = num('form light', 0, 1, 0.05, 0.25);
  const dither = num('dither', 0, 1, 0.05, 0.35);
  const accents = el('input', { type: 'checkbox', checked: true });
  controls.append(el('label', { className: 'note' }, accents, ' use the suggested accent colours'));
  for (const i of [target, nMat, structure, veins, steps, coreR, simplify, vibrance, form, dither])
    i.addEventListener('change', reconvert);
  controls.append(prev, prevNote);
  const actions = el('div', { className: 'row' });
  controls.append(actions);
  button('Cancel', () => dlg.close(), actions);
  const applyBtn = button(
    'Apply to titan',
    () => {
      if (!converted || !img) return;
      opts.onApply({
        converted,
        keyart: keyartUrl(img),
        accents: accents.checked,
        form: +form.value,
        dither: +dither.value,
      });
      dlg.close();
    },
    actions,
  );
  applyBtn.className = 'primary';
  applyBtn.disabled = true;

  dlg.append(el('div', { className: 'importGrid' }, el('div', {}, stage, note), controls));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  paintTools();
  dlg.showModal();

  /* ---------------------------------------------------------------- loading */

  async function load(f: Blob): Promise<void> {
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.src = url;
    await im.decode();
    img = im;
    src = makeSource(im);
    view.width = ink.width = src.w;
    view.height = ink.height = src.h;
    mask = autoMask(src, +strength.value);
    core = interiorPoint(mask, src.w, src.h);
    bg.length = 0;
    undo.length = 0;
    note.textContent = `${im.naturalWidth}×${im.naturalHeight} art (working copy ${src.w}×${src.h}). Auto mask applied: refine it with the lasso, the brush and background samples.`;
    redraw();
    reconvert();
  }
  file.addEventListener('change', () => file.files?.[0] && void load(file.files[0]));
  dlg.addEventListener('dragover', (e) => e.preventDefault());
  dlg.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) void load(f);
  });

  /* ---------------------------------------------------------------- drawing */

  function redraw(): void {
    if (!src) return;
    const ctx = view.getContext('2d')!;
    const out = ctx.createImageData(src.w, src.h);
    const { w, h, rgba } = src;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const on = mask[i]!;
      const edge =
        on &&
        ((i % w > 0 && !mask[i - 1]) ||
          (i % w < w - 1 && !mask[i + 1]) ||
          (i >= w && !mask[i - w]) ||
          (i < w * (h - 1) && !mask[i + w]));
      if (edge) out.data.set([232, 220, 150, 255], o);
      else if (on) out.data.set([rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, 255], o);
      else out.data.set([rgba[o]! * 0.22, rgba[o + 1]! * 0.22, rgba[o + 2]! * 0.3 + 18, 255], o);
    }
    ctx.putImageData(out, 0, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff8a7a';
    for (const p of bg) {
      ctx.beginPath();
      ctx.moveTo(p.x - 5, p.y - 5);
      ctx.lineTo(p.x + 5, p.y + 5);
      ctx.moveTo(p.x + 5, p.y - 5);
      ctx.lineTo(p.x - 5, p.y + 5);
      ctx.stroke();
    }
    if (core) {
      ctx.strokeStyle = '#8fd6a0';
      ctx.beginPath();
      ctx.arc(core.x, core.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    cutBtn.textContent = `Cut background (${bg.length})`;
  }

  function edit(fn: () => void): void {
    if (!src) return;
    undo.push(mask.slice());
    if (undo.length > 30) undo.shift();
    fn();
    redraw();
    reconvert();
  }

  let convTimer = 0;
  function reconvert(): void {
    clearTimeout(convTimer);
    convTimer = window.setTimeout(doConvert, 120);
  }

  function doConvert(): void {
    if (!src || !core) return;
    try {
      converted = convert(src, mask, {
        target: +target.value,
        materials: +nMat.value,
        steps: +steps.value,
        core,
        coreR: +coreR.value,
        kind: opts.kind,
        simplify: +simplify.value,
        vibrance: +vibrance.value,
        structure: +structure.value,
        veins: +veins.value,
      });
      const def: TitanDef = {
        ...opts.def,
        materials: converted.materials,
        art: { ...opts.def.art, params: { form: +form.value, dither: +dither.value } },
      };
      const { map } = paintImage(def, converted.body, DEFAULT_LIGHTING);
      prev.width = map.w;
      prev.height = map.h;
      prev.style.width = `${map.w * 2}px`;
      const ctx = prev.getContext('2d')!;
      const im = ctx.createImageData(map.w, map.h);
      new Uint32Array(im.data.buffer).set(map.baseColor);
      ctx.putImageData(im, 0, 0);
      prevNote.textContent = `${converted.w}×${converted.h} px, ${converted.materials.length} materials (${converted.materials.map((m) => m.key).join(', ')})`;
      applyBtn.disabled = false;
    } catch (e) {
      converted = null;
      applyBtn.disabled = true;
      prevNote.textContent = (e as Error).message;
    }
  }

  /* ---------------------------------------------------------------- input */

  const at = (e: PointerEvent): [number, number] => {
    const r = ink.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * ink.width, ((e.clientY - r.top) / r.height) * ink.height];
  };
  let down = false;
  ink.addEventListener('pointerdown', (e) => {
    if (!src) return;
    ink.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    down = true;
    if (tool === 'bg') {
      bg.push({ x, y });
      redraw();
      down = false;
    } else if (tool === 'core') {
      core = { x, y };
      redraw();
      reconvert();
      down = false;
    } else if (tool.startsWith('brush')) {
      undo.push(mask.slice());
      brush(mask, src.w, src.h, x, y, +brushR.value, tool === 'brush+' ? 1 : 0);
      redraw();
    } else lasso = [[x, y]];
  });
  ink.addEventListener('pointermove', (e) => {
    if (!down || !src) return;
    const [x, y] = at(e);
    if (tool.startsWith('brush')) {
      brush(mask, src.w, src.h, x, y, +brushR.value, tool === 'brush+' ? 1 : 0);
      redraw();
    } else if (tool.startsWith('lasso')) {
      lasso.push([x, y]);
      const c = ink.getContext('2d')!;
      c.clearRect(0, 0, ink.width, ink.height);
      c.strokeStyle = tool === 'lasso+' ? '#e8dc96' : '#ff8a7a';
      c.lineWidth = 2;
      c.beginPath();
      lasso.forEach(([px, py], k) => (k ? c.lineTo(px, py) : c.moveTo(px, py)));
      c.stroke();
    }
  });
  ink.addEventListener('pointerup', () => {
    if (!down || !src) return;
    down = false;
    if (tool.startsWith('lasso') && lasso.length > 2) {
      const pts = lasso;
      edit(() => fillPolygon(mask, src!.w, src!.h, pts, tool === 'lasso+' ? 1 : 0));
      ink.getContext('2d')!.clearRect(0, 0, ink.width, ink.height);
    } else if (tool.startsWith('brush')) reconvert();
    lasso = [];
  });
}

/** The key art to keep beside the titan: webp, at most 1600 px on its long side. */
function keyartUrl(img: HTMLImageElement): string {
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.88);
}
