import assert from 'node:assert/strict';
import test from 'node:test';

import { homographLemmaIndex, productGloss } from '../scripts/build/gloss-homograph-reference.mjs';

const lemmas = homographLemmaIndex(['슬슬', '이', '본가', '주다', '깨다', '까치발', '감잡이', '들', '지구', '리넨'].map((lemma) => ({ lemma })));
const counters = () => ({ stripped: 0, unconfirmed: 0 });

test('homograph reference numbers are removed from references only (Issue #797)', () => {
  const cases = [
    ['quoted reference', '모양. ‘슬슬02’보다 센 느낌을 준다.', '모양. ‘슬슬’보다 센 느낌을 준다.'],
    ['quoted single-syllable headword', '‘이01’를 이르는 말.', '‘이’를 이르는 말.'],
    ['sense number kept', '‘본가01「3」’의 높임.', '‘본가「3」’의 높임.'],
    ['roman and bracket groups kept', '‘주다01[Ⅰ]「1」’의 / ‘깨다01[1]’의', '‘주다[Ⅰ]「1」’의 / ‘깨다[1]’의'],
    ['hanja suffix kept', '‘리넨01(linen)’을', '‘리넨(linen)’을'],
    ['affix headword', '명사에 ‘-들08’이 붙어', '명사에 ‘-들’이 붙어'],
    ['several quoted references', '‘슬슬02’과 ‘이01’', '‘슬슬’과 ‘이’'],
    ['arrow reference', '→ 까치발02.', '→ 까치발.'],
    ['arrow reference with sense number', '→ 감잡이02「2」.', '→ 감잡이「2」.'],
    ['arrow reference with group and hanja', '→ 지구08(地球).', '→ 지구(地球).'],
    // valid-but-unusual / fail-closed controls: nothing here is a reference
    ['year and unit numbers stay', '숙종34년(1708)에 영하102℃, 8분의12 박자', '숙종34년(1708)에 영하102℃, 8분의12 박자'],
    ['ordinals stay', '제10대 왕, 제427조', '제10대 왕, 제427조'],
    ['quoted non-headword stays', '‘제10대’를 이르는 말.', '‘제10대’를 이르는 말.'],
    ['unquoted numbered word stays', '입원01과 퇴원01을 아울러', '입원01과 퇴원01을 아울러'],
    ['latin and digit mixes stay', '‘M16’ 소총 (M16)', '‘M16’ 소총 (M16)'],
    ['three-digit stays', '‘슬슬102’', '‘슬슬102’'],
    ['arrow not at gloss start stays', '뜻. → 까치발02.', '뜻. → 까치발02.'],
    ['unknown headword stays', '‘없는말02’을', '‘없는말02’을'],
    ['arrow without number', '→ 할머니_.', '→ 할머니_.'],
  ];
  for (const [name, source, expected] of cases) assert.equal(productGloss(source, lemmas), expected, name);
});

test('counters report stripped and unconfirmed references', () => {
  const c = counters();
  productGloss('‘슬슬02’ ‘없는말02’', lemmas, c);
  assert.deepEqual(c, { stripped: 1, unconfirmed: 1 });
});
