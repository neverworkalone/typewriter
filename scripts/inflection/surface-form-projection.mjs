import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractOpenOVowelWithAt } from './contract.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/m6-2-inflection-exceptions.json',
);
export const DEFAULT_SURFACE_FORM_REVIEW_MANIFEST = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/m6-3-surface-form-review.json',
);
export const SURFACE_FORM_PROJECTION_VERSION = '1';

export const SURFACE_FORM_RULE_IDS = Object.freeze({
  verbPresentAdnominalNeun: 'verb-present-adnominal-neun',
  verbPastAdnominalEun: 'verb-past-adnominal-eun',
  adjectivePresentAdnominalEun: 'adjective-present-adnominal-eun',
  adjectivePresentAdnominalNeunException: 'adjective-present-adnominal-neun-exception',
  predicateFutureAdnominalEul: 'predicate-future-adnominal-eul',
  predicatePlainPastCodaBearing: 'predicate-plain-past-coda-bearing',
  predicatePlainPastOpenA: 'predicate-plain-past-open-a',
  predicatePlainPastHada: 'predicate-plain-past-hada',
  predicatePlainPastOpenOBoda: 'predicate-plain-past-open-o-boda',
  predicatePlainPastRequiredOda: 'predicate-plain-past-required-oda',
  predicatePlainPastRegisteredException: 'predicate-plain-past-registered-exception',
});

const RULE_ORDER = Object.freeze(Object.values(SURFACE_FORM_RULE_IDS));
const EXCEPTION_CLASS_IDS = new Set([
  'm6-2-b-irregular-adjective',
  'm6-3-b-irregular-verb',
  'm6-2-d-irregular-verb',
  'm6-2-h-irregular-adjective',
  'm6-2-eu-irregular-predicate',
  'm6-2-reu-irregular-verb',
  'm6-3-reu-irregular-adjective',
  'm6-2-si-irregular-verb',
  'm6-2-eopda-present-adnominal',
  'm6-2-itda-present-adnominal',
  'm6-3-open-eu-past',
  'm6-3-shortened-didida-lemma',
]);
const REGULAR_RISK_CODA_CLASS_IDS = new Map([
  ['ㄷ', { verb: 'm6-3-regular-d-verb', adjective: 'm6-3-regular-d-adjective' }],
  ['ㅂ', { verb: 'm6-3-regular-b-verb', adjective: 'm6-3-regular-b-adjective' }],
  ['ㅅ', { verb: 'm6-3-regular-s-verb', adjective: 'm6-3-regular-s-adjective' }],
  ['ㅎ', { verb: 'm6-3-regular-h-verb', adjective: 'm6-3-regular-h-adjective' }],
]);
const REVIEW_DISPOSITION_CLASS_IDS = new Set([
  ...[...REGULAR_RISK_CODA_CLASS_IDS.values()].flatMap(Object.values),
  'm6-3-open-vowel-past-excluded',
  'm6-3-predicate-excluded',
]);
const EMPTY_SURFACE_FORM_REVIEW_MANIFEST = Object.freeze({
  schema_version: 1,
  contract_id: 'm6-3-surface-form-review-v1',
  source_issue: 175,
  dispositions: Object.freeze([]),
  reviewed_collisions: Object.freeze({
    exact_generated: Object.freeze([]),
    ambiguous_generated: Object.freeze([]),
  }),
});

const HANGUL_BASE = 0xac00;
const HANGUL_COUNT = 11172;
const FINAL_CONSONANTS = Object.freeze([
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ',
  'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ',
  'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
]);
const VOWELS = Object.freeze([
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ',
  'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
]);
const FINAL_INDEX = new Map(FINAL_CONSONANTS.map((value, index) => [value, index]));
const VOWEL_INDEX = new Map(VOWELS.map((value, index) => [value, index]));
const SS_CODA = FINAL_INDEX.get('ㅆ');
const L_CODA = FINAL_INDEX.get('ㄹ');
const N_CODA = FINAL_INDEX.get('ㄴ');

export class SurfaceFormProjectionError extends Error {
  constructor(message, code = 'SURFACE_FORM_PROJECTION_ERROR') {
    super(message);
    this.name = 'SurfaceFormProjectionError';
    this.code = code;
  }
}

function recordOf(recordInfoOrRecord) {
  return recordInfoOrRecord?.record ?? recordInfoOrRecord;
}

function hangulParts(character) {
  if (typeof character !== 'string' || [...character].length !== 1) return null;
  const offset = character.codePointAt(0) - HANGUL_BASE;
  if (offset < 0 || offset >= HANGUL_COUNT) return null;
  return {
    onset: Math.floor(offset / 588),
    vowel: Math.floor((offset % 588) / 28),
    coda: offset % 28,
  };
}

function composeHangul({ onset, vowel, coda }) {
  return String.fromCodePoint(
    HANGUL_BASE + onset * 588 + vowel * 28 + coda,
  );
}

function finalParts(stem) {
  const characters = [...stem];
  const last = characters.at(-1);
  const parts = hangulParts(last);
  if (!parts) return null;
  return { characters, last, parts };
}

function replaceFinalSyllable(stem, update) {
  const final = finalParts(stem);
  if (!final) return null;
  final.characters[final.characters.length - 1] = composeHangul(update(final.parts));
  return final.characters.join('');
}

function replaceFinalCoda(stem, expected, replacement) {
  const expectedIndex = FINAL_INDEX.get(expected);
  const replacementIndex = FINAL_INDEX.get(replacement);
  return replaceFinalSyllable(stem, (parts) => {
    if (parts.coda !== expectedIndex) {
      throw new SurfaceFormProjectionError(
        'Stem does not end in the expected coda ' + expected + '.',
        'EXCEPTION_CLASS_STEM_MISMATCH',
      );
    }
    return { ...parts, coda: replacementIndex };
  });
}

function removeFinalCoda(stem, expected) {
  const expectedIndex = FINAL_INDEX.get(expected);
  return replaceFinalSyllable(stem, (parts) => {
    if (parts.coda !== expectedIndex) {
      throw new SurfaceFormProjectionError(
        'Stem does not end in the expected coda ' + expected + '.',
        'EXCEPTION_CLASS_STEM_MISMATCH',
      );
    }
    return { ...parts, coda: 0 };
  });
}

function addFinalCoda(stem, coda) {
  const codaIndex = FINAL_INDEX.get(coda);
  return replaceFinalSyllable(stem, (parts) => {
    if (parts.coda !== 0) {
      throw new SurfaceFormProjectionError(
        'A final coda can only be attached to an open stem syllable.',
        'INVALID_CODA_ATTACHMENT',
      );
    }
    return { ...parts, coda: codaIndex };
  });
}

function changeFinalVowelAndCoda(stem, vowel, coda = 0) {
  const vowelIndex = VOWEL_INDEX.get(vowel);
  if (vowelIndex === undefined) return null;
  return replaceFinalSyllable(stem, (parts) => ({
    ...parts,
    vowel: vowelIndex,
    coda,
  }));
}

function finalVowel(stem) {
  const final = finalParts(stem);
  return final ? VOWELS[final.parts.vowel] : null;
}

function isOpenFinal(stem) {
  const final = finalParts(stem);
  return Boolean(final && final.parts.coda === 0);
}

function isBrightVowel(vowel) {
  return new Set(['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ']).has(vowel);
}

function regularPastSuffix(stem) {
  const vowel = finalVowel(stem);
  return vowel === 'ㅏ' || vowel === 'ㅗ' ? '았다' : '었다';
}

function adnominalEun(stem) {
  const final = finalParts(stem);
  if (!final) return null;
  if (final.parts.coda === 0) return addFinalCoda(stem, 'ㄴ');
  if (final.parts.coda === L_CODA) {
    return addFinalCoda(removeFinalCoda(stem, 'ㄹ'), 'ㄴ');
  }
  return stem + '은';
}

function adnominalEul(stem) {
  const final = finalParts(stem);
  if (!final) return null;
  if (final.parts.coda === 0) return addFinalCoda(stem, 'ㄹ');
  if (final.parts.coda === L_CODA) return stem;
  return stem + '을';
}

function presentVerbNeun(stem) {
  const final = finalParts(stem);
  if (!final) return null;
  const regularStem = final.parts.coda === L_CODA
    ? removeFinalCoda(stem, 'ㄹ')
    : stem;
  return regularStem + '는';
}

function openAPlainPast(stem) {
  if (finalVowel(stem) !== 'ㅏ' || !isOpenFinal(stem)) return null;
  return addFinalCoda(stem, 'ㅆ') + '다';
}

function plainPastForClass(stem, classId) {
  if (
    classId === 'm6-2-b-irregular-adjective'
    || classId === 'm6-3-b-irregular-verb'
  ) {
    return [removeFinalCoda(stem, 'ㅂ') + '웠다'];
  }

  if (classId === 'm6-2-d-irregular-verb') {
    const changed = replaceFinalCoda(stem, 'ㄷ', 'ㄹ');
    return [changed + regularPastSuffix(changed)];
  }

  if (classId === 'm6-2-si-irregular-verb') {
    const changed = removeFinalCoda(stem, 'ㅅ');
    return [changed + regularPastSuffix(changed)];
  }

  if (classId === 'm6-2-h-irregular-adjective') {
    const final = finalParts(stem);
    if (!final || final.parts.coda !== FINAL_INDEX.get('ㅎ')) return null;
    const pastVowelByStemVowel = new Map([
      ['ㅏ', 'ㅐ'],
      ['ㅑ', 'ㅒ'],
      ['ㅓ', 'ㅔ'],
      ['ㅕ', 'ㅖ'],
    ]);
    const changedVowel = pastVowelByStemVowel.get(VOWELS[final.parts.vowel]);
    if (!changedVowel) return null;
    return [changeFinalVowelAndCoda(stem, changedVowel, SS_CODA) + '다'];
  }

  if (
    classId === 'm6-2-eu-irregular-predicate'
    || classId === 'm6-3-open-eu-past'
  ) {
    if (finalVowel(stem) !== 'ㅡ' || !isOpenFinal(stem)) return null;
    const characters = [...stem];
    const precedingVowel = characters.length > 1
      ? finalVowel(characters.slice(0, -1).join(''))
      : null;
    const endingVowel = isBrightVowel(precedingVowel) ? 'ㅏ' : 'ㅓ';
    return [changeFinalVowelAndCoda(stem, endingVowel, SS_CODA) + '다'];
  }

  if (
    classId === 'm6-2-reu-irregular-verb'
    || classId === 'm6-3-reu-irregular-adjective'
  ) {
    const characters = [...stem];
    if (characters.length < 2 || characters.at(-1) !== '르') return null;
    const preceding = characters.at(-2);
    const precedingParts = hangulParts(preceding);
    if (!precedingParts || precedingParts.coda !== 0) return null;
    const bright = isBrightVowel(VOWELS[precedingParts.vowel]);
    const adjustedPrevious = composeHangul({ ...precedingParts, coda: L_CODA });
    const adjustedLast = composeHangul({
      onset: 5,
      vowel: VOWEL_INDEX.get(bright ? 'ㅏ' : 'ㅓ'),
      coda: SS_CODA,
    });
    const prefix = characters.slice(0, -2).join('');
    return [prefix + adjustedPrevious + adjustedLast + '다'];
  }

  return null;
}

function formsForRule({ record, sense, classId, ruleId }) {
  const lemma = record.lemma;
  const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : null;
  if (!stem || stem.includes(' ')) return null;

  if (classId === 'm6-3-shortened-didida-lemma') return null;

  if (ruleId === SURFACE_FORM_RULE_IDS.verbPresentAdnominalNeun) {
    return [presentVerbNeun(stem)];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.verbPastAdnominalEun) {
    if (classId === 'm6-2-d-irregular-verb') {
      return [replaceFinalCoda(stem, 'ㄷ', 'ㄹ') + '은'];
    }
    if (
      classId === 'm6-3-b-irregular-verb'
      || classId === 'm6-2-b-irregular-adjective'
    ) {
      return [removeFinalCoda(stem, 'ㅂ') + '운'];
    }
    if (classId === 'm6-2-si-irregular-verb') {
      return [removeFinalCoda(stem, 'ㅅ') + '은'];
    }
    return [adnominalEun(stem)];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.adjectivePresentAdnominalEun) {
    if (
      classId === 'm6-2-eopda-present-adnominal'
      || classId === 'm6-2-itda-present-adnominal'
    ) return null;
    if (classId === 'm6-2-b-irregular-adjective') {
      return [removeFinalCoda(stem, 'ㅂ') + '운'];
    }
    if (classId === 'm6-2-h-irregular-adjective') {
      return [addFinalCoda(removeFinalCoda(stem, 'ㅎ'), 'ㄴ')];
    }
    return [adnominalEun(stem)];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.adjectivePresentAdnominalNeunException) {
    if (
      classId !== 'm6-2-eopda-present-adnominal'
      && classId !== 'm6-2-itda-present-adnominal'
    ) return null;
    return [stem + '는'];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicateFutureAdnominalEul) {
    if (classId === 'm6-2-d-irregular-verb') {
      return [replaceFinalCoda(stem, 'ㄷ', 'ㄹ') + '을'];
    }
    if (
      classId === 'm6-3-b-irregular-verb'
      || classId === 'm6-2-b-irregular-adjective'
    ) {
      return [removeFinalCoda(stem, 'ㅂ') + '울'];
    }
    if (classId === 'm6-2-si-irregular-verb') {
      return [removeFinalCoda(stem, 'ㅅ') + '을'];
    }
    if (classId === 'm6-2-h-irregular-adjective') {
      return [addFinalCoda(removeFinalCoda(stem, 'ㅎ'), 'ㄹ')];
    }
    return [adnominalEul(stem)];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException) {
    return plainPastForClass(stem, classId);
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastHada) {
    if (!lemma.endsWith('하다')) return null;
    return [stem.slice(0, -1) + '했' + '다'];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastCodaBearing) {
    if (isOpenFinal(stem)) return null;
    if (
      classId === 'm6-2-b-irregular-adjective'
      || classId === 'm6-3-b-irregular-verb'
      || classId === 'm6-2-d-irregular-verb'
      || classId === 'm6-2-si-irregular-verb'
      || classId === 'm6-2-h-irregular-adjective'
    ) {
      return null;
    }
    return [stem + regularPastSuffix(stem)];
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastOpenA) {
    if (lemma.endsWith('하다')) return null;
    const form = openAPlainPast(stem);
    return form ? [form] : null;
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastRequiredOda) {
    if (!lemma.endsWith('오다')) return null;
    const contracted = contractOpenOVowelWithAt(stem);
    return contracted ? [contracted + '다'] : null;
  }

  if (ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastOpenOBoda) {
    if (!lemma.endsWith('보다')) return null;
    const contracted = contractOpenOVowelWithAt(stem);
    if (!contracted) return null;
    return [stem + '았다', contracted + '다'];
  }

  if (
    ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastOpenA
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastRequiredOda
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastOpenOBoda
  ) {
    return null;
  }

  return null;
}

function isPlainPastRule(ruleId) {
  return ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastCodaBearing
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastOpenA
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastHada
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastOpenOBoda
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastRequiredOda
    || ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException;
}

function plainPastRuleId(record, classId) {
  const lemma = record.lemma;
  const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : '';
  if (
    classId === 'm6-3-shortened-didida-lemma'
    || classId === 'm6-2-b-irregular-adjective'
    || classId === 'm6-3-b-irregular-verb'
    || classId === 'm6-2-d-irregular-verb'
    || classId === 'm6-2-h-irregular-adjective'
    || classId === 'm6-2-eu-irregular-predicate'
    || classId === 'm6-2-reu-irregular-verb'
    || classId === 'm6-3-reu-irregular-adjective'
    || classId === 'm6-2-si-irregular-verb'
    || classId === 'm6-3-open-eu-past'
  ) {
    return SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException;
  }
  if (lemma.endsWith('하다')) {
    return SURFACE_FORM_RULE_IDS.predicatePlainPastHada;
  }

  const final = finalParts(stem);
  if (final?.parts.coda !== 0) {
    return SURFACE_FORM_RULE_IDS.predicatePlainPastCodaBearing;
  }
  if (final && VOWELS[final.parts.vowel] === 'ㅏ') {
    return SURFACE_FORM_RULE_IDS.predicatePlainPastOpenA;
  }
  if (lemma.endsWith('오다')) {
    return SURFACE_FORM_RULE_IDS.predicatePlainPastRequiredOda;
  }
  if (lemma.endsWith('보다')) {
    return SURFACE_FORM_RULE_IDS.predicatePlainPastOpenOBoda;
  }
  return SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException;
}

function ruleIdsForSense(record, sense, classId) {
  const plainPastRule = plainPastRuleId(record, classId);
  if (sense.pos === 'verb') {
    return [
      SURFACE_FORM_RULE_IDS.verbPresentAdnominalNeun,
      SURFACE_FORM_RULE_IDS.verbPastAdnominalEun,
      SURFACE_FORM_RULE_IDS.predicateFutureAdnominalEul,
      plainPastRule,
    ];
  }

  if (sense.pos === 'adjective') {
    return [
      (
        classId === 'm6-2-eopda-present-adnominal'
        || classId === 'm6-2-itda-present-adnominal'
      )
        ? SURFACE_FORM_RULE_IDS.adjectivePresentAdnominalNeunException
        : SURFACE_FORM_RULE_IDS.adjectivePresentAdnominalEun,
      SURFACE_FORM_RULE_IDS.predicateFutureAdnominalEul,
      plainPastRule,
    ];
  }

  return [];
}

function sourceKey(recordId, senseId) {
  return recordId + '\u0000' + senseId;
}

function finalCodaForPredicate(record) {
  if (!record?.lemma?.endsWith('다') || record.lemma.includes(' ')) return null;
  const stem = record.lemma.slice(0, -1);
  const final = finalParts(stem);
  return final ? FINAL_CONSONANTS[final.parts.coda] : null;
}

function expectedRegularRiskClass(record, sense) {
  const coda = finalCodaForPredicate(record);
  return REGULAR_RISK_CODA_CLASS_IDS.get(coda)?.[sense.pos] ?? null;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateManifestBindings(records, manifest, requireTargets) {
  if (
    !manifest
    || manifest.schema_version !== 1
    || manifest.contract_id !== 'm6-2-inflection-exceptions-v1'
    || !Array.isArray(manifest.exceptions)
  ) {
    throw new SurfaceFormProjectionError(
      'The M6-2 exception manifest has an invalid envelope.',
      'INVALID_EXCEPTION_MANIFEST',
    );
  }

  const recordsById = new Map();
  for (const recordInfo of records) {
    const record = recordOf(recordInfo);
    recordsById.set(record.id, record);
  }

  const exceptionsBySense = new Map();
  const seen = new Set();
  for (const entry of manifest.exceptions) {
    if (
      !entry
      || typeof entry.record_id !== 'string'
      || typeof entry.sense_id !== 'string'
      || typeof entry.class_id !== 'string'
    ) {
      throw new SurfaceFormProjectionError(
        'Every exception binding requires record_id, sense_id, and class_id.',
        'INVALID_EXCEPTION_BINDING',
      );
    }
    if (!EXCEPTION_CLASS_IDS.has(entry.class_id)) {
      throw new SurfaceFormProjectionError(
        'Unknown surface-form exception class: ' + entry.class_id + '.',
        'UNKNOWN_EXCEPTION_CLASS',
      );
    }

    const key = sourceKey(entry.record_id, entry.sense_id);
    if (seen.has(key)) {
      throw new SurfaceFormProjectionError(
        'Duplicate exception binding for ' + entry.record_id + '/' + entry.sense_id + '.',
        'DUPLICATE_EXCEPTION_BINDING',
      );
    }
    seen.add(key);

    const record = recordsById.get(entry.record_id);
    if (!record) {
      if (requireTargets) {
        throw new SurfaceFormProjectionError(
          'Exception binding references missing record ' + entry.record_id + '.',
          'MISSING_EXCEPTION_RECORD',
        );
      }
      continue;
    }

    const sense = record.senses.find(({ id }) => id === entry.sense_id);
    if (!sense) {
      throw new SurfaceFormProjectionError(
        'Exception binding references missing sense ' + entry.sense_id + '.',
        'MISSING_EXCEPTION_SENSE',
      );
    }
    if (record.role !== 'start' || record.record_type !== 'entry') {
      throw new SurfaceFormProjectionError(
        'Exception bindings may only target searchable entry records.',
        'INVALID_EXCEPTION_TARGET',
      );
    }

    const stem = record.lemma.endsWith('다') ? record.lemma.slice(0, -1) : '';
    const final = finalParts(stem);
    const expected = {
      'm6-2-b-irregular-adjective': sense.pos === 'adjective' && final?.parts.coda === FINAL_INDEX.get('ㅂ'),
      'm6-3-b-irregular-verb': sense.pos === 'verb' && final?.parts.coda === FINAL_INDEX.get('ㅂ'),
      'm6-2-d-irregular-verb': sense.pos === 'verb' && final?.parts.coda === FINAL_INDEX.get('ㄷ'),
      'm6-2-h-irregular-adjective': sense.pos === 'adjective' && final?.parts.coda === FINAL_INDEX.get('ㅎ'),
      'm6-2-eu-irregular-predicate': ['verb', 'adjective'].includes(sense.pos)
        && final?.parts.coda === 0 && VOWELS[final.parts.vowel] === 'ㅡ',
      'm6-2-reu-irregular-verb': sense.pos === 'verb' && stem.endsWith('르'),
      'm6-3-reu-irregular-adjective': sense.pos === 'adjective' && stem.endsWith('르'),
      'm6-2-si-irregular-verb': sense.pos === 'verb' && final?.parts.coda === FINAL_INDEX.get('ㅅ'),
      'm6-2-eopda-present-adnominal': sense.pos === 'adjective' && record.lemma.endsWith('없다'),
      'm6-2-itda-present-adnominal': sense.pos === 'adjective' && record.lemma.endsWith('있다'),
      'm6-3-open-eu-past': ['verb', 'adjective'].includes(sense.pos)
        && final?.parts.coda === 0 && VOWELS[final.parts.vowel] === 'ㅡ',
      'm6-3-shortened-didida-lemma': sense.pos === 'verb' && record.lemma === '내딛다',
    }[entry.class_id];

    if (!expected) {
      throw new SurfaceFormProjectionError(
        'Exception class ' + entry.class_id + ' does not match ' + record.id + '/' + sense.id + '.',
        'EXCEPTION_CLASS_TARGET_MISMATCH',
      );
    }
    exceptionsBySense.set(key, entry.class_id);
  }

  return exceptionsBySense;
}

function validateReviewManifestBindings(
  records,
  manifest,
  exceptionsBySense,
  requireTargets,
) {
  if (
    !manifest
    || manifest.schema_version !== 1
    || manifest.contract_id !== 'm6-3-surface-form-review-v1'
    || manifest.source_issue !== 175
    || !Array.isArray(manifest.dispositions)
    || !manifest.reviewed_collisions
    || !Array.isArray(manifest.reviewed_collisions.exact_generated)
    || !Array.isArray(manifest.reviewed_collisions.ambiguous_generated)
  ) {
    throw new SurfaceFormProjectionError(
      'The M6-3 surface-form review manifest has an invalid envelope.',
      'INVALID_SURFACE_FORM_REVIEW_MANIFEST',
    );
  }

  const recordsById = new Map(records.map((recordInfo) => {
    const record = recordOf(recordInfo);
    return [record.id, record];
  }));
  const dispositionsBySense = new Map();
  for (const entry of manifest.dispositions) {
    if (
      !entry
      || typeof entry.record_id !== 'string'
      || typeof entry.sense_id !== 'string'
      || typeof entry.class_id !== 'string'
      || typeof entry.reason !== 'string'
      || entry.reason.trim().length === 0
    ) {
      throw new SurfaceFormProjectionError(
        'Every review disposition requires class_id, record_id, sense_id, and a reason.',
        'INVALID_SURFACE_FORM_DISPOSITION',
      );
    }
    if (!REVIEW_DISPOSITION_CLASS_IDS.has(entry.class_id)) {
      throw new SurfaceFormProjectionError(
        'Unknown surface-form review class: ' + entry.class_id + '.',
        'UNKNOWN_SURFACE_FORM_REVIEW_CLASS',
      );
    }

    const key = sourceKey(entry.record_id, entry.sense_id);
    if (dispositionsBySense.has(key)) {
      throw new SurfaceFormProjectionError(
        'Duplicate review disposition for ' + entry.record_id + '/' + entry.sense_id + '.',
        'DUPLICATE_SURFACE_FORM_DISPOSITION',
      );
    }
    if (exceptionsBySense.has(key)) {
      throw new SurfaceFormProjectionError(
        'A sense cannot have both an exception class and a review disposition: '
          + entry.record_id + '/' + entry.sense_id + '.',
        'CONFLICTING_SURFACE_FORM_CLASSIFICATION',
      );
    }

    const record = recordsById.get(entry.record_id);
    if (!record) {
      if (requireTargets) {
        throw new SurfaceFormProjectionError(
          'Review disposition references missing record ' + entry.record_id + '.',
          'MISSING_SURFACE_FORM_REVIEW_RECORD',
        );
      }
      continue;
    }
    const sense = record.senses.find(({ id }) => id === entry.sense_id);
    if (!sense) {
      throw new SurfaceFormProjectionError(
        'Review disposition references missing sense ' + entry.sense_id + '.',
        'MISSING_SURFACE_FORM_REVIEW_SENSE',
      );
    }
    if (record.role !== 'start' || record.record_type !== 'entry') {
      throw new SurfaceFormProjectionError(
        'Review dispositions may only target searchable entry records.',
        'INVALID_SURFACE_FORM_REVIEW_TARGET',
      );
    }
    if (sense.pos !== 'verb' && sense.pos !== 'adjective') {
      throw new SurfaceFormProjectionError(
        'Review dispositions may only target predicate senses.',
        'INVALID_SURFACE_FORM_REVIEW_TARGET',
      );
    }

    const stem = record.lemma.endsWith('다') ? record.lemma.slice(0, -1) : '';
    const validTarget = entry.class_id === 'm6-3-predicate-excluded'
      ? record.lemma.endsWith('다')
      : entry.class_id === 'm6-3-open-vowel-past-excluded'
        ? record.lemma.endsWith('다')
          && !record.lemma.includes(' ')
          && isOpenFinal(stem)
          && plainPastRuleId(record, null)
            === SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException
        : expectedRegularRiskClass(record, sense) === entry.class_id;
    if (!validTarget) {
      throw new SurfaceFormProjectionError(
        'Review class ' + entry.class_id + ' does not match '
          + record.id + '/' + sense.id + '.',
        'SURFACE_FORM_REVIEW_CLASS_TARGET_MISMATCH',
      );
    }
    dispositionsBySense.set(key, entry);
  }

  return dispositionsBySense;
}

function allRelevantRecords(records) {
  return records
    .map((recordInfo) => ({ info: recordInfo, record: recordOf(recordInfo) }))
    .filter(({ record }) => (
      record?.role === 'start'
      && record?.record_type === 'entry'
      && Array.isArray(record.senses)
    ));
}

function addDecision(decisions, record, sense, ruleId, result) {
  const key = sourceKey(record.id, sense.id) + '\u0000' + ruleId;
  if (decisions.has(key)) {
    throw new SurfaceFormProjectionError(
      'A surface-form rule was applied more than once to ' + record.id + '/' + sense.id + '.',
      'DUPLICATE_RULE_DECISION',
    );
  }
  decisions.set(key, result);
}

function addExclusion(exclusions, record, sense, ruleId, reason) {
  exclusions.push({
    record_id: record.id,
    sense_id: sense.id,
    rule_id: ruleId,
    reason,
  });
}

function exclusionReason(record, classId, ruleId) {
  if (classId === 'm6-3-shortened-didida-lemma') {
    return 'shortened-citation-lemma-inflection-not-supported';
  }
  if (record.lemma.includes(' ')) return 'multiword-predicate-not-tokenized';
  if (!record.lemma.endsWith('다')) return 'predicate-lemma-not-citation-form';
  if (isPlainPastRule(ruleId)) return 'open-vowel-class-not-registered';
  return 'unsupported-predicate-class';
}

function exactFormsIndex(records) {
  const index = new Map();
  for (const recordInfo of records) {
    const record = recordOf(recordInfo);
    if (record?.role !== 'start') continue;
    for (const [field, value] of [
      ['lemma', record.lemma],
      ...(record.search_forms ?? []).map((form) => ['search-form', form]),
    ]) {
      const current = index.get(value) ?? new Map();
      const candidate = {
        record_id: record.id,
        record_type: record.record_type,
        field,
      };
      current.set(record.id + '\u0000' + record.record_type + '\u0000' + field, candidate);
      index.set(value, current);
    }
  }
  return new Map([...index.entries()].map(([form, candidates]) => [
    form,
    [...candidates.values()].sort((left, right) => (
      compareStrings(left.record_id, right.record_id)
      || compareStrings(left.record_type, right.record_type)
      || compareStrings(left.field, right.field)
    )),
  ]));
}

function collisionAudit(records, rows) {
  const exact = exactFormsIndex(records);
  const generatedByForm = new Map();
  for (const row of rows) {
    const candidates = generatedByForm.get(row.form) ?? new Map();
    const key = sourceKey(row.record_id, row.sense_id);
    candidates.set(key, {
      record_id: row.record_id,
      sense_id: row.sense_id,
      rule_id: row.rule_id,
    });
    generatedByForm.set(row.form, candidates);
  }

  const exactCollisions = [];
  const ambiguousGeneratedForms = [];
  for (const [form, candidateMap] of generatedByForm) {
    const candidates = [...candidateMap.values()].sort((left, right) => (
      compareStrings(left.record_id, right.record_id)
      || compareStrings(left.sense_id, right.sense_id)
      || compareStrings(left.rule_id, right.rule_id)
    ));
    if (exact.has(form)) {
      exactCollisions.push({
        form,
        exact_candidates: exact.get(form),
        generated_candidates: candidates,
      });
    }
    if (candidates.length > 1) {
      ambiguousGeneratedForms.push({
        form,
        candidate_count: candidates.length,
        candidates,
      });
    }
  }

  exactCollisions.sort((left, right) => compareStrings(left.form, right.form));
  ambiguousGeneratedForms.sort((left, right) => compareStrings(left.form, right.form));
  return { exactCollisions, ambiguousGeneratedForms };
}

function compareExactCandidates(left, right) {
  return compareStrings(left.record_id, right.record_id)
    || compareStrings(left.record_type, right.record_type)
    || compareStrings(left.field, right.field);
}

function compareGeneratedCandidates(left, right) {
  return compareStrings(left.record_id, right.record_id)
    || compareStrings(left.sense_id, right.sense_id)
    || compareStrings(left.rule_id, right.rule_id);
}

function validateCollisionReview(manifest, actual) {
  const reviewed = manifest.reviewed_collisions;
  const exactSeen = new Set();
  const ambiguousSeen = new Set();
  for (const entry of reviewed.exact_generated) {
    if (
      !entry
      || typeof entry.form !== 'string'
      || typeof entry.reason !== 'string'
      || entry.reason.trim().length === 0
      || !Array.isArray(entry.exact_candidates)
      || !Array.isArray(entry.generated_candidates)
    ) {
      throw new SurfaceFormProjectionError(
        'Every exact/generated collision review requires a form, candidates, and a reason.',
        'INVALID_COLLISION_REVIEW',
      );
    }
    if (exactSeen.has(entry.form)) {
      throw new SurfaceFormProjectionError(
        'Duplicate exact/generated collision review for ' + entry.form + '.',
        'DUPLICATE_COLLISION_REVIEW',
      );
    }
    exactSeen.add(entry.form);
  }
  for (const entry of reviewed.ambiguous_generated) {
    if (
      !entry
      || typeof entry.form !== 'string'
      || typeof entry.reason !== 'string'
      || entry.reason.trim().length === 0
      || !Array.isArray(entry.candidates)
    ) {
      throw new SurfaceFormProjectionError(
        'Every generated ambiguity review requires a form, candidates, and a reason.',
        'INVALID_COLLISION_REVIEW',
      );
    }
    if (ambiguousSeen.has(entry.form)) {
      throw new SurfaceFormProjectionError(
        'Duplicate generated ambiguity review for ' + entry.form + '.',
        'DUPLICATE_COLLISION_REVIEW',
      );
    }
    ambiguousSeen.add(entry.form);
  }

  const expectedExact = reviewed.exact_generated.map((entry) => ({
    form: entry.form,
    exact_candidates: [...entry.exact_candidates].sort(compareExactCandidates),
    generated_candidates: [...entry.generated_candidates].sort(compareGeneratedCandidates),
  })).sort((left, right) => compareStrings(left.form, right.form));
  const actualExact = actual.exactCollisions.map((entry) => ({
    form: entry.form,
    exact_candidates: [...entry.exact_candidates].sort(compareExactCandidates),
    generated_candidates: [...entry.generated_candidates].sort(compareGeneratedCandidates),
  }));
  const expectedAmbiguous = reviewed.ambiguous_generated.map((entry) => ({
    form: entry.form,
    candidates: [...entry.candidates].sort(compareGeneratedCandidates),
  })).sort((left, right) => compareStrings(left.form, right.form));
  const actualAmbiguous = actual.ambiguousGeneratedForms.map((entry) => ({
    form: entry.form,
    candidates: [...entry.candidates].sort(compareGeneratedCandidates),
  }));
  if (
    JSON.stringify(expectedExact) !== JSON.stringify(actualExact)
    || JSON.stringify(expectedAmbiguous) !== JSON.stringify(actualAmbiguous)
  ) {
    throw new SurfaceFormProjectionError(
      'Generated collisions differ from the reviewed exact/generated and generated/generated candidate sets.',
      'SURFACE_FORM_COLLISION_REVIEW_MISMATCH',
    );
  }
}

function validateClassDispositionCoverage(
  eligible,
  exceptionsBySense,
  dispositionsBySense,
  requireClassDispositions,
) {
  if (!requireClassDispositions) return;
  for (const { record } of eligible) {
    for (const sense of record.senses) {
      if (sense.pos !== 'verb' && sense.pos !== 'adjective') continue;
      const key = sourceKey(record.id, sense.id);
      const exceptionClass = exceptionsBySense.get(key) ?? null;
      const disposition = dispositionsBySense.get(key);
      const fullyExcluded = disposition?.class_id === 'm6-3-predicate-excluded';

      if (
        sense.pos === 'adjective'
        && record.lemma.endsWith('없다')
        && exceptionClass !== 'm6-2-eopda-present-adnominal'
        && !fullyExcluded
      ) {
        throw new SurfaceFormProjectionError(
          'An adjective ending in 없다 requires its present-adnominal class or an explicit exclusion of all generated forms: '
            + record.id + '/' + sense.id + '.',
          'MISSING_EXCEPTION_CLASS',
        );
      }
      if (
        sense.pos === 'adjective'
        && record.lemma.endsWith('있다')
        && exceptionClass !== 'm6-2-itda-present-adnominal'
        && !fullyExcluded
      ) {
        throw new SurfaceFormProjectionError(
          'An adjective ending in 있다 requires its present-adnominal class or an explicit exclusion of all generated forms: '
            + record.id + '/' + sense.id + '.',
          'MISSING_EXCEPTION_CLASS',
        );
      }
      if (fullyExcluded) continue;
      if (!record.lemma.endsWith('다') || record.lemma.includes(' ')) continue;

      const riskClass = expectedRegularRiskClass(record, sense);
      if (
        riskClass
        && !exceptionClass
        && disposition?.class_id !== riskClass
      ) {
        throw new SurfaceFormProjectionError(
          'Predicate sense with a risk coda requires an explicit regular class, supported exception, or exclusion: '
            + record.id + '/' + sense.id + '.',
          'MISSING_PREDICATE_CLASS_DISPOSITION',
        );
      }

      if (
        !exceptionClass
        && plainPastRuleId(record, null)
          === SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException
        && disposition?.class_id !== 'm6-3-open-vowel-past-excluded'
      ) {
        throw new SurfaceFormProjectionError(
          'Unsupported open-vowel past requires an explicit sense-bound exclusion: '
            + record.id + '/' + sense.id + '.',
          'MISSING_PLAIN_PAST_DISPOSITION',
        );
      }
    }
  }
}

export async function loadSurfaceFormExceptionManifest(
  filePath = DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST,
) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'Could not read M6-2 surface-form exception manifest: ' + error.message,
      'EXCEPTION_MANIFEST_UNAVAILABLE',
    );
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'M6-2 surface-form exception manifest is invalid JSON: ' + error.message,
      'INVALID_EXCEPTION_MANIFEST',
    );
  }
}

export function loadSurfaceFormExceptionManifestSync(
  filePath = DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST,
) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'Could not read M6-2 surface-form exception manifest: ' + error.message,
      'EXCEPTION_MANIFEST_UNAVAILABLE',
    );
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'M6-2 surface-form exception manifest is invalid JSON: ' + error.message,
      'INVALID_EXCEPTION_MANIFEST',
    );
  }
}

export async function loadSurfaceFormReviewManifest(
  filePath = DEFAULT_SURFACE_FORM_REVIEW_MANIFEST,
) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'Could not read M6-3 surface-form review manifest: ' + error.message,
      'SURFACE_FORM_REVIEW_MANIFEST_UNAVAILABLE',
    );
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'M6-3 surface-form review manifest is invalid JSON: ' + error.message,
      'INVALID_SURFACE_FORM_REVIEW_MANIFEST',
    );
  }
}

export function loadSurfaceFormReviewManifestSync(
  filePath = DEFAULT_SURFACE_FORM_REVIEW_MANIFEST,
) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'Could not read M6-3 surface-form review manifest: ' + error.message,
      'SURFACE_FORM_REVIEW_MANIFEST_UNAVAILABLE',
    );
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new SurfaceFormProjectionError(
      'M6-3 surface-form review manifest is invalid JSON: ' + error.message,
      'INVALID_SURFACE_FORM_REVIEW_MANIFEST',
    );
  }
}

export function buildSurfaceFormProjection(
  records,
  {
    exceptionManifest,
    reviewManifest,
    requireExceptionTargets = false,
    requireClassDispositions = false,
    requireCollisionReview = false,
  } = {},
) {
  if (!Array.isArray(records)) {
    throw new SurfaceFormProjectionError('Canonical records must be an array.');
  }
  if (!exceptionManifest) {
    throw new SurfaceFormProjectionError('An M6-2 exception manifest is required.');
  }
  if (!reviewManifest && (requireClassDispositions || requireCollisionReview)) {
    throw new SurfaceFormProjectionError(
      'Strict surface-form admission requires the M6-3 review manifest.',
      'SURFACE_FORM_REVIEW_MANIFEST_REQUIRED',
    );
  }
  const activeReviewManifest = reviewManifest ?? EMPTY_SURFACE_FORM_REVIEW_MANIFEST;

  const exceptionsBySense = validateManifestBindings(
    records,
    exceptionManifest,
    requireExceptionTargets,
  );
  const dispositionsBySense = validateReviewManifestBindings(
    records,
    activeReviewManifest,
    exceptionsBySense,
    requireExceptionTargets,
  );
  const rowsByKey = new Map();
  const exclusions = [];
  const decisions = new Map();
  const eligible = allRelevantRecords(records);
  validateClassDispositionCoverage(
    eligible,
    exceptionsBySense,
    dispositionsBySense,
    requireClassDispositions,
  );

  for (const { record } of eligible) {
    for (const sense of record.senses) {
      if (sense.pos !== 'verb' && sense.pos !== 'adjective') continue;
      const key = sourceKey(record.id, sense.id);
      const classId = exceptionsBySense.get(key) ?? null;
      const disposition = dispositionsBySense.get(key);
      const ruleIds = ruleIdsForSense(record, sense, classId);

      if (disposition?.class_id === 'm6-3-predicate-excluded') {
        for (const ruleId of ruleIds) {
          addExclusion(exclusions, record, sense, ruleId, disposition.reason);
          addDecision(decisions, record, sense, ruleId, 'excluded');
        }
        continue;
      }

      for (const ruleId of ruleIds) {
        if (
          disposition?.class_id === 'm6-3-open-vowel-past-excluded'
          && ruleId === plainPastRuleId(record, classId)
        ) {
          addExclusion(exclusions, record, sense, ruleId, disposition.reason);
          addDecision(decisions, record, sense, ruleId, 'excluded');
          continue;
        }

        if (
          record.lemma.includes(' ')
          || !record.lemma.endsWith('다')
          || classId === 'm6-3-shortened-didida-lemma'
        ) {
          addExclusion(
            exclusions,
            record,
            sense,
            ruleId,
            exclusionReason(record, classId, ruleId),
          );
          addDecision(decisions, record, sense, ruleId, 'excluded');
          continue;
        }

        const forms = formsForRule({ record, sense, classId, ruleId });
        if (!forms || forms.length === 0 || forms.some((form) => !form)) {
          if (
            ruleId === SURFACE_FORM_RULE_IDS.predicatePlainPastRegisteredException
            && classId
            && classId !== 'm6-2-eopda-present-adnominal'
          ) {
            throw new SurfaceFormProjectionError(
              'Registered exception class ' + classId + ' has no implementation for '
                + record.id + '/' + sense.id + '.',
              'UNSUPPORTED_EXCEPTION_FORM',
            );
          }
          addExclusion(
            exclusions,
            record,
            sense,
            ruleId,
            exclusionReason(record, classId, ruleId),
          );
          addDecision(decisions, record, sense, ruleId, 'excluded');
          continue;
        }

        let generatedCount = 0;
        for (const form of forms) {
          if (typeof form !== 'string' || form.length === 0) {
            throw new SurfaceFormProjectionError(
              'A generated surface form must be a non-empty string.',
              'INVALID_GENERATED_FORM',
            );
          }
          const key = form + '\u0000' + record.id + '\u0000' + sense.id;
          const existing = rowsByKey.get(key);
          if (!existing) {
            rowsByKey.set(key, {
              form,
              record_id: record.id,
              sense_id: sense.id,
              rule_id: ruleId,
              sense_position: record.senses.findIndex(({ id }) => id === sense.id),
            });
          } else if (RULE_ORDER.indexOf(ruleId) < RULE_ORDER.indexOf(existing.rule_id)) {
            existing.rule_id = ruleId;
          }
          generatedCount += 1;
        }
        addDecision(decisions, record, sense, ruleId, 'generated:' + generatedCount);
      }
    }
  }

  const rows = [...rowsByKey.values()].sort((left, right) => (
    compareStrings(left.record_id, right.record_id)
    || left.sense_position - right.sense_position
    || compareStrings(left.form, right.form)
    || compareStrings(left.rule_id, right.rule_id)
  ));
  const expectedDecisionCount = eligible.reduce(
    (count, { record }) => count + record.senses.reduce(
      (senseCount, sense) => senseCount
        + (sense.pos === 'verb' || sense.pos === 'adjective'
          ? ruleIdsForSense(
            record,
            sense,
            exceptionsBySense.get(sourceKey(record.id, sense.id)) ?? null,
          ).length
          : 0),
      0,
    ),
    0,
  );

  if (decisions.size !== expectedDecisionCount) {
    throw new SurfaceFormProjectionError(
      'Surface-form rule coverage is incomplete: ' + decisions.size + '/' + expectedDecisionCount + '.',
      'INCOMPLETE_SURFACE_FORM_COVERAGE',
    );
  }

  const collisions = collisionAudit(records, rows);
  if (requireCollisionReview) validateCollisionReview(activeReviewManifest, collisions);
  return {
    rows: rows.map(({ form, record_id, sense_id, rule_id }) => ({
      form,
      record_id,
      sense_id,
      rule_id,
    })),
    exclusions: exclusions.sort((left, right) => (
      compareStrings(left.record_id, right.record_id)
      || compareStrings(left.sense_id, right.sense_id)
      || compareStrings(left.rule_id, right.rule_id)
    )),
    coverage: {
      eligible_record_count: eligible.length,
      eligible_sense_count: eligible.reduce(
        (count, { record }) => count + record.senses.filter(
          ({ pos }) => pos === 'verb' || pos === 'adjective',
        ).length,
        0,
      ),
      generated_surface_form_count: rows.length,
      generated_distinct_form_count: new Set(rows.map(({ form }) => form)).size,
      excluded_rule_count: exclusions.length,
      complete_rule_decision_count: decisions.size,
      expected_rule_decision_count: expectedDecisionCount,
      exception_binding_count: exceptionsBySense.size,
      class_disposition_count: dispositionsBySense.size,
      exact_collision_form_count: collisions.exactCollisions.length,
      ambiguous_generated_form_count: collisions.ambiguousGeneratedForms.length,
    },
    collisions,
  };
}

export function buildOrReuseSurfaceFormProjection(
  records,
  {
    context,
    exceptionManifest,
    reviewManifest,
    requireExceptionTargets = false,
    requireClassDispositions = false,
    requireCollisionReview = false,
  } = {},
) {
  const cache = context?.derived?.surfaceFormProjectionCache;
  const cacheMatches = records === context?.records
    && context?.derived?.surfaceFormProjection
    && cache?.exceptionManifest === exceptionManifest
    && cache?.reviewManifest === reviewManifest
    && (!requireExceptionTargets || cache.requireExceptionTargets)
    && (!requireClassDispositions || cache.requireClassDispositions)
    && (!requireCollisionReview || cache.requireCollisionReview);
  if (cacheMatches) return context.derived.surfaceFormProjection;

  const projection = buildSurfaceFormProjection(records, {
    exceptionManifest,
    reviewManifest,
    requireExceptionTargets,
    requireClassDispositions,
    requireCollisionReview,
  });
  if (records === context?.records) {
    context.derived ??= {};
    context.derived.surfaceFormProjection = projection;
    context.derived.surfaceFormProjectionCache = {
      exceptionManifest,
      reviewManifest,
      requireExceptionTargets,
      requireClassDispositions,
      requireCollisionReview,
    };
    if (context.metrics) {
      context.metrics.surface_form_projection_build_count =
        (context.metrics.surface_form_projection_build_count ?? 0) + 1;
    }
  }
  return projection;
}
