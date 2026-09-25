const HANGUL_SYLLABLE_BASE = 0xac00;
const HANGUL_SYLLABLE_COUNT = 11172;
const FINAL_CONSONANT_COUNT = 28;
const VOWEL_BLOCK_SIZE = 588;
const OPEN_O_VOWEL_INDEX = 8;
const COMPOUND_WA_VOWEL_INDEX = 9;
const SS_FINAL_CONSONANT_INDEX = 20;

/**
 * Apply the shared open-ㅗ + 았 contraction primitive to a stem.
 * Returns null when the stem does not end in an open Hangul syllable with ㅗ.
 */
export function contractOpenOVowelWithAt(stem) {
  if (typeof stem !== 'string') return null;
  const syllables = [...stem];
  const finalSyllable = syllables.at(-1);
  if (!finalSyllable) return null;

  const syllableIndex = finalSyllable.codePointAt(0) - HANGUL_SYLLABLE_BASE;
  if (syllableIndex < 0 || syllableIndex >= HANGUL_SYLLABLE_COUNT) return null;

  const finalConsonantIndex = syllableIndex % FINAL_CONSONANT_COUNT;
  const vowelIndex = Math.floor((syllableIndex % VOWEL_BLOCK_SIZE) / FINAL_CONSONANT_COUNT);
  if (finalConsonantIndex !== 0 || vowelIndex !== OPEN_O_VOWEL_INDEX) return null;

  const onsetIndex = Math.floor(syllableIndex / VOWEL_BLOCK_SIZE);
  const contractedSyllable = String.fromCodePoint(
    HANGUL_SYLLABLE_BASE
    + onsetIndex * VOWEL_BLOCK_SIZE
    + COMPOUND_WA_VOWEL_INDEX * FINAL_CONSONANT_COUNT
    + SS_FINAL_CONSONANT_INDEX,
  );

  syllables[syllables.length - 1] = contractedSyllable;
  return syllables.join('');
}
