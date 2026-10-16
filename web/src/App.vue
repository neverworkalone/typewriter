<script setup>
import ExtensionPreview from './components/ExtensionPreview.vue';
import SiteFooter from './components/SiteFooter.vue';
import SiteHeader from './components/SiteHeader.vue';
import { CHROME_WEB_STORE_URL, GITHUB_URL } from './site-links.js';

const features = [
  {
    title: '유의어',
    body: '사전에서 같은 뜻으로 이어지는 말을 먼저 보여 줍니다. 문장의 의미를 그대로 두고 다른 단어를 고를 때 쓰세요.',
  },
  {
    title: '반의어',
    body: '같은 축에서 맞서는 말을 찾아, 문장의 방향을 바꾸거나 대비를 세울 수 있습니다.',
  },
  {
    title: '말의 결',
    body: '뜻은 비슷해도 분위기와 질감이 다른 표현을 살펴봅니다. 같은 장면을 다른 온도로 쓰고 싶을 때 도움이 됩니다.',
  },
  {
    title: '연상',
    body: '장면, 감각, 행동으로 이어지는 말을 따라가며 글감을 넓힙니다. 한 단어에서 다음 단어로 길이 이어집니다.',
  },
];

const steps = [
  ['01', '쓰다가 멈춥니다', '문장 속 단어가 마음에 들지 않을 때, 확장 프로그램을 엽니다.'],
  ['02', '단어를 찾아봅니다', '찾은 말의 관계가 유형별로 나뉘어 나타납니다.'],
  ['03', '작가가 고릅니다', '문맥에 맞는 말은 작가가 직접 고르고, 문장은 작가가 씁니다.'],
];

const principles = [
  ['01', '사람이 문장을 씁니다', '문장 생성이나 AI 다시쓰기를 하지 않습니다.'],
  ['02', '관계를 구분해 보여 줍니다', '바꿔 쓸 말과 분위기·장면·감각의 연상을 구별합니다.'],
  ['03', '검색은 설치한 브라우저 안에서', '사전 조회에 외부 사전 API나 AI 서비스 연결을 사용하지 않습니다.'],
];
</script>

<template>
  <a class="skip-link" href="#main">본문으로 건너뛰기</a>
  <div class="web-app" data-product-surface="web-landing" id="top">
    <SiteHeader />

    <main id="main">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-copy">
          <p class="eyebrow">CHROME EXTENSION · KOREAN WRITER'S DICTIONARY</p>
          <h1 id="hero-title">
            작가를 위한,<br />말의 결을<span class="hero-mobile-break" aria-hidden="true"></span> 찾는 사전.
          </h1>
          <p class="hero-description">
            문장을 쓰다가 다른 말이 필요할 때, 뜻을 그대로 두거나 결을 바꾸며 다음 단어를 찾아 보세요.
            Typewriter는 Chrome 확장 프로그램으로 설치해 쓰는 사전입니다.
          </p>
          <div class="hero-actions">
            <a class="button" :href="CHROME_WEB_STORE_URL">Chrome 웹 스토어에서 설치</a>
            <a class="button button-quiet" href="#features">기능 살펴보기</a>
          </div>
        </div>
        <ExtensionPreview />
      </section>

      <section class="section" aria-labelledby="steps-title">
        <div class="section-heading">
          <p class="eyebrow">HOW IT WORKS</p>
          <h2 id="steps-title">쓰던 자리에서, 한 걸음.</h2>
        </div>
        <ol class="steps">
          <li v-for="[number, title, body] in steps" :key="number">
            <span class="item-number">{{ number }}</span>
            <h3>{{ title }}</h3>
            <p>{{ body }}</p>
          </li>
        </ol>
      </section>

      <section id="features" class="section" aria-labelledby="features-title">
        <div class="section-heading">
          <p class="eyebrow">FEATURES</p>
          <h2 id="features-title">한 단어에서, 다른 결로.</h2>
        </div>
        <ul class="features">
          <li v-for="feature in features" :key="feature.title">
            <h3>{{ feature.title }}</h3>
            <p>{{ feature.body }}</p>
          </li>
        </ul>
      </section>

      <section id="philosophy" class="section philosophy" aria-labelledby="philosophy-title">
        <div class="section-heading">
          <p class="eyebrow">PHILOSOPHY</p>
          <h2 id="philosophy-title">말은 작가의 몫으로 남깁니다.</h2>
        </div>
        <div class="philosophy-body">
          <p>
            Typewriter는 일반적인 뜻풀이를 늘어놓는 사전이 아니라, 문장을 쓰는 사람이 다음 단어를 찾도록 돕는
            작가용 사전입니다. 단어에서 뜻뿐 아니라 분위기, 장면, 감각으로 이어지는 길을 보여 줍니다.
          </p>
          <ul class="principles">
            <li v-for="[number, title, body] in principles" :key="number">
              <span class="item-number">{{ number }}</span>
              <h3>{{ title }}</h3>
              <p>{{ body }}</p>
            </li>
          </ul>
        </div>
      </section>

      <section id="install" class="section install" aria-labelledby="install-title">
        <h2 id="install-title">지금 Chrome에 추가하세요.</h2>
        <p>
          사전은 설치한 확장 프로그램 안에서 동작합니다. 이 페이지는 제품을 소개하는 안내 페이지이며 검색은 제공하지 않습니다.
        </p>
        <div class="hero-actions">
          <a class="button" :href="CHROME_WEB_STORE_URL">Chrome 웹 스토어에서 설치</a>
          <a class="button button-quiet" :href="GITHUB_URL">GitHub에서 프로젝트 보기</a>
        </div>
      </section>
    </main>

    <SiteFooter />
  </div>
</template>
