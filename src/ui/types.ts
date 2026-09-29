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

/** Training-mode requests that the current `UIAction` union cannot carry (see docs/proposals/001). */
export type UIExtraAction =
  { type: 'setDummy'; mode: 'idle' | 'guard' | 'ai' } | { type: 'resetPositions' } | { type: 'healBoth' };

export interface UIDeps {
  input: InputManager;
  titans: readonly TitanInfo[];
  portrait: PortraitProvider;
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
  /** Called when the render-quality option changes (`UIAction` has no slot for it; see proposal 001). */
  onQuality?: (q: 0 | 1 | 2) => void;
  /** Called for training commands beyond the `UIAction` union. */
  onExtra?: (a: UIExtraAction) => void;
  /** Version label shown on the title screen. */
  version?: string;
  /** Wall clock (ms) for idle timers; default `performance.now`. */
  now?: () => number;
  /** Idle seconds on the title before attract mode starts (default 60). */
  attractAfterSec?: number;
}

export type ImplementedSet = ReadonlySet<string>;
