import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  DAMAGE_TYPES,
  parseScript,
  validateTitanDef,
  type AimDir,
  type DebugShape,
  type MatchConfig,
  type MoveDef,
  type TitanDef,
  type TitanId,
  type ViewRect,
} from '@/contracts';
import { createFighter, type FighterImpl } from '@/combat';
import { KitBehaviour } from '@/combat/behaviours/kit/base';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef, IMPLEMENTED_TITANS } from '@/titans';
import { blitLayers, makeFrame, paintBackdrop } from '../titans/blit';
import { motionEditor } from './motionPanel';
import type { Note } from '../../tools/builder/notes';

/**
 * THE MOTION STUDIO (titan builder, Phase 2): play any move of the titan being edited in the REAL sim (the game's own fighters,
 * matter world and behaviours, drawn by the software compositor), frame by frame:
 *
 *  - a timeline of the clip, coloured by the move's phase (startup, charge, active, recovery, guard), with the hits marked;
 *    drag on it to scrub, ←/→ to step a tick, space to play;
 *  - the live hitboxes over the frame (Training's view), and the move's phase and tick;
 *  - MOVE: its frame data and the selected aim's hitboxes, as numbers: every change re-runs the clip;
 *  - MOTION: the animation presets (kit.motion), tuned while the clip plays;
 *  - NOTES: pin a note to the frame on screen (it is saved with the frame to docs/titans/<id>/NOTES.md, a task list Claude
 *    works through), and tick notes off.
 *
 * Edits change the builder's copy of the titan (unsaved until Save), exactly like the side panels.
 */

export interface StudioOpts {
  def: () => TitanDef;
  /** The studio changed the titan: mark it unsaved and refresh the side panels. */
  edited: () => void;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

/** The clip's crop of the arena (px at game scale) and how far ahead of the titan it looks. */
const CW = 400;
const CH = 250;
const LEAD = 70;
const T0 = 12;
const SCRIPT_BTN: Record<string, string> = {
  strike: 'strike',
  crush: 'crush',
  surge: 'surge',
  signature: 'sig',
  ultimate: 'ult',
  guard: 'guard',
};
const PHASE_COL: Record<string, string> = {
  startup: '#c8a640',
  charge: '#9a6cd8',
  active: '#e0524a',
  recovery: '#4a7ad0',
  guard: '#4fae6a',
  surge: '#4fb6c0',
  hitstun: '#7a4040',
  idle: '#2a2d44',
};
const FEEL: Partial<Record<string, [number, number]>> = {
  strike: [30, 48],
  crush: [72, 120],
  ultimate: [180, 300],
};

interface TickInfo {
  phase: string;
  label: string;
  shapes: DebugShape[];
  dealt: boolean;
  taken: boolean;
}

export function openStudio(o: StudioOpts): void {
  const def0 = o.def();
  const moves = (): MoveDef[] => o.def().moves;
  let sel = moves()[0]?.id ?? '';
  let aim: AimDir = 'forward';
  let foe: TitanId = (def0.id === 'planet' ? 'asteroid' : 'planet') as TitanId;
  let gap = 230;
  let hold = 40;
  let foeAt = 0;
  let speed = 1;
  let showHit = true;
  let frames: ImageBitmap[] = [];
  let info: TickInfo[] = [];
  let tick = 0;
  let playing = true;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let simTimer = 0;
  let presetsShown = true;

  const dlg = el('dialog', { className: 'import studio' });
  const view = el('canvas', { className: 'studioView' });
  view.width = CW * 2;
  view.height = CH * 2;
  const vctx = view.getContext('2d')!;
  const line = el('canvas', { className: 'timeline' });
  line.width = CW * 2;
  line.height = 34;
  const lctx = line.getContext('2d')!;
  const readout = el('div', { className: 'note readout' });
  const tabs = el('div', { className: 'row tools' });
  const side = el('div', { className: 'body studioSide' });
  const problems = el('p', { className: 'note warn' });

  /* ---------------------------------------------------------------------------------------------- controls */

  const moveSel = el('select');
  const fillMoves = (): void => {
    moveSel.replaceChildren(
      el('option', { value: '', textContent: 'idle (no move)' }),
      ...moves().map((m) => el('option', { value: m.id, textContent: `${m.slot}: ${m.name}` })),
    );
    moveSel.value = sel;
  };
  fillMoves();
  moveSel.addEventListener('change', () => {
    sel = moveSel.value;
    const m = current();
    if (m?.slot === 'guard') foeAt = foeAt || 30;
    buildSide();
    resim();
  });
  const aimSel = el(
    'select',
    {},
    ...(['up', 'forward', 'down'] as const).map((a) => el('option', { value: a, textContent: `aim ${a}` })),
  );
  aimSel.value = aim;
  aimSel.addEventListener('change', () => {
    aim = aimSel.value as AimDir;
    buildSide();
    resim();
  });
  const foeSel = el(
    'select',
    {},
    ...IMPLEMENTED_TITANS.map((id) => el('option', { value: id, textContent: `vs ${id}` })),
  );
  foeSel.value = foe;
  foeSel.addEventListener('change', () => {
    foe = foeSel.value as TitanId;
    resim();
  });
  const num = (label: string, get: () => number, set: (v: number) => void, min: number, max: number) => {
    const i = el('input', { type: 'number', min: String(min), max: String(max), value: String(get()) });
    i.style.width = '64px';
    i.addEventListener('change', () => {
      set(Math.max(min, Math.min(max, Math.round(+i.value || 0))));
      i.value = String(get());
      resim();
    });
    return el('label', { className: 'inline' }, `${label} `, i);
  };
  const speedSel = el(
    'select',
    {},
    ...[1, 0.5, 0.25, 0.1].map((s) => el('option', { value: String(s), textContent: `${s}×` })),
  );
  speedSel.addEventListener('change', () => (speed = +speedSel.value));
  const hitBox = el('input', { type: 'checkbox', checked: true });
  hitBox.addEventListener('change', () => {
    showHit = hitBox.checked;
    draw();
  });
  const playBtn = el('button', { type: 'button', textContent: '❚❚' });
  playBtn.addEventListener('click', () => toggle());
  const stepBtn = (label: string, d: number): HTMLButtonElement => {
    const b = el('button', { type: 'button', textContent: label });
    b.addEventListener('click', () => {
      playing = false;
      seek(tick + d);
    });
    return b;
  };
  const closeBtn = el('button', { type: 'button', textContent: 'Close', className: 'primary' });
  closeBtn.addEventListener('click', () => dlg.close());

  const top = el(
    'div',
    { className: 'row' },
    el('h1', { textContent: 'MOTION STUDIO' }),
    moveSel,
    aimSel,
    foeSel,
    num(
      'gap',
      () => gap,
      (v) => (gap = v),
      80,
      420,
    ),
    num(
      'hold',
      () => hold,
      (v) => (hold = v),
      1,
      240,
    ),
    num(
      'foe strikes at',
      () => foeAt,
      (v) => (foeAt = v),
      0,
      280,
    ),
    closeBtn,
  );
  const transport = el(
    'div',
    { className: 'row' },
    stepBtn('◀', -1),
    playBtn,
    stepBtn('▶', 1),
    speedSel,
    el('label', { className: 'inline' }, hitBox, ' hitboxes'),
    readout,
  );

  /* ---------------------------------------------------------------------------------------------- side tabs */

  type Tab = 'move' | 'motion' | 'notes';
  let tab: Tab = 'move';
  for (const [t, label] of [
    ['move', 'MOVE'],
    ['motion', 'MOTION'],
    ['notes', 'NOTES'],
  ] as [Tab, string][]) {
    const b = el('button', { type: 'button', textContent: label });
    b.dataset['tab'] = t;
    b.addEventListener('click', () => {
      tab = t;
      buildSide();
    });
    tabs.append(b);
  }

  const current = (): MoveDef | null => moves().find((m) => m.id === sel) ?? null;

  const buildSide = (): void => {
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('button'))
      b.classList.toggle('on', b.dataset['tab'] === tab);
    side.replaceChildren();
    if (tab === 'move') moveTab();
    else if (tab === 'motion') {
      motionEditor(side, o.def(), () => {
        o.edited();
        resim();
      });
      presetsShown = !!o.def().kit?.motion?.length;
    } else void notesTab();
  };

  const edit = (): void => {
    o.edited();
    resim();
  };

  const field = (
    parent: HTMLElement,
    label: string,
    get: () => number,
    set: (v: number) => void,
    step = 1,
  ): void => {
    const i = el('input', { type: 'number', step: String(step), value: String(get()) });
    i.addEventListener('change', () => {
      const v = +i.value;
      if (!Number.isFinite(v)) return;
      set(v);
      edit();
      if (parent.dataset['feel']) moveTab();
    });
    parent.append(el('div', { className: 'field' }, el('label', { textContent: label }), i));
  };

  const moveTab = (): void => {
    side.replaceChildren();
    const m = current();
    if (!m) {
      side.append(
        el('p', {
          className: 'note',
          textContent:
            'The idle: no move. Pick a move above to edit its timing and hitboxes, or tune presets in MOTION.',
        }),
      );
      return;
    }
    side.append(el('h2', { textContent: `${m.name} · ${m.slot}` }));
    const fr = m.frame as unknown as Record<string, number>;
    const frameBox = el('div', { className: 'preset' });
    frameBox.dataset['feel'] = '1';
    frameBox.append(el('b', { textContent: 'frame (ticks, 60 = 1 s)' }));
    for (const k of ['startup', 'active', 'recovery', 'hitstop', 'chargeMax'])
      if (k in fr || k === 'startup' || k === 'active' || k === 'recovery')
        field(
          frameBox,
          k,
          () => fr[k] ?? 0,
          (v) => (fr[k] = Math.max(k === 'active' ? 1 : 0, Math.round(v))),
        );
    const total = (fr['startup'] ?? 0) + (fr['active'] ?? 0) + (fr['recovery'] ?? 0);
    const band = FEEL[m.slot];
    frameBox.append(
      el('p', {
        className: band && (total < band[0] || total > band[1]) ? 'note warn' : 'note',
        textContent: `total ${total} ticks${band ? ` (feel target ${band[0]}–${band[1]})` : ''}`,
      }),
    );
    side.append(frameBox);
    const v = m.variants[aim];
    const hbs = v?.hitboxes ?? [];
    if (!hbs.length)
      side.append(
        el('p', {
          className: 'note',
          textContent: `no hitboxes for aim ${aim} (its behaviour does the work)`,
        }),
      );
    hbs.forEach((hb, j) => {
      const box = el('div', { className: 'preset' });
      box.append(el('b', { textContent: `hitbox ${j + 1}: ${hb.id} (${hb.shape.kind})` }));
      const h = hb as unknown as Record<string, number>;
      field(
        box,
        'from',
        () => h['from']!,
        (x) => (h['from'] = Math.max(0, Math.round(x))),
      );
      field(
        box,
        'to',
        () => h['to']!,
        (x) => (h['to'] = Math.max(0, Math.round(x))),
      );
      const type = el('select', {}, ...DAMAGE_TYPES.map((t) => el('option', { value: t, textContent: t })));
      type.value = hb.damage.type;
      type.addEventListener('change', () => {
        hb.damage.type = type.value as typeof hb.damage.type;
        edit();
      });
      box.append(el('div', { className: 'field' }, el('label', { textContent: 'type' }), type));
      field(
        box,
        'energy',
        () => hb.damage.energy,
        (x) => (hb.damage.energy = Math.max(0, x)),
        10,
      );
      const sh = hb.shape as unknown as Record<string, unknown>;
      for (const [k, val] of Object.entries(sh))
        if (typeof val === 'number')
          field(
            box,
            `shape ${k}`,
            () => sh[k] as number,
            (x) => (sh[k] = x),
          );
      const kb = hb.knockback as unknown as Record<string, number> | undefined;
      if (kb)
        for (const k of ['x', 'y'])
          if (typeof kb[k] === 'number')
            field(
              box,
              `knockback ${k}`,
              () => kb[k]!,
              (x) => (kb[k] = x),
              10,
            );
      side.append(box);
    });
  };

  const notesTab = async (): Promise<void> => {
    const id = o.def().id;
    const text = el('textarea', { rows: 4, placeholder: 'What should change at this frame?' });
    const pin = el('button', { type: 'button', textContent: 'Pin note to this frame', className: 'primary' });
    const list = el('div');
    const copy = el('button', { type: 'button', textContent: 'Copy for Claude' });
    const show = (notes: Note[]): void => {
      list.replaceChildren();
      notes.forEach((n, i) => {
        const c = el('input', { type: 'checkbox', checked: n.done });
        c.addEventListener('change', async () => {
          show(await o.api<Note[]>(`notes?id=${id}`, put({ index: i, done: c.checked })));
        });
        list.append(
          el(
            'div',
            { className: n.done ? 'noteItem done' : 'noteItem' },
            c,
            el('b', { textContent: ` ${n.title}` }),
            el('small', { textContent: ` · tick ${n.tick}${n.phase ? `, ${n.phase}` : ''} · ${n.date}` }),
            el('div', { textContent: n.text }),
          ),
        );
      });
      const open = notes.filter((n) => !n.done).length;
      copy.disabled = open === 0;
      copy.onclick = () =>
        void navigator.clipboard?.writeText(
          `Work through docs/titans/${id}/NOTES.md: ${open} open note${open === 1 ? '' : 's'} from the motion studio, each pinned to a frame (the PNG beside it). Tick each one off when it is done.`,
        );
    };
    pin.addEventListener('click', async () => {
      if (!text.value.trim()) return;
      const m = current();
      const inf = info[tick];
      const title = m ? `${m.name} (${aim})` : 'Idle';
      try {
        const notes = await o.api<Note[]>(`notes?id=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            tick,
            phase: inf?.label ?? '',
            text: text.value,
            png: view.toDataURL('image/png'),
          }),
        });
        text.value = '';
        show(notes);
      } catch (e) {
        list.prepend(el('p', { className: 'note warn', textContent: (e as Error).message }));
      }
    });
    side.append(
      el('p', {
        className: 'note',
        textContent: `Pause on the frame, write what should change, pin it. Notes are saved with the frame to docs/titans/${id}/NOTES.md.`,
      }),
      text,
      el('div', { className: 'row' }, pin, copy),
      list,
    );
    try {
      show(await o.api<Note[]>(`notes?id=${id}`));
    } catch (e) {
      list.append(
        el('p', { className: 'note warn', textContent: `notes need npm run dev: ${(e as Error).message}` }),
      );
    }
  };
  const put = (b: unknown): RequestInit => ({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

  /* ---------------------------------------------------------------------------------------------- the sim */

  const resim = (): void => {
    clearTimeout(simTimer);
    readout.textContent = 'simulating…';
    simTimer = window.setTimeout(() => void simulate(), 120);
  };

  const simulate = async (): Promise<void> => {
    const d = o.def();
    const errs = validateTitanDef(d);
    problems.textContent = errs.length ? `not playable: ${errs.slice(0, 3).join(' · ')}` : '';
    if (errs.length) return;
    const m = current();
    const cfg: MatchConfig = {
      seed: 7,
      stage: 'nursery',
      mode: 'versus',
      slots: [
        { titan: d.id as TitanId, controller: 'human' },
        { titan: foe, controller: 'human' },
      ],
    };
    let match: Match;
    try {
      match = createMatch(cfg, {
        createWorld: (s) => createMatterWorld(s),
        createFighter,
        getTitanDef: (id) => (id === d.id ? d : getTitanDef(id)),
        arena: DEFAULT_ARENA,
        lighting: DEFAULT_LIGHTING,
      });
    } catch (e) {
      problems.textContent = `not playable: ${(e as Error).message}`;
      return;
    }
    let guard = 0;
    while (match.phase === 'intro' && guard++ < 1000) match.step();
    const f = match.fighters[0] as FighterImpl;
    const g = match.fighters[1] as FighterImpl;
    g.px = f.px + gap;
    g.py = f.py;
    f.meter = 1;
    f.resource = f.resourceMax;
    const fr = m ? { ...m.frame, ...(m.variants[aim]?.frame ?? {}) } : null;
    const len = fr ? fr.startup + (fr.chargeMax ? hold : 0) + fr.active + fr.recovery : 0;
    const parts: string[] = [];
    if (m) {
      if (aim !== 'forward') parts.push(`${T0 - 3}:${aim}*${len + 6}`);
      const btn = SCRIPT_BTN[m.slot] ?? 'strike';
      const held = m.slot === 'guard' || fr?.chargeMax ? `*${hold}` : '';
      parts.push(`${T0}:${btn}${held}`);
    }
    const t1 = match.tick + 1;
    match.setSources(
      createScriptSource(parseScript(parts.join(',')), t1),
      createScriptSource(parseScript(foeAt > 0 ? `${foeAt}:strike` : ''), t1),
    );
    const N = Math.min(300, Math.max(120, T0 + len + 50, foeAt + 60));
    const camX = Math.round(f.px + LEAD - CW / 2);
    const camY = Math.round(f.py - CH / 2 - 10);
    const vr: ViewRect = { x0: camX, y0: camY, w: CW, h: CH };
    const buf = makeFrame(CW, CH);
    const next: ImageBitmap[] = [];
    const nextInfo: TickInfo[] = [];
    const tmp: DebugShape[] = [];
    for (let k = 0; k < N; k++) {
      match.step();
      buf.fill(0xff1a0c08);
      paintBackdrop(buf, CW, CH);
      blitLayers(
        buf,
        [...f.renderLayers(vr, 1), ...g.renderLayers(vr, 1), ...match.world.renderLayers(vr, 1)],
        vr,
        1,
        CW,
        CH,
      );
      const rgba = new Uint8ClampedArray(CW * CH * 4);
      rgba.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      next.push(await createImageBitmap(new ImageData(rgba, CW, CH)));
      tmp.length = 0;
      f.debugShapes(tmp);
      g.debugShapes(tmp);
      const mv = f.mv;
      const phase = mv.def
        ? mv.phase
        : f.state === 'guard'
          ? 'guard'
          : f.state === 'hitstun'
            ? 'hitstun'
            : 'idle';
      const of = mv.def
        ? mv.phase === 'startup'
          ? mv.startup
          : mv.phase === 'active'
            ? mv.active
            : mv.phase === 'recovery'
              ? mv.recovery
              : mv.chargeMax
        : 0;
      let dealt = false;
      let taken = false;
      for (const e of match.events)
        if (e.t === 'hit') {
          if (e.attacker === 0) dealt = true;
          else taken = true;
        }
      nextInfo.push({
        phase,
        label: mv.def ? `${mv.phase} ${mv.phaseTick}/${of}` : phase,
        shapes: tmp.map((s) => ({ ...s, shape: { ...s.shape } as DebugShape['shape'] })),
        dealt,
        taken,
      });
      if (k === 0) offset = { x: vr.x0, y: vr.y0 };
    }
    for (const b of frames) b.close();
    frames = next;
    info = nextInfo;
    tick = Math.min(tick, frames.length - 1);
    // a titan with a hand-written idle draws its own and ignores kit.motion: say so where the presets are edited
    const own = Object.getPrototypeOf((f as unknown as { behaviour: object }).behaviour) as {
      renderLayers: unknown;
    };
    handwritten = own.renderLayers !== KitBehaviour.prototype.renderLayers;
    if (handwritten && presetsShown && tab === 'motion' && !problems.textContent)
      problems.textContent = `${d.name} has a hand-written idle: its presets do not show.`;
    drawLine();
    draw();
  };
  let offset = { x: 0, y: 0 };
  let handwritten = false;

  /* ---------------------------------------------------------------------------------------------- drawing */

  const draw = (): void => {
    const b = frames[tick];
    vctx.imageSmoothingEnabled = false;
    vctx.fillStyle = '#07070d';
    vctx.fillRect(0, 0, view.width, view.height);
    if (b) vctx.drawImage(b, 0, 0, view.width, view.height);
    const inf = info[tick];
    const s = view.width / CW;
    if (inf && showHit) {
      vctx.lineWidth = 1.5;
      for (const d of inf.shapes) {
        vctx.strokeStyle = `#${(d.color & 0xffffff).toString(16).padStart(6, '0')}`;
        const sh = d.shape as unknown as Record<string, number> & { kind: string };
        const X = (x: number): number => (x - offset.x) * s;
        const Y = (y: number): number => (y - offset.y) * s;
        vctx.beginPath();
        if (sh.kind === 'point' || sh.kind === 'field')
          vctx.arc(X(sh['x']!), Y(sh['y']!), sh['r']! * s, 0, 6.283);
        else if (sh.kind === 'line') {
          vctx.lineWidth = Math.max(1.5, (sh['width'] ?? 1) * s);
          vctx.globalAlpha = 0.45;
          vctx.moveTo(X(sh['x0']!), Y(sh['y0']!));
          vctx.lineTo(X(sh['x1']!), Y(sh['y1']!));
        } else if (sh.kind === 'cone') {
          const a = Math.atan2(sh['dirY']!, sh['dirX']!);
          vctx.moveTo(X(sh['x']!), Y(sh['y']!));
          vctx.arc(X(sh['x']!), Y(sh['y']!), sh['range']! * s, a - sh['halfAngle']!, a + sh['halfAngle']!);
          vctx.closePath();
        } else if (sh.kind === 'ring') {
          vctx.arc(X(sh['x']!), Y(sh['y']!), sh['r1']! * s, 0, 6.283);
          vctx.moveTo(X(sh['x']!) + sh['r0']! * s, Y(sh['y']!));
          vctx.arc(X(sh['x']!), Y(sh['y']!), sh['r0']! * s, 0, 6.283);
        }
        vctx.stroke();
        vctx.globalAlpha = 1;
        vctx.lineWidth = 1.5;
      }
    }
    readout.textContent = frames.length
      ? `tick ${tick} / ${frames.length - 1} · ${inf?.label ?? ''}${inf?.dealt ? ' · HIT' : ''}`
      : '';
    // the cursor on the timeline
    drawLine();
  };

  const drawLine = (): void => {
    const n = Math.max(1, info.length);
    const w = line.width / n;
    lctx.fillStyle = '#07070d';
    lctx.fillRect(0, 0, line.width, line.height);
    info.forEach((inf, k) => {
      lctx.fillStyle = PHASE_COL[inf.phase] ?? PHASE_COL['idle']!;
      lctx.fillRect(k * w, 8, Math.ceil(w), 18);
      if (inf.dealt) {
        lctx.fillStyle = '#ffffff';
        lctx.fillRect(k * w, 0, Math.max(1, w), 7);
      }
      if (inf.taken) {
        lctx.fillStyle = '#ff6a5a';
        lctx.fillRect(k * w, 27, Math.max(1, w), 7);
      }
    });
    lctx.fillStyle = '#e8dc96';
    lctx.fillRect(tick * w, 0, Math.max(2, w), line.height);
  };

  const seek = (k: number): void => {
    tick = Math.max(0, Math.min(frames.length - 1, k));
    draw();
  };
  const toggle = (): void => {
    playing = !playing;
    playBtn.textContent = playing ? '❚❚' : '▶';
  };
  const scrub = (e: PointerEvent): void => {
    const r = line.getBoundingClientRect();
    playing = false;
    playBtn.textContent = '▶';
    seek(Math.floor(((e.clientX - r.left) / r.width) * info.length));
  };
  line.addEventListener('pointerdown', (e) => {
    line.setPointerCapture(e.pointerId);
    scrub(e);
  });
  line.addEventListener('pointermove', (e) => {
    if (e.buttons) scrub(e);
  });
  const key = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      playing = false;
      playBtn.textContent = '▶';
      seek(tick + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  };
  dlg.addEventListener('keydown', key);

  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && frames.length) {
      acc += dt * 60 * speed;
      while (acc >= 1) {
        acc -= 1;
        tick = tick + 1 >= frames.length ? 0 : tick + 1;
      }
      draw();
    }
    raf = requestAnimationFrame(loop);
  };

  /* ---------------------------------------------------------------------------------------------- open */

  dlg.append(
    el(
      'div',
      { className: 'importGrid' },
      el('div', { className: 'studioMain' }, top, problems, view, line, transport),
      el('div', { className: 'studioCol' }, tabs, side),
    ),
  );
  dlg.addEventListener('close', () => {
    cancelAnimationFrame(raf);
    clearTimeout(simTimer);
    dlg.removeEventListener('keydown', key);
    for (const b of frames) b.close();
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();
  buildSide();
  resim();
  raf = requestAnimationFrame(loop);
}
