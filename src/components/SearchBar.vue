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
  'clear',
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

function clearValue() {
  if (props.disabled || props.readonly) return;

  emit('update:modelValue', '');
  emit('clear');
  nextTick(() => input.value?.focus());
}

function handleEscape(event) {
  if (input.value?.value) {
    event.preventDefault();
    event.stopPropagation();
    clearValue();
  }
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
    <div class="search-input-wrap">
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
        @keydown.escape="handleEscape"
      />
      <button
        v-if="modelValue && !disabled && !readonly"
        class="search-clear-button"
        type="button"
        aria-label="검색어 지우기"
        title="검색어 지우기"
        @mousedown.prevent
        @click="clearValue"
      ><span aria-hidden="true">×</span></button>
    </div>
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

.search-input-wrap {
  position: relative;
  min-width: 0;
  flex: 1 1 auto;
}

.search-input,
.search-button {
  font: inherit;
}

.search-input {
  width: 100%;
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

.search-input:focus,
.search-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.search-clear-button {
  position: absolute;
  top: 50%;
  right: 7px;
  display: grid;
  width: 24px;
  height: 24px;
  padding: 0;
  transform: translateY(-50%);
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #7e433e;
  cursor: pointer;
  font-size: 21px;
  line-height: 1;
}

.search-clear-button:hover {
  background: rgba(126, 67, 62, 0.08);
}

.search-clear-button:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 1px;
}

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

.search-row.is-compact .search-clear-button {
  right: 5.25px;
  width: 21px;
  height: 21px;
  font-size: 18.375px;
}

.search-row.is-compact .search-button {
  flex-basis: 63px;
  width: 63px;
}
</style>
