import type {
  DamageType,
  StageId,
  StageInfo,
  TitanAttributes,
  TitanDef,
  TitanId,
  UiSoundId,
} from '@/contracts';
import type { InputManager, KeyValueStore } from '@/input';
import type { OnlineUiPort } from '@/net/types';
import type { LadderTitan } from './ladder';

/** What the select screen needs to know about a titan. Build it from a `TitanDef` with `titanInfoFromDef`. */
export interface TitanInfo {
  id: TitanId;
  name: string;
  nameKo: string;
  epithet: string;
  /** Hex accent colours (from `TitanDef.ui`). */
  accent: string;
  accent2: string;
  tagline: string;
  attributes: TitanAttributes;
  resource: { name: string; nameKo: string; display: 'pips' | 'bar'; max: number };
  destruction: DamageType;
  passive: { name: string; text: string };
  failureMode: { name: string; text: string };
}

export function titanInfoFromDef(def: TitanDef): TitanInfo {
  return {
    id: def.id,
    name: def.name,
    nameKo: def.nameKo,
    epithet: def.epithet,
    accent: def.ui.accent,
    accent2: def.ui.accent2,
    tagline: def.ui.tagline,
    attributes: def.attributes,
    resource: {
      name: def.resource.name,
      nameKo: def.resource.nameKo,
      display: def.resource.display,
      max: def.resource.max,
    },
    destruction: def.destruction,
    passive: def.passive,
    failureMode: def.failureMode,
  };
}

/** A sprite the UI may blit or resample. */
export interface PortraitSprite {
  pixels: Uint32Array;
  w: number;
  h: number;
}

/** The app wires this to the titan generator (`MatterMap.pixels` of a fresh pristine body); dev/ui uses synthetic sprites. */
export type PortraitProvider = (id: TitanId) => PortraitSprite | null;

export interface UIDeps {
  input: InputManager;
  titans: readonly TitanInfo[];
  portrait: PortraitProvider;
  /**
   * Are the wordmark's bead portraits generated yet (src/ui/pixel/wordmark.ts)? Until then the boot and title screens draw
   * the wordmark without its beads, so they never wait on the titan generator. Absent: always (fixture portraits are cheap).
   */
  portraitsWarm?: () => boolean;
  stages: readonly StageInfo[];
  /** Titans / stages that can actually be played right now. Others are shown greyed as "coming soon". */
  implementedTitans: readonly TitanId[];
  implementedStages: readonly StageId[];
  /** Persistence for UI preferences (volumes, quality, last picks). Omit for `localStorage`; `null` for none. */
  storage?: KeyValueStore | null;
  /** Menu sounds: wire to `audio.handle([{ t: 'ui', id }])`. */
  sound?: (id: UiSoundId) => void;
  /** Seed source for `startMatch` (default: a time-derived seed). */
  newSeed?: () => number;
  /** Version label shown on the title screen. */
  version?: string;
  /** Wall clock (ms) for idle timers; default `performance.now`. */
  now?: () => number;
  /** Idle seconds on the title before attract mode starts (default 60). */
  attractAfterSec?: number;
  /**
   * Titans hidden from the select until unlocked (the Mouth, D37): named on the tournament tower, joined to the roster by
   * `UICtx.unlockTitan` (the ladder, when the final boss falls).
   */
  lockedTitans?: readonly TitanInfo[];
  /** The app persists an unlock (`setMouthUnlocked(true)`) and adds the titan to its own roster. */
  onUnlock?: (id: TitanId) => void;
  /**
   * The roster's tournament data (`ladderRoster()` from src/titans/roster.ts): tier, home stage, ship date, catalogue
   * number, WIP flag. COSMIC CLASH builds its lineup from it; without it the offered titans stand in (tier 2 each).
   */
  roster?: readonly LadderTitan[];
  /** Today's date (epoch ms) for the NEW tags; default `Date.now`. */
  today?: () => number;
  /** The online session (src/net/online.ts) the ONLINE screens drive; absent: the menu item says it is unavailable. */
  online?: OnlineUiPort;
}

export type ImplementedSet = ReadonlySet<string>;
