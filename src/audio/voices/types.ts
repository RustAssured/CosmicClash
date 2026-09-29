import type { AudioFighterScene, SimEvent, TitanId } from '@/contracts';

type Ev<T extends SimEvent['t']> = Extract<SimEvent, { t: T }>;
export type MoveEvent = Ev<'move'>;
export type ChargeEvent = Ev<'charge'>;
export type ReleaseEvent = Ev<'release'>;
export type SurgeEvent = Ev<'surge'>;
export type HitEvent = Ev<'hit'>;
export type GuardEvent = Ev<'guard'>;
export type KoEvent = Ev<'ko'>;
export type UltimateEvent = Ev<'ultimate'>;
export type CueEvent = Ev<'cue'>;
export type MatterEvent = Ev<'matter'>;

/**
 * Everything a one-shot sound needs. The engine builds one per event batch. All scheduling is against `ac.currentTime`-based
 * times (`t`), never wall-clock, so the same code renders identically through an OfflineAudioContext.
 */
export interface VoiceCtx {
  ac: BaseAudioContext;
  /** Dry sfx bus input. */
  dry: AudioNode;
  /** Reverb send input (high-passed inside the graph so sub-bass never muddies the tail). */
  wet: AudioNode;
  /** 2 s of white noise / brown noise, shared by every voice. */
  noise: AudioBuffer;
  brown: AudioBuffer;
  /** Deterministic 0..1 stream (seeded per engine), for per-event variation. */
  rand(): number;
  /** World x → stereo position −1..1 relative to the listener. */
  panOf(x: number): number;
  /** Voice budget: false if the engine is at its polyphony cap and this sound (of priority `prio` 0..2) should be dropped. */
  take(prio: number): boolean;
  release(): void;
  /** Momentary slowdown of the world (KO dilation): 1 = normal. Voices scale pitch/durations by it where it makes sense. */
  timeScale: number;
}

export interface FighterCtx {
  slot: 0 | 1;
  titan: TitanId;
}

/**
 * A titan's sonic signature. One file implements this. Every handler is optional: anything a voice does not handle falls back
 * to the shared, titan-neutral sounds in `sfx.ts` — so a new titan can ship with a partial voice.
 */
export interface TitanVoice {
  readonly titan: TitanId;
  /** A move enters startup (the wind-up cue). */
  onMove?(c: VoiceCtx, t: number, ev: MoveEvent): void;
  /** Hold-to-charge progress: 'start' begins a sustained voice, 'hold' updates it (frac 0..1), 'release' ends it. */
  onCharge?(c: VoiceCtx, t: number, ev: ChargeEvent): void;
  /** The active phase begins: the whoosh / boom of the move itself. */
  onRelease?(c: VoiceCtx, t: number, ev: ReleaseEvent): void;
  onSurge?(c: VoiceCtx, t: number, ev: SurgeEvent): void;
  /** This titan's blow landed on something (adds the titan's own flavour to the damage-type layer). */
  onHitDealt?(c: VoiceCtx, t: number, ev: HitEvent, mag: number): void;
  /** This titan's BODY was hit: the material's voice (glass ring, rock crunch). */
  onHitTaken?(c: VoiceCtx, t: number, ev: HitEvent, mag: number): void;
  onGuard?(c: VoiceCtx, t: number, ev: GuardEvent): void;
  onKo?(c: VoiceCtx, t: number, ev: KoEvent): void;
  onUltimate?(c: VoiceCtx, t: number, ev: UltimateEvent): void;
  onCue?(c: VoiceCtx, t: number, ev: CueEvent): void;
  /** Return true if handled; false/undefined falls back to the generic matter sound (so no event kind is ever silent). */
  onMatter?(c: VoiceCtx, t: number, ev: MatterEvent): boolean | void;
  /** Continuous voice for the fighter in `slot` (breathing pad, tumble rumble). Called every frame; return value unused. */
  update?(c: VoiceCtx, scene: AudioFighterScene, slot: 0 | 1, dt: number): void;
  /** Called when the fighter leaves the scene or the engine is disposed. */
  stop?(slot: 0 | 1 | 'all'): void;
}
