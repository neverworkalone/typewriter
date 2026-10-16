<script setup>
import galleryDesk from './assets/gallery-desk.jpg';
import gallerySearch from './assets/gallery-search.jpg';
import heroPhoto from './assets/hero.jpg';
import icon48 from './assets/icon48.png';
import studyPhoto from './assets/study.jpg';
import { CHROME_WEB_STORE_URL, GITHUB_URL } from './site-links.js';

const baseHref = import.meta.env?.BASE_URL || '/';

const features = [
  {
    number: '01',
    symbol: '↗',
    title: '유의어',
    caption: '뜻이 이어지는 말',
    body: '같은 뜻을 향하는 다른 표현을 찾습니다.',
    bodyShort: '같은 뜻을 향하는 다른 표현',
  },
  {
    number: '02',
    symbol: '↔',
    title: '반의어',
    caption: '반대편의 표현',
    body: '반대편에 놓인 말을 통해 표현의 폭을 넓힙니다.',
    bodyShort: '다른 방향에 놓인 말을 발견',
  },
  {
    number: '03',
    symbol: '≈',
    title: '말의 결',
    caption: '표현의 온도',
    body: '미묘한 온도와 분위기를 따라가 봅니다.',
    bodyShort: '미묘한 분위기와 언어의 온도',
  },
  {
    number: '04',
    symbol: '✦',
    title: '연상',
    caption: '장면과 감각',
    body: '장면과 감각에서 새로운 단어로 이어집니다.',
    bodyShort: '장면과 감각으로 이어지는 생각',
  },
];

const gallery = [
  {
    src: gallerySearch,
    alt: '단어를 검색하면 유의어와 말의 결, 연상이 나뉘어 나타나는 Typewriter 확장 프로그램 화면',
    title: '01   단어를 찾는 순간',
    caption: '궁금한 단어가 새로운 표현으로 이어지는 경험.',
    captionShort: '궁금한 단어에서 다음 이야기로.',
  },
  {
    src: galleryDesk,
    alt: '책상 위 노트북에서 Typewriter로 단어를 찾는 작가의 모습',
    title: '02   이야기가 시작되는 자리',
    caption: '더 좋은 단어를 발견하는 고요한 책상 위의 시간.',
    captionShort: '',
  },
];

const legalLinks = [
  ['LICENSE.md', '소프트웨어 라이선스'],
  ['DATA-LICENSE.md', '데이터 라이선스'],
  ['THIRD-PARTY-NOTICES.txt', '제3자 고지'],
  ['BRAND.md', '브랜드 정책'],
];
</script>

<template>
  <a class="skip-link" href="#main">본문으로 건너뛰기</a>
  <div class="web-app" data-product-surface="web-landing" id="top">
    <section class="hero" aria-labelledby="hero-title">
      <img class="hero-photo" :src="heroPhoto" alt="" width="1280" height="800" fetchpriority="high" />
      <div class="hero-shade" aria-hidden="true"></div>
      <div class="hero-fade" aria-hidden="true"></div>
      <header class="site-header">
        <a class="wordmark" href="#top" aria-label="Typewriter 처음으로">Type<span>writer</span></a>
        <nav class="site-nav" aria-label="주요 링크">
          <a :href="CHROME_WEB_STORE_URL" target="_blank" rel="noopener noreferrer">설치하기</a>
          <a :href="GITHUB_URL" target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
      </header>
      <div class="hero-copy">
        <p class="hero-eyebrow">작가를 위한 유의어 사전</p>
        <span class="hero-rule" aria-hidden="true"></span>
        <h1 id="hero-title">
          더 좋은 단어가,<br />더 넓은 이야기를<br />만듭니다.
        </h1>
        <p class="hero-body">
          같은 장면도,<br />다른 단어를 만날 때<br />새로운 이야기가 시작됩니다.
        </p>
        <a class="cta-primary" :href="CHROME_WEB_STORE_URL" target="_blank" rel="noopener noreferrer">
          크롬 웹 스토어에서 설치하기&nbsp;&nbsp;↗
        </a>
      </div>
    </section>

    <main id="main">
      <section id="features" class="paths" aria-labelledby="features-title">
        <div class="wrap">
          <div class="paths-head">
            <div>
              <p class="overline">01 / 단어의 세계</p>
              <h2 id="features-title">한 단어에서,<br />다음 문장으로.</h2>
            </div>
            <p class="paths-intro">
              <span class="only-desktop">
                정확한 뜻을 짚고, 다른 결을 살펴보고,<br />마침내 내 문장에 맞는 표현을 고릅니다.<br />Typewriter는 그 탐색의 길을 넓혀 줍니다.
              </span>
              <span class="only-mobile">
                정확한 뜻에서 분위기와 연상까지.<br />어울리는 말을 찾도록 돕습니다.
              </span>
            </p>
          </div>
          <ul class="feature-grid">
            <li v-for="feature in features" :key="feature.number" class="feature-card">
              <span class="feature-index">{{ feature.number }}</span>
              <span class="feature-symbol" aria-hidden="true">{{ feature.symbol }}</span>
              <h3>{{ feature.title }}</h3>
              <p class="feature-caption">{{ feature.caption }}</p>
              <p class="feature-body">
                <span class="only-desktop">{{ feature.body }}</span>
                <span class="only-mobile">{{ feature.bodyShort }}</span>
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section id="philosophy" class="manifesto" aria-labelledby="philosophy-title">
        <img class="manifesto-photo" :src="studyPhoto" alt="" width="1280" height="800" loading="lazy" />
        <div class="manifesto-shade" aria-hidden="true"></div>
        <div class="manifesto-fade" aria-hidden="true"></div>
        <div class="wrap manifesto-copy">
          <p class="overline overline-light">02 / 글쓰기를 위한 사전</p>
          <h2 id="philosophy-title">
            <span class="manifesto-first">문장을 대신 쓰지<br />않습니다.</span>
            <span class="manifesto-second">어울리는 말을<br />함께 찾습니다.</span>
          </h2>
          <p class="manifesto-body">
            <span class="only-desktop">
              단어의 뜻에서 출발해 유의어와 반의어,<br />뉘앙스와 연상까지. 선택은 언제나 작가의 몫입니다.
            </span>
            <span class="only-mobile">
              선택은 작가의 몫입니다.<br />Typewriter는 그 길을 넓혀 줍니다.
            </span>
          </p>
        </div>
      </section>

      <section class="gallery" aria-labelledby="gallery-title">
        <div class="wrap">
          <p class="overline">03 / 더 깊은 이야기</p>
          <h2 id="gallery-title">말이 떠오르는<br class="br-mobile" /> 순간을 담았습니다.</h2>
          <div class="gallery-grid">
            <figure v-for="item in gallery" :key="item.src">
              <img :src="item.src" :alt="item.alt" width="1280" height="800" loading="lazy" />
              <figcaption>
                <span class="gallery-title">{{ item.title }}</span>
                <span class="gallery-caption only-desktop">{{ item.caption }}</span>
                <span v-if="item.captionShort" class="gallery-caption only-mobile">{{ item.captionShort }}</span>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section class="signature" aria-label="한 단어의 힘">
        <div class="wrap">
          <p class="overline">한 단어의 힘</p>
          <blockquote>
            <p>
              “단어 하나가,<br class="br-mobile" /> 세상을 더 깊고<br class="br-desktop" /> 아름답게 만듭니다.”
            </p>
          </blockquote>
          <span class="signature-rule" aria-hidden="true"></span>
          <p class="signature-note">좋은 단어가, 더 나은 이야기를.</p>
        </div>
      </section>

      <section id="install" class="install" aria-labelledby="install-title">
        <div class="wrap install-grid">
          <div>
            <p class="overline">크롬 확장 프로그램<span class="only-desktop"> 안내</span></p>
            <h2 id="install-title">당신의 다음 문장에<br />어울리는 단어를.</h2>
            <p class="install-copy">
              Typewriter는 브라우저 안에서 사용하는<br />작가를 위한 한국어 사전입니다.
            </p>
          </div>
          <div class="install-card">
            <div class="install-card-head">
              <img :src="icon48" alt="" width="48" height="48" />
              <div>
                <p class="install-name">Typewriter</p>
                <p class="install-tagline">작가를 위한, 말의 결을 찾는 사전</p>
              </div>
            </div>
            <div class="install-card-detail">
              <p class="install-kind">크롬 확장 프로그램</p>
              <p class="install-detail">
                단어를 찾고, 관계를 탐색하고,<br />문장에 어울리는 표현을 선택하세요.
              </p>
            </div>
            <a class="cta-dark" :href="CHROME_WEB_STORE_URL" target="_blank" rel="noopener noreferrer">
              크롬 웹 스토어에서 설치하기&nbsp;&nbsp;↗
            </a>
          </div>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <div class="wrap footer-grid">
        <div>
          <p class="wordmark footer-wordmark" aria-label="Typewriter">Type<span>writer</span></p>
          <p class="footer-tagline">작가를 위한, 말의 결을 찾는 사전</p>
        </div>
        <nav class="site-nav footer-nav" aria-label="바로가기">
          <a :href="CHROME_WEB_STORE_URL" target="_blank" rel="noopener noreferrer">설치하기</a>
          <a :href="GITHUB_URL" target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
      </div>
      <div class="wrap footer-legal">
        <p>
          사전 데이터는 국립국어원 표준국어대사전·한국어기초사전·우리말샘에서 선별한 내용(CC BY-SA 2.0 KR)과
          Typewriter가 직접 편집한 말의 결·연상으로 구성됩니다.
        </p>
        <ul aria-label="법적 고지">
          <li v-for="[file, label] in legalLinks" :key="file">
            <a :href="`${baseHref}${file}`">{{ label }}</a>
          </li>
        </ul>
      </div>
    </footer>
  </div>
</template>
