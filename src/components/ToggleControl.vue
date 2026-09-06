<script setup>
defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
  label: {
    type: String,
    default: '설정 전환',
  },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <button
    class="toggle-control"
    :class="{ 'is-on': modelValue }"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="toggle-knob" aria-hidden="true"></span>
  </button>
</template>

<style scoped>
.toggle-control {
  position: relative;
  width: 44px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: #e5e7eb;
  cursor: pointer;
}

.toggle-control.is-on {
  background: #e5534b;
}

.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(26, 36, 51, 0.12);
  transition: transform 120ms ease;
}

.toggle-control.is-on .toggle-knob {
  transform: translateX(20px);
}

.toggle-control:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
}
</style>
