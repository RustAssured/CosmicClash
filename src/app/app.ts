import {
  LOGICAL_H,
  LOGICAL_W,
  ROUND_INTRO_TICKS,
  STAGE_IDS,
  TITAN_IDS,
  makeLayer,
  rgba,
  type AudioScene,
  type DebugOverlayMode,
  type DebugShape,
  type Difficulty,
  type HarnessParams,
  type HudState,
  type InputSource,
  type MatchConfig,
  type RenderFrame,
  type RenderLayer,
  type SimEvent,
  type SlotController,
  type StageId,
  type TitanDef,
  type TitanId,
  type UIAction,
} from '@/contracts';
import { createAudioEngine, type AudioEngineExt } from '@/audio';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createCamera, createLoop, type Loop } from '@/engine';
import { createInputManager } from '@/input';
import { createMatterWorld, warmUp } from '@/matter';
import { createRenderer, type DebuggableRenderer } from '@/render';
import { createAiSource, createMatch, createScriptSource, type Match } from '@/sim';
import { STAGES, isStageImplemented } from '@/stages';
import { IMPLEMENTED_TITANS, TITAN_DEFS, getTitanDef, renderPortrait } from '@/titans';
import { PixelCanvas, createUI, drawText, titanInfoFromDef, type TitanInfo } from '@/ui';
import { FIXTURE_TITANS, fixturePortraitProvider } from '@/ui/fixtures';
import { fillHudState } from './announcer';
import { createDebugLayer, drawDebugShapes } from './debugDraw';
import { FxState, buildAudioScene } from './fx';
import { createGuardDummy, tapSource, type TappedSource } from './tap';

/** Everything a running match needs besides the pure Match. */
interface Session {
  match: Match;
  config: MatchConfig;
  taps: (TappedSource | null)[];
  srcs: (InputSource | null)[];
  attract: boolean;
  /** Training dummy mode. */
  dummy: 'idle' | 'guard' | 'ai';
  aiLevel: Difficulty;
}

const MENU_STAGE: StageId = 'nursery';

interface MatchOpts {
  attract?: boolean;
  skipIntro?: boolean;
  scripts?: [HarnessParams['script0'], HarnessParams['script1']];
}
const DEBUG_MODES: DebugOverlayMode[] = [
  'temperature',
  'integrity',
  'bonds',
  'infection',
  'islands',
  'stress',
  'materials',
];
const sleep0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * The application shell: owns the device/audio/UI/render objects, the fixed-tick loop, and the menu ⇄ match state machine.
 * All game logic lives in the pure modules; this class only wires them and turns their outputs into frames and sound.
 */
export class App {
  readonly renderer: DebuggableRenderer = createRenderer();
  readonly input = createInputManager({});
  readonly audio: AudioEngineExt = createAudioEngine();
  readonly camera = createCamera();
  readonly fx = new FxState();
  loop!: Loop;
  ui!: ReturnType<typeof createUI>;
  session: Session | null = null;
  paused = false;
  ready = false;
  /** Harness: draw no UI/HUD layer at all (clean screenshots). */
  hideUi = false;

  private canvas!: HTMLCanvasElement;
  private trainingFrameData = false;
  private trainingView: 'off' | 'hitboxes' | 'matter' = 'off';
  private matterMode = 0;
  /** Comfort option: scales camera shake / zoom pulses / roll (0..1). */
  private shakeScale = 1;
  private readonly camEvents: SimEvent[] = [];
  private starting = false;
  private loadingText: string | null = null;
  private loadingFraction = 0;
  private readonly hud = { training: false } as HudState;
  private readonly frame: RenderFrame;
  private readonly layers: RenderLayer[] = [];
  private readonly frameEvents: SimEvent[] = [];
  private readonly eventLog: SimEvent[] = [];
  private readonly actions: UIAction[] = [];
  private readonly debugLayer = createDebugLayer();
  private readonly loadingLayer = makeLayer('loading', 'screen', 110, LOGICAL_W, LOGICAL_H);
  private readonly loadingCv = new PixelCanvas(LOGICAL_W, LOGICAL_H, this.loadingLayer.pixels);
  private readonly shapes: DebugShape[] = [];
  private timeSec = 0;
  private nowMs = 0;
  private lastFrameMs = 0;
  private menuStage: StageId = MENU_STAGE;
  /** Per-tick sim cost samples for the harness benchmark. */
  simSamples: number[] = [];
  measureSim = false;

  constructor() {
    const cam = this.camera.sample(0);
    this.frame = {
      tick: 0,
      timeSec: 0,
      alpha: 0,
      camera: cam.state,
      view: cam.view,
      stage: MENU_STAGE,
      layers: this.layers,
      ui: null,
      fx: this.fx.sample(0),
    };
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  boot
   * ------------------------------------------------------------------------------------------------ */
  async start(
    canvas: HTMLCanvasElement,
    opts: { quality?: 0 | 1 | 2 | 'auto'; preserveDrawingBuffer?: boolean } = {},
  ): Promise<void> {
    this.canvas = canvas;
    await this.renderer.init(canvas, {
      quality: opts.quality ?? 'auto',
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    this.input.attach();
    this.audio.autoUnlock(document);
    this.ui = createUI({
      input: this.input,
      titans: TITAN_IDS.map((id): TitanInfo => {
        const d = TITAN_DEFS[id];
        return d ? titanInfoFromDef(d) : FIXTURE_TITANS.find((t) => t.id === id)!;
      }),
      portrait: (id) => {
        if (TITAN_DEFS[id]) return renderPortrait(id, 1, STAGES[this.menuStage].lighting);
        return fixturePortraitProvider(id);
      },
      stages: STAGE_IDS.map((id) => STAGES[id]),
      implementedTitans: IMPLEMENTED_TITANS,
      implementedStages: STAGE_IDS.filter((id) => isStageImplemented(id)),
      sound: (id) => this.audio.handle([{ t: 'ui', id }]),
      version: 'v0.1',
    });
    this.loop = createLoop({
      tick: () => this.tick(),
      frame: (alpha, dt) => this.render(alpha, dt),
    });
    window.addEventListener('resize', this.onResize);
    this.onResize();
    void this.renderer.prepareStage(this.menuStage);
    this.loop.start();
    // warm caches without blocking the first frames: JIT the matter world and generate the menu portraits
    void this.warm();
  }

  private async warm(): Promise<void> {
    await sleep0();
    warmUp();
    for (const id of IMPLEMENTED_TITANS) {
      await sleep0();
      renderPortrait(id, 1, STAGES[this.menuStage].lighting);
    }
    this.ready = true;
  }

  private readonly onResize = (): void => {
    this.renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  };

  /* ------------------------------------------------------------------------------------------------ *
   *  match lifecycle
   * ------------------------------------------------------------------------------------------------ */
  /** Build a match (async: prepares the stage in the background, showing a loading bar). */
  async startMatch(config: MatchConfig, opts: MatchOpts = {}): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      this.endMatch();
      this.loadingText = 'LOADING';
      this.loadingFraction = 0;
      await this.renderer.prepareStage(config.stage, (f) => (this.loadingFraction = f));
      await sleep0();
      this.buildSession(config, opts);
    } finally {
      this.starting = false;
      this.loadingText = null;
    }
  }

  /** Synchronous core of startMatch (the stage must already be prepared). Also used by the benchmark to chain fights. */
  buildSession(config: MatchConfig, opts: MatchOpts = {}): Session {
    const defs: [TitanDef, TitanDef] = [
      getTitanDef(config.slots[0].titan),
      getTitanDef(config.slots[1].titan),
    ];
    const stage = STAGES[config.stage];
    const match = createMatch(config, {
      createWorld: createMatterWorld,
      createFighter,
      getTitanDef,
      arena: stage.arena,
      lighting: stage.lighting,
    });
    const session: Session = {
      match,
      config,
      taps: [null, null],
      srcs: [null, null],
      attract: !!opts.attract,
      dummy: 'idle',
      aiLevel: 3,
    };
    this.session = session;
    // a human slot with no device (harness boot skips the Assign screen) falls back to the keyboard layouts
    const assigned = this.input.assignment();
    for (const slot of [0, 1] as const) {
      if (config.slots[slot].controller === 'human' && assigned[slot] === null)
        this.input.assign(slot, slot === 0 ? 'kb:kb1' : 'kb:kb2');
    }
    this.bindSources(session, defs, opts.scripts);
    this.fx.reset();
    const v0 = match.fighters[0].view;
    const v1 = match.fighters[1].view;
    this.camera.reset((v0.x + v1.x) / 2, (v0.y + v1.y) / 2);
    this.paused = false;
    this.trainingFrameData = !!config.infinite;
    this.trainingView = 'off';
    this.menuStage = config.stage;
    if (opts.skipIntro) for (let i = 0; i < ROUND_INTRO_TICKS + 1; i++) match.step();
    if (!opts.attract) this.ui.showHud();
    return session;
  }

  private bindSources(
    s: Session,
    defs: [TitanDef, TitanDef],
    scripts?: [HarnessParams['script0'], HarnessParams['script1']],
  ): void {
    const srcs: (InputSource | null)[] = [null, null];
    for (const slot of [0, 1] as const) {
      const c: SlotController = s.config.slots[slot].controller;
      const level = (s.config.slots[slot].aiLevel ?? 3) as Difficulty;
      const script = scripts?.[slot];
      if (script && script.length) srcs[slot] = createScriptSource(script, ROUND_INTRO_TICKS);
      else if (c === 'human') {
        const t = tapSource(this.input.source(slot));
        s.taps[slot] = t;
        srcs[slot] = t;
      } else if (c === 'ai') {
        srcs[slot] = createAiSource(s.match, slot, createAI(level, defs[slot], s.config.seed * 7 + slot));
      }
    }
    s.srcs = srcs;
    s.match.setSources(srcs[0], srcs[1]);
  }

  /** Replace one slot's input source (harness scripts, training dummy). */
  replaceSource(slot: 0 | 1, src: InputSource | null): void {
    const s = this.session;
    if (!s) return;
    s.srcs[slot] = src;
    s.match.setSources(s.srcs[0]!, s.srcs[1]!);
  }

  endMatch(): void {
    this.session = null;
    this.paused = false;
    this.frameEvents.length = 0;
  }

  /** Replace the training dummy's behaviour. */
  private setDummy(mode: 'idle' | 'guard' | 'ai'): void {
    const s = this.session;
    if (!s) return;
    s.dummy = mode;
    const src =
      mode === 'guard'
        ? createGuardDummy()
        : mode === 'ai'
          ? createAiSource(s.match, 1, createAI(3, getTitanDef(s.config.slots[1].titan), 5))
          : null;
    this.replaceSource(1, src);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  simulation tick (fixed 60 Hz, called by the loop)
   * ------------------------------------------------------------------------------------------------ */
  tick(): void {
    const s = this.session;
    if (!s || this.paused) return;
    const m = s.match;
    const t0 = this.measureSim ? performance.now() : 0;
    m.step();
    if (this.measureSim) this.simSamples.push(performance.now() - t0);
    const ev = m.events;
    this.fx.tick(ev, m);
    const v0 = m.fighters[0].view;
    const v1 = m.fighters[1].view;
    this.camera.tick(
      {
        a: { x: v0.x, y: v0.y, hw: (v0.boundsX1 - v0.boundsX0) / 2, hh: (v0.boundsY1 - v0.boundsY0) / 2 },
        b: { x: v1.x, y: v1.y, hw: (v1.boundsX1 - v1.boundsX0) / 2, hh: (v1.boundsY1 - v1.boundsY0) / 2 },
        arena: m.arena,
      },
      this.cameraEvents(ev),
    );
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      this.frameEvents.push(e);
      if (e.t === 'rumble' && s.config.slots[e.slot].controller === 'human')
        this.input.rumble(e.slot, e.strong, e.weak, e.ms);
      this.eventLog.push(e);
    }
    if (this.eventLog.length > 600) this.eventLog.splice(0, this.eventLog.length - 400);
    this.loop.timeScale = m.timeScale;
    if (m.phase === 'matchend' && m.phaseTick === 1) this.onMatchEnd(s);
  }

  /** Events for the camera with comfort scaling applied to shake/zoom/roll (the sim's own events are never modified). */
  private cameraEvents(ev: readonly SimEvent[]): readonly SimEvent[] {
    const k = this.shakeScale;
    if (k >= 1) return ev;
    const out = this.camEvents;
    out.length = 0;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      if (e.t === 'shake') out.push({ ...e, amp: e.amp * k });
      else if (e.t === 'zoom') out.push({ ...e, amount: e.amount * k });
      else if (e.t === 'roll') out.push({ ...e, radians: e.radians * k });
      else if (e.t === 'hit') out.push({ ...e, energy: e.energy * k });
      else out.push(e);
    }
    return out;
  }

  private onMatchEnd(s: Session): void {
    if (s.attract) {
      // keep the attract loop alive with a fresh pairing
      void this.startAttract();
      return;
    }
    this.ui.showResults(s.match.winner);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  frame (render + UI + audio)
   * ------------------------------------------------------------------------------------------------ */
  render(alpha: number, dtSec: number): void {
    const now = performance.now();
    this.nowMs = now;
    this.timeSec += dtSec;
    const t0 = now;
    this.input.poll(now);
    this.ui.update(dtSec);
    this.handleUiActions();
    const s = this.session;

    // pause / training toggles from the players' own buttons
    if (s && !s.attract) {
      for (const tap of s.taps) {
        if (!tap) continue;
        const e = tap.take();
        if (e.pause && !this.paused && s.match.phase !== 'matchend') this.setPaused(true);
        if (e.training) this.cycleTraining();
      }
      if (!this.paused && this.ui.screen === 'pause') this.setPaused(true);
    }

    const f = this.frame;
    this.layers.length = 0;
    f.tick = s ? s.match.tick : 0;
    f.timeSec = this.timeSec;
    f.alpha = this.paused ? 0 : alpha;

    if (s) {
      const cam = this.camera.sample(f.alpha);
      f.camera = cam.state;
      f.view = cam.view;
      f.stage = s.config.stage;
      const m = s.match;
      for (const fighter of m.fighters) {
        const ls = fighter.renderLayers(f.view, f.alpha);
        for (let i = 0; i < ls.length; i++) this.layers.push(ls[i]!);
      }
      const wl = m.world.renderLayers(f.view, f.alpha);
      for (let i = 0; i < wl.length; i++) this.layers.push(wl[i]!);
      this.addTrainingLayers(s, f.view);
      f.fx = this.fx.sample(f.alpha);
      const hudPaused = this.paused;
      const hudState = fillHudState(this.hud, m, this.trainingFrameData, hudPaused);
      this.ui.draw(
        this.ui.screen === 'hud' ||
          this.ui.screen === 'pause' ||
          this.ui.screen === 'results' ||
          this.ui.screen === 'attract'
          ? hudState
          : null,
      );
    } else {
      // menus: a slow, hand-made dolly over the stage so the scenery breathes behind the UI
      const arena = STAGES[this.menuStage].arena;
      const cx = (arena.minX + arena.maxX) / 2 + Math.sin(this.timeSec * 0.07) * 140;
      const cy = arena.restY - 40 + Math.sin(this.timeSec * 0.05 + 1) * 24;
      this.camera.reset(cx, cy);
      const cam = this.camera.sample(0);
      f.camera = cam.state;
      f.view = cam.view;
      f.stage = this.menuStage;
      f.fx = this.fx.sample(0);
      this.ui.draw(null);
    }
    f.ui = this.hideUi ? null : this.ui.layer;
    if (this.loadingText) {
      this.drawLoading();
      this.layers.push(this.loadingLayer);
    }
    this.renderer.draw(f);

    // audio: one-shots then continuous state
    if (this.frameEvents.length) {
      this.audio.handle(this.frameEvents);
      this.frameEvents.length = 0;
    }
    this.audio.update(this.audioScene(s), dtSec);
    this.lastFrameMs = performance.now() - t0;
  }

  private audioScene(s: Session | null): AudioScene {
    if (!s) {
      return {
        phase: 'menu',
        stage: this.menuStage,
        intensity: 0.15,
        listenerX: 0,
        fighters: null,
        lowestIntegrity: 1,
        timeScale: 1,
      };
    }
    const phase: AudioScene['phase'] = s.attract
      ? 'attract'
      : this.paused
        ? 'pause'
        : s.match.phase === 'matchend'
          ? 'results'
          : 'fight';
    return buildAudioScene(s.match, phase, this.fx.intensity(), this.frame.camera.x);
  }

  private addTrainingLayers(s: Session, view: RenderFrame['view']): void {
    if (this.trainingView === 'hitboxes') {
      this.shapes.length = 0;
      const bounds: [number, number, number, number][] = [];
      for (const f of s.match.fighters) {
        f.debugShapes(this.shapes);
        bounds.push([f.view.boundsX0, f.view.boundsY0, f.view.boundsX1, f.view.boundsY1]);
      }
      drawDebugShapes(this.debugLayer, view, this.shapes, bounds);
      this.layers.push(this.debugLayer);
    } else if (this.trainingView === 'matter') {
      for (const f of s.match.fighters) {
        const l = s.match.world.debugOverlay(f.body.id, DEBUG_MODES[this.matterMode]!);
        if (l) this.layers.push(l);
      }
    }
  }

  private drawLoading(): void {
    const cv = this.loadingCv;
    cv.clear(0);
    const y = LOGICAL_H - 46;
    drawText(cv, this.loadingText ?? '', LOGICAL_W / 2, y, {
      color: rgba(220, 235, 228),
      align: 'center',
      outline: rgba(6, 8, 12),
    });
    const w = 120;
    const x = (LOGICAL_W - w) >> 1;
    cv.rect(x, y + 14, w, 3, rgba(20, 28, 34, 200));
    cv.rect(x, y + 14, Math.max(2, Math.round(w * this.loadingFraction)), 3, rgba(168, 189, 178));
    this.loadingLayer.version++;
    this.loadingLayer.dirty = null;
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  UI actions, pause, training
   * ------------------------------------------------------------------------------------------------ */
  private handleUiActions(): void {
    this.actions.length = 0;
    this.ui.drainActions(this.actions);
    for (const a of this.actions) this.onAction(a);
  }

  onAction(a: UIAction): void {
    switch (a.type) {
      case 'unlockAudio':
        void this.audio.unlock();
        break;
      case 'setVolume':
        this.audio.setVolumes(a);
        break;
      case 'setAccessibility':
        this.shakeScale = Math.min(1, Math.max(0, a.shake));
        this.fx.flashScale = Math.min(1, Math.max(0, a.flash));
        break;
      case 'setQuality':
        this.renderer.debugSetTier(a.quality);
        break;
      case 'startMatch':
        void this.startMatch(a.config);
        break;
      case 'rematch':
        if (this.session)
          void this.startMatch({
            ...this.session.config,
            seed: (this.session.config.seed * 1664525 + 1013904223) >>> 0,
          });
        break;
      case 'restartRound':
      case 'resetPositions':
        this.resetPositions();
        break;
      case 'healBoth':
        this.healBoth();
        break;
      case 'resume':
        this.setPaused(false);
        break;
      case 'quitToTitle':
        this.endMatch();
        this.ui.showTitle();
        break;
      case 'toggleTraining':
        this.trainingFrameData = !this.trainingFrameData;
        break;
      case 'setTrainingView':
        this.trainingView = a.overlay;
        break;
      case 'setDummy':
        this.setDummy(a.mode);
        break;
      case 'attractStart':
        void this.startAttract();
        break;
      case 'attractStop':
        this.endMatch();
        this.ui.showTitle();
        break;
    }
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.ui.showPause(p);
  }

  private cycleTraining(): void {
    if (this.trainingView === 'matter') this.matterMode = (this.matterMode + 1) % DEBUG_MODES.length;
    else this.trainingFrameData = !this.trainingFrameData;
  }

  private resetPositions(): void {
    const s = this.session;
    if (!s) return;
    const m = s.match;
    for (const f of m.fighters) {
      const cx = (m.arena.minX + m.arena.maxX) / 2;
      f.nextRound(
        f.slot === 0 ? cx - 190 : cx + 190,
        m.arena.restY,
        f.slot === 0 ? 1 : -1,
        0,
        m.tick + f.slot,
      );
    }
    this.setPaused(false);
  }

  private healBoth(): void {
    const s = this.session;
    if (!s) return;
    for (const f of s.match.fighters) s.match.world.restore(f.body.id);
  }

  /** AI-vs-AI attract loop with a random pairing on an implemented stage. */
  async startAttract(): Promise<void> {
    const ids = IMPLEMENTED_TITANS;
    const a = ids[Math.floor(Math.random() * ids.length)]!;
    let b = ids[Math.floor(Math.random() * ids.length)]!;
    if (ids.length > 1) while (b === a) b = ids[Math.floor(Math.random() * ids.length)]!;
    const stages = STAGE_IDS.filter((id) => isStageImplemented(id));
    const stage = stages[Math.floor(Math.random() * stages.length)]!;
    await this.startMatch(
      {
        seed: (Math.random() * 0xffffffff) >>> 0,
        stage,
        mode: 'attract',
        slots: [
          { titan: a as TitanId, controller: 'ai', aiLevel: 4 },
          { titan: b as TitanId, controller: 'ai', aiLevel: 4 },
        ],
      },
      { attract: true },
    );
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  harness access
   * ------------------------------------------------------------------------------------------------ */
  get frameMs(): number {
    return this.lastFrameMs;
  }
  get lastNow(): number {
    return this.nowMs;
  }
  drainEventLog(): SimEvent[] {
    const out = this.eventLog.slice();
    this.eventLog.length = 0;
    return out;
  }
  get canvasEl(): HTMLCanvasElement {
    return this.canvas;
  }
}
