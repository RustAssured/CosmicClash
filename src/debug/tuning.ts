/**
 * The debug tuning / diagnostics registry (MASTER_PROMPT Phase 1; URI_SPEC §9; the prototypes' tuning panels).
 *
 * Any titan or system registers live knobs (`registerTuning`) and a diagnostics drawer (`registerDiagnostics`). The in-game
 * overlay (src/ui/debugOverlay.ts, toggled with ` on the keyboard or R3 on a pad) lists every knob as a slider and draws every
 * diagnostics layer in screen space over the fight.
 *
 * Determinism. Pure TypeScript, no DOM, no clock, no RNG. Registering a knob never changes anything: a knob's `set` runs only
 * through `adjust` / `reset`, which only the overlay calls, on a player's key press. Replays, tests and headless tools never
 * open the overlay, so they never tune. Every applied change bumps `edits` and is logged (`changes`), so a run that was tuned
 * can say so (a tuned match's hash is not a reference hash).
 */

export interface TuningKnob {
  /** Stable id within its owner (e.g. 'power'). */
  key: string;
  /** Short label for the panel (≤ 18 characters reads best). */
  label: string;
  min: number;
  max: number;
  /** One press of − / + moves this much (Shift: ×10). */
  step: number;
  get(): number;
  set(v: number): void;
}

/** Screen-space drawing for diagnostics (640×360 logical px, packed RGBA colours). World → screen via `sx` / `sy`. */
export interface DiagCtx {
  /** World x / y → screen px under the current camera view. */
  sx(worldX: number): number;
  sy(worldY: number): number;
  line(x0: number, y0: number, x1: number, y1: number, color: number): void;
  /** An arrow from (x, y) along (dx, dy) (screen px). */
  arrow(x: number, y: number, dx: number, dy: number, color: number): void;
  /** Outline rectangle. */
  box(x: number, y: number, w: number, h: number, color: number): void;
  /** Horizontal bar: `frac` (0..1) of `w` filled, the rest dark. */
  bar(x: number, y: number, w: number, h: number, frac: number, color: number): void;
  circle(cx: number, cy: number, r: number, color: number): void;
  /** Small caps text (3×5 micro face), top-left at (x, y). */
  text(x: number, y: number, s: string, color: number): void;
}

export type DiagnosticsFn = (d: DiagCtx) => void;

export interface TuningChange {
  owner: string;
  key: string;
  value: number;
}

interface KnobEntry {
  owner: string;
  knob: TuningKnob;
  /** The value when it was registered (reset target). */
  initial: number;
}

const snap = (v: number, k: TuningKnob): number => {
  const c = Math.min(k.max, Math.max(k.min, v));
  // keep the value on the step grid from min (no float drift after many presses)
  const n = Math.round((c - k.min) / k.step);
  return Math.min(k.max, +(k.min + n * k.step).toFixed(6));
};

export class TuningRegistry {
  private readonly knobs: KnobEntry[] = [];
  private readonly diags = new Map<string, DiagnosticsFn>();
  /** Applied changes, oldest first (capped). */
  readonly changes: TuningChange[] = [];
  /** Number of changes applied since start (0 = this run was never tuned). */
  edits = 0;

  /** Register (or replace) an owner's knobs. Returns an unregister function. */
  register(owner: string, knobs: readonly TuningKnob[]): () => void {
    this.unregister(owner);
    for (const knob of knobs) this.knobs.push({ owner, knob, initial: knob.get() });
    return () => this.unregister(owner);
  }

  /** Register (or replace) an owner's diagnostics drawer. Returns an unregister function. */
  registerDiagnostics(owner: string, draw: DiagnosticsFn): () => void {
    this.diags.set(owner, draw);
    return () => {
      if (this.diags.get(owner) === draw) this.diags.delete(owner);
    };
  }

  /** Drop an owner's knobs and diagnostics. */
  unregister(owner: string): void {
    for (let i = this.knobs.length - 1; i >= 0; i--)
      if (this.knobs[i]!.owner === owner) this.knobs.splice(i, 1);
    this.diags.delete(owner);
  }

  /** Drop every owner whose id starts with `prefix` (a match's knobs at its end). */
  unregisterPrefix(prefix: string): void {
    for (let i = this.knobs.length - 1; i >= 0; i--)
      if (this.knobs[i]!.owner.startsWith(prefix)) this.knobs.splice(i, 1);
    for (const k of [...this.diags.keys()]) if (k.startsWith(prefix)) this.diags.delete(k);
  }

  /** Every knob in registration order (owners grouped as registered). */
  list(): readonly { owner: string; knob: TuningKnob; initial: number }[] {
    return this.knobs;
  }

  diagnostics(): IterableIterator<[string, DiagnosticsFn]> {
    return this.diags.entries();
  }

  /** Move knob `index` by `steps` steps (player action only). Returns the new value. */
  adjust(index: number, steps: number): number {
    const e = this.knobs[index];
    if (!e) return NaN;
    return this.apply(e, e.knob.get() + steps * e.knob.step);
  }

  /** Put knob `index` back to its registered value (player action only). */
  reset(index: number): number {
    const e = this.knobs[index];
    if (!e) return NaN;
    return this.apply(e, e.initial);
  }

  private apply(e: KnobEntry, raw: number): number {
    const v = snap(raw, e.knob);
    if (v === e.knob.get()) return v;
    e.knob.set(v);
    this.edits++;
    this.changes.push({ owner: e.owner, key: e.knob.key, value: v });
    if (this.changes.length > 200) this.changes.shift();
    return v;
  }
}

/** The process-wide registry the overlay reads. */
export const tuning = new TuningRegistry();
export const registerTuning = (owner: string, knobs: readonly TuningKnob[]): (() => void) =>
  tuning.register(owner, knobs);
export const registerDiagnostics = (owner: string, draw: DiagnosticsFn): (() => void) =>
  tuning.registerDiagnostics(owner, draw);
