<script setup>
import SiteFooter from './components/SiteFooter.vue';
import SiteHeader from './components/SiteHeader.vue';
</script>

<template>
  <main class="web-app about-app" data-product-surface="web-about">
    <SiteHeader current-page="about" />

    <section class="hero" aria-labelledby="hero-title">
      <p class="eyebrow">KOREAN WRITER'S DICTIONARY</p>
      <h1 id="hero-title">
        작가를 위한,<br />말의 결을<span class="hero-mobile-break" aria-hidden="true"></span> 찾는 사전.
      </h1>
      <p class="hero-description">
        문장을 쓰다가 다른 말을 찾을 때, 뜻을 바꾸거나 그대로 두면서 다음 단어를 탐색해 보세요.
      </p>
    </section>

    <section class="about-section" aria-labelledby="about-title">
      <div class="section-heading">
        <p class="eyebrow">WORDS LEAD TO OTHER WORDS</p>
        <h2 id="about-title">한 단어에서, 다른 결로.</h2>
      </div>
      <div class="about-copy">
        <p>
          Typewriter는 문장을 쓰는 사람이 다음 단어를 찾도록 돕는 한국어 작가 사전입니다. 단어와 표현에서
          뜻뿐 아니라 분위기, 장면, 감각으로 이어지는 길을 살펴볼 수 있습니다.
        </p>
        <p>
          문장을 대신 쓰거나 고치지 않으며, 일반적인 뜻풀이를 늘어놓는 데 그치지 않습니다. 각 관계가 바로
          바꾸어 쓸 말인지, 분위기나 장면의 연상인지 구분해 보여 줍니다.
        </p>
        <p>
          사전의 편집 판단을 확인하면서 문맥에 맞는 말을 고르는 일은 작가의 몫으로 남깁니다.
        </p>
      </div>
    </section>

    <section class="principles" aria-label="Typewriter의 원칙">
      <article>
        <span class="principle-number">01</span>
        <h3>사람이 문장을 씁니다</h3>
        <p>문장 생성이나 AI 다시쓰기를 하지 않습니다.</p>
      </article>
      <article>
        <span class="principle-number">02</span>
        <h3>관계를 구분해 보여 줍니다</h3>
        <p>직접 바꿔 쓸 말과 분위기·장면·감각의 연상을 구별합니다.</p>
      </article>
      <article>
        <span class="principle-number">03</span>
        <h3>검색은 브라우저 안에서</h3>
        <p>사전 조회에 외부 사전 API나 AI 서비스 연결을 사용하지 않습니다.</p>
      </article>
    </section>

    <SiteFooter />
  </main>
</template>
