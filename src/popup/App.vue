<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

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
let unsubscribe = null;

const records = computed(() => (
  searchState.value.status === 'ready' ? searchState.value.results : []
));

function applyState(nextState) {
  searchState.value = nextState;

  if (nextState.status === 'loading' && nextState.query !== null) {
    query.value = nextState.query;
  }
  if (nextState.status === 'ready' && nextState.results[0]) {
    query.value = nextState.results[0].lemma;
  }
}

async function loadSettings() {
  try {
    settings.value = await settingsStore.load();
  } catch {
    settings.value = { ...DEFAULT_SETTINGS };
  }
}

async function search(value = query.value) {
  const term = typeof value === 'string' ? value.trim() : '';
  if (!term) return;

  query.value = term;
  await session.searchExact(term);
}

async function openRelation(relation) {
  await session.openRelationTarget(relation);
}

function goBack() {
  session.back();
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
    await session.openRelationTarget(searchState.value.targetRecordId);
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
});

onBeforeUnmount(() => {
  unsubscribe?.();
  if (ownsRuntime) runtime?.close();
});
</script>

<template>
  <main class="popup-app" data-product-surface="popup">
    <span class="sr-only">말의 결을 찾는 사전</span>
    <DictionaryPanel
      :query="query"
      :records="records"
      :status="searchState.status"
      :error="searchState.error"
      :empty-reason="searchState.emptyReason"
      :can-go-back="searchState.canGoBack"
      :mode="searchState.mode"
      :settings="settings"
      autofocus
      @update:query="query = $event"
      @submit="search"
      @relation="openRelation"
      @back="goBack"
      @retry="retry"
      @open-settings="openOptions"
    />
  </main>
</template>
