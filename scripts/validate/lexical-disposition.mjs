const HOLD_BASES = new Set([
  'unresolved-lexical-unit',
  'unresolved-identity',
  'unresolved-sense',
  'unresolved-scope',
]);

const REJECTION_BASES = new Set([
  'duplicate-identity',
  'not-a-lexical-unit',
  'unsupported-scope',
]);

function fail(message, suffix, errorCodePrefix) {
  const error = new Error(message);
  error.code = `${errorCodePrefix}_${suffix}`;
  throw error;
}

/**
 * Keep held and rejected authority inside unresolved lexical structure.
 * Both authored decision sources and the common production boundary use this
 * rule so a later selector cannot turn editorial quality into exclusion.
 */
export function validateLexicalDispositionBasis(row, {
  label = 'decision',
  errorCodePrefix = 'LEXICAL_DISPOSITION',
} = {}) {
  if (row?.decision === 'held') {
    if (!HOLD_BASES.has(row.hold_basis) || Object.hasOwn(row, 'rejection_basis')) {
      fail(
        `${label}.hold_basis must identify an unresolved lexical-unit, identity, sense, or scope question`,
        'HOLD_BASIS',
        errorCodePrefix,
      );
    }
  } else if (row?.decision === 'rejected') {
    if (!REJECTION_BASES.has(row.rejection_basis)) {
      fail(
        `${label}.rejection_basis must identify a lexical-unit, identity, or scope defect`,
        'REJECTION_BASIS',
        errorCodePrefix,
      );
    }
    if (Object.hasOwn(row, 'hold_basis')) {
      fail(
        `${label}.hold_basis is only valid for a held lexical identity`,
        'HOLD_BASIS',
        errorCodePrefix,
      );
    }
  } else if (Object.hasOwn(row ?? {}, 'rejection_basis') || Object.hasOwn(row ?? {}, 'hold_basis')) {
    fail(
      `${label} hold_basis and rejection_basis are only valid for held or rejected lexical identities`,
      'DISPOSITION_BASIS',
      errorCodePrefix,
    );
  }
  return row;
}
