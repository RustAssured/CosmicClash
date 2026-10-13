import {
  LOGICAL_H,
  LOGICAL_W,
  ROUNDS_TO_WIN,
  ROUND_INTRO_TICKS,
  ROUND_LENGTH_PACE,
  ROUND_LENGTH_SECONDS,
  SLICE,
  emptyInput,
  STAGE_IDS,
  TITAN_IDS,
  makeLayer,
  rgba,
  type AudioScene,
  type CameraState,
  type InputFrame,
  type DebugOverlayMode,
  type DebugShape,
  type Difficulty,
  type HarnessCamera,
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
import { createFighter, PACE } from '@/combat';
import { cameraTargetOf, createCamera, createLoop, type Loop } from '@/engine';
import { createInputManager, emptyDebugInput } from '@/input';
import { registerMatchKnobs, releaseMatchKnobs, type KnobAI, type KnobFighter } from '@/debug/matchKnobs';
import { DebugOverlay } from '@/ui/debugOverlay';
import { createMatterWorld, warmUp } from '@/matter';
import { TITAN_SKY, createRenderer, type DebuggableRenderer } from '@/render';
import { createAiSource, createMatch, createScriptSource, type Match } from '@/sim';
import { STAGES, isStageImplemented } from '@/stages';
import { IMPLEMENTED_TITANS, TITAN_DEFS, getTitanDef, isTitanOffered, renderPortrait } from '@/titans';
import { isMouthUnlocked, mouthBossDef, mouthDef, setMouthUnlocked } from '@/titans';
import { mouthPortrait } from '@/titans/mouth/portrait';
import { arenaForMatch } from '@/combat/mouth/arena';
import { PixelCanvas, createUI, drawText, titanInfoFromDef, type TitanInfo } from '@/ui';
import { FIXTURE_TITANS, fixturePortraitProvider } from '@/ui/fixtures';
import { loadUISettings, resolveStore } from '@/ui/settings';
import { AudioMeter } from '@/telemetry/audioMeter';
import type { StripRecorder } from '@/telemetry/strips';
import { Telemetry } from '@/telemetry/telemetry';
import { fillHudState } from './announcer';
import { createDebugLayer, drawDebugShapes } from './debugDraw';
import { Aftermath } from './aftermath';
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
  /** The AI controllers per slot (the debug overlay tunes them). */
  ais: (KnobAI | null)[];
}

const MENU_STAGE: StageId = 'nursery';
const CURSOR_IDLE_MS = 1500;
/** The aftermath opens this many sim ticks after the deciding KO (1 s; KO slow-motion stretches it in wall time). */
const AFTERMATH_DELAY_TICKS = 60;

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
  /** Titans offered in menus / attract mode (the slice unless `?full=1`). */
  private roster: TitanId[] = [];
  /** Stages offered in menus / attract mode (the slice's two arenas unless `?full=1`). */
  private stageRoster: StageId[] = [];
  /** Prototype flags from the URL (`orbit=1`, `zdepth=1`), applied to every match that does not set them itself. */
  private footwork: 'classic' | 'orbit' = 'classic';
  /** The aftermath view while it is open, the tick it opens at (-1 = not scheduled), and whether it was already shown. */
  aftermath: Aftermath | null = null;
  private aftermathAt = -1;
  private aftermathDone = false;
  /** False with the harness's `aftermath=0` (captures and tests go straight to results). */
  private aftermathEnabled = true;
  private saveNext = false;
  private uiHiddenBefore = false;
  private afterTick = 0;
  /** Input for the aftermath when no human slot exists (AI vs AI). */
  private afterSrc: TappedSource | null = null;
  private readonly afterInput: InputFrame = emptyInput();
  private readonly aftCam: CameraState = {
    x: 0,
    y: 0,
    zoom: 1,
    roll: 0,
    shakeX: 0,
    shakeY: 0,
    dolly: 0,
    kickX: 0,
    kickY: 0,
  };
  /** Trailer capture (harness `setCamera`): a scripted camera over the game camera at render time; null = off. */
  cameraOverride: HarnessCamera | null = null;
  /** The camera of the last rendered frame (trailer capture starts scripted moves from it). */
  get lastCamera(): Readonly<CameraState> {
    return this.frame.camera;
  }
  private readonly trailerCam: CameraState = { ...this.aftCam };
  private readonly trailerView: RenderFrame['view'] = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  private dragX = 0;
  private dragY = 0;
  private wheel = 0;
  private zdepth = false;
  private witness = false;
  /** Per-tick sim cost samples for the harness benchmark. */
  simSamples: number[] = [];
  measureSim = false;
  /** Evidence telemetry (harness `tele=1|2`): presentation-side only, never read by the sim. */
  telemetry: Telemetry | null = null;
  strips: StripRecorder | null = null;
  private teleOverlay = false;
  private meterState: 'none' | 'pending' | 'on' = 'none';
  private readonly teleLayer = makeLayer('telemetry', 'screen', 104, LOGICAL_W, LOGICAL_H);
  private readonly teleCv = new PixelCanvas(LOGICAL_W, LOGICAL_H, this.teleLayer.pixels);
  /** The debug tuning / diagnostics overlay (keyboard ` or pad R3), and its input frame. */
  readonly debug = new DebugOverlay();
  private readonly debugIn = emptyDebugInput();

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
    opts: {
      quality?: 0 | 1 | 2 | 'auto';
      preserveDrawingBuffer?: boolean;
      full?: boolean;
      footwork?: 'classic' | 'orbit';
      zdepth?: boolean;
      witness?: boolean;
      aftermath?: boolean;
    } = {},
  ): Promise<void> {
    this.canvas = canvas;
    this.aftermathEnabled = opts.aftermath ?? true;
    this.footwork = opts.footwork ?? 'classic';
    this.zdepth = !!opts.zdepth;
    this.witness = !!opts.witness;
    // the vertical slice (D26/D27): only its titans in menus and attract mode unless `?full=1`
    // work-in-progress titans (kit.wip) only with `?wip=<id>` / `?<id>=1` (an unshipped titan must not go live)
    this.roster = (
      opts.full
        ? IMPLEMENTED_TITANS.slice()
        : IMPLEMENTED_TITANS.filter((id) => (SLICE.titans as readonly TitanId[]).includes(id))
    ).filter(isTitanOffered);
    // the Mouth (D37) is the final boss: offered only once unlocked (`?mouth=1` or the ladder's unlock)
    const mouthOn = isMouthUnlocked();
    if (mouthOn) this.roster.push('mouth');
    this.stageRoster = STAGE_IDS.filter(
      (id) => isStageImplemented(id) && (opts.full || (SLICE.stages as readonly StageId[]).includes(id)),
    );
    if (!this.stageRoster.includes(this.menuStage)) this.menuStage = this.stageRoster[0] ?? MENU_STAGE;
    this.hideIdleCursor();
    this.attachAftermathMouse(canvas);
    await this.renderer.init(canvas, {
      quality: opts.quality ?? 'auto',
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    this.input.attach();
    this.audio.autoUnlock(document);
    this.ui = createUI({
      input: this.input,
      titans: (opts.full
        ? TITAN_IDS.filter((id) => (id !== 'mouth' || mouthOn) && isTitanOffered(id))
        : this.roster
      ).map((id): TitanInfo => {
        const d = id === 'mouth' ? mouthDef() : TITAN_DEFS[id];
        return d ? titanInfoFromDef(d) : FIXTURE_TITANS.find((t) => t.id === id)!;
      }),
      portrait: (id) => {
        if (id === 'mouth') return mouthPortrait();
        if (TITAN_DEFS[id]) return renderPortrait(id, 1, TITAN_SKY);
        return fixturePortraitProvider(id);
      },
      stages: (opts.full ? STAGE_IDS : this.stageRoster).map((id) => STAGES[id]),
      implementedTitans: this.roster,
      implementedStages: this.stageRoster,
      // the tournament names the locked Mouth on its tower and unlocks it when the final boss falls
      lockedTitans: mouthOn ? [] : [titanInfoFromDef(mouthDef())],
      onUnlock: (id) => {
        if (id !== 'mouth') return;
        setMouthUnlocked(true);
        if (!this.roster.includes('mouth')) this.roster.push('mouth');
      },
      sound: (id) => this.audio.handle([{ t: 'ui', id }]),
      version: 'v0.1',
    });
    this.loop = createLoop({
      tick: () => this.tick(),
      frame: (alpha, dt) => this.render(alpha, dt),
    });
    // the stored display choice (Options › FILL SCREEN) applies from the very first frame
    this.renderer.setIntegerScale(!loadUISettings(resolveStore(undefined)).fill);
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
    for (const id of this.roster) {
      await sleep0();
      if (id === 'mouth') mouthPortrait();
      else renderPortrait(id, 1, TITAN_SKY);
    }
    this.ready = true;
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  aftermath (SLICE_PLAN §8, D27): freeze at the deciding KO + 1 s; pan / zoom / orbit / HUD / save PNG
   * ------------------------------------------------------------------------------------------------ */
  private enterAftermath(m: Match): void {
    this.aftermathAt = -1;
    const a = m.arena;
    // frame the remains: the centre of both bodies' live bounds, not wherever the KO camera happened to be
    const v0 = m.fighters[0].view;
    const v1 = m.fighters[1].view;
    const cx = (Math.min(v0.boundsX0, v1.boundsX0) + Math.max(v0.boundsX1, v1.boundsX1)) / 2;
    const cy = (Math.min(v0.boundsY0, v1.boundsY0) + Math.max(v0.boundsY1, v1.boundsY1)) / 2;
    this.aftermath = new Aftermath(cx, cy, {
      minX: a.minX + LOGICAL_W / 4,
      maxX: a.maxX - LOGICAL_W / 4,
      minY: a.minY + LOGICAL_H / 4,
      maxY: a.maxY - LOGICAL_H / 4,
    });
    this.uiHiddenBefore = this.hideUi;
    this.hideUi = true;
    this.renderer.setInspect(true);
    // AI-vs-AI (no human slot): the aftermath still answers to the first keyboard layout / an assigned pad
    const s = this.session;
    this.afterSrc = null;
    if (s && !s.taps.some((t) => t)) {
      if (this.input.assignment()[0] === null) this.input.assign(0, 'kb:kb1');
      this.afterSrc = tapSource(this.input.source(0));
    }
  }

  private exitAftermath(): void {
    this.aftermath = null;
    this.aftermathDone = true;
    this.hideUi = this.uiHiddenBefore;
    this.renderer.setInspect(false);
  }

  /** Read the first human's input (pad or keyboard layout) plus the mouse, and apply it to the aftermath view. */
  private updateAftermath(s: Session, dtSec: number): void {
    const a = this.aftermath!;
    const inp = this.afterInput;
    let tap: TappedSource | null = this.afterSrc;
    for (const t of s.taps) if (t && !tap) tap = t;
    let edges = { pause: false, training: false };
    if (tap) {
      tap.poll(++this.afterTick, inp);
      edges = tap.take();
    } else {
      Object.assign(inp, emptyInput());
    }
    const act = a.update(inp, dtSec, { dragX: this.dragX, dragY: this.dragY, wheel: this.wheel });
    this.dragX = this.dragY = this.wheel = 0;
    if (act.toggleHud || edges.training) {
      a.hud = !a.hud;
      this.hideUi = !a.hud;
    }
    if (act.save) {
      a.hideHintsOnce = true;
      this.saveNext = true;
    }
    if (act.exit || edges.pause) this.exitAftermath();
  }

  /** Save exactly what is on screen (full display resolution) as a PNG download. */
  private savePng(): void {
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `adeuk-aftermath-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.aftermath?.noteSaved();
    }, 'image/png');
  }

  /** Mouse drag pans and the wheel zooms the aftermath view (ignored otherwise). */
  private attachAftermathMouse(canvas: HTMLCanvasElement): void {
    let down = false;
    let lx = 0;
    let ly = 0;
    const toLogical = (): number => canvas.clientWidth / LOGICAL_W || 1;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.aftermath) return;
      down = true;
      lx = e.clientX;
      ly = e.clientY;
    });
    window.addEventListener('pointerup', () => (down = false));
    window.addEventListener('pointermove', (e) => {
      if (!down || !this.aftermath) return;
      const k = toLogical();
      // dragging moves the picture with the pointer, so the camera goes the other way
      this.dragX -= (e.clientX - lx) / k;
      this.dragY -= (e.clientY - ly) / k;
      lx = e.clientX;
      ly = e.clientY;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.aftermath) return;
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: false },
    );
  }

  /** D7: the mouse cursor disappears after 1.5 s without mouse movement and comes back on the next move. */
  private hideIdleCursor(): void {
    const root = document.documentElement;
    let timer = 0;
    const wake = (): void => {
      root.style.cursor = '';
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (root.style.cursor = 'none'), CURSOR_IDLE_MS);
    };
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
    wake();
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
  buildSession(cfg: MatchConfig, opts: MatchOpts = {}): Session {
    // the stored Options › ROUND LENGTH (the UI saves it as it changes)
    const length = loadUISettings(resolveStore(undefined)).roundLength;
    const config: MatchConfig = {
      ...cfg,
      footwork: cfg.footwork ?? this.footwork,
      zdepth: cfg.zdepth ?? this.zdepth,
      witness: cfg.witness ?? this.witness,
      // the Options row ROUND LENGTH, fixed into the config when the match starts (a config that names its pace keeps it)
      pace: cfg.pace ?? ROUND_LENGTH_PACE[length],
      roundSeconds: cfg.roundSeconds ?? ROUND_LENGTH_SECONDS[length],
    };
    // the tournament's final boss: the Mouth's boss variant (D35) for a slot flagged `boss`
    const bossMouth = config.slots.some((s) => s.titan === 'mouth' && s.boss);
    const defOf = (id: TitanId): TitanDef => (id === 'mouth' && bossMouth ? mouthBossDef() : getTitanDef(id));
    // the AI reads the definition the fighter really plays (D36: the colossus is its own titan, so that is getTitanDef)
    const defs: [TitanDef, TitanDef] = [defOf(config.slots[0].titan), defOf(config.slots[1].titan)];
    const stage = STAGES[config.stage];
    const match = createMatch(config, {
      createWorld: createMatterWorld,
      createFighter,
      getTitanDef: defOf,
      // arena B when the Mouth plays (Gate 3A §1, D37): the stage's width, 360 px tall
      arena: arenaForMatch(stage.arena, [config.slots[0].titan, config.slots[1].titan]),
      // one sky for every titan (D31 / proposal 172 §1): stages keep their own light for their scenery only
      lighting: TITAN_SKY,
    });
    const session: Session = {
      match,
      config,
      taps: [null, null],
      srcs: [null, null],
      attract: !!opts.attract,
      dummy: 'idle',
      aiLevel: 3,
      ais: [null, null],
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
    if (this.aftermath) this.exitAftermath();
    this.aftermathAt = -1;
    this.aftermathDone = false;
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
        const ai = createAI(level, defs[slot], s.config.seed * 7 + slot, {
          footwork: s.config.footwork ?? 'classic',
        });
        s.ais[slot] = ai as unknown as KnobAI;
        srcs[slot] = createAiSource(s.match, slot, ai);
      }
    }
    s.srcs = srcs;
    s.match.setSources(srcs[0], srcs[1]);
    this.registerKnobs(s);
  }

  /** The debug overlay's knobs and diagnostics for this match (they only read until a player moves a slider). */
  private registerKnobs(s: Session): void {
    // the PACE knob moves this match's pace on both fighters (each keeps its own copy from the config; the next match takes
    // the Options row's value again)
    const fs = s.match.fighters as unknown as { pace?: number }[];
    const pace = {
      get damageTaken(): number {
        return fs.find((f) => typeof f.pace === 'number')?.pace ?? PACE.damageTaken;
      },
      set damageTaken(v: number) {
        for (const f of fs) if (typeof f.pace === 'number') f.pace = v;
      },
    };
    registerMatchKnobs(
      s.match.fighters as unknown as KnobFighter[],
      [s.config.slots[0].titan, s.config.slots[1].titan],
      s.ais,
      pace,
    );
  }

  /** Replace one slot's input source (harness scripts, training dummy). */
  replaceSource(slot: 0 | 1, src: InputSource | null): void {
    const s = this.session;
    if (!s) return;
    s.srcs[slot] = src;
    s.match.setSources(s.srcs[0]!, s.srcs[1]!);
  }

  endMatch(): void {
    if (this.session) releaseMatchKnobs();
    this.session = null;
    this.paused = false;
    this.frameEvents.length = 0;
  }

  /** Replace the training dummy's behaviour. */
  private setDummy(mode: 'idle' | 'guard' | 'ai'): void {
    const s = this.session;
    if (!s) return;
    s.dummy = mode;
    const ai =
      mode === 'ai'
        ? createAI(3, getTitanDef(s.config.slots[1].titan), 5, { footwork: s.config.footwork ?? 'classic' })
        : null;
    const src = mode === 'guard' ? createGuardDummy() : ai ? createAiSource(s.match, 1, ai) : null;
    s.ais[1] = ai as unknown as KnobAI | null;
    this.replaceSource(1, src);
    this.registerKnobs(s);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  simulation tick (fixed 60 Hz, called by the loop)
   * ------------------------------------------------------------------------------------------------ */
  tick(): void {
    const s = this.session;
    // the aftermath freezes the arena: the match is simply not stepped until the player leaves it
    if (!s || this.paused || this.aftermath) return;
    const m = s.match;
    const timed = this.measureSim || this.telemetry !== null;
    const t0 = timed ? performance.now() : 0;
    m.step();
    const simMs = timed ? performance.now() - t0 : 0;
    if (this.measureSim) this.simSamples.push(simMs);
    const ev = m.events;
    if (this.telemetry) this.telemetry.afterTick(m, ev, simMs);
    if (this.strips) this.strips.onTick(m.tick, ev);
    this.fx.tick(ev, m);
    const v0 = m.fighters[0].view;
    const v1 = m.fighters[1].view;
    this.camera.tick(
      // frame the live bounds (arms and hanging city included), not the anchors
      { a: cameraTargetOf(v0), b: cameraTargetOf(v1), arena: m.arena },
      this.cameraEvents(ev),
    );
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      this.frameEvents.push(e);
      if (e.t === 'rumble' && s.config.slots[e.slot].controller === 'human')
        this.input.rumble(e.slot, e.strong, e.weak, e.ms);
      this.eventLog.push(e);
      // the KO that decides the match opens the aftermath 1 s (sim time) later
      if (
        e.t === 'round' &&
        e.phase === 'ko' &&
        e.winner !== -1 &&
        !s.attract &&
        this.aftermathEnabled &&
        !this.aftermathDone &&
        m.wins[e.winner] + 1 >= ROUNDS_TO_WIN
      )
        this.aftermathAt = m.tick + AFTERMATH_DELAY_TICKS;
    }
    if (this.eventLog.length > 600) this.eventLog.splice(0, this.eventLog.length - 400);
    this.loop.timeScale = m.timeScale;
    if (this.aftermathAt >= 0 && m.tick >= this.aftermathAt) this.enterAftermath(m);
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
    if (this.telemetry) {
      this.telemetry.beginFrame(
        now,
        typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null,
      );
      if (this.meterState === 'none' && this.audio.ready) void this.attachMeters();
    }
    this.input.poll(now);
    this.debug.handle(this.input.debugPoll(this.debugIn, now));
    this.ui.update(dtSec);
    this.handleUiActions();
    const s = this.session;

    if (s && this.aftermath) this.updateAftermath(s, dtSec);
    // pause / training toggles from the players' own buttons
    else if (s && !s.attract) {
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
      const a = this.aftermath;
      if (a) {
        this.camera.reset(a.x, a.y);
        f.alpha = 0;
      }
      const cam = this.camera.sample(f.alpha);
      f.camera = cam.state;
      f.view = cam.view;
      if (a) {
        // whole-number zoom and free orbit are applied in the final pass (renderer inspect mode)
        // the scenery comes back to rest (no windup dolly, no impact kick): the aftermath shows the battlefield in context
        Object.assign(this.aftCam, cam.state, {
          zoom: a.zoom,
          roll: a.roll,
          shakeX: 0,
          shakeY: 0,
          dolly: 0,
          kickX: 0,
          kickY: 0,
        });
        f.camera = this.aftCam;
      } else if (this.cameraOverride) {
        // trailer capture: a scripted camera (whole-pixel view origin, as the game camera's)
        const o = this.cameraOverride;
        const c = Object.assign(this.trailerCam, cam.state);
        if (o.x !== undefined) c.x = o.x;
        if (o.y !== undefined) c.y = o.y;
        if (o.zoom !== undefined) c.zoom = o.zoom;
        if (o.dolly !== undefined) c.dolly = o.dolly;
        if (o.still) Object.assign(c, { roll: 0, shakeX: 0, shakeY: 0, kickX: 0, kickY: 0 });
        const v = this.trailerView;
        v.x0 = o.x !== undefined ? Math.round(c.x + c.shakeX - LOGICAL_W / 2) : cam.view.x0;
        v.y0 = o.y !== undefined ? Math.round(c.y + c.shakeY - LOGICAL_H / 2) : cam.view.y0;
        f.camera = c;
        f.view = v;
      }
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
    if (this.telemetry && this.teleOverlay && s) {
      this.drawTelemetry();
      this.layers.push(this.teleLayer);
    }
    if (s && !this.aftermath) {
      const dl = this.debug.draw(f.view);
      if (dl) this.layers.push(dl);
    }
    if (this.aftermath) {
      // the hint goes in the UI slot (composited after the zoom/orbit of the frame), or the HUD does when it is on
      const hint = this.aftermath.drawHints();
      f.ui = this.aftermath.hud ? this.ui.layer : hint ? this.aftermath.layer : null;
    }
    this.renderer.draw(f);
    if (this.saveNext) {
      // toBlob snapshots the canvas NOW (same task as the draw), so no preserveDrawingBuffer is needed
      this.saveNext = false;
      this.savePng();
    }
    if (s && (this.telemetry || this.strips)) {
      const done = performance.now();
      this.telemetry?.afterDraw(done, this.layers, f.fx, f.view, f.alpha, this.canvas);
      if (this.telemetry) for (const l of this.renderer.drainLuma()) this.telemetry.pushLuma(l.mean);
      this.strips?.onFrame(f.tick, done, this.canvas);
    }

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

  /** Turn evidence telemetry on (harness / capture tools). `overlay` draws the two-line readout at the bottom edge. */
  enableTelemetry(overlay: boolean): Telemetry {
    if (!this.telemetry) {
      this.telemetry = new Telemetry();
      this.telemetry.attach(window);
      // flash metrics come from the renderer's async GPU luminance read-back (pushLuma), not a canvas snapshot
    }
    this.teleOverlay = overlay;
    const s = this.session;
    if (s)
      this.telemetry.humanSlots = [
        s.config.slots[0].controller === 'human',
        s.config.slots[1].controller === 'human',
      ];
    return this.telemetry;
  }

  private async attachMeters(): Promise<void> {
    const t = this.telemetry;
    const ac = this.audio.context;
    const taps = this.audio.taps();
    if (!t || !taps || !(ac instanceof AudioContext)) return;
    this.meterState = 'pending';
    try {
      t.master = await AudioMeter.attach(ac, taps.output);
      t.bed = await AudioMeter.attach(ac, taps.music);
      this.meterState = 'on';
    } catch (e) {
      console.warn('loudness meter unavailable:', e);
      this.meterState = 'on';
    }
  }

  private drawTelemetry(): void {
    const t = this.telemetry!;
    const cv = this.teleCv;
    cv.clear(0);
    const [a, b] = t.summaryLines();
    const y = LOGICAL_H - 14;
    cv.rect(0, y - 2, LOGICAL_W, 14, rgba(4, 6, 10, 170));
    drawText(cv, a, 3, y, { color: rgba(168, 220, 200), font: 'micro' });
    drawText(cv, b, 3, y + 6, { color: rgba(230, 214, 150), font: 'micro' });
    this.teleLayer.version++;
    this.teleLayer.dirty = null;
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
        // the renderer's own comfort-scaled effects: impulse glow, bloom gain, luminance-governor cap
        this.renderer.setComfort(this.fx.flashScale);
        break;
      case 'setQuality':
        this.renderer.debugSetTier(a.quality);
        break;
      case 'setDisplay':
        this.renderer.setIntegerScale(!a.fill);
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
    const ids = this.roster;
    const a = ids[Math.floor(Math.random() * ids.length)]!;
    let b = ids[Math.floor(Math.random() * ids.length)]!;
    if (ids.length > 1) while (b === a) b = ids[Math.floor(Math.random() * ids.length)]!;
    const stages = this.stageRoster;
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
