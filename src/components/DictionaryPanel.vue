<script setup>
import { computed } from 'vue';

import { SEARCH_STATUS } from '../domain/search-state.js';
import { DEFAULT_SETTINGS } from '../ui/settings.js';
import DictionaryResult from './DictionaryResult.vue';
import ProductFooter from './ProductFooter.vue';
import SearchBar from './SearchBar.vue';

const props = defineProps({
  query: {
    type: String,
    default: '',
  },
  records: {
    type: Array,
    default: () => [],
  },
  status: {
    type: String,
    default: SEARCH_STATUS.idle,
  },
  error: {
    type: Object,
    default: null,
  },
  emptyReason: {
    type: String,
    default: null,
  },
  mode: {
    type: String,
    default: 'idle',
  },
  settings: {
    type: Object,
    default: () => DEFAULT_SETTINGS,
  },
  compact: {
    type: Boolean,
    default: false,
  },
  interactive: {
    type: Boolean,
    default: true,
  },
  autofocus: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  'update:query',
  'submit',
  'relation',
  'retry',
  'open-settings',
]);

const isReady = computed(() => (
  props.records.length > 0
  && (props.status === SEARCH_STATUS.ready || props.status === SEARCH_STATUS.loading)
));
const isInitialLoading = computed(() => (
  props.status === SEARCH_STATUS.loading && props.records.length === 0
));
const isRelationTarget = computed(() => isReady.value && props.mode === 'relation-target');
const statusTitle = computed(() => {
  if (props.status === SEARCH_STATUS.loading) return '검색 중입니다.';
  if (props.status === SEARCH_STATUS.empty) {
    return props.emptyReason === 'relation-target-not-found'
      ? '관계 대상을 찾을 수 없습니다.'
      : '검색 결과가 없습니다.';
  }
  if (props.error?.kind === 'load') return '사전과 WASM을 불러오지 못했습니다.';
  if (props.error?.kind === 'query') return '검색 중 오류가 발생했습니다.';
  return '검색 결과를 표시할 수 없습니다.';
});

const statusDescription = computed(() => {
  if (props.status === SEARCH_STATUS.loading) return '잠시만 기다려 주세요.';
  if (props.status === SEARCH_STATUS.empty) return '';
  if (props.error?.kind === 'load') {
    return '패키지된 사전 파일을 확인한 뒤 다시 시도해 주세요.';
  }
  if (props.error?.kind === 'query') return '검색 요청을 처리하지 못했습니다.';
  return '';
});

const showRetry = computed(() => props.status === SEARCH_STATUS.error);
</script>

<template>
  <section
    class="dictionary-panel"
    :class="[
      {
        'is-compact': compact,
        'has-results': isReady,
        'is-relation-target': isRelationTarget,
      },
      `state-${status}`,
    ]"
    :aria-busy="status === SEARCH_STATUS.loading"
    data-dictionary-panel
  >
    <SearchBar
      :model-value="query"
      :compact="compact"
      :autofocus="autofocus"
      :readonly="!interactive"
      @update:model-value="emit('update:query', $event)"
      @submit="emit('submit', $event)"
    />

    <div v-if="isReady" class="dictionary-scroll-region">
      <DictionaryResult
        v-for="record in records"
        :key="record.id"
        :record="record"
        :settings="settings"
        :compact="compact"
        :interactive="interactive"
        @relation="emit('relation', $event)"
      />
      <ProductFooter
        :compact="compact"
        @open-settings="emit('open-settings')"
      />
    </div>

    <div
      v-else-if="status === SEARCH_STATUS.idle || isInitialLoading"
      class="dictionary-empty-region"
      :class="{ 'is-loading': isInitialLoading }"
    >
      <ProductFooter
        :compact="compact"
        @open-settings="emit('open-settings')"
      />
    </div>

    <div
      v-else
      class="dictionary-state-region"
      :class="{ 'is-empty': status === SEARCH_STATUS.empty }"
      :data-search-state="status"
      role="status"
      aria-live="polite"
    >
      <div class="state-copy">
        <strong>{{ statusTitle }}</strong>
        <span v-if="statusDescription">{{ statusDescription }}</span>
      </div>
      <button
        v-if="showRetry"
        class="retry-button"
        type="button"
        @click="emit('retry')"
      >다시 시도</button>
      <ProductFooter
        :compact="compact"
        @open-settings="emit('open-settings')"
      />
    </div>
  </section>
</template>

<style scoped>
.dictionary-panel {
  display: flex;
  width: 480px;
  max-width: 100vw;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 8px;
  overflow: hidden;
  border: 1px solid #e1ddda;
  background: #f4f3f2;
  box-shadow: 0 4px 14px rgba(26, 36, 51, 0.12);
}

.dictionary-scroll-region {
  display: flex;
  min-height: 0;
  max-height: 487px;
  flex-direction: column;
  gap: 8px;
  padding: 8px 4px 0;
  overflow-y: auto;
  scrollbar-color: #968f89 transparent;
  scrollbar-width: thin;
}

.dictionary-scroll-region::-webkit-scrollbar {
  width: 4px;
}

.dictionary-scroll-region::-webkit-scrollbar-track {
  background: transparent;
}

.dictionary-scroll-region::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #968f89;
}

.dictionary-scroll-region :deep(.dictionary-result + .dictionary-result) {
  padding-top: 12px;
  border-top: 1px solid #e1ddda;
}

.retry-button:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
  border-radius: 3px;
}

.dictionary-empty-region,
.dictionary-state-region {
  display: flex;
  min-height: 20px;
  flex-direction: column;
  gap: 8px;
}

.dictionary-state-region {
  min-height: 104px;
  justify-content: center;
  padding: 8px 4px 0;
}

.dictionary-state-region.is-empty {
  min-height: 104px;
  padding: 0 4px;
  justify-content: flex-end;
}

.dictionary-state-region.is-empty .state-copy {
  gap: 0;
}

.state-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #77716b;
  text-align: center;
}

.state-copy strong {
  color: #5f5955;
  font-size: 14px;
}

.state-copy span {
  font-size: 12px;
  line-height: 18px;
}

.retry-button {
  align-self: center;
  min-height: 28px;
  padding: 4px 12px;
  border: 1px solid #e5534b;
  border-radius: 6px;
  background: #fff;
  color: #7e433e;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.dictionary-panel.is-compact {
  width: 420px;
  gap: 7px;
  padding: 8.75px 8.75px 7px;
}

.dictionary-panel.is-compact .dictionary-scroll-region {
  max-height: none;
  gap: 7px;
  padding: 7px 3.5px 0;
  overflow-y: visible;
  scrollbar-width: none;
}

.dictionary-panel.is-compact.has-results .dictionary-scroll-region {
  min-height: 0;
}

.dictionary-panel.is-compact .dictionary-scroll-region :deep(.dictionary-result + .dictionary-result) {
  padding-top: 10.5px;
}

.dictionary-panel.is-compact .dictionary-state-region {
  min-height: 92px;
  padding-top: 7px;
}

.dictionary-panel.is-compact .state-copy strong {
  font-size: 12.25px;
}

.dictionary-panel.is-compact .state-copy span,
.dictionary-panel.is-compact .retry-button {
  font-size: 10.5px;
}

.dictionary-panel.is-compact .dictionary-scroll-region::-webkit-scrollbar {
  display: none;
}
</style>
