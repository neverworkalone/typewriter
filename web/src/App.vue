<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import DictionaryPanel from '../../src/components/DictionaryPanel.vue';
import ToggleControl from '../../src/components/ToggleControl.vue';
import SiteFooter from './components/SiteFooter.vue';
import SiteHeader from './components/SiteHeader.vue';
import { SearchSession } from '../../src/domain/index.js';
import { DictionaryRuntime } from '../../src/runtime/query-adapter.js';
import {
  BACKGROUND_PRESETS,
  createSettingsStore,
  DEFAULT_SETTINGS,
  getBackgroundPreset,
  SETTING_DEFINITIONS,
} from '../../src/ui/settings.js';

const props = defineProps({
  runtime: {
    type: Object,
    default: null,
  },
  session: {
    type: Object,
    default: null,
  },
  settingsStore: {
    type: Object,
    default: null,
  },
});

const ownsRuntime = !props.runtime && !props.session;
const runtime = props.runtime || (props.session ? null : new DictionaryRuntime());
const session = props.session || new SearchSession({ runtime });
const settingsStore = props.settingsStore || createSettingsStore({ storage: null });

const examples = ['담담하다', '마음이 놓이다', '쓰다', '시작하다'];
const query = ref('');
const searchState = ref(session.state);
const settings = ref({ ...DEFAULT_SETTINGS });
const settingsError = ref(false);
const settingsOpen = ref(false);
const runtimeStatus = ref(null);
const lastRecords = ref([]);
const dictionaryPanel = ref(null);
const settingsDialog = ref(null);
const settingsCloseButton = ref(null);
let unsubscribe = null;
let stopBackgroundSync = null;
let previousBodyBackground = '';
let webHistoryIndex = 0;
let restoringBrowserHistory = false;
let suppressInitialHistoryEntry = false;
let navigationPending = false;
let previousFocus = null;

const records = computed(() => (
  searchState.value.status === 'ready'
    ? searchState.value.results
    : searchState.value.status === 'loading'
      ? lastRecords.value
      : []
));

const historyAction = computed(() => actionFromSearchState(searchState.value));
const backgroundColor = computed(() => getBackgroundPreset(settings.value.background).color);

function rootAction() {
  return { type: 'root' };
}

function actionFromSearchState(state) {
  if (state.mode === 'exact' && typeof state.query === 'string') {
    return { type: 'query', query: state.query };
  }
  if (state.mode === 'relation-target' && state.targetRecordId) {
    return {
      type: 'target',
      targetRecordId: state.targetRecordId,
      sourceSenseId: state.navigation?.sourceSenseId ?? null,
      targetSenseId: state.navigation?.targetSenseId ?? null,
      relationType: state.navigation?.relationType ?? null,
    };
  }
  return null;
}

function actionFromLocation() {
  const parameters = new URL(window.location.href).searchParams;
  const term = parameters.get('q');
  if (term) return { type: 'query', query: term };

  const targetRecordId = parameters.get('target');
  if (targetRecordId) {
    return {
      type: 'target',
      targetRecordId,
      sourceSenseId: parameters.get('sourceSense') || null,
      targetSenseId: parameters.get('targetSense') || null,
      relationType: parameters.get('relationType') || null,
    };
  }

  return null;
}

function actionUrl(action) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';

  if (action.type === 'query') {
    url.searchParams.set('q', action.query);
  } else if (action.type === 'target') {
    url.searchParams.set('target', action.targetRecordId);
    if (action.sourceSenseId) url.searchParams.set('sourceSense', action.sourceSenseId);
    if (action.targetSenseId) url.searchParams.set('targetSense', action.targetSenseId);
    if (action.relationType) url.searchParams.set('relationType', action.relationType);
  }

  return url;
}

function actionMatchesState(action, state) {
  if (!action || action.type === 'root') return state.mode === 'idle';
  if (action.type === 'query') {
    return state.mode === 'exact' && state.query === action.query;
  }
  return state.mode === 'relation-target'
    && state.targetRecordId === action.targetRecordId
    && (action.targetSenseId === null
      || state.navigation?.targetSenseId === action.targetSenseId);
}

function applyState(nextState) {
  if (nextState.status === 'loading' && nextState.mode !== 'idle') {
    navigationPending = true;
  }
  searchState.value = nextState;

  if (nextState.status === 'ready') {
    lastRecords.value = nextState.results;
  } else if (nextState.status === 'empty' || nextState.status === 'error') {
    lastRecords.value = [];
  }

  if (nextState.status === 'loading' && nextState.query !== null) {
    query.value = nextState.query;
  }
  if (nextState.status === 'ready') {
    query.value = nextState.query ?? nextState.results[0]?.lemma ?? query.value;
  } else if (nextState.status === 'idle' && nextState.mode === 'idle') {
    query.value = '';
  }

  const action = actionFromSearchState(nextState);
  if (
    action
    && ['ready', 'empty', 'error'].includes(nextState.status)
    && navigationPending
    && !restoringBrowserHistory
    && !suppressInitialHistoryEntry
  ) {
    webHistoryIndex += 1;
    window.history.pushState({
      typewriterIndex: webHistoryIndex,
      typewriterAction: action,
    }, '', actionUrl(action));
  }
  if (['ready', 'empty', 'error'].includes(nextState.status)) {
    navigationPending = false;
  }
}

async function loadSettings() {
  try {
    settings.value = await settingsStore.load();
  } catch {
    settings.value = { ...DEFAULT_SETTINGS };
  }
}

async function saveSetting(key, value) {
  const updated = { ...settings.value, [key]: value };
  settings.value = updated;
  settingsError.value = false;

  try {
    settings.value = await settingsStore.save(updated);
  } catch {
    settingsError.value = true;
  }
}

async function loadRuntimeStatus() {
  if (typeof runtime?.getRuntimeStatus !== 'function') return;

  try {
    runtimeStatus.value = await runtime.getRuntimeStatus();
  } catch {
    runtimeStatus.value = null;
  }
}

async function runAction(action) {
  if (action.type === 'query') {
    await session.searchExact(action.query);
    return;
  }
  if (action.type === 'target') {
    await session.openRelationTarget(action);
    return;
  }
  session.reset();
}

async function search(value = query.value) {
  const term = typeof value === 'string' ? value : '';
  if (!term.trim()) return;

  suppressInitialHistoryEntry = false;
  query.value = term;
  await session.searchExact(term);
  await nextTick();
  dictionaryPanel.value?.focusSearch?.();
}

function clearSearch() {
  if (typeof session.cancelPending === 'function') {
    navigationPending = false;
    session.cancelPending();
  }
  query.value = '';
}

async function openRelation(relation) {
  suppressInitialHistoryEntry = false;
  await session.openRelationTarget(relation);
  await nextTick();
  dictionaryPanel.value?.focusSearch?.();
}

async function retry() {
  if (searchState.value.error?.kind === 'load' && typeof runtime?.retry === 'function') {
    try {
      await runtime.retry();
    } catch {
      // SearchSession records the retry failure below.
    }
  }

  if (searchState.value.mode === 'relation-target' && searchState.value.targetRecordId) {
    await session.openRelationTarget(historyAction.value);
    return;
  }
  await search(searchState.value.query || query.value);
}

function goBack() {
  if (webHistoryIndex > 0) {
    window.history.back();
  } else {
    session.back();
    nextTick(() => dictionaryPanel.value?.focusSearch?.());
  }
}

function openSettings() {
  previousFocus = document.activeElement;
  settingsOpen.value = true;
  nextTick(() => settingsCloseButton.value?.focus());
}

function closeSettings() {
  settingsOpen.value = false;
  nextTick(() => previousFocus?.focus?.());
}

function keepSettingsFocusInside(event) {
  if (event.key !== 'Tab') return;

  const focusable = [...(settingsDialog.value?.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) ?? [])].filter((element) => element.getAttribute('aria-hidden') !== 'true');
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !settingsDialog.value?.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !settingsDialog.value?.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

async function restoreBrowserHistory(event) {
  const targetIndex = event.state?.typewriterIndex;
  const action = event.state?.typewriterAction;
  if (!Number.isInteger(targetIndex) || !action) return;

  restoringBrowserHistory = true;
  try {
    if (searchState.value.status === 'loading') {
      session.cancelPending();
      navigationPending = false;
    }

    while (webHistoryIndex > targetIndex && session.state.canGoBack) {
      session.back();
      webHistoryIndex -= 1;
    }
    while (webHistoryIndex < targetIndex && session.state.canGoForward) {
      session.forward();
      webHistoryIndex += 1;
    }

    if (!actionMatchesState(action, session.state)) {
      await runAction(action);
    }
    webHistoryIndex = targetIndex;
  } finally {
    restoringBrowserHistory = false;
  }
  await nextTick();
  dictionaryPanel.value?.focusSearch?.();
}

function initializeBrowserHistory() {
  const currentUrl = window.location.href;
  const initialAction = actionFromLocation();
  const rootUrl = new URL(currentUrl);
  rootUrl.search = '';
  rootUrl.hash = '';

  webHistoryIndex = 0;
  window.history.replaceState({
    typewriterIndex: 0,
    typewriterAction: rootAction(),
  }, '', rootUrl);

  if (initialAction) {
    webHistoryIndex = 1;
    window.history.pushState({
      typewriterIndex: 1,
      typewriterAction: initialAction,
    }, '', actionUrl(initialAction));
    suppressInitialHistoryEntry = true;
    void runAction(initialAction).finally(() => {
      suppressInitialHistoryEntry = false;
    });
  }
}

onMounted(() => {
  unsubscribe = session.subscribe(applyState);
  window.addEventListener('popstate', restoreBrowserHistory);
  previousBodyBackground = document.body.style.backgroundColor;
  stopBackgroundSync = watch(backgroundColor, (color) => {
    document.body.style.backgroundColor = color;
  }, { immediate: true });
  initializeBrowserHistory();
  void loadSettings();
  void loadRuntimeStatus();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  stopBackgroundSync?.();
  window.removeEventListener('popstate', restoreBrowserHistory);
  document.body.style.backgroundColor = previousBodyBackground;
  if (ownsRuntime) runtime?.close();
});
</script>

<template>
  <main
    class="web-app"
    data-product-surface="web"
    :data-runtime-query-only="runtimeStatus?.query_only"
    :data-runtime-write-blocked="runtimeStatus?.write_blocked"
    :data-runtime-persisted-write-count="runtimeStatus?.persisted_write_count"
  >
    <SiteHeader />

    <section class="search-stage" aria-label="Typewriter 사전 검색">
      <h1 class="search-stage-title">사전에서 다음 말을 찾아보세요</h1>
      <DictionaryPanel
        ref="dictionaryPanel"
        :query="query"
        :records="records"
        :status="searchState.status"
        :error="searchState.error"
        :empty-reason="searchState.emptyReason"
        :mode="searchState.mode"
        :can-go-back="searchState.canGoBack"
        :selected-record-id="searchState.selectedRecordId"
        :selected-sense-id="searchState.selectedSenseId"
        :settings="settings"
        settings-href="#preferences"
        @update:query="query = $event"
        @submit="search"
        @clear="clearSearch"
        @relation="openRelation"
        @back="goBack"
        @select-candidate="(candidate) => session.selectCandidate(candidate.recordId, candidate.senseId)"
        @retry="retry"
        @open-settings="openSettings"
      />
      <p class="runtime-note">
        검색과 관계 탐색은 canonical data에서 결정적으로 만든 SQLite 사전을 브라우저에서 읽어 처리합니다.
        외부 사전이나 AI 서비스에 검색어를 보내지 않습니다.
      </p>
      <div class="example-searches" aria-label="검색 예시">
        <span>이런 말을 찾아보세요</span>
        <button v-for="example in examples" :key="example" type="button" @click="search(example)">
          {{ example }}
        </button>
      </div>
    </section>

    <SiteFooter />

    <div
      v-if="settingsOpen"
      class="settings-backdrop"
      role="presentation"
      @click.self="closeSettings"
      @keydown.esc="closeSettings"
    >
      <section
        ref="settingsDialog"
        id="preferences"
        class="web-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        @keydown="keepSettingsFocusInside"
      >
        <header class="settings-heading">
          <div>
            <p class="eyebrow">YOUR READING SPACE</p>
            <h2 id="settings-title">검색 결과 설정</h2>
          </div>
          <button
            ref="settingsCloseButton"
            class="settings-close"
            type="button"
            aria-label="설정 닫기"
            @click="closeSettings"
          >×</button>
        </header>

        <p class="settings-description">표시할 항목과 화면 배경을 이 브라우저에 저장합니다.</p>
        <div class="web-setting-list">
          <div v-for="setting in SETTING_DEFINITIONS" :key="setting.key" class="web-setting-row">
            <div>
              <strong>{{ setting.label }}</strong>
              <span>{{ setting.description }}</span>
            </div>
            <ToggleControl
              :model-value="settings[setting.key]"
              :label="setting.label + ' 표시'"
              @update:model-value="saveSetting(setting.key, $event)"
            />
          </div>
        </div>
        <div class="web-background-settings">
          <h3>화면 배경</h3>
          <div class="background-options" role="radiogroup" aria-label="화면 배경">
            <button
              v-for="preset in BACKGROUND_PRESETS"
              :key="preset.key"
              type="button"
              role="radio"
              :aria-checked="String(settings.background === preset.key)"
              :aria-label="preset.label"
              :class="{ 'is-selected': settings.background === preset.key }"
              :style="{ '--preset-color': preset.color }"
              @click="saveSetting('background', preset.key)"
            >{{ preset.label }}</button>
          </div>
        </div>
        <p v-if="settingsError" class="settings-error" role="status">
          설정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.
        </p>
      </section>
    </div>
  </main>
</template>
