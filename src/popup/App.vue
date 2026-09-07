<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import { SearchSession } from '../domain/index.js';
import { DictionaryRuntime } from '../runtime/query-adapter.js';
import {
  createSettingsStore,
  DEFAULT_SETTINGS,
} from '../ui/settings.js';
import DictionaryPanel from '../components/DictionaryPanel.vue';

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
  openOptionsPage: {
    type: Function,
    default: null,
  },
});

const ownsRuntime = !props.runtime && !props.session;
const runtime = props.runtime || (props.session ? null : new DictionaryRuntime());
const session = props.session || new SearchSession({ runtime });
const settingsStore = props.settingsStore || createSettingsStore();

const query = ref('');
const searchState = ref(session.state);
const settings = ref({ ...DEFAULT_SETTINGS });
const runtimeStatus = ref(null);
const lastRecords = ref([]);
const dictionaryPanel = ref(null);
let unsubscribe = null;

const records = computed(() => (
  searchState.value.status === 'ready'
    ? searchState.value.results
    : searchState.value.status === 'loading'
      ? lastRecords.value
      : []
));

function applyState(nextState) {
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
  }
}

async function loadSettings() {
  try {
    settings.value = await settingsStore.load();
  } catch {
    settings.value = { ...DEFAULT_SETTINGS };
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

async function search(value = query.value) {
  const term = typeof value === 'string' ? value : '';
  if (!term.trim()) return;

  query.value = term;
  await session.searchExact(term);
  await nextTick();
  dictionaryPanel.value?.focusSearch?.();
}

function clearSearch() {
  if (typeof session.cancelPending === 'function') {
    session.cancelPending();
  }
  query.value = '';
}

async function openRelation(relation) {
  await session.openRelationTarget(relation);
  await nextTick();
  dictionaryPanel.value?.focusSearch?.();
}

async function goBack() {
  session.back?.();
  await nextTick();
  dictionaryPanel.value?.focusSearch?.();
}

function selectCandidate(recordId) {
  session.selectCandidate?.(recordId);
}

async function retry() {
  if (searchState.value.error?.kind === 'load' && typeof runtime?.retry === 'function') {
    try {
      await runtime.retry();
    } catch {
      // SearchSession records the final load failure below.
    }
  }

  if (searchState.value.mode === 'relation-target' && searchState.value.targetRecordId) {
    await openRelation(searchState.value.targetRecordId);
    return;
  }

  await search(searchState.value.query || query.value);
}

function openOptions() {
  if (props.openOptionsPage) {
    props.openOptionsPage();
    return;
  }

  const extensionRuntime = globalThis.chrome?.runtime;
  if (typeof extensionRuntime?.openOptionsPage === 'function') {
    extensionRuntime.openOptionsPage();
    return;
  }

  if (typeof window !== 'undefined') {
    window.location.assign('options.html');
  }
}

onMounted(() => {
  unsubscribe = session.subscribe(applyState);
  void loadSettings();
  void loadRuntimeStatus();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  if (ownsRuntime) runtime?.close();
});
</script>

<template>
  <main
    class="popup-app"
    data-product-surface="popup"
    :data-runtime-query-only="runtimeStatus?.query_only"
    :data-runtime-write-blocked="runtimeStatus?.write_blocked"
    :data-runtime-persisted-write-count="runtimeStatus?.persisted_write_count"
  >
    <span class="sr-only">말의 결을 찾는 사전</span>
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
      :settings="settings"
      autofocus
      @update:query="query = $event"
      @submit="search"
      @clear="clearSearch"
      @relation="openRelation"
      @back="goBack"
      @select-candidate="selectCandidate"
      @retry="retry"
      @open-settings="openOptions"
    />
  </main>
</template>
