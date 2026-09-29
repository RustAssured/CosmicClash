import {
  LOGICAL_H,
  LOGICAL_W,
  makeLayer,
  type GameUI,
  type HudState,
  type MatchConfig,
  type RenderLayer,
  type StageId,
  type TitanId,
  type UIAction,
  type UIScreenId,
  type UiSoundId,
} from '@/contracts';
import type { DeviceInfo, InputManager, NavFrame } from '@/input';
import { AdvantageTracker } from './advantage';
import { BAYER4, PixelCanvas } from './pixel/canvas';
import { createAssignScreen } from './screens/assign';
import { createAttractScreen } from './screens/attract';
import { createBootScreen } from './screens/boot';
import { createControllerScreen } from './screens/controller';
import { createHudScreen } from './screens/hudscreen';
import { type MatchSetup, type Screen, type TrainingState, type UICtx } from './screens/kit';
import { createModeScreen } from './screens/mode';
import { createOptionsScreen } from './screens/options';
import { createPauseScreen } from './screens/pause';
import { createResultsScreen } from './screens/results';
import { createSelectScreen } from './screens/select';
import { createStageScreen } from './screens/stage';
import { createTitleScreen } from './screens/title';
import { loadUISettings, resolveStore, saveUISettings, type UISettings } from './settings';
import type { TitanInfo, UIDeps } from './types';

const FADE_SEC = 0.22;

/**
 * The pixel UI. One instance draws every screen into ONE screen-space layer (640×360, transparent where the scenery should
 * show through). It is a small stack machine: forward steps `push`, Back `pop`s, and the app drives the top-level state with
 * `showHud / showPause / showResults / showTitle`.
 */
export function createUI(deps: UIDeps): GameUI {
  return new UIRuntime(deps);
}

class UIRuntime implements GameUI, UICtx {
  readonly layer: RenderLayer = makeLayer('ui', 'screen', 100, LOGICAL_W, LOGICAL_H);
  readonly cv = new PixelCanvas(LOGICAL_W, LOGICAL_H, this.layer.pixels);
  readonly deps: UIDeps;
  readonly input: InputManager;
  readonly advantage = new AdvantageTracker();
  settings: UISettings;
  setup: MatchSetup;
  readonly training: TrainingState = { view: 'off', dummy: 'idle' };
  hud: HudState | null = null;
  t = 0;
  dt = 0;
  screenTime = 0;
  private stack: UIScreenId[] = ['boot'];
  private readonly screens: Partial<Record<UIScreenId, Screen>> = {};
  private readonly actions: UIAction[] = [];
  private idle = 0;
  private fade = 1;
  private readonly store;
  private readonly titanMap = new Map<TitanId, TitanInfo>();
  private readonly readyTitans: Set<string>;
  private readonly readyStages: Set<string>;
  private navAny!: Readonly<NavFrame>;
  private attractAfter: number;

  constructor(deps: UIDeps) {
    this.deps = deps;
    this.input = deps.input;
    this.store = resolveStore(deps.storage);
    this.settings = loadUISettings(this.store);
    for (const t of deps.titans) this.titanMap.set(t.id, t);
    this.readyTitans = new Set(deps.implementedTitans);
    this.readyStages = new Set(deps.implementedStages);
    this.attractAfter = deps.attractAfterSec ?? 60;
    const firstReady = (deps.implementedTitans[0] ?? deps.titans[0]?.id ?? 'lastone') as TitanId;
    const pick = (id: TitanId): TitanId => (this.readyTitans.has(id) ? id : firstReady);
    this.setup = {
      mode: 'versus',
      aiLevel: this.settings.aiLevel,
      p1: pick(this.settings.lastP1),
      p2: pick(this.settings.lastP2),
      stage: (this.readyStages.has(this.settings.lastStage)
        ? this.settings.lastStage
        : (deps.implementedStages[0] ?? 'nursery')) as StageId,
    };
    this.layer.z = 100;
    this.enterTop(undefined);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  GameUI
   * ------------------------------------------------------------------------------------------------ */
  get screen(): UIScreenId {
    return this.stack[this.stack.length - 1]!;
  }

  get idleSeconds(): number {
    return this.screen === 'title' ? this.idle : 0;
  }

  get nav(): Readonly<NavFrame> {
    return this.navAny;
  }

  navFor(slot: 0 | 1): Readonly<NavFrame> {
    return this.input.nav(slot);
  }

  update(dtSec: number): void {
    this.dt = dtSec;
    this.t += dtSec;
    this.screenTime += dtSec;
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dtSec / FADE_SEC);
    this.input.pollIfStale();
    this.navAny = this.input.nav('any');
    const n = this.navAny;
    const active = n.any || n.up || n.down || n.left || n.right || n.confirm || n.back || n.start;
    if (this.screen === 'title') {
      if (active) this.idle = 0;
      else this.idle += dtSec;
      if (this.idle >= this.attractAfter) {
        this.idle = 0;
        this.emit({ type: 'attractStart' });
        this.go('attract');
        return;
      }
    }
    this.currentScreen().update(this);
  }

  draw(hud: HudState | null): void {
    if (hud) {
      this.hud = hud;
      this.advantage.update(hud.match.fighters.map((f) => f.view) as never, hud.match.tick);
    }
    const cv = this.cv;
    cv.clear(0);
    this.currentScreen().draw(this, hud ?? this.hud);
    if (this.fade < 1) ditherFade(cv, this.fade);
    this.layer.version++;
    this.layer.dirty = null;
  }

  drainActions(out: UIAction[]): void {
    for (const a of this.actions) out.push(a);
    this.actions.length = 0;
  }

  showHud(): void {
    this.stack = ['hud'];
    this.enterTop(undefined);
  }

  showResults(winner: 0 | 1 | -1): void {
    this.stack = ['results'];
    this.enterTop(winner);
  }

  showPause(open: boolean): void {
    if (open) {
      if (this.screen !== 'pause') {
        this.sound('pause');
        this.push('pause');
      }
    } else if (this.screen === 'pause' || this.stack.includes('pause')) {
      this.sound('unpause');
      while (this.stack.length > 1 && this.screen !== 'hud') this.stack.pop();
      if (this.stack.length === 0) this.stack.push('hud');
      this.fade = 1;
      this.screenTime = 0;
      this.resetScreen();
    }
  }

  /** @internal see `showScreen` */
  stackReset(id: UIScreenId, params?: unknown): void {
    this.stack = [id];
    this.idle = 0;
    this.enterTop(params);
  }

  showTitle(): void {
    this.stack = ['title'];
    this.idle = 0;
    this.advantage.reset();
    this.enterTop(undefined);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  UICtx
   * ------------------------------------------------------------------------------------------------ */
  emit(a: UIAction): void {
    this.actions.push(a);
  }

  sound(id: UiSoundId): void {
    this.deps.sound?.(id);
  }

  go(id: UIScreenId, params?: unknown): void {
    this.stack[this.stack.length - 1] = id;
    this.enterTop(params);
  }

  push(id: UIScreenId, params?: unknown): void {
    this.stack.push(id);
    this.enterTop(params);
  }

  pop(): void {
    if (this.stack.length > 1) this.stack.pop();
    this.enterTop(undefined, true);
  }

  resetIdle(): void {
    this.idle = 0;
  }

  saveSettings(): void {
    saveUISettings(this.store, this.settings);
  }

  titan(id: TitanId): TitanInfo {
    return this.titanMap.get(id) ?? this.deps.titans[0]!;
  }

  isTitanReady(id: TitanId): boolean {
    return this.readyTitans.has(id);
  }

  isStageReady(id: StageId): boolean {
    return this.readyStages.has(id);
  }

  promptDevice(): DeviceInfo | null {
    return (
      this.input.lastActiveDevice() ??
      this.input.devices().find((d) => d.kind !== 'keyboard') ??
      this.input.devices()[0] ??
      null
    );
  }

  startMatch(): void {
    const s = this.setup;
    this.settings.lastP1 = s.p1;
    this.settings.lastP2 = s.p2;
    this.settings.lastStage = s.stage;
    this.settings.aiLevel = s.aiLevel;
    this.saveSettings();
    const seed = this.deps.newSeed?.() ?? ((this.deps.now?.() ?? Date.now()) * 1000) & 0x7fffffff;
    const config: MatchConfig = {
      seed: seed || 1,
      stage: s.stage,
      mode: s.mode,
      slots: [
        { titan: s.p1, controller: 'human' },
        s.mode === 'versus'
          ? { titan: s.p2, controller: 'human' }
          : s.mode === 'vsai'
            ? { titan: s.p2, controller: 'ai', aiLevel: s.aiLevel }
            : { titan: s.p2, controller: 'dummy' },
      ],
      infinite: s.mode === 'training',
    };
    this.sound('start');
    this.emit({ type: 'startMatch', config });
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  internals
   * ------------------------------------------------------------------------------------------------ */
  private currentScreen(): Screen {
    const id = this.screen;
    let s = this.screens[id];
    if (!s) {
      s = this.build(id);
      this.screens[id] = s;
    }
    return s;
  }

  private build(id: UIScreenId): Screen {
    switch (id) {
      case 'boot':
        return createBootScreen();
      case 'title':
        return createTitleScreen();
      case 'attract':
        return createAttractScreen();
      case 'mode':
        return createModeScreen();
      case 'assign':
        return createAssignScreen();
      case 'select':
        return createSelectScreen();
      case 'stage':
        return createStageScreen();
      case 'controller':
        return createControllerScreen();
      case 'options':
        return createOptionsScreen();
      case 'pause':
        return createPauseScreen();
      case 'results':
        return createResultsScreen();
      case 'hud':
        return createHudScreen();
    }
  }

  private enterTop(params: unknown, returning = false): void {
    this.screenTime = 0;
    this.fade = returning ? 0.4 : 0;
    this.resetScreen(params);
  }

  private resetScreen(params?: unknown): void {
    this.currentScreen().enter?.(this, params);
    if (this.screen === 'hud') this.advantage.reset();
  }
}

/** Ordered-dither reveal: keeps `level` (0..1) of the pixels, in a fixed 4×4 Bayer order. */
export function ditherFade(cv: PixelCanvas, level: number): void {
  const keep = Math.round(level * 16);
  if (keep >= 16) return;
  const px = cv.pixels;
  const w = cv.w;
  for (let y = 0; y < cv.h; y++) {
    const row = y * w;
    const by = (y & 3) * 4;
    for (let x = 0; x < w; x++) {
      if (BAYER4[by + (x & 3)]! >= keep) px[row + x] = 0;
    }
  }
}

/**
 * Jump straight to a screen. For the debug harness (`?mode=controller|select|title|menu`), the screenshot tool and tests —
 * the shipped flow reaches screens only through the menus and the `show*` calls. `params` are the screen's enter params.
 */
export function showScreen(ui: GameUI, id: UIScreenId, params?: unknown): void {
  (ui as UIRuntime).stackReset(id, params);
}
