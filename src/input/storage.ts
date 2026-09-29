import {
  ACTIONS,
  DEFAULT_SETTINGS,
  type Action,
  type ConfirmMode,
  type InputSettings,
  type KeyRef,
  type KeyValueStore,
  type LabelMode,
  type RawRef,
  type StickCalibration,
} from './types';

/**
 * Persistence. `localStorage` can throw (private windows, blocked site data), return null, or hold garbage written by an
 * older build — the game must work without it, so every access is guarded and everything read back is sanitised.
 */
export const STORAGE_KEY = 'adeuk.input.v1';

export interface DeviceOverrides {
  bindings?: Partial<Record<Action, RawRef[]>>;
  calL?: StickCalibration | null;
  calR?: StickCalibration | null;
  /** Quarter-turn rotation override; absent = profile default. */
  rotation?: number;
}
export interface KeyboardOverrides {
  keys?: Partial<Record<Action, KeyRef[]>>;
}
export interface PersistedInput {
  v: 1;
  /** The player enabled the WebHID enhancement: reconnect to the already-permitted pad silently on launch. */
  hid?: boolean;
  settings: Partial<InputSettings>;
  devices: Record<string, DeviceOverrides>;
  keyboards: Record<string, KeyboardOverrides>;
}

export const emptyPersisted = (): PersistedInput => ({ v: 1, settings: {}, devices: {}, keyboards: {} });

/** In-memory store, used when the browser has none (and by tests). */
export function createMemoryStore(
  initial: Record<string, string> = {},
): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** `window.localStorage` or null — never throws. */
export function browserStore(): KeyValueStore | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Some browsers hand back a store whose first write throws (quota 0 / Safari private); probe once.
    const probe = '__adeuk_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function sanitizeRef(v: unknown): RawRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.k === 'b' && isNum(o.i) && Number.isInteger(o.i) && o.i >= 0 && o.i < 64) return { k: 'b', i: o.i };
  if (o.k === 'a' && isNum(o.i) && Number.isInteger(o.i) && o.i >= 0 && o.i < 64 && (o.s === 1 || o.s === -1))
    return { k: 'a', i: o.i, s: o.s };
  if (o.k === 'h' && (o.d === 'u' || o.d === 'd' || o.d === 'l' || o.d === 'r')) return { k: 'h', d: o.d };
  return null;
}

function sanitizeCal(v: unknown): StickCalibration | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const keys = ['cx', 'cy', 'minX', 'maxX', 'minY', 'maxY'] as const;
  for (const k of keys) if (!isNum(o[k])) return null;
  return {
    cx: clamp(o.cx as number, -0.6, 0.6),
    cy: clamp(o.cy as number, -0.6, 0.6),
    minX: clamp(o.minX as number, 0.3, 1.6),
    maxX: clamp(o.maxX as number, 0.3, 1.6),
    minY: clamp(o.minY as number, 0.3, 1.6),
    maxY: clamp(o.maxY as number, 0.3, 1.6),
  };
}

export function sanitizeSettings(v: unknown): Partial<InputSettings> {
  const out: Partial<InputSettings> = {};
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (isNum(o.deadzone)) out.deadzone = clamp(o.deadzone, 0.05, 0.45);
  if (
    o.labelMode === 'auto' ||
    o.labelMode === 'nintendo' ||
    o.labelMode === 'xbox' ||
    o.labelMode === 'playstation'
  )
    out.labelMode = o.labelMode as LabelMode;
  if (o.confirmMode === 'label' || o.confirmMode === 'positional')
    out.confirmMode = o.confirmMode as ConfirmMode;
  if (isNum(o.rumble)) out.rumble = clamp(o.rumble, 0, 1);
  return out;
}

/** Parse + sanitise whatever is in storage. Anything malformed is dropped, never thrown. */
export function parsePersisted(raw: string | null): PersistedInput {
  const out = emptyPersisted();
  if (!raw) return out;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!j || typeof j !== 'object') return out;
  const o = j as Record<string, unknown>;
  out.settings = sanitizeSettings(o.settings);
  if (o.hid === true) out.hid = true;
  if (o.devices && typeof o.devices === 'object') {
    for (const [key, dv] of Object.entries(o.devices as Record<string, unknown>)) {
      if (!dv || typeof dv !== 'object') continue;
      const d = dv as Record<string, unknown>;
      const ov: DeviceOverrides = {};
      if (d.bindings && typeof d.bindings === 'object') {
        const b: Partial<Record<Action, RawRef[]>> = {};
        for (const a of ACTIONS) {
          const list = (d.bindings as Record<string, unknown>)[a];
          if (Array.isArray(list)) {
            const refs = list.map(sanitizeRef).filter((r): r is RawRef => r !== null);
            if (refs.length) b[a] = refs.slice(0, 4);
          }
        }
        if (Object.keys(b).length) ov.bindings = b;
      }
      const cl = sanitizeCal(d.calL);
      const cr = sanitizeCal(d.calR);
      if (cl) ov.calL = cl;
      if (cr) ov.calR = cr;
      if (isNum(d.rotation) && Number.isInteger(d.rotation)) ov.rotation = ((d.rotation % 4) + 4) % 4;
      if (Object.keys(ov).length) out.devices[key] = ov;
    }
  }
  if (o.keyboards && typeof o.keyboards === 'object') {
    for (const [key, kv] of Object.entries(o.keyboards as Record<string, unknown>)) {
      if (!kv || typeof kv !== 'object') continue;
      const keys = (kv as Record<string, unknown>).keys;
      if (!keys || typeof keys !== 'object') continue;
      const m: Partial<Record<Action, KeyRef[]>> = {};
      for (const a of ACTIONS) {
        const list = (keys as Record<string, unknown>)[a];
        if (Array.isArray(list)) {
          const codes = list.filter(
            (c): c is string => typeof c === 'string' && c.length > 0 && c.length < 24,
          );
          if (codes.length) m[a] = codes.slice(0, 4);
        }
      }
      if (Object.keys(m).length) out.keyboards[key] = { keys: m };
    }
  }
  return out;
}

export function loadPersisted(store: KeyValueStore | null): PersistedInput {
  if (!store) return emptyPersisted();
  try {
    return parsePersisted(store.getItem(STORAGE_KEY));
  } catch {
    return emptyPersisted();
  }
}

export function savePersisted(store: KeyValueStore | null, p: PersistedInput): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

export const mergeSettings = (patch: Partial<InputSettings>): InputSettings => ({
  ...DEFAULT_SETTINGS,
  ...sanitizeSettings(patch),
});
