import { describe, expect, it } from 'vitest';

import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTINGS_STORAGE_KEY,
} from '../src/ui/settings.js';

describe('settings storage', () => {
  it('normalizes the supported display settings and background preset', () => {
    expect(normalizeSettings({
      definition: 0,
      synonyms: 'yes',
      background: 'unknown',
      unknown: true,
    })).toEqual({
      definition: false,
      synonyms: true,
      antonyms: false,
      texture: true,
      association: false,
      background: DEFAULT_SETTINGS.background,
    });
  });

  it('persists and reloads settings through extension local storage', async () => {
    let payload = {};
    const storage = {
      get: async () => payload,
      set: async (next) => {
        payload = next;
      },
    };
    const store = createSettingsStore({ storage, fallbackStorage: null });

    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    await store.save({
      ...DEFAULT_SETTINGS,
      association: true,
      texture: false,
      background: 'fog',
    });

    expect(payload[SETTINGS_STORAGE_KEY]).toMatchObject({
      association: true,
      texture: false,
      background: 'fog',
    });
    expect(await store.load()).toEqual({
      ...DEFAULT_SETTINGS,
      association: true,
      texture: false,
      background: 'fog',
    });
  });
});
