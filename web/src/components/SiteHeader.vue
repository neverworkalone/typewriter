<script setup>
import { CHROME_WEB_STORE_URL, GITHUB_URL } from '../site-links.js';
</script>

<template>
  <header class="site-header">
    <a class="site-wordmark" href="#top" aria-label="Typewriter 처음으로">TYPEWRITER</a>
    <nav class="site-navigation" aria-label="주요 메뉴">
      <a class="nav-link" href="#features">기능</a>
      <a class="nav-link" href="#philosophy">철학</a>
      <a class="nav-link" href="#install">설치</a>
      <a class="nav-link nav-link-github" :href="GITHUB_URL">GitHub</a>
      <a class="button button-small" :href="CHROME_WEB_STORE_URL">Chrome에 추가</a>
    </nav>
  </header>
</template>
