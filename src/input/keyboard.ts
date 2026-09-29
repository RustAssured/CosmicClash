import type { Action, KeyRef } from './types';
import { ACTION_BIT } from './bindings';
import { ACTIONS } from './types';

/**
 * Keyboard layouts for local 2P on ONE keyboard. `event.code` (physical position) is used everywhere, so AZERTY /
 * QWERTZ / Dvorak players get the same *shape* under their fingers.
 *
 * Design: left hand moves, right hand acts. The right-hand action keys copy the Nintendo diamond (Y left · X top ·
 * B bottom · A right) so the muscle memory matches the pad:
 *
 *   P1  move W A S D    ·  J Strike · I Crush · K Surge · L Signature · O Ultimate · Shift/Space Guard · Q/E Feint · Esc pause · Tab training
 *   P2  move ← ↑ ↓ →    ·  Numpad 4 Strike · 8 Crush · 2 Surge · 6 Signature · 9 Ultimate · 0 Guard · 7/1 Feint · Enter pause · − training
 *
 * Ghosting: most keyboards can register at least any three simultaneous letter keys; the sets above keep the busiest
 * combination (a direction + two actions + Guard on a modifier) inside that, and modifiers/numpad sit on separate
 * matrix lines on common boards. P2 needs a numpad.
 */
export interface KeyLayout {
  id: 'kb1' | 'kb2';
  name: string;
  shortName: string;
  profileKey: string;
  move: { up: KeyRef[]; down: KeyRef[]; left: KeyRef[]; right: KeyRef[] };
  actions: Record<Action, KeyRef[]>;
  /** Menu navigation keys for this layout (on top of `move`). */
  nav: { confirm: KeyRef[]; back: KeyRef[]; start: KeyRef[]; tab: KeyRef[] };
}

export const KEY_LAYOUT_P1: KeyLayout = {
  id: 'kb1',
  name: 'Keyboard 1 · WASD',
  shortName: 'WASD',
  profileKey: 'kb:kb1',
  move: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'] },
  actions: {
    strike: ['KeyJ'],
    crush: ['KeyI'],
    surge: ['KeyK'],
    signature: ['KeyL'],
    ultimate: ['KeyO'],
    guard: ['ShiftLeft', 'Space'],
    feint: ['KeyQ', 'KeyE'],
    pause: ['Escape'],
    training: ['Tab'],
  },
  nav: {
    confirm: ['Space', 'KeyJ', 'KeyL'],
    back: ['KeyK', 'Escape', 'Backspace'],
    start: ['Escape'],
    tab: ['Tab', 'KeyQ', 'KeyE'],
  },
};

export const KEY_LAYOUT_P2: KeyLayout = {
  id: 'kb2',
  name: 'Keyboard 2 · Arrows',
  shortName: 'ARROWS',
  profileKey: 'kb:kb2',
  move: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'] },
  actions: {
    strike: ['Numpad4'],
    crush: ['Numpad8'],
    surge: ['Numpad2', 'Numpad5'],
    signature: ['Numpad6'],
    ultimate: ['Numpad9'],
    guard: ['Numpad0'],
    feint: ['Numpad7', 'Numpad1'],
    pause: ['Enter', 'NumpadEnter'],
    training: ['NumpadSubtract'],
  },
  nav: {
    confirm: ['Enter', 'NumpadEnter', 'Numpad6', 'Numpad4'],
    back: ['Backspace', 'Numpad0', 'Numpad2'],
    start: ['Enter', 'NumpadEnter'],
    tab: ['NumpadSubtract', 'Numpad7', 'Numpad1'],
  },
};

export const KEY_LAYOUTS: readonly KeyLayout[] = [KEY_LAYOUT_P1, KEY_LAYOUT_P2];

/** Codes the page must not scroll/zoom/tab on while the game has focus. */
export function isGameKey(code: string): boolean {
  return GAME_KEYS.has(code);
}
const GAME_KEYS = new Set<string>();
for (const l of KEY_LAYOUTS) {
  for (const list of [
    ...Object.values(l.move),
    ...Object.values(l.actions),
    l.nav.confirm,
    l.nav.back,
    l.nav.start,
    l.nav.tab,
  ])
    for (const c of list) GAME_KEYS.add(c);
}

/** Display text for a physical key code: 'KeyJ' → 'J', 'ArrowUp' → '↑', 'Numpad4' → 'N4'. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const r = code.slice(6);
    if (r === 'Enter') return 'N-ENT';
    if (r === 'Subtract') return 'N−';
    if (r === 'Add') return 'N+';
    return 'N' + r;
  }
  switch (code) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'SHIFT';
    case 'ControlLeft':
    case 'ControlRight':
      return 'CTRL';
    case 'Space':
      return 'SPACE';
    case 'Escape':
      return 'ESC';
    case 'Enter':
      return 'ENTER';
    case 'Backspace':
      return 'BKSP';
    case 'Tab':
      return 'TAB';
    case 'Semicolon':
      return ';';
    case 'Quote':
      return "'";
    case 'Comma':
      return ',';
    case 'Period':
      return '.';
    case 'Slash':
      return '/';
    default:
      return code.toUpperCase();
  }
}

export const DIR_BITS = { u: 1, d: 2, l: 4, r: 8 } as const;

/**
 * Keyboard state for one layout, fed by key events. Because key events are true events, a tap shorter than one sim tick is
 * *latched* (`latchHeld`, `latchDirs`) and reported on the next tick sample — nothing the player presses is lost.
 */
export class KeyboardState {
  readonly layout: KeyLayout;
  private down = new Set<string>();
  /** Override key lists (remaps), by action. */
  overrides: Partial<Record<Action, KeyRef[]>> = {};
  latchHeld = 0;
  latchDirs = 0;
  /** Fresh key presses since the last drain, for activation / capture. */
  fresh: string[] = [];

  constructor(layout: KeyLayout) {
    this.layout = layout;
  }

  keysFor(a: Action): readonly KeyRef[] {
    return this.overrides[a] ?? this.layout.actions[a];
  }

  /** Does this layout use `code` for anything (movement, an action, nav)? */
  owns(code: string): boolean {
    const l = this.layout;
    if (
      l.move.up.includes(code) ||
      l.move.down.includes(code) ||
      l.move.left.includes(code) ||
      l.move.right.includes(code)
    )
      return true;
    for (const a of ACTIONS) if (this.keysFor(a).includes(code)) return true;
    return (
      l.nav.confirm.includes(code) ||
      l.nav.back.includes(code) ||
      l.nav.start.includes(code) ||
      l.nav.tab.includes(code)
    );
  }

  keyDown(code: string): void {
    if (this.down.has(code)) return;
    this.down.add(code);
    this.fresh.push(code);
    this.latchHeld |= this.actionBitsOf(code);
    this.latchDirs |= this.dirBitsOf(code);
  }

  keyUp(code: string): void {
    this.down.delete(code);
  }

  releaseAll(): void {
    this.down.clear();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  private anyDown(list: readonly KeyRef[]): boolean {
    for (let i = 0; i < list.length; i++) if (this.down.has(list[i]!)) return true;
    return false;
  }

  private actionBitsOf(code: string): number {
    let m = 0;
    for (const a of ACTIONS) if (this.keysFor(a).includes(code)) m |= ACTION_BIT[a];
    return m;
  }

  private dirBitsOf(code: string): number {
    const mv = this.layout.move;
    let m = 0;
    if (mv.up.includes(code)) m |= DIR_BITS.u;
    if (mv.down.includes(code)) m |= DIR_BITS.d;
    if (mv.left.includes(code)) m |= DIR_BITS.l;
    if (mv.right.includes(code)) m |= DIR_BITS.r;
    return m;
  }

  /** Currently held action bits. */
  heldActions(): number {
    let m = 0;
    for (const a of ACTIONS) if (this.anyDown(this.keysFor(a))) m |= ACTION_BIT[a];
    return m;
  }

  /** Currently held direction bits (`DIR_BITS`). */
  heldDirs(): number {
    const mv = this.layout.move;
    let m = 0;
    if (this.anyDown(mv.up)) m |= DIR_BITS.u;
    if (this.anyDown(mv.down)) m |= DIR_BITS.d;
    if (this.anyDown(mv.left)) m |= DIR_BITS.l;
    if (this.anyDown(mv.right)) m |= DIR_BITS.r;
    return m;
  }

  /** Held menu-nav bits: 1 confirm, 2 back, 4 start, 8 tab. */
  heldNav(): number {
    const n = this.layout.nav;
    let m = 0;
    if (this.anyDown(n.confirm)) m |= 1;
    if (this.anyDown(n.back)) m |= 2;
    if (this.anyDown(n.start)) m |= 4;
    if (this.anyDown(n.tab)) m |= 8;
    return m;
  }

  consumeLatch(): void {
    this.latchHeld = 0;
    this.latchDirs = 0;
  }
}

/** Direction bits → stick vector; diagonals are normalised so they are no faster than cardinals. */
export function dirsToStick(dirs: number, out: { x: number; y: number }): void {
  let x = 0;
  let y = 0;
  if (dirs & DIR_BITS.l) x -= 1;
  if (dirs & DIR_BITS.r) x += 1;
  if (dirs & DIR_BITS.u) y -= 1;
  if (dirs & DIR_BITS.d) y += 1;
  if (x !== 0 && y !== 0) {
    x *= Math.SQRT1_2;
    y *= Math.SQRT1_2;
  }
  out.x = x;
  out.y = y;
}
