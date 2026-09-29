import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEY,
  createMemoryStore,
  emptyPersisted,
  loadPersisted,
  parsePersisted,
  savePersisted,
} from './storage';
import type { KeyValueStore } from './types';

describe('persistence', () => {
  it('round-trips settings, per-device bindings/calibration/rotation and keyboard remaps', () => {
    const store = createMemoryStore();
    const p = emptyPersisted();
    p.settings = { deadzone: 0.25, labelMode: 'xbox', confirmMode: 'positional', rumble: 0.5 };
    p.hid = true;
    p.devices['057e:2009:standard'] = {
      bindings: { strike: [{ k: 'b', i: 7 }], crush: [{ k: 'a', i: 5, s: -1 }], guard: [{ k: 'h', d: 'u' }] },
      calL: { cx: 0.05, cy: -0.02, minX: 0.9, maxX: 0.95, minY: 0.88, maxY: 0.92 },
      rotation: 1,
    };
    p.keyboards.kb1 = { keys: { strike: ['KeyH'] } };
    expect(savePersisted(store, p)).toBe(true);
    expect(loadPersisted(store)).toEqual(p);
  });
  it('drops garbage without throwing', () => {
    expect(parsePersisted('not json')).toEqual(emptyPersisted());
    expect(parsePersisted('null')).toEqual(emptyPersisted());
    expect(parsePersisted(null)).toEqual(emptyPersisted());
    const p = parsePersisted(
      JSON.stringify({
        settings: { deadzone: 9, labelMode: 'sega', confirmMode: 'label', rumble: -3 },
        devices: {
          x: {
            bindings: {
              strike: [{ k: 'b', i: -1 }, { k: 'b', i: 3 }, { k: 'zz' }],
              notanaction: [{ k: 'b', i: 1 }],
            },
            calL: { cx: 'a' },
            rotation: 7,
          },
        },
        keyboards: { kb1: { keys: { strike: [1, 'KeyQ'] } } },
      }),
    );
    expect(p.settings).toEqual({ deadzone: 0.45, confirmMode: 'label', rumble: 0 });
    expect(p.devices.x).toEqual({ bindings: { strike: [{ k: 'b', i: 3 }] }, rotation: 3 });
    expect(p.keyboards.kb1).toEqual({ keys: { strike: ['KeyQ'] } });
  });
  it('clamps calibration into a plausible range', () => {
    const p = parsePersisted(
      JSON.stringify({ devices: { d: { calL: { cx: 5, cy: -5, minX: 0, maxX: 9, minY: 1, maxY: 1 } } } }),
    );
    expect(p.devices.d!.calL).toEqual({ cx: 0.6, cy: -0.6, minX: 0.3, maxX: 1.6, minY: 1, maxY: 1 });
  });
  it('survives a storage that throws on read or write, or is absent', () => {
    const bad: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadPersisted(bad)).toEqual(emptyPersisted());
    expect(savePersisted(bad, emptyPersisted())).toBe(false);
    expect(loadPersisted(null)).toEqual(emptyPersisted());
    expect(savePersisted(null, emptyPersisted())).toBe(false);
  });
  it('uses one versioned key', () => {
    expect(STORAGE_KEY).toBe('adeuk.input.v1');
  });
});
