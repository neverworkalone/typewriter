import assert from 'node:assert/strict';

// Reviewer trust is decided from the registry on the protected base branch, not
// from the change that uses a reviewer. A change may add registry entries, but
// an entry is usable only after that change has been merged, and base entries
// are immutable. Producers therefore cannot self-grant a reviewer identity.

export const REVIEW_INPUT_PATH_PATTERN = /^data\/batches\/(.+)-semantic-review-input\.json$/u;
export const REGISTRY_PATH = 'config/semantic-reviewers.json';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const normalizeId = (value) => value.trim().toLowerCase();

export function parseReviewerRegistry(value) {
  assert.equal(value?.schema_version, 1, 'reviewer registry has an unsupported schema version');
  assert.ok(Array.isArray(value.reviewers) && value.reviewers.length > 0, 'reviewer registry lists no reviewers');
  const ids = value.reviewers.map((entry) => entry?.id);
  assert.ok(ids.every(nonEmpty), 'reviewer registry ids must be non-empty strings');
  assert.equal(new Set(ids.map(normalizeId)).size, ids.length, 'reviewer registry ids must be unique (case-insensitive)');
  return new Map(value.reviewers.map((entry) => [entry.id, entry]));
}

// `baseRegistry` / `headRegistry` are parsed JSON (or null when the file does
// not exist on that side). `changedInputs` are the review inputs added or
// modified by the change: [{ path, input, candidateAuthor }].
export function evaluateReviewerTrust({ baseRegistry, headRegistry, changedInputs }) {
  const failures = [];
  const base = baseRegistry === null ? null : parseReviewerRegistry(baseRegistry);
  const head = headRegistry === null ? null : parseReviewerRegistry(headRegistry);

  if (base !== null) {
    if (head === null) {
      failures.push('the change deletes the reviewer registry');
    } else {
      for (const [id, entry] of base) {
        if (!head.has(id)) failures.push(`the change removes trusted reviewer ${id}`);
        else if (JSON.stringify(head.get(id)) !== JSON.stringify(entry)) {
          failures.push(`the change rewrites trusted reviewer ${id}`);
        }
      }
    }
  }

  for (const { path: inputPath, input, candidateAuthor } of changedInputs) {
    const reviewer = input?.reviewer;
    if (!nonEmpty(reviewer)) {
      failures.push(`${inputPath} names no reviewer`);
      continue;
    }
    if (base === null) {
      failures.push(`${inputPath} uses reviewer ${reviewer} but the base branch has no reviewer registry`);
    } else if (!base.has(reviewer)) {
      const selfGranted = head?.has(reviewer) ? ' (added to the registry by this same change)' : '';
      failures.push(`${inputPath} uses reviewer ${reviewer}, which is not trusted on the base branch${selfGranted}`);
    }
    if (!nonEmpty(candidateAuthor)) {
      failures.push(`${inputPath} has no candidate-review author to compare with`);
    } else if (normalizeId(candidateAuthor) === normalizeId(reviewer)) {
      failures.push(`${inputPath} reviewer ${reviewer} is the candidate-review author; self-review is not independent`);
    }
  }
  return { ok: failures.length === 0, failures };
}
