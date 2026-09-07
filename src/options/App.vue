<script setup>
import { computed, onMounted, ref } from 'vue';

import DictionaryPanel from '../components/DictionaryPanel.vue';
import ToggleControl from '../components/ToggleControl.vue';
import { projectRecord } from '../domain/index.js';
import {
  BACKGROUND_PRESETS,
  createSettingsStore,
  DEFAULT_SETTINGS,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  normalizeSettings,
} from '../ui/settings.js';
import { PREVIEW_RECORD } from '../components/preview-record.js';

const props = defineProps({
  settingsStore: {
    type: Object,
    default: null,
  },
});

const settingsStore = props.settingsStore || createSettingsStore();
const settings = ref({ ...DEFAULT_SETTINGS });
const savedSettings = ref({ ...DEFAULT_SETTINGS });
const settingsReady = ref(false);
const saveState = ref('saved');
const saving = ref(false);
const productVersion = globalThis.chrome?.runtime?.getManifest?.().version || '0.3.0';

const previewRecord = computed(() => projectRecord(PREVIEW_RECORD));
const isDirty = computed(() => (
  settingsReady.value
  && SETTING_KEYS.some((key) => settings.value[key] !== savedSettings.value[key])
));
const saveStatus = computed(() => {
  if (!settingsReady.value) return '불러오는 중';
  if (saving.value) return '저장 중';
  if (saveState.value === 'error') return '저장 실패';
  if (saveState.value === 'fallback') return '기본값 사용';
  return isDirty.value ? '저장되지 않음' : '저장됨';
});

async function loadSettings() {
  try {
    const loaded = normalizeSettings(await settingsStore.load());
    settings.value = loaded;
    savedSettings.value = { ...loaded };
    saveState.value = 'saved';
  } catch {
    settings.value = { ...DEFAULT_SETTINGS };
    savedSettings.value = { ...DEFAULT_SETTINGS };
    saveState.value = 'fallback';
  } finally {
    settingsReady.value = true;
  }
}

async function saveSettings() {
  if (!settingsReady.value || saving.value || !isDirty.value) return;

  saving.value = true;
  saveState.value = 'saving';
  const snapshot = normalizeSettings(settings.value);
  try {
    const result = await settingsStore.save(snapshot);
    const persisted = normalizeSettings(result ?? snapshot);
    settings.value = { ...persisted };
    savedSettings.value = { ...persisted };
    saveState.value = 'saved';
  } catch {
    saveState.value = 'error';
  } finally {
    saving.value = false;
  }
}

function updateSetting(key, value) {
  if (!settingsReady.value || saving.value) return;

  settings.value = {
    ...settings.value,
    [key]: value,
  };
  saveState.value = 'dirty';
}

onMounted(() => {
  void loadSettings();
});
</script>

<template>
  <main class="settings-app" data-product-surface="options">
    <span class="sr-only">말의 결을 찾는 사전</span>
    <header class="options-header">
      <div class="brand-lockup">
        <img class="brand-mark" src="/logo.png" alt="" />
        <span class="brand-name">Typewriter</span>
        <span class="brand-version">{{ productVersion }}</span>
      </div>
      <div class="save-controls">
        <span
          class="save-status"
          :class="{
            'is-error': saveState === 'error',
            'is-dirty': isDirty,
            'is-saving': saveState === 'saving',
          }"
          aria-live="polite"
        >
          {{ saveStatus }}
        </span>
        <button
          class="save-button"
          :class="{ 'is-inactive': !isDirty || saving || !settingsReady }"
          type="button"
          :disabled="!settingsReady || saving || !isDirty"
          @click="saveSettings"
        >
          저장
        </button>
      </div>
    </header>

    <section class="settings-workspace">
      <div class="settings-column">
        <h1>검색 결과</h1>
        <p class="page-description">팝업에 표시할 검색 결과 항목을 선택합니다.</p>
        <section class="settings-card" aria-labelledby="settings-card-title">
          <h2 id="settings-card-title">검색 결과 표시</h2>
          <p class="card-description">필요한 항목만 켜고 끌 수 있습니다.</p>
          <div class="setting-list">
            <div v-for="setting in SETTING_DEFINITIONS" :key="setting.key" class="setting-row">
              <div class="setting-copy">
                <strong>{{ setting.label }}</strong>
                <span>{{ setting.description }}</span>
              </div>
              <ToggleControl
                :model-value="settings[setting.key]"
                :label="setting.label + ' 표시'"
                :disabled="!settingsReady || saving"
                @update:model-value="updateSetting(setting.key, $event)"
              />
            </div>
          </div>
        </section>
      </div>

      <div class="preview-column">
        <h1>미리보기</h1>
        <p class="page-description">현재 설정에 따라 팝업 결과가 어떻게 보이는지 확인할 수 있습니다.</p>
        <section class="preview-panel" aria-label="검색 결과 미리보기">
          <DictionaryPanel
            query="쓸쓸하다"
            :records="[previewRecord]"
            status="ready"
            :settings="settings"
            compact
            :interactive="false"
          />
        </section>
      </div>

      <section class="background-card" aria-labelledby="background-card-title">
        <h2 id="background-card-title">배경색</h2>
        <p class="card-description">오늘의 기분에 어울리는 빛깔을 골라보세요.</p>
        <div class="background-preset-list" role="radiogroup" aria-label="팝업 배경색">
          <button
            v-for="preset in BACKGROUND_PRESETS"
            :key="preset.key"
            class="background-preset"
            :class="{ 'is-selected': settings.background === preset.key }"
            :style="{ '--background-preset-color': preset.color }"
            :data-background-preset-key="preset.key"
            type="button"
            role="radio"
            :aria-checked="String(settings.background === preset.key)"
            :aria-label="`팝업 배경색 ${preset.label}`"
            :disabled="!settingsReady || saving"
            @click="updateSetting('background', preset.key)"
          >{{ preset.label }}</button>
        </div>
      </section>
    </section>
  </main>
</template>
