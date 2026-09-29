import {
  HITSTOP_MAX_TICKS,
  HITSTOP_MIN_TICKS,
  KO_MASS_FRAC,
  KO_TIME_SCALE,
  ROUNDS_TO_WIN,
  ROUND_INTRO_TICKS,
  ROUND_OUTRO_TICKS,
  ROUND_TIME_TICKS,
  Rng,
  clamp,
  emptyInput,
  hash32,
  type AIContext,
  type ArenaInfo,
  type Fighter,
  type FighterFactory,
  type FighterTickCtx,
  type InputFrame,
  type InputSource,
  type MatchApi,
  type MatchConfig,
  type MatterWorld,
  type RoundPhase,
  type SimEvent,
  type StageId,
  type StageLighting,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { accumulateInput, createNullSource } from './sources';

export interface MatchDeps {
  createWorld(seed: number): MatterWorld;
  createFighter: FighterFactory;
  getTitanDef(id: TitanId): TitanDef;
  arena: ArenaInfo;
  lighting: StageLighting;
}

const KO_PHASE_TICKS = 72;
const KO_SLOWMO_TICKS = 50;
const TIMEOVER_PHASE_TICKS = 48;
const DEFAULT_START_GAP = 380;
const INFINITE_RESET_DELAY = 90;
/** Fraction of missing matter that regrows (as scars) between rounds. */
const ROUND_HEAL_FRACTION = 0.6;

const q = (v: number, s: number): number => Math.round(v * s) | 0;

/**
 * Pure, headless match orchestrator: best-of-3 rounds, hit-stop, KO slow-motion, timeouts, training reset.
 * Runs identically in the browser and in Node. Tick order per DESIGN §1.2 (fighter order alternates per tick so neither slot is favoured).
 */
export class Match implements MatchApi {
  readonly config: MatchConfig;
  readonly world: MatterWorld;
  readonly fighters: [Fighter, Fighter];
  readonly arena: ArenaInfo;
  readonly lighting: StageLighting;
  readonly stage: StageId;

  tick = 0;
  phase: RoundPhase = 'intro';
  phaseTick = 0;
  round = 1;
  wins: [number, number] = [0, 0];
  winner: 0 | 1 | -1 = -1;
  roundTicksLeft = ROUND_TIME_TICKS;
  hitstopTicks = 0;
  timeScale = 1;
  readonly events: SimEvent[] = [];

  private readonly rng: Rng;
  private readonly fighterRng: [Rng, Rng];
  private readonly sources: [InputSource, InputSource] = [createNullSource(), createNullSource()];
  private readonly frames: [InputFrame, InputFrame] = [emptyInput(), emptyInput()];
  private readonly acc: [InputFrame, InputFrame] = [emptyInput(), emptyInput()];
  private readonly ctx: FighterTickCtx;
  private _roundTick = 0;
  private tsScale = 1;
  private tsTicks = 0;
  private roundWinner: 0 | 1 | -1 = -1;
  private infiniteKoTicks = 0;

  constructor(config: MatchConfig, deps: MatchDeps) {
    this.config = config;
    this.arena = deps.arena;
    this.lighting = deps.lighting;
    this.stage = config.stage;
    this.rng = new Rng(config.seed);
    this.fighterRng = [this.rng.fork('f0'), this.rng.fork('f1')];
    this.world = deps.createWorld(this.rng.fork('world').nextU32());
    this.world.setLighting(deps.lighting);
    this.world.setArena(deps.arena);

    const mk = (slot: 0 | 1): Fighter =>
      deps.createFighter({
        slot,
        def: deps.getTitanDef(config.slots[slot].titan),
        world: this.world,
        seed: this.rng.fork(`titan${slot}`).nextU32(),
        lighting: deps.lighting,
        arena: deps.arena,
        x: this.startX(slot),
        y: deps.arena.restY,
        facing: slot === 0 ? 1 : -1,
      });
    this.fighters = [mk(0), mk(1)];

    if (config.startState && config.startState !== 'intact') {
      // '50' / '10' mean HUD integrity 50% / 10% (0% = KO), so map through the KO mass threshold
      const integrity = config.startState === '50' ? 0.5 : 0.1;
      const frac = KO_MASS_FRAC + integrity * (1 - KO_MASS_FRAC);
      for (const f of this.fighters)
        this.world.carve(f.body.id, frac, this.rng.fork(`carve${f.slot}`).nextU32());
    }

    this.ctx = {
      tick: 0,
      input: this.frames[0],
      foe: this.fighters[1],
      world: this.world,
      rng: this.fighterRng[0],
      arena: this.arena,
      events: this.events,
      live: false,
    };
    this.emit({ t: 'round', phase: 'intro', round: 1, winner: -1 });
  }

  /** Ticks since the current round went live. */
  roundTick(): number {
    return this._roundTick;
  }

  private startX(slot: 0 | 1): number {
    const cx = (this.arena.minX + this.arena.maxX) / 2;
    const half = (this.config.startGap ?? DEFAULT_START_GAP) / 2;
    return slot === 0 ? cx - half : cx + half;
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  setSources(a: InputSource | null, b: InputSource | null): void {
    this.sources[0] = a ?? createNullSource();
    this.sources[1] = b ?? createNullSource();
  }

  aiContext(s: 0 | 1): AIContext {
    return {
      tick: this.tick,
      self: this.fighters[s].view,
      foe: this.fighters[1 - s].view,
      arena: this.arena,
      roundTicksLeft: this.roundTicksLeft,
      roundTick: this._roundTick,
    };
  }

  step(): void {
    this.events.length = 0;
    this.tick++;
    for (let s = 0; s < 2; s++) this.sources[s]!.poll(this.tick, this.frames[s]!);

    if (this.hitstopTicks > 0) {
      this.hitstopTicks--;
      for (let s = 0; s < 2; s++) accumulateInput(this.acc[s]!, this.frames[s]!);
      this.refreshTimeScale();
      return;
    }
    // Deliver any presses made during hit-stop merged into this tick's frame (the fighter's buffer then covers them).
    for (let s = 0; s < 2; s++) {
      const f = this.frames[s]!;
      const a = this.acc[s]!;
      if (a.pressed | a.released) {
        f.pressed |= a.pressed;
        f.released |= a.released;
        a.pressed = 0;
        a.released = 0;
      }
    }

    this.phaseTick++;
    switch (this.phase) {
      case 'intro':
        this.stepFighters(false);
        if (this.phaseTick >= ROUND_INTRO_TICKS) this.enterPhase('fight');
        break;
      case 'fight':
        this._roundTick++;
        this.stepFighters(true);
        if (!this.config.infinite) this.roundTicksLeft--;
        this.checkRoundEnd();
        break;
      case 'ko':
        this.stepFighters(false);
        if (this.phaseTick >= KO_PHASE_TICKS) this.enterPhase('roundend');
        break;
      case 'timeover':
        this.stepFighters(false);
        if (this.phaseTick >= TIMEOVER_PHASE_TICKS) this.enterPhase('roundend');
        break;
      case 'roundend':
        this.stepFighters(false);
        if (this.phaseTick >= ROUND_OUTRO_TICKS) this.nextRoundOrEnd();
        break;
      case 'matchend':
        this.stepFighters(false);
        break;
    }
    this.absorbEvents();
    this.refreshTimeScale();
  }

  private stepFighters(live: boolean): void {
    const ctx = this.ctx;
    ctx.tick = this.tick;
    ctx.live = live;
    const first = (this.tick & 1) as 0 | 1;
    for (let n = 0; n < 2; n++) {
      const s = ((first + n) & 1) as 0 | 1;
      ctx.input = this.frames[s]!;
      ctx.foe = this.fighters[1 - s]!;
      ctx.rng = this.fighterRng[s]!;
      this.fighters[s]!.tick(ctx);
    }
    // the world ticks AFTER both fighters have set their transforms and applied their hits
    this.world.tick();
    this.world.drainEvents(this.events);
  }

  /** Pull hit-stop / time-scale requests out of the event list (fighters and world emit them like any event). */
  private absorbEvents(): void {
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (e.t === 'hitstop') {
        const t = clamp(Math.round(e.ticks), HITSTOP_MIN_TICKS, HITSTOP_MAX_TICKS);
        if (t > this.hitstopTicks) this.hitstopTicks = t;
        this.fighters[0].freeze(t);
        this.fighters[1].freeze(t);
      } else if (e.t === 'timescale') {
        this.tsScale = clamp(e.scale, 0.05, 1);
        this.tsTicks = Math.max(this.tsTicks, e.ticks);
      }
    }
  }

  private refreshTimeScale(): void {
    let s = 1;
    if (this.phase === 'ko') {
      s =
        this.phaseTick < KO_SLOWMO_TICKS
          ? KO_TIME_SCALE
          : KO_TIME_SCALE +
            ((1 - KO_TIME_SCALE) * (this.phaseTick - KO_SLOWMO_TICKS)) / (KO_PHASE_TICKS - KO_SLOWMO_TICKS);
    }
    if (this.tsTicks > 0) {
      this.tsTicks--;
      s = Math.min(s, this.tsScale);
    }
    this.timeScale = clamp(s, 0.05, 1);
  }

  private enterPhase(p: RoundPhase): void {
    this.phase = p;
    this.phaseTick = 0;
    if (p === 'fight') {
      this.emit({ t: 'round', phase: 'fight', round: this.round, winner: -1 });
    } else if (p === 'roundend') {
      if (this.roundWinner !== -1) {
        this.wins[this.roundWinner]++;
        this.fighters[this.roundWinner].setVictory();
      }
      this.emit({ t: 'round', phase: 'end', round: this.round, winner: this.roundWinner });
    }
  }

  private checkRoundEnd(): void {
    const k0 = this.fighters[0].view.ko;
    const k1 = this.fighters[1].view.ko;
    if (this.config.infinite) {
      // Training: nothing ends; a KO'd dummy is rebuilt after a beat.
      if (k0 || k1) {
        if (++this.infiniteKoTicks >= INFINITE_RESET_DELAY) {
          this.infiniteKoTicks = 0;
          this.resetFighters(1);
        }
      }
      return;
    }
    if (k0 || k1) {
      this.roundWinner = k0 && k1 ? this.tieBreak() : k0 ? 1 : 0;
      this.phase = 'ko';
      this.phaseTick = 0;
      this.emit({ t: 'round', phase: 'ko', round: this.round, winner: this.roundWinner });
      return;
    }
    if (this.roundTicksLeft <= 0) {
      this.roundWinner = this.tieBreak();
      this.phase = 'timeover';
      this.phaseTick = 0;
      this.emit({ t: 'round', phase: 'timeover', round: this.round, winner: this.roundWinner });
    }
  }

  /** Higher integrity wins; then higher mass fraction; a dead heat is decided by the seeded RNG (never a stalemate). */
  private tieBreak(): 0 | 1 {
    const a = this.fighters[0].view;
    const b = this.fighters[1].view;
    if (a.integrityPct !== b.integrityPct) return a.integrityPct > b.integrityPct ? 0 : 1;
    if (a.bodyStats.massFrac !== b.bodyStats.massFrac)
      return a.bodyStats.massFrac > b.bodyStats.massFrac ? 0 : 1;
    return this.rng.chance(0.5) ? 0 : 1;
  }

  private nextRoundOrEnd(): void {
    const w = this.wins[0] >= ROUNDS_TO_WIN ? 0 : this.wins[1] >= ROUNDS_TO_WIN ? 1 : -1;
    if (w !== -1) {
      this.winner = w;
      this.phase = 'matchend';
      this.phaseTick = 0;
      this.emit({ t: 'round', phase: 'match', round: this.round, winner: w });
      return;
    }
    this.round++;
    this.roundTicksLeft = ROUND_TIME_TICKS;
    this._roundTick = 0;
    this.roundWinner = -1;
    this.resetFighters(ROUND_HEAL_FRACTION);
    this.phase = 'intro';
    this.phaseTick = 0;
    this.emit({ t: 'round', phase: 'intro', round: this.round, winner: -1 });
  }

  private resetFighters(heal: number): void {
    for (const f of this.fighters) {
      const s = f.slot;
      f.nextRound(
        this.startX(s),
        this.arena.restY,
        s === 0 ? 1 : -1,
        heal,
        this.rng.fork(`round${this.round}-${s}`).nextU32(),
      );
    }
  }

  hash(): number {
    let h = hash32(
      this.world.hash(),
      this.tick,
      this.phase.length,
      this.round,
      this.wins[0],
      this.wins[1],
      this.roundTicksLeft,
      this.hitstopTicks,
    );
    for (const f of this.fighters) {
      const v = f.view;
      h = hash32(
        h,
        q(v.x, 16),
        q(v.y, 16),
        q(v.vx, 16),
        q(v.vy, 16),
        v.facing,
        v.moveTick,
        v.phaseTick,
        v.hitstunTicks,
        q(v.chargeFrac, 255),
        q(v.resource, 64),
        q(v.meter, 1000),
        q(v.bodyStats.massFrac, 10000),
        v.ko ? 1 : 0,
      );
    }
    return h >>> 0;
  }
}

export function createMatch(config: MatchConfig, deps: MatchDeps): Match {
  return new Match(config, deps);
}
