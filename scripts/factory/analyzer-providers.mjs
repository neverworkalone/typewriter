import { POS_VALUES, digest } from '../intake/candidate-contract.mjs';
import { PINNED_ANALYZER, analysisInputDigest, assertPinnedAnalyzer } from '../intake/pipeline.mjs';
import { createKiwiAnalyzer } from '../intake/kiwi-client.mjs';

// Morphological-analyzer Provider boundary for Factory Stage 1 (issue #272; docs/lexical-factory-contracts.md).
//
// A Provider is a plain object:
//   { id, identity, capabilities: { n_best, derivation }, analyze(requests), assertMetadata(metadata) }
// `analyze([{ id, text }])` resolves `{ metadata, results }` where each result is
// `{ id, input_digest, status: 'ok'|'error'|'unsupported'|'ambiguous', analyses: [[{ lemma, pos, form, derived_from?, derived_from_index? }]] }`
// (the kiwi_service shape). Providers only analyze; admission judgment stays in Stage 1's common
// resolution policy. Provider-specific details never enter candidate rows or manifests.

export const PROVIDER_RESULT_CONTRACT = 'analyzer-provider-result-v1';
// Version of the common resolution policy (stage1.mjs `resolveWithProviders`). Changing the policy
// changes the manifest analyzer digest of any non-default provider order.
export const RESOLUTION_POLICY = 'provider-resolution-v1';
export const DEFAULT_PROVIDER_ORDER = Object.freeze(['kiwi']);
// Explicitly classified unresolved outcomes a later provider may be asked about. Every other hold
// (lemma/POS mismatch, evidence, coverage, licensing, editorial) is never reopened by a fallback.
export const FALLBACK_ELIGIBLE_HOLDS = Object.freeze(['analysis_missing', 'analysis_unsupported', 'analysis_error', 'analysis_stale', 'analysis_ambiguous']);

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const providerIdentityDigest = (identity) => digest(['analyzer-provider-identity', identity.provider_id, identity.implementation, identity.version,
  identity.model, JSON.stringify(identity.config ?? {})]);

export const providerDescriptor = (provider) => ({ provider_id: provider.id, identity_digest: providerIdentityDigest(provider.identity) });

// Pinned Kiwi, behavior-identical to the former hard-wired analyzer. `analyze` is injectable so
// tests need no Python.
export function createKiwiProvider({ analyze, python } = {}) {
  return {
    id: 'kiwi',
    identity: Object.freeze({
      provider_id: 'kiwi', implementation: 'kiwipiepy', version: PINNED_ANALYZER.kiwipiepy_version,
      model: PINNED_ANALYZER.kiwipiepy_model_version, config: Object.freeze({ proposal_contract: 'derivation-root-v1' }),
    }),
    capabilities: Object.freeze({ n_best: true, derivation: true }),
    analyze: analyze ?? createKiwiAnalyzer({ python }),
    assertMetadata: (metadata) => assertPinnedAnalyzer(metadata),
  };
}

// Structural check of the provider object itself; a malformed provider is a configuration error.
export function assertProvider(provider) {
  const errors = [];
  if (!isObject(provider)) throw new Error('analyzer provider must be an object');
  if (!PROVIDER_ID.test(String(provider.id))) errors.push(`provider id ${provider.id} must match ${PROVIDER_ID}`);
  const { identity } = provider;
  if (!isObject(identity) || identity.provider_id !== provider.id) errors.push('provider identity.provider_id must equal id');
  else for (const key of ['implementation', 'version', 'model']) if (typeof identity[key] !== 'string' || !identity[key]) errors.push(`provider identity.${key} must be a pinned non-empty string`);
  if (!isObject(provider.capabilities) || typeof provider.capabilities.n_best !== 'boolean' || typeof provider.capabilities.derivation !== 'boolean') {
    errors.push('provider capabilities must declare boolean n_best and derivation');
  }
  if (typeof provider.analyze !== 'function' || typeof provider.assertMetadata !== 'function') errors.push('provider needs analyze() and assertMetadata()');
  if (errors.length) throw new Error(`invalid analyzer provider: ${errors.join('; ')}`);
  return provider;
}

const wellFormedPath = (path) => Array.isArray(path) && path.every((item) => isObject(item)
  && typeof item.lemma === 'string' && item.lemma.length > 0 && POS_VALUES.includes(item.pos) && typeof item.form === 'string');

// Versioned normalized result for one request. Malformed output is never trusted: it becomes an
// explicit `error`. Provider diagnostics (`reason`) stay in the sidecar, not in decisions.
export function normalizeProviderResult(provider, request, raw) {
  const base = { contract: PROVIDER_RESULT_CONTRACT, provider_id: provider.id, request_id: request.id, identity_digest: providerIdentityDigest(provider.identity),
    capabilities: provider.capabilities, analyses: [], diagnostics: {} };
  if (!isObject(raw) || raw.id !== request.id) return { ...base, outcome: 'missing', input_digest: null };
  const common = { ...base, input_digest: typeof raw.input_digest === 'string' ? raw.input_digest : null, diagnostics: { reason: typeof raw.reason === 'string' ? raw.reason : '' } };
  if (common.input_digest !== analysisInputDigest(request.text)) return { ...common, outcome: 'stale' };
  if (raw.status === 'error') return { ...common, outcome: 'error' };
  if (raw.status === 'ambiguous') return { ...common, outcome: 'ambiguous' };
  if (raw.status !== 'ok' || !Array.isArray(raw.analyses) || raw.analyses.length === 0) return { ...common, outcome: 'unsupported' };
  if (!raw.analyses.every(wellFormedPath)) return { ...common, outcome: 'error', diagnostics: { reason: 'malformed_analysis' } };
  return { ...common, outcome: 'success', analyses: raw.analyses };
}

// Back to the kiwi_service result shape `resolveSurface` interprets (unchanged Kiwi semantics).
export const toLegacyOutcome = (normalized) => (normalized.outcome === 'missing' ? undefined : {
  id: normalized.request_id, input_digest: normalized.input_digest ?? 'invalid',
  status: normalized.outcome === 'success' ? 'ok' : normalized.outcome === 'stale' ? 'ok' : normalized.outcome === 'error' ? 'error' : 'unsupported',
  analyses: normalized.analyses,
});
