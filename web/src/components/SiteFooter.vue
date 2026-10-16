<script setup>
import { GITHUB_URL } from '../site-links.js';

const baseHref = import.meta.env?.BASE_URL || '/';
const legalLinks = [
  ['LICENSE.md', '소프트웨어 라이선스'],
  ['DATA-LICENSE.md', '데이터 라이선스'],
  ['THIRD-PARTY-NOTICES.txt', '제3자 고지'],
  ['BRAND.md', '브랜드 정책'],
];
</script>

<template>
  <footer class="site-footer">
    <div class="footer-main">
      <p class="footer-brand">TYPEWRITER</p>
      <p>작가를 위한, 말의 결을 찾는 사전.</p>
    </div>
    <p class="footer-notice">
      사전 데이터는 국립국어원 표준국어대사전·한국어기초사전·우리말샘에서 선별한 내용(CC BY-SA 2.0 KR)과
      Typewriter가 직접 편집한 말의 결·연상으로 구성됩니다. 자세한 출처와 조건은 아래 고지를 확인해 주세요.
    </p>
    <ul class="footer-links" aria-label="법적 고지">
      <li v-for="[file, label] in legalLinks" :key="file">
        <a :href="`${baseHref}${file}`">{{ label }}</a>
      </li>
      <li><a :href="GITHUB_URL">GitHub</a></li>
    </ul>
  </footer>
</template>
