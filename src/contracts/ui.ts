import type { Difficulty } from './ai';
import type { HudState, MatchConfig } from './sim';
import type { RenderLayer } from './render';

/** What the UI asks the app to do. The app owns the state machine between menus and matches. */
export type UIAction =
  | { type: 'startMatch'; config: MatchConfig }
  | { type: 'quitToTitle' }
  | { type: 'resume' }
  | { type: 'rematch' }
  | { type: 'restartRound' }
  | { type: 'unlockAudio' }
  | { type: 'setVolume'; master?: number; music?: number; sfx?: number }
  | { type: 'setQuality'; quality: 0 | 1 | 2 }
  /** Training: what the dummy does. */
  | { type: 'setDummy'; mode: 'idle' | 'guard' | 'ai' }
  | { type: 'resetPositions' }
  | { type: 'healBoth' }
  | { type: 'toggleTraining' }
  | { type: 'setTrainingView'; overlay: 'off' | 'hitboxes' | 'matter' }
  | { type: 'attractStart' }
  | { type: 'attractStop' };

export type UIScreenId =
  | 'boot'
  | 'title'
  | 'mode'
  | 'assign'
  | 'select'
  | 'stage'
  | 'controller'
  | 'options'
  | 'hud'
  | 'pause'
  | 'results'
  | 'attract';

/** Pixel-art UI/HUD. Renders into ONE screen-space layer at logical resolution (crisp, composited last). */
export interface GameUI {
  readonly screen: UIScreenId;
  readonly layer: RenderLayer;
  /** Called by the app whenever the UI should act on input (menus at 60 Hz; also runs during matches for pause). */
  update(dtSec: number): void;
  /** Rasterise the current screen (or the HUD when `hud` is set) into `layer`. */
  draw(hud: HudState | null): void;
  /** Actions requested since the last drain. */
  drainActions(out: UIAction[]): void;
  /** Tell the UI which high-level state the app is in. */
  showHud(): void;
  showResults(winner: 0 | 1 | -1): void;
  showPause(open: boolean): void;
  showTitle(): void;
  /** Idle time on the title screen in seconds (attract mode trigger at 60 s). */
  readonly idleSeconds: number;
}

export interface DifficultyLabel {
  level: Difficulty;
  name: string;
  nameKo: string;
}
