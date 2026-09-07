export const SETTINGS_STORAGE_KEY = 'typewriter.settings.v1';

export const BACKGROUND_PRESETS = Object.freeze([
  Object.freeze({ key: 'manuscript', label: '원고', color: '#f6f3ee' }),
  Object.freeze({ key: 'blank', label: '여백', color: '#fbfbfa' }),
  Object.freeze({ key: 'fog', label: '안개', color: '#f1f4f6' }),
  Object.freeze({ key: 'old-book', label: '고서', color: '#f3ede2' }),
  Object.freeze({ key: 'leaf', label: '잎새', color: '#f0f3ed' }),
  Object.freeze({ key: 'moonlight', label: '달빛', color: '#f2f0f4' }),
]);

export const DEFAULT_BACKGROUND_PRESET = BACKGROUND_PRESETS[0].key;

export const SETTING_KEYS = Object.freeze([
  'definition',
  'synonyms',
  'antonyms',
  'texture',
  'association',
  'background',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  definition: true,
  synonyms: true,
  antonyms: false,
  texture: true,
  association: false,
  background: DEFAULT_BACKGROUND_PRESET,
});

export const SETTING_DEFINITIONS = Object.freeze([
  {
    key: 'definition',
    label: '뜻풀이',
    description: '기본 뜻을 표시합니다.',
  },
  {
    key: 'synonyms',
    label: '유의어',
    description: '직접 바꾸어 쓸 수 있는 말을 표시합니다.',
  },
  {
    key: 'antonyms',
    label: '반의어',
    description: '반대되는 뜻의 말을 표시합니다.',
  },
  {
    key: 'texture',
    label: '말의 결',
    description: '비슷한 정서와 분위기의 말을 표시합니다.',
  },
  {
    key: 'association',
    label: '연상',
    description: '관련 장면, 감각, 행동, 이미지를 표시합니다.',
  },
]);

export function getBackgroundPreset(value) {
  return BACKGROUND_PRESETS.find((preset) => preset.key === value) || BACKGROUND_PRESETS[0];
}

export function normalizeSettings(value) {
  const candidate = value && typeof value === 'object' ? value : {};

  return Object.fromEntries(
    [
      ...SETTING_KEYS.filter((key) => key !== 'background').map((key) => [
        key,
        candidate[key] === undefined ? DEFAULT_SETTINGS[key] : Boolean(candidate[key]),
      ]),
      ['background', getBackgroundPreset(candidate.background).key],
    ],
  );
}

function getExtensionStorage() {
  return globalThis.chrome?.storage?.local || null;
}

function getFallbackStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readExtensionStorage(storage) {
  if (!storage || typeof storage.get !== 'function') {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const onResolve = (value) => finish(resolve, value);
    const onReject = (error) => finish(reject, error);

    try {
      const result = storage.get.length >= 2
        ? storage.get(SETTINGS_STORAGE_KEY, onResolve)
        : storage.get(SETTINGS_STORAGE_KEY);

      if (result && typeof result.then === 'function') {
        result.then(onResolve, onReject);
      } else if (result !== undefined && storage.get.length < 2) {
        onResolve(result);
      }
    } catch (error) {
      onReject(error);
    }
  });
}

function writeExtensionStorage(storage, settings) {
  if (!storage || typeof storage.set !== 'function') {
    return Promise.resolve();
  }

  const payload = { [SETTINGS_STORAGE_KEY]: settings };
  try {
    const result = storage.set.length >= 2
      ? storage.set(payload, () => {})
      : storage.set(payload);
    return result && typeof result.then === 'function' ? result : Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

function readFallbackStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return null;
  }

  const raw = storage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeFallbackStorage(storage, settings) {
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }

  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function createSettingsStore({ storage, fallbackStorage } = {}) {
  const extensionStorage = storage === undefined ? getExtensionStorage() : storage;
  const fallback = fallbackStorage === undefined ? getFallbackStorage() : fallbackStorage;

  return {
    async load() {
      if (extensionStorage) {
        const result = await readExtensionStorage(extensionStorage);
        const stored = result?.[SETTINGS_STORAGE_KEY] ?? result;
        if (stored && typeof stored === 'object') {
          return normalizeSettings(stored);
        }
      }

      return normalizeSettings(readFallbackStorage(fallback));
    },

    async save(value) {
      const settings = normalizeSettings(value);
      if (extensionStorage) {
        await writeExtensionStorage(extensionStorage, settings);
      } else {
        writeFallbackStorage(fallback, settings);
      }
      return settings;
    },
  };
}
