<script setup>
const props = defineProps({
  currentPage: {
    type: String,
    default: 'dictionary',
  },
});

const baseHref = import.meta.env?.BASE_URL || '/';
const homeHref = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
const aboutHref = `${homeHref}about/`;
</script>

<template>
  <header class="site-header">
    <a
      class="site-wordmark"
      :href="homeHref"
      :aria-current="props.currentPage === 'dictionary' ? 'page' : undefined"
      aria-label="Typewriter 홈"
    >TYPEWRITER</a>
    <nav class="site-navigation" aria-label="주요 메뉴">
      <a :href="aboutHref" :aria-current="props.currentPage === 'about' ? 'page' : undefined">
        제품 소개
      </a>
      <a href="https://github.com/neverworkalone/typewriter">GitHub</a>
    </nav>
  </header>
</template>
