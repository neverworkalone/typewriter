import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { contractOpenOVowelWithAt } from '../scripts/inflection/contract.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalDirectory = path.join(repositoryRoot, 'data/canonical');
const contractPath = path.join(
  repositoryRoot,
  'tests/fixtures/search-regressions/m6-2-inflection-contract.json',
);
const baselinePath = path.join(repositoryRoot, 'docs/m6-1-quality-baseline.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const canonical = await readCanonicalRecords(canonicalDirectory, { useSharedContext: false });
const records = canonical.records.map(({ record }) => record);
const recordsById = new Map(records.map((record) => [record.id, record]));

const predicatePos = new Set(['verb', 'adjective']);
const codaTable = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ',
  'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ',
  'ㅍ', 'ㅎ',
];
const vowelTable = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ',
  'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];

function stemFinalCoda(lemma) {
  const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : lemma;
  const lastCharacter = [...stem].at(-1);
  if (!lastCharacter) return null;
  const offset = lastCharacter.codePointAt(0) - 0xac00;
  if (offset < 0 || offset >= 11172) return null;
  return codaTable[offset % 28];
}

function stemFinalVowel(lemma) {
  const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : lemma;
  const lastCharacter = [...stem].at(-1);
  if (!lastCharacter) return null;
  const offset = lastCharacter.codePointAt(0) - 0xac00;
  if (offset < 0 || offset >= 11172) return null;
  return vowelTable[Math.floor((offset % 588) / 28)];
}

function uniquePredicatePos(record) {
  return [...new Set(record.senses.map(({ pos }) => pos).filter((pos) => predicatePos.has(pos)))];
}

function deriveInventory() {
  const starts = records.filter((record) => record.role === 'start');
  const predicateEntries = starts.filter((record) => (
    record.record_type === 'entry' && uniquePredicatePos(record).length > 0
  ));
  const singleTokenEntries = predicateEntries.filter(({ lemma }) => !lemma.includes(' '));
  const openStemEntries = singleTokenEntries.filter(({ lemma }) => stemFinalCoda(lemma) === '');
  const posSenseCounts = { verb: 0, adjective: 0 };
  const posRecordCounts = { verb: 0, adjective: 0 };
  const openStemFinalVowelCounts = {};
  for (const record of openStemEntries) {
    const vowel = stemFinalVowel(record.lemma);
    openStemFinalVowelCounts[vowel] = (openStemFinalVowelCounts[vowel] ?? 0) + 1;
  }

  for (const record of starts) {
    for (const sense of record.senses) {
      if (predicatePos.has(sense.pos)) posSenseCounts[sense.pos] += 1;
    }
    for (const pos of uniquePredicatePos(record)) posRecordCounts[pos] += 1;
  }

  const countByPosAndCoda = (pos, coda) => singleTokenEntries.filter((record) => (
    uniquePredicatePos(record).includes(pos) && stemFinalCoda(record.lemma) === coda
  )).length;

  return {
    predicate_sense_counts: posSenseCounts,
    predicate_record_counts: posRecordCounts,
    entry_predicate_record_count: predicateEntries.length,
    single_token_entry_predicate_record_count: singleTokenEntries.length,
    open_stem_predicate_record_count: openStemEntries.length,
    open_stem_final_vowel_counts: openStemFinalVowelCounts,
    open_stem_past_class_counts: {
      hada: openStemEntries.filter(({ lemma }) => lemma.endsWith('하다')).length,
      open_a_other: openStemEntries.filter((record) => (
        stemFinalVowel(record.lemma) === 'ㅏ' && !record.lemma.endsWith('하다')
      )).length,
      open_o_boda: openStemEntries.filter((record) => (
        stemFinalVowel(record.lemma) === 'ㅗ' && record.lemma.endsWith('보다')
      )).length,
      open_o_oda: openStemEntries.filter((record) => (
        stemFinalVowel(record.lemma) === 'ㅗ' && record.lemma.endsWith('오다')
      )).length,
      open_o_other: openStemEntries.filter((record) => (
        stemFinalVowel(record.lemma) === 'ㅗ'
        && !record.lemma.endsWith('보다')
        && !record.lemma.endsWith('오다')
      )).length,
      other_open_vowel: openStemEntries.filter((record) => (
        !['ㅏ', 'ㅗ'].includes(stemFinalVowel(record.lemma))
      )).length,
    },
    mixed_pos_record_ids: singleTokenEntries
      .filter((record) => uniquePredicatePos(record).length > 1)
      .map(({ id }) => id)
      .sort(),
    multiword_record_ids: predicateEntries
      .filter(({ lemma }) => lemma.includes(' '))
      .map(({ id }) => id)
      .sort(),
    spelling_features: {
      ends_hada: singleTokenEntries.filter(({ lemma }) => lemma.endsWith('하다')).length,
      ends_reuda: singleTokenEntries.filter(({ lemma }) => lemma.endsWith('르다')).length,
      stem_final_coda_l: singleTokenEntries
        .filter((record) => stemFinalCoda(record.lemma) === 'ㄹ').length,
      stem_final_coda_d_verb: countByPosAndCoda('verb', 'ㄷ'),
      stem_final_coda_b_adjective: countByPosAndCoda('adjective', 'ㅂ'),
      stem_final_coda_b_verb: countByPosAndCoda('verb', 'ㅂ'),
      stem_final_coda_s_verb: countByPosAndCoda('verb', 'ㅅ'),
      stem_final_coda_h_adjective: countByPosAndCoda('adjective', 'ㅎ'),
      stem_final_coda_h_verb: countByPosAndCoda('verb', 'ㅎ'),
    },
  };
}

function findExactStartMatches(query) {
  return records.filter((record) => (
    record.role === 'start'
    && (record.lemma === query || record.search_forms.includes(query))
  ));
}

test('M6-2 contract is pinned to the reproduced M6-1 canonical snapshot', () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract_id, 'm6-2-inflection-search-v1');
  assert.equal(contract.source.issue, 174);
  assert.equal(contract.source.baseline_id, baseline.baseline_id);
  assert.equal(contract.source.canonical_revision, baseline.source.canonical_revision);
  assert.equal(canonical.canonicalRevision, contract.source.canonical_revision);
  assert.deepEqual(deriveInventory(), contract.inventory);
  assert.deepEqual(
    contract.supported_rule_ids,
    [
      'verb-present-adnominal-neun',
      'verb-past-adnominal-eun',
      'adjective-present-adnominal-eun',
      'adjective-present-adnominal-neun-exception',
      'predicate-future-adnominal-eul',
      'predicate-plain-past-coda-bearing',
      'predicate-plain-past-open-a',
      'predicate-plain-past-hada',
      'predicate-plain-past-open-o-boda',
      'predicate-plain-past-required-oda',
      'predicate-plain-past-registered-exception',
    ],
  );
  assert.deepEqual(contract.plain_past_policy, {
    priority_order: [
      'predicate-plain-past-registered-exception',
      'predicate-plain-past-hada',
      'predicate-plain-past-coda-bearing',
      'predicate-plain-past-open-a',
      'predicate-plain-past-required-oda',
      'predicate-plain-past-open-o-boda',
    ],
    coda_bearing: {
      rule_id: 'predicate-plain-past-coda-bearing',
      attachment: 'append 았다 after final stem vowel ㅏ or ㅗ; otherwise append 었다',
    },
    open_a: {
      rule_id: 'predicate-plain-past-open-a',
      contracted_form: 'required',
      attachment: 'merge final open ㅏ with 았 by adding coda ㅆ to that stem syllable',
    },
    hada: {
      rule_id: 'predicate-plain-past-hada',
      lemma_suffix: '하다',
      surface_suffix: '했다',
    },
    open_o_boda: {
      rule_id: 'predicate-plain-past-open-o-boda',
      lemma_suffix: '보다',
      uncontracted_form: 'supported',
      uncontracted_attachment: 'append 았다 to the stem',
      contracted_form: 'supported',
      contracted_attachment: 'replace the final open ㅗ nucleus with ㅘ, then add coda ㅆ',
    },
    open_o_oda: {
      rule_id: 'predicate-plain-past-required-oda',
      lemma_suffix: '오다',
      contracted_form: 'required',
      contracted_attachment: 'replace the final open ㅗ nucleus with ㅘ, then add coda ㅆ',
      uncontracted_form: 'unsupported',
    },
    other_open_stem_vowels: 'unsupported unless registered as a sense-bound exception',
  });
});

test('open ㅗ past contraction replaces the vowel nucleus before adding ㅆ', () => {
  assert.equal(contractOpenOVowelWithAt('보'), '봤');
  assert.equal(contractOpenOVowelWithAt('오'), '왔');
  assert.equal(contractOpenOVowelWithAt('바라보'), '바라봤');
  assert.equal(contractOpenOVowelWithAt('다가오'), '다가왔');
  assert.equal(contractOpenOVowelWithAt('가'), null);
  assert.equal(contractOpenOVowelWithAt('봄'), null);
  assert.equal(contractOpenOVowelWithAt(''), null);
  assert.equal(contractOpenOVowelWithAt(null), null);

  const contractedCases = new Map(
    contract.cases.map((searchCase) => [searchCase.query, searchCase]),
  );
  for (const query of ['봤다', '바라봤다']) {
    const searchCase = contractedCases.get(query);
    const candidate = searchCase.expected_candidates[0];
    assert.deepEqual(searchCase.rule_ids, ['predicate-plain-past-open-o-boda']);
    assert.equal(contractOpenOVowelWithAt(candidate.lemma.slice(0, -1)) + '다', query);
  }
  for (const query of ['보았다', '바라보았다']) {
    const searchCase = contractedCases.get(query);
    const candidate = searchCase.expected_candidates[0];
    assert.deepEqual(searchCase.rule_ids, ['predicate-plain-past-open-o-boda']);
    assert.equal(candidate.lemma.slice(0, -1) + '았다', query);
  }
  for (const query of ['왔다', '다가왔다']) {
    const searchCase = contractedCases.get(query);
    const candidate = searchCase.expected_candidates[0];
    assert.deepEqual(searchCase.rule_ids, ['predicate-plain-past-required-oda']);
    assert.equal(contractOpenOVowelWithAt(candidate.lemma.slice(0, -1)) + '다', query);
  }
  assert.deepEqual(contractedCases.get('오았다').expected_candidates, []);
  assert.equal(contractedCases.get('오았다').unsupported_reason, 'mandatory-o-contraction');
});

test('canonical positive and ambiguous cases bind to all licensed start senses', () => {
  const cases = contract.cases.filter((searchCase) => searchCase.corpus_binding === 'canonical');
  const supportedRuleIds = new Set(contract.supported_rule_ids);
  for (const searchCase of cases) {
    assert.ok(searchCase.expected_candidates.length > 0, `${searchCase.id} has candidates`);
    for (const ruleId of searchCase.rule_ids) {
      assert.ok(supportedRuleIds.has(ruleId), `${searchCase.id} uses a supported rule`);
    }
    if (searchCase.classification !== 'collision') {
      assert.deepEqual(findExactStartMatches(searchCase.query), [], `${searchCase.id} is generated`);
    }
    for (const candidate of searchCase.expected_candidates) {
      for (const ruleId of candidate.rule_ids ?? searchCase.rule_ids) {
        assert.ok(supportedRuleIds.has(ruleId), `${searchCase.id} candidate uses a supported rule`);
      }
      if (candidate.exception_id) {
        assert.ok(candidate.sense_ids.length > 0, `${searchCase.id} binds exception to senses`);
      }
      const record = recordsById.get(candidate.record_id);
      assert.ok(record, `${searchCase.id} references ${candidate.record_id}`);
      assert.equal(record.role, 'start', `${searchCase.id} uses a searchable record`);
      assert.equal(record.record_type, 'entry', `${searchCase.id} uses an entry`);
      assert.equal(record.lemma, candidate.lemma, `${searchCase.id} preserves its lemma`);
      for (const senseId of candidate.sense_ids) {
        const sense = record.senses.find(({ id }) => id === senseId);
        assert.ok(sense, `${searchCase.id} references ${senseId}`);
        assert.equal(sense.pos, candidate.pos, `${senseId} matches the rule POS`);
      }
    }
  }

  const ambiguousCases = cases.filter(({ classification }) => classification === 'ambiguous');
  assert.equal(ambiguousCases.length, 2);
  for (const searchCase of ambiguousCases) {
    const candidateIds = searchCase.expected_candidates.map(({ record_id }) => record_id);
    assert.ok(candidateIds.length > 1, `${searchCase.id} preserves multiple records`);
    assert.deepEqual(candidateIds, [...candidateIds].sort());
    assert.deepEqual(findExactStartMatches(searchCase.query), []);
  }
});

test('existing exact/search-form hits keep precedence over generated collisions', () => {
  const searchCase = contract.cases.find(({ classification }) => classification === 'collision');
  assert.ok(searchCase);
  const exactMatches = findExactStartMatches(searchCase.query);
  assert.deepEqual(exactMatches.map(({ id }) => id), ['w935']);
  assert.equal(exactMatches[0].lemma === searchCase.query ? 'exact-lemma' : 'exact-search-form',
    searchCase.expected_match_kind);
  assert.deepEqual(searchCase.generated_candidate_record_ids, ['w935']);
  assert.equal(searchCase.expected_candidates.length, 1);
  assert.equal(searchCase.expected_candidates[0].record_id, 'w935');
});

test('required examples absent from the contract snapshot stay marked contract-only', () => {
  const syntheticCases = contract.cases.filter(
    ({ classification }) => classification === 'synthetic-positive',
  );
  assert.equal(syntheticCases.length, 5);
  for (const searchCase of syntheticCases) {
    assert.deepEqual(findExactStartMatches(searchCase.query), [], `${searchCase.id} is contract-only`);
    for (const ruleId of searchCase.rule_ids) {
      assert.ok(contract.supported_rule_ids.includes(ruleId), `${searchCase.id} uses a supported rule`);
    }
    const candidate = searchCase.expected_candidates[0];
    assert.equal(candidate.record_id, null);
    assert.equal(candidate.sense_ids.length, 0);
    assert.equal(
      searchCase.corpus_binding,
      'example-target-absent-at-contract-snapshot',
    );
    assert.equal(records.some((record) => record.lemma === candidate.lemma), false);
  }
  assert.deepEqual(
    syntheticCases.map(({ query, rule_ids: ruleIds, expected_candidates: [candidate] }) => (
      [query, candidate.lemma, ruleIds]
    )),
    [
      ['먹었다', '먹다', ['predicate-plain-past-coda-bearing']],
      ['예쁜', '예쁘다', ['adjective-present-adnominal-eun']],
      ['왔다', '오다', ['predicate-plain-past-required-oda']],
      ['보았다', '보다', ['predicate-plain-past-open-o-boda']],
      ['봤다', '보다', ['predicate-plain-past-open-o-boda']],
    ],
  );
});

test('unsupported examples use no exact start key and stay outside generated rules', () => {
  const unsupportedCases = contract.cases.filter(
    ({ classification }) => classification === 'unsupported',
  );
  assert.equal(unsupportedCases.length, 4);
  for (const searchCase of unsupportedCases) {
    assert.deepEqual(searchCase.expected_candidates, []);
    assert.deepEqual(findExactStartMatches(searchCase.query), []);
    if (searchCase.base_record_id) {
      const record = recordsById.get(searchCase.base_record_id);
      assert.ok(record, `${searchCase.id} references its canonical base`);
      assert.equal(record.role, 'start');
    }
  }
  assert.equal(
    unsupportedCases.find(({ query }) => query === '오았다').unsupported_reason,
    'mandatory-o-contraction',
  );
  assert.equal(
    unsupportedCases.find(({ query }) => query === '기다렸다').unsupported_reason,
    'open-vowel-class-not-registered',
  );
});

test('plain-past irregular paths bind the exception class to the exact candidate senses', () => {
  const irregular = contract.cases.find(({ id }) => id === 'ambiguous-d-irregular-past-deureotda');
  assert.deepEqual(irregular.rule_ids, [
    'predicate-plain-past-coda-bearing',
    'predicate-plain-past-registered-exception',
  ]);
  assert.deepEqual(irregular.expected_candidates[0].rule_ids, [
    'predicate-plain-past-registered-exception',
  ]);
  assert.equal(irregular.expected_candidates[0].exception_id, 'm6-2-d-irregular-verb');
  assert.deepEqual(irregular.expected_candidates[1].rule_ids, [
    'predicate-plain-past-coda-bearing',
  ]);
  assert.equal(irregular.expected_candidates[1].exception_id, undefined);
});
