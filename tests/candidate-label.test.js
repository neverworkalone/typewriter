// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';

import DictionaryPanel from '../src/components/DictionaryPanel.vue';
import { firstSentence } from '../src/domain/exact-search-candidates.js';
import { SEARCH_MODES, SEARCH_STATUS } from '../src/domain/search-state.js';

describe('firstSentence', () => {
  it.each([
    ['육욕천의 둘째 하늘. 섬부주 위에 있는 곳으로, 수미산 꼭대기.', '육욕천의 둘째 하늘.'],
    ['짧다. 다음 문장.', '짧다.'],
    ['한 문장만 있는 뜻풀이.', '한 문장만 있는 뜻풀이.'],
    // decimals, numbering, abbreviations are not sentence ends
    ['길이가 3.5미터 되는 막대. 다음.', '길이가 3.5미터 되는 막대.'],
    ['1. 첫째 뜻을 이르는 말. 둘째.', '1. 첫째 뜻을 이르는 말.'],
    ['제2. 항목 기준의 하나. 다음.', '제2. 항목 기준의 하나.'],
    ['e.g. 예를 들어 쓰는 말. 다음.', 'e.g. 예를 들어 쓰는 말.'],
    ['A. 기호로 쓰는 문자. 다음.', 'A. 기호로 쓰는 문자.'],
    ['etc. 따위를 이르는 말. 다음.', 'etc. 따위를 이르는 말.'],
    // closers and other terminators
    ['"가자." 하고 말함. 다음.', '"가자." 하고 말함.'],
    ['그렇게 말하다(그리 말하다.) 하는 뜻. 다음.', '그렇게 말하다(그리 말하다.) 하는 뜻.'],
    ['말을 한다(옛말). 다음 문장.', '말을 한다(옛말).'],
    ['정말인가? 그럴 수도 있다.', '정말인가?'],
    ['아이고! 놀람을 나타내는 말.', '아이고!'],
    ['그렇다." 다음.', '그렇다."'],
    ['놀랍다…! 다음.', '놀랍다…!'],
    // ASCII single quotes: quotation vs apostrophe
    ["'가자.' 하고 말했다. 다음 문장.", "'가자.' 하고 말했다."],
    ["'가자!' 하고 말했다. 다음.", "'가자!' 하고 말했다."],
    ["‘가자.’ 하고 말했다. 다음.", "‘가자.’ 하고 말했다."],
    ["그가 '가자.' 하고 말했다. 다음.", "그가 '가자.' 하고 말했다."],
    ['"그가 \'가자.\' 했다." 하고 말했다. 다음.', '"그가 \'가자.\' 했다." 하고 말했다.'],
    ["It's a dog's life. Next.", "It's a dog's life."],
    ["the dogs' bones are here. Next.", "the dogs' bones are here."],
    // ambiguous ASCII ' + space inside a quote (closing quote vs possessive): keep the whole text
    ["She read the line 'the dogs' bones.' aloud, then stopped. Next.", "She read the line 'the dogs' bones.' aloud, then stopped. Next."],
    ["He said 'stop' loudly. Next.", "He said 'stop' loudly. Next."],
    ["'가자' 하고 말했다. 다음.", "'가자' 하고 말했다."],
    ["'끝났다.' 다음.", "'끝났다.' 다음."],
    ["'닫히지 않은 따옴표. 다음.", "'닫히지 않은 따옴표. 다음."],
    // no terminator / no boundary: whole text, no loss
    ['종결 부호가 없는 뜻풀이', '종결 부호가 없는 뜻풀이'],
    ['3.5', '3.5'],
    ['www.example.com 주소', 'www.example.com 주소'],
    ['...', '...'],
    ['  앞뒤 공백.  다음.  ', '앞뒤 공백.'],
    ['', ''],
    ['공백없는긴텍스트'.repeat(20), '공백없는긴텍스트'.repeat(20)],
  ])('%j -> %j', (input, expected) => {
    expect(firstSentence(input)).toBe(expected);
  });

  it('returns an empty string for non-strings', () => {
    expect(firstSentence(null)).toBe('');
    expect(firstSentence(undefined)).toBe('');
  });
});

const GLOSS_A = '육욕천의 둘째 하늘. 섬부주 위에 8만 유순(由旬) 되는 수미산 꼭대기에 있는 곳으로, 제석천이 사는 곳.';
const GLOSS_B = '사람이 마땅히 지켜야 할 바른길. 인륜의 도.';
const mounted = [];

function senseOf(id, gloss) {
  return {
    id,
    pos: 'noun',
    gloss,
    groups: [{ id: `${id}-def`, kind: 'definition', label: '뜻풀이', items: [{ text: gloss }] }],
  };
}

function mountPanel(senses) {
  const host = document.createElement('div');
  document.body.append(host);
  const record = { id: 'w1', lemma: '도리', senses };
  const app = createApp(DictionaryPanel, {
    query: '도리',
    records: [record],
    status: SEARCH_STATUS.ready,
    mode: SEARCH_MODES.exact,
    selectedRecordId: 'w1',
    selectedSenseId: senses[0].id,
  });
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

afterEach(() => {
  while (mounted.length) {
    const { app, host } = mounted.pop();
    app.unmount();
    host.remove();
  }
});

describe('candidate picker label', () => {
  it('shows only the first sentence per candidate and keeps the full gloss in the body', async () => {
    const host = mountPanel([senseOf('w1-s1', GLOSS_A), senseOf('w1-s2', GLOSS_B)]);
    await nextTick();

    const options = [...host.querySelectorAll('.candidate-option')];
    expect(options.map((option) => option.querySelector('.candidate-label').textContent)).toEqual([
      '육욕천의 둘째 하늘.',
      '사람이 마땅히 지켜야 할 바른길.',
    ]);
    expect(options.map((option) => option.dataset.senseId)).toEqual(['w1-s1', 'w1-s2']);
    expect(host.querySelector('.definition-text').textContent.trim()).toBe(GLOSS_A);
  });

  it('does not shorten the body gloss when there is a single candidate', async () => {
    const host = mountPanel([senseOf('w1-s1', GLOSS_A)]);
    await nextTick();

    expect(host.querySelector('.candidate-list')).toBeNull();
    expect(host.querySelector('.definition-text').textContent.trim()).toBe(GLOSS_A);
  });
});
