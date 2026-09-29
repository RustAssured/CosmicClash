import { describe, expect, it } from 'vitest';
import { createMemoryStore, type KeyValueStore } from '@/input';
import {
  UI_STORAGE_KEY,
  defaultUISettings,
  loadUISettings,
  parseUISettings,
  saveUISettings,
} from './settings';

describe('UI settings', () => {
  it('round-trips through storage', () => {
    const store = createMemoryStore();
    const s = {
      ...defaultUISettings(),
      master: 3,
      quality: 1 as const,
      lastP1: 'planet' as const,
      aiLevel: 6 as const,
    };
    saveUISettings(store, s);
    expect(loadUISettings(store)).toEqual(s);
  });
  it('clamps and sanitises garbage', () => {
    const s = parseUISettings(
      JSON.stringify({
        master: 99,
        music: -4,
        sfx: 'x',
        quality: 7,
        lastP1: 'nope',
        lastStage: 'rim',
        aiLevel: 0,
      }),
    );
    expect(s).toMatchObject({
      master: 10,
      music: 0,
      sfx: 8,
      quality: 2,
      lastP1: 'lastone',
      lastStage: 'rim',
      aiLevel: 1,
    });
    expect(parseUISettings('not json')).toEqual(defaultUISettings());
    expect(parseUISettings(null)).toEqual(defaultUISettings());
  });
  it('survives storage that throws or is absent', () => {
    const bad: KeyValueStore = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(loadUISettings(bad)).toEqual(defaultUISettings());
    expect(() => saveUISettings(bad, defaultUISettings())).not.toThrow();
    expect(loadUISettings(null)).toEqual(defaultUISettings());
    expect(UI_STORAGE_KEY).toBe('adeuk.ui.v1');
  });
});
