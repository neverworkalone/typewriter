import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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

function stemFinalCoda(lemma) {
  const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : lemma;
  const lastCharacter = [...stem].at(-1);
  if (!lastCharacter) return null;
  const offset = lastCharacter.codePointAt(0) - 0xac00;
  if (offset < 0 || offset >= 11172) return null;
  return codaTable[offset % 28];
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
  const posSenseCounts = { verb: 0, adjective: 0 };
  const posRecordCounts = { verb: 0, adjective: 0 };

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
      'predicate-plain-past',
    ],
  );
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
  assert.equal(syntheticCases.length, 2);
  for (const searchCase of syntheticCases) {
    const candidate = searchCase.expected_candidates[0];
    assert.equal(candidate.record_id, null);
    assert.equal(candidate.sense_ids.length, 0);
    assert.equal(
      searchCase.corpus_binding,
      'example-target-absent-at-contract-snapshot',
    );
    assert.equal(records.some((record) => record.lemma === candidate.lemma), false);
  }
});

test('unsupported examples use no exact start key and stay outside generated rules', () => {
  const unsupportedCases = contract.cases.filter(
    ({ classification }) => classification === 'unsupported',
  );
  assert.equal(unsupportedCases.length, 2);
  for (const searchCase of unsupportedCases) {
    assert.deepEqual(searchCase.expected_candidates, []);
    assert.deepEqual(findExactStartMatches(searchCase.query), []);
  }
});
