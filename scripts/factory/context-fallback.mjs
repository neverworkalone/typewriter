import { createHash } from 'node:crypto';

import { POS_VALUES, digest } from '../intake/candidate-contract.mjs';
import { fallbackBlockers } from './ensemble-resolver.mjs';

export { fallbackBlockers };

// Contextual fallback (issue #285 §2A): the M9-style local source-context review for observations
// whose lemma/POS the three pinned Providers could not reliably assign. It is a RECOVERY path for
// observed candidate surfaces only; it cannot recover words the extractor never proposed.
//
// The portable, committed artifact is a TEXT-FREE decision record bound by digests. Raw paragraphs
// are looked up only through an injected local `contextSource` (the ignored corpus index), never
// logged, sent to a remote API or written to Git. A context decision here is an AI self-check
// (`independent: false`, `human_reviewed: false`): it is neither ground truth nor editorial or
// canonical approval, and it never clears an extractor hold.

export const CONTEXT_CONTRACT = 'context-fallback-decisions-v1';
export const CONTEXT_METHOD = 'm9-local-context-review-v1';
export const CONTEXT_OUTCOMES = Object.freeze(['context_confirmed', 'context_reassigned', 'truth_unknown']);
export const RESOLVING_OUTCOMES = Object.freeze(['context_confirmed', 'context_reassigned']);
export const RESOLVED_REASON = 'context_supports_reading';
export const UNKNOWN_REASONS = Object.freeze(['no_source', 'permission_denied', 'weak_alignment', 'conflicting_readings', 'verification_failed']);
export const CONTEXT_REASONS = Object.freeze([RESOLVED_REASON, ...UNKNOWN_REASONS]);
export const MAX_CONTEXT_DECISIONS = 2000;

const SHA256 = /^[0-9a-f]{64}$/u;
const KOREAN_WORD = /^[가-힣]+$/u;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class ContextFallbackError extends Error {
  constructor(errors) {
    super(`Context fallback: ${errors.join('; ')}`);
    this.name = 'ContextFallbackError';
    this.errors = errors;
  }
}

export const fallbackEligible = (entry) => fallbackBlockers(entry).length === 0;

// Exact, whitespace-delimited eojeol alignment with the observed form (edge punctuation ignored).
// A substring or prefix of a larger word is not alignment.
export function alignedInContext(text, surface) {
  return alignedOffset(text, surface) !== null;
}

// Offset of the FIRST whitespace-delimited eojeol that equals the surface (edge punctuation
// ignored), in the original text — so a review window is built from the exact aligned token and
// never from an earlier substring (가 inside 가방). Null when no eojeol aligns.
export function alignedOffset(text, surface) {
  if (typeof text !== 'string') return null;
  const wanted = surface.normalize('NFC');
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0].normalize('NFC');
    const lead = token.match(/^[^\p{L}\p{N}]*/u)[0].length;
    const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (core === wanted) return { start: match.index + lead, end: match.index + lead + core.length };
  }
  return null;
}

// Binds the source snapshot, exact document/paragraph ids, a digest of the paragraph (not its text)
// and the observed form. A changed context changes this digest; the digest reveals no text.
export const contextSourceDigest = ({ snapshot, ref, text, surface }) => digest(['context-source', CONTEXT_METHOD, snapshot, ref, sha256(text.normalize('NFC')), surface]);

export const decisionSha256 = (record) => {
  const { decision_sha256: _omit, ...content } = record;
  return sha256(JSON.stringify(content));
};
export const contextDecisionsSha256 = (decisions) => digest(['context-decisions', CONTEXT_CONTRACT, decisions.map((decision) => decision.decision_sha256)]);

const hypothesisKey = (entry) => `${entry.lemma}\u0000${entry.pos}`;

// proposals: agent-authored judgments, [{ observation_digest, outcome, lemma?, pos?, reason_code? }].
// Each is checked here against the queue entry and — for a resolving outcome — against the live
// local source. Anything the source cannot support becomes `truth_unknown` with its reason: never a
// guess. `agent` is the honest authoring agent label (self-check, not independent review).
export async function recordContextDecisions({ proposals, queue, contextSource, snapshot, agent }) {
  const errors = [];
  if (typeof agent !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(agent)) {
    throw new ContextFallbackError(['the authoring agent must be stated explicitly (e.g. "claude" or "codex"); provenance is never defaulted']);
  }
  const byDigest = new Map(queue.map((entry) => [entry.observation_digest, entry]));
  const decisions = [];
  const seen = new Set();
  const ordered = [...proposals].sort((a, b) => compare(a.observation_digest, b.observation_digest));
  for (const proposal of ordered) {
    const entry = byDigest.get(proposal.observation_digest);
    if (!entry) { errors.push(`context proposal ${String(proposal.observation_digest).slice(0, 12)}: not an unresolved observation of this run`); continue; }
    if (seen.has(entry.observation_digest)) { errors.push(`context proposal for ${entry.surface}: duplicated`); continue; }
    seen.add(entry.observation_digest);
    if (!CONTEXT_OUTCOMES.includes(proposal.outcome)) { errors.push(`context proposal for ${entry.surface}: outcome must be one of ${CONTEXT_OUTCOMES.join(', ')}`); continue; }
    const blockers = fallbackBlockers(entry);
    if (blockers.length) { errors.push(`context proposal for ${entry.surface}: fallback is not allowed (${blockers.join(', ')}); the hold is not bypassable by a contextual verdict`); continue; }
    const base = {
      decision_id: null, observation_digest: entry.observation_digest, trace_digest: entry.trace_digest, surface: entry.surface, evidence: entry.evidence,
      considered: entry.hypotheses, method: CONTEXT_METHOD, author: { kind: 'agent-self-check', agent }, independent: false, human_reviewed: false,
    };
    const unknown = (reason) => decisions.push({ ...base, outcome: 'truth_unknown', reason_code: reason });
    if (proposal.outcome === 'truth_unknown') {
      unknown(UNKNOWN_REASONS.includes(proposal.reason_code) ? proposal.reason_code : 'conflicting_readings');
      continue;
    }
    if (!KOREAN_WORD.test(String(proposal.lemma)) || !POS_VALUES.includes(proposal.pos)) { errors.push(`context proposal for ${entry.surface}: lemma/POS are required for a resolving outcome`); continue; }
    const known = entry.hypotheses.some((hypothesis) => hypothesisKey(hypothesis) === hypothesisKey(proposal));
    if (proposal.outcome === 'context_confirmed' && !known) { errors.push(`context proposal for ${entry.surface}: context_confirmed must name an analyzer hypothesis; use context_reassigned for another reading`); continue; }
    if (proposal.outcome === 'context_reassigned' && known) { errors.push(`context proposal for ${entry.surface}: context_reassigned names an analyzer hypothesis; use context_confirmed`); continue; }
    let found;
    try {
      found = await contextSource.lookup({ kind: entry.evidence.kind, ref: entry.evidence.ref });
    } catch {
      found = { status: 'denied' };
    }
    // The index is not the snapshot the evidence was built from: nothing may be recorded against it.
    if (found?.status === 'snapshot_mismatch') { errors.push(`context proposal for ${entry.surface}: the local corpus index does not match the evidence source snapshot ${snapshot}`); continue; }
    if (found?.status === 'denied') { unknown('permission_denied'); continue; }
    if (found?.status !== 'ok' || typeof found.text !== 'string' || found.text.length === 0) { unknown('no_source'); continue; }
    if (!alignedInContext(found.text, entry.surface)) { unknown('weak_alignment'); continue; }
    decisions.push({
      ...base, outcome: proposal.outcome, lemma: proposal.lemma, pos: proposal.pos, reason_code: RESOLVED_REASON,
      source_digest: contextSourceDigest({ snapshot, ref: entry.evidence.ref, text: found.text, surface: entry.surface }),
    });
  }
  if (errors.length) throw new ContextFallbackError(errors);
  return finalizeDecisions(decisions);
}

// Stable ids and per-record digests, in a deterministic order independent of proposal order.
function finalizeDecisions(decisions) {
  const ordered = [...decisions].sort((a, b) => compare(a.observation_digest, b.observation_digest));
  return ordered.map((decision, index) => {
    const withId = { ...decision, decision_id: `D${String(index + 1).padStart(4, '0')}` };
    return { ...withId, decision_sha256: decisionSha256(withId) };
  });
}

const DECISION_KEYS = ['decision_id', 'observation_digest', 'trace_digest', 'surface', 'evidence', 'considered', 'method', 'author', 'independent', 'human_reviewed',
  'outcome', 'reason_code', 'lemma', 'pos', 'source_digest', 'decision_sha256'];

// Portable shape + digest validation of the committed text-free record (no source access needed).
export function validateContextDecisions(decisions) {
  const errors = [];
  if (!Array.isArray(decisions)) return ['context_fallback.decisions must be an array'];
  if (decisions.length > MAX_CONTEXT_DECISIONS) errors.push(`context_fallback: more than ${MAX_CONTEXT_DECISIONS} decisions`);
  const seen = new Set();
  decisions.forEach((decision, index) => {
    const at = `context decision ${index + 1}`;
    if (!isObject(decision) || Object.keys(decision).some((key) => !DECISION_KEYS.includes(key))) { errors.push(`${at}: unknown or missing fields`); return; }
    if (decision.decision_id !== `D${String(index + 1).padStart(4, '0')}`) errors.push(`${at}: decision_id must be D${String(index + 1).padStart(4, '0')}`);
    for (const key of ['observation_digest', 'trace_digest', 'decision_sha256']) if (!SHA256.test(String(decision[key]))) errors.push(`${at}: ${key} must be sha256 hex`);
    if (SHA256.test(String(decision.decision_sha256)) && decision.decision_sha256 !== decisionSha256(decision)) errors.push(`${at}: decision_sha256 does not bind its content (tampered)`);
    if (seen.has(decision.observation_digest)) errors.push(`${at}: a second decision for the same observation`);
    seen.add(decision.observation_digest);
    if (decision.method !== CONTEXT_METHOD) errors.push(`${at}: method must be ${CONTEXT_METHOD}`);
    // Honest attribution: an agent self-check is neither independent nor human-reviewed.
    if (!isObject(decision.author) || decision.author.kind !== 'agent-self-check' || typeof decision.author.agent !== 'string' || !decision.author.agent
      || decision.independent !== false || decision.human_reviewed !== false) errors.push(`${at}: provenance must be an agent self-check (independent: false, human_reviewed: false)`);
    if (!CONTEXT_OUTCOMES.includes(decision.outcome)) errors.push(`${at}: outcome must be one of ${CONTEXT_OUTCOMES.join(', ')}`);
    if (!CONTEXT_REASONS.includes(decision.reason_code)) errors.push(`${at}: reason_code must be one of ${CONTEXT_REASONS.join(', ')}`);
    if (!Array.isArray(decision.considered) || decision.considered.length === 0) errors.push(`${at}: the competing analyzer hypotheses considered must be recorded`);
    if (RESOLVING_OUTCOMES.includes(decision.outcome)) {
      if (!KOREAN_WORD.test(String(decision.lemma)) || !POS_VALUES.includes(decision.pos)) errors.push(`${at}: a resolving decision needs lemma and pos`);
      if (decision.reason_code !== RESOLVED_REASON) errors.push(`${at}: a resolving decision must carry ${RESOLVED_REASON}`);
      if (!SHA256.test(String(decision.source_digest))) errors.push(`${at}: a resolving decision must bind its source with source_digest`);
      const known = Array.isArray(decision.considered) && decision.considered.some((hypothesis) => hypothesisKey(hypothesis) === hypothesisKey(decision));
      if ((decision.outcome === 'context_confirmed') !== known) errors.push(`${at}: context_confirmed must name a considered hypothesis and context_reassigned must not`);
    } else if (decision.outcome === 'truth_unknown') {
      if (!UNKNOWN_REASONS.includes(decision.reason_code)) errors.push(`${at}: truth_unknown needs one of ${UNKNOWN_REASONS.join(', ')}`);
      if (decision.lemma !== undefined || decision.pos !== undefined || decision.source_digest !== undefined) errors.push(`${at}: truth_unknown carries no lemma, POS or source digest`);
    }
    if (!isObject(decision.evidence) || typeof decision.surface !== 'string') errors.push(`${at}: surface and evidence are required`);
  });
  return errors;
}

// Integration check against the local source (never part of routine CI): recomputes each resolving
// decision's source digest from the live paragraph. A changed or missing context fails closed.
export async function verifyDecisionsAgainstSource({ decisions, contextSource, snapshot }) {
  const errors = [];
  for (const decision of decisions.filter((entry) => RESOLVING_OUTCOMES.includes(entry.outcome))) {
    let found;
    try { found = await contextSource.lookup({ kind: decision.evidence.kind, ref: decision.evidence.ref }); } catch { found = { status: 'denied' }; }
    if (found?.status === 'snapshot_mismatch') { errors.push(`${decision.decision_id}: the local corpus index does not match the recorded source snapshot ${snapshot}`); continue; }
    if (found?.status !== 'ok') { errors.push(`${decision.decision_id}: source context is not available (${found?.status ?? 'unknown'})`); continue; }
    if (!alignedInContext(found.text, decision.surface)) errors.push(`${decision.decision_id}: the observed eojeol no longer aligns with its source`);
    else if (contextSourceDigest({ snapshot, ref: decision.evidence.ref, text: found.text, surface: decision.surface }) !== decision.source_digest) errors.push(`${decision.decision_id}: source context changed since the decision was recorded`);
  }
  return errors;
}

// Deterministic replay of recorded decisions: binds each to the CURRENT trace and observation.
// A decision whose trace/observation digest no longer matches (analyzers, order or surface changed,
// or the decision was edited) is rejected, never silently re-inferred or ignored.
export function replayContextDecisions({ decisions, queue }) {
  const errors = validateContextDecisions(decisions);
  const byDigest = new Map(queue.map((entry) => [entry.observation_digest, entry]));
  const resolved = new Map();
  const unknown = new Map();
  for (const decision of decisions) {
    const entry = byDigest.get(decision.observation_digest);
    if (!entry) { errors.push(`${decision.decision_id}: not an unresolved observation of this run`); continue; }
    if (entry.trace_digest !== decision.trace_digest) { errors.push(`${decision.decision_id}: the analyzer trace changed since this decision was recorded`); continue; }
    if (entry.surface !== decision.surface || JSON.stringify(entry.evidence) !== JSON.stringify(decision.evidence) || JSON.stringify(entry.hypotheses) !== JSON.stringify(decision.considered)) {
      errors.push(`${decision.decision_id}: the decision does not match the observation it names`); continue;
    }
    const blockers = fallbackBlockers(entry);
    if (blockers.length) { errors.push(`${decision.decision_id}: fallback is not allowed for ${entry.surface} (${blockers.join(', ')})`); continue; }
    (RESOLVING_OUTCOMES.includes(decision.outcome) ? resolved : unknown).set(decision.observation_digest, decision);
  }
  if (errors.length) throw new ContextFallbackError(errors);
  return { resolved, unknown };
}
