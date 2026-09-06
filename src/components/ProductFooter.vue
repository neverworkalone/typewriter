<script setup>
defineProps({
  compact: {
    type: Boolean,
    default: false,
  },
});

defineEmits(['open-settings']);
</script>

<template>
  <div class="product-footer-wrap" :class="{ 'is-compact': compact }">
    <div class="footer-divider" aria-hidden="true"></div>
    <footer class="product-footer">
      <span>Typewriter</span>
      <a
        href="options.html"
        data-settings-link
        @click.prevent="$emit('open-settings')"
      >설정</a>
    </footer>
  </div>
</template>

<style scoped>
.product-footer-wrap {
  width: 100%;
  display: contents;
}

.footer-divider {
  width: 100%;
  height: 1px;
  background: #d8d3cf;
}

.product-footer {
  display: flex;
  width: 100%;
  height: 20px;
  padding-right: 12px;
  gap: 12px;
  align-items: center;
  justify-content: flex-end;
  overflow: hidden;
  color: #77716b;
  font-size: 12px;
  line-height: normal;
  white-space: nowrap;
}

.product-footer a {
  color: #e5534b;
  font-weight: 700;
  text-decoration: none;
}

.product-footer a:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
  border-radius: 2px;
}

.product-footer-wrap.is-compact .product-footer {
  height: 17.5px;
  padding-right: 10.5px;
  gap: 10.5px;
  font-size: 10.5px;
}
</style>
