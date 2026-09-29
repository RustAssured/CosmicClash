import type { SimEvent } from './sim';
import type { StageId } from './render';
import type { TitanId } from './titan';

/** UI-originated sounds (menus). Sim-originated audio comes straight from SimEvent. */
export type UiSoundId =
  'move' | 'confirm' | 'back' | 'select' | 'error' | 'start' | 'pause' | 'unpause' | 'roundwin' | 'tick';
export interface UiSoundEvent {
  t: 'ui';
  id: UiSoundId;
}

export type AudioEvent = SimEvent | UiSoundEvent;

export interface AudioFighterScene {
  titan: TitanId;
  /** World x for stereo pan relative to the listener. */
  x: number;
  speed: number;
  massFrac: number;
  /** 0..1 charge / resource / meter. */
  charge: number;
  resource: number;
  meter: number;
  state: string;
}

export interface AudioScene {
  phase: 'menu' | 'fight' | 'pause' | 'results' | 'attract';
  stage: StageId | null;
  /** 0..1 fight intensity (damage rate, proximity, low integrity). Drives drone + rhythm layers. */
  intensity: number;
  listenerX: number;
  fighters: [AudioFighterScene, AudioFighterScene] | null;
  /** Round outcome hints. */
  lowestIntegrity: number;
  timeScale: number;
}

export interface AudioVolumes {
  master: number;
  music: number;
  sfx: number;
}

/** Fully procedural WebAudio engine (no external assets). Latency target: hit → sound ≤ 50 ms. */
export interface AudioEngine {
  /** Create/resume the AudioContext. Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): Promise<void>;
  /** Fire one-shots. Called every frame with the events since last call (cheap when empty). */
  handle(events: readonly AudioEvent[]): void;
  /** Continuous state: adaptive score, per-titan drones. Called every frame. */
  update(scene: AudioScene, dtSec: number): void;
  setVolumes(v: Partial<AudioVolumes>): void;
  /** Peak level since last call (0..1+ pre-limiter) — used by tests to prove the limiter holds. */
  readonly ready: boolean;
  dispose(): void;
}
