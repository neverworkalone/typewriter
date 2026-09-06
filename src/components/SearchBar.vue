<script setup>
import { nextTick, ref } from 'vue';

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  compact: {
    type: Boolean,
    default: false,
  },
  autofocus: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  readonly: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  'update:modelValue',
  'submit',
  'focus',
  'tab',
]);

const input = ref(null);
const button = ref(null);

function updateValue(event) {
  emit('update:modelValue', event.target.value);
}

function submit() {
  if (props.disabled || props.readonly) return;
  emit('submit', input.value?.value ?? props.modelValue);
}

function handleTab(event) {
  emit('tab', event);
  if (event.shiftKey || props.disabled) return;

  event.preventDefault();
  button.value?.focus();
}

function focus() {
  nextTick(() => input.value?.focus());
}

defineExpose({ focus });
</script>

<template>
  <form
    class="search-row"
    :class="{ 'is-compact': compact }"
    role="search"
    @submit.prevent="submit"
  >
    <input
      ref="input"
      class="search-input"
      :value="modelValue"
      :placeholder="readonly ? '쓸쓸하다' : '단어를 입력하세요'"
      :autofocus="autofocus"
      :disabled="disabled"
      :readonly="readonly"
      aria-label="검색어"
      @input="updateValue"
      @focus="emit('focus', $event)"
      @keydown.tab="handleTab"
      @keydown.enter.prevent="submit"
    />
    <button
      ref="button"
      class="search-button"
      type="submit"
      :disabled="disabled || readonly"
    >검색</button>
  </form>
</template>

<style scoped>
.search-row {
  display: flex;
  width: 100%;
  height: 36px;
  gap: 8px;
  align-items: flex-start;
}

.search-input,
.search-button {
  font: inherit;
}

.search-input {
  min-width: 0;
  flex: 1 1 auto;
  height: 36px;
  padding: 0 36px 0 12px;
  overflow: hidden;
  border: 1px solid #e5534b;
  border-radius: 8px;
  outline: none;
  background: #fff;
  color: #2b2927;
  font-size: 14px;
}

.search-input::placeholder {
  color: #77716b;
  opacity: 1;
}

.search-input:focus-visible,
.search-button:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
}

.search-button {
  flex: 0 0 72px;
  width: 72px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: #e5534b;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
}

.search-button:disabled {
  cursor: default;
  opacity: 1;
}

.search-row.is-compact {
  height: 31.5px;
  gap: 7px;
}

.search-row.is-compact .search-input,
.search-row.is-compact .search-button {
  height: 31.5px;
  border-radius: 7px;
  font-size: 12.25px;
}

.search-row.is-compact .search-input {
  padding-left: 10.5px;
  padding-right: 31.5px;
}

.search-row.is-compact .search-button {
  flex-basis: 63px;
  width: 63px;
}
</style>
