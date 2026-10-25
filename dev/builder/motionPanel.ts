import type { MotionPreset, TitanDef } from '@/contracts';
import {
  MOTION_KNOBS,
  MOTION_TRIGGERS,
  MOTION_TYPES,
  motionKnob,
  motionProblems,
  type MotionType,
} from '@/combat/behaviours/kit/motion';

/**
 * The ANIMATION PRESETS editor (kit.motion; the runtime is src/combat/behaviours/kit/motion.ts): add a preset, bind it to a
 * material, pick when it runs and tune its knobs with sliders. Shared by the builder's MOTION panel and the motion studio,
 * which plays the result in the real sim. `edited` runs after every change (the caller marks the titan unsaved and redraws).
 */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const BLURB: Record<MotionType, string> = {
  swirl: 'turns like a vortex and drains to its centre',
  pulse: 'brightens and glows on a beat',
  shimmer: 'scattered cells flare and fade',
  stretch: 'pulled out toward the aim during a move, like rubber',
  iris: 'petals close over it (Guard by default)',
};

const DEFAULT_ON: Record<MotionType, string> = {
  swirl: 'always',
  pulse: 'always',
  shimmer: 'always',
  stretch: 'strike',
  iris: 'guard',
};

/** A titan with a hand-written idle ignores its presets: say so instead of letting sliders do nothing. */
export const HANDWRITTEN_IDLE: readonly string[] = ['remainder', 'cradle'];

export function motionEditor(parent: HTMLElement, def: TitanDef, edited: () => void): void {
  const keys = def.materials.map((m) => m.key);
  const list = (): MotionPreset[] => (def.kit!.motion ??= []);
  const redraw = (): void => {
    parent.replaceChildren();
    fill();
  };
  const change = (): void => {
    if (def.kit!.motion && def.kit!.motion.length === 0) delete def.kit!.motion;
    edited();
  };

  const fill = (): void => {
    if (HANDWRITTEN_IDLE.includes(def.id))
      parent.append(
        el('p', {
          className: 'note warn',
          textContent: `${def.name} draws its own hand-written idle, so presets added here do not show in the game. They are for titans without one.`,
        }),
      );
    parent.append(
      el('p', {
        className: 'note',
        textContent:
          'Pieces of a living idle and of move animation, each bound to one material. They stack in this order. Play them in the studio (▶ Studio).',
      }),
    );
    const presets = def.kit?.motion ?? [];
    presets.forEach((p, i) => parent.append(card(p, i)));
    const problems = motionProblems(def);
    if (problems.length)
      parent.append(el('p', { className: 'note warn', textContent: problems.join(' · ') }));
    // add
    const type = el(
      'select',
      {},
      ...MOTION_TYPES.map((t) => el('option', { value: t, textContent: `${t}: ${BLURB[t]}` })),
    );
    const add = el('button', { type: 'button', textContent: '+ Add preset' });
    add.addEventListener('click', () => {
      const t = type.value as MotionType;
      const p: MotionPreset = { type: t, material: guessMaterial(def, t) };
      for (const k of MOTION_KNOBS[t]) p[k.key] = k.def;
      list().push(p);
      change();
      redraw();
    });
    parent.append(el('div', { className: 'row' }, type, add));
  };

  const card = (p: MotionPreset, i: number): HTMLElement => {
    const t = p.type as MotionType;
    const box = el('div', { className: 'preset' });
    const head = el('div', { className: 'row' }, el('b', { textContent: `${i + 1}. ${p.type}` }));
    const btn = (label: string, title: string, fn: () => void): void => {
      const b = el('button', { type: 'button', textContent: label, title });
      b.addEventListener('click', () => {
        fn();
        change();
        redraw();
      });
      head.append(b);
    };
    if (i > 0)
      btn('↑', 'run earlier', () => {
        const a = list();
        [a[i - 1], a[i]] = [a[i]!, a[i - 1]!];
      });
    btn('✕', 'remove', () => list().splice(i, 1));
    box.append(head);
    if (BLURB[t]) box.append(el('p', { className: 'note', textContent: BLURB[t] }));
    const select = (
      label: string,
      options: readonly string[],
      get: () => string,
      set: (v: string) => void,
    ): void => {
      const s = el('select', {}, ...options.map((o) => el('option', { value: o, textContent: o })));
      s.value = get();
      s.addEventListener('change', () => {
        set(s.value);
        change();
      });
      box.append(el('div', { className: 'field wide' }, el('label', { textContent: label }), s));
    };
    select(
      'material',
      keys,
      () => p.material,
      (v) => (p.material = v),
    );
    select(
      'runs',
      MOTION_TRIGGERS,
      () => p.on ?? DEFAULT_ON[t] ?? 'always',
      (v) => {
        if (v === DEFAULT_ON[t]) delete p.on;
        else p.on = v;
      },
    );
    if (t === 'iris')
      select(
        'petal colour',
        keys,
        () => (typeof p.cover === 'string' ? p.cover : (keys.find((k) => k === 'bone') ?? keys[0]!)),
        (v) => (p.cover = v),
      );
    for (const k of MOTION_KNOBS[t] ?? []) {
      const input = el('input', {
        type: 'range',
        min: String(k.min),
        max: String(k.max),
        step: String(k.step),
        value: String(motionKnob(p, k.key)),
      });
      const out = el('output', { textContent: String(motionKnob(p, k.key)) });
      input.addEventListener('input', () => {
        p[k.key] = +input.value;
        out.textContent = input.value;
        change();
      });
      box.append(
        el('div', { className: 'field' }, el('label', { textContent: k.label, title: k.hint }), input, out),
      );
    }
    return box;
  };

  fill();
}

/** A sensible first material for a new preset: one that sounds like what it does, else the largest-sounding layer. */
function guessMaterial(def: TitanDef, t: MotionType): string {
  const keys = def.materials.map((m) => m.key);
  const want: Record<MotionType, string[]> = {
    swirl: ['vortex', 'galaxy', 'storm', 'swirl', 'nebula', 'core'],
    pulse: ['core', 'eye', 'heart', 'vein', 'glow'],
    shimmer: ['star', 'spark', 'ember', 'crystal', 'glow'],
    stretch: ['vortex', 'galaxy', 'flesh', 'tissue', 'membrane'],
    iris: ['vortex', 'eye', 'core', 'galaxy'],
  };
  return want[t].find((k) => keys.includes(k)) ?? keys[0] ?? '';
}
